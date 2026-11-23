// Чтение .mxl (это обычный ZIP с MusicXML внутри) без внешних библиотек.
// Распаковка — через DecompressionStream('deflate-raw'), который есть в браузерах
// на Chromium 103+/Safari 16.4+/Firefox 113+. В Node инфлятор передаётся явно (тесты).

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRIES = 4096;

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

/** Конец центрального каталога: последние 64 КБ файла, сигнатура ищется с конца. */
function findEndOfCentralDirectory(bytes) {
  const limit = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= limit; i -= 1) {
    if (u32(bytes, i) === EOCD_SIG) return i;
  }
  throw new Error('Файл не похож на ZIP: не найден центральный каталог (это точно .mxl?).');
}

/**
 * Список записей ZIP: { name, method, compressedSize, localOffset }.
 * ZIP64 не поддерживаем — такие файлы почти не встречаются у MuseScore/Audiveris.
 */
export function readZipEntries(bytes) {
  if (!bytes || bytes.length < 22) throw new Error('Файл пустой — это не .mxl.');
  if (u32(bytes, 0) !== LOCAL_SIG) throw new Error('Файл не похож на ZIP: нет сигнатуры PK\\x03\\x04.');
  const eocd = findEndOfCentralDirectory(bytes);
  const count = u16(bytes, eocd + 10);
  if (count === 0xffff) throw new Error('ZIP64 не поддерживается: сохраните MusicXML как .musicxml.');
  if (count > MAX_ENTRIES) throw new Error('В архиве слишком много файлов — это точно .mxl?');
  let offset = u32(bytes, eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== CENTRAL_SIG) {
      throw new Error('Повреждён центральный каталог ZIP.');
    }
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Сжатые данные записи (без локального заголовка). */
export function entryData(bytes, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || u32(bytes, offset) !== LOCAL_SIG) {
    throw new Error(`Повреждён локальный заголовок «${entry.name}».`);
  }
  const nameLength = u16(bytes, offset + 26);
  const extraLength = u16(bytes, offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  return bytes.subarray(start, start + entry.compressedSize);
}

/** DecompressionStream('deflate-raw') → Uint8Array. */
async function inflateWithStream(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Браузер не умеет распаковывать .mxl — сохраните файл как .musicxml.');
  }
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    throw new Error(`Не удалось распаковать .mxl (${error.message}). Сохраните файл как .musicxml.`);
  }
}

/** container.xml указывает на корневой MusicXML; если его нет — берём самый большой XML. */
function chooseEntry(entries) {
  const xml = entries.filter((e) => /\.(musicxml|xml)$/i.test(e.name) && !/^META-INF\//i.test(e.name));
  if (!xml.length) throw new Error('В архиве .mxl нет MusicXML.');
  const named = xml.find((e) => /\.musicxml$/i.test(e.name)) || xml[0];
  return xml.reduce((best, e) => (e.compressedSize > best.compressedSize ? e : best), named);
}

/**
 * .mxl → { name, text }.
 * options.inflate(raw: Uint8Array) — необязательный синхронный/асинхронный инфлятор
 * (в тестах Node передаём zlib.inflateRawSync).
 */
export async function extractMusicXml(bytes, options = {}) {
  const entries = readZipEntries(bytes);
  const container = entries.find((e) => e.name === 'META-INF/container.xml');
  let chosen = null;

  if (container) {
    const inflate = options.inflate || ((data) => inflateWithStream(data));
    const raw = container.method === 0 ? entryData(bytes, container) : await inflate(entryData(bytes, container));
    const text = new TextDecoder('utf-8').decode(raw);
    const match = text.match(/full-path\s*=\s*"([^"]+)"/i);
    if (match) chosen = entries.find((e) => e.name === match[1]) || null;
  }
  if (!chosen) chosen = chooseEntry(entries);

  const inflate = options.inflate || ((data) => inflateWithStream(data));
  const raw = chosen.method === 0 ? entryData(bytes, chosen) : await inflate(entryData(bytes, chosen));
  return { name: chosen.name, text: new TextDecoder('utf-8').decode(raw) };
}
