// Минимальный SMF type 0: PPQ 96, tempo 120 BPM, равные длительности.

export const PPQ = 96;
export const TEMPO_BPM = 120;

function vlq(value) {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function chunk(id, payload) {
  const len = payload.length;
  return [
    ...Array.from(id, (ch) => ch.charCodeAt(0)),
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...payload,
  ];
}

/**
 * Строит MIDI-файл. steps — массив шагов, каждый шаг массив MIDI-нот (аккорд).
 * Одна нота = один шаг, если передан массив чисел.
 * @returns {Uint8Array}
 */
export function buildMidi(steps, options = {}) {
  const ppq = options.ppq || PPQ;
  const bpm = options.bpm || TEMPO_BPM;
  const stepTicks = options.stepTicks || ppq;

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Нет нот для MIDI-файла.');
  }

  const normalized = steps.map((step) => (Array.isArray(step) ? step : [step]));
  const flat = normalized.flat();
  for (const midi of flat) {
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      throw new Error(`Некорректная MIDI-нота: ${midi}.`);
    }
  }

  const events = [];
  const tempo = Math.round(60000000 / bpm);
  const name = Array.from('notetab', (ch) => ch.charCodeAt(0));
  events.push({ t: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] });
  events.push({ t: 0, bytes: [0xff, 0x03, name.length, ...name] });

  normalized.forEach((chord, i) => {
    const start = i * stepTicks;
    const end = start + Math.round(stepTicks * 0.9);
    for (const midi of chord) {
      events.push({ t: start, bytes: [0x90, midi, 100] });
      events.push({ t: end, bytes: [0x80, midi, 0] });
    }
  });

  const total = normalized.length * stepTicks;
  events.push({ t: total, bytes: [0xff, 0x2f, 0x00] });
  events.sort((a, b) => a.t - b.t);

  const track = [];
  let last = 0;
  for (const event of events) {
    track.push(...vlq(event.t - last), ...event.bytes);
    last = event.t;
  }

  const header = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // длина заголовка = 6
    0x00, 0x00, // format 0
    0x00, 0x01, // один трек
    (ppq >> 8) & 0xff, ppq & 0xff,
  ];
  const bytes = [...header, ...chunk('MTrk', track)];
  return new Uint8Array(bytes);
}

/** Разбор заголовка — используется в тестах и для самопроверки. */
export function inspectMidi(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ascii = (offset, len) => String.fromCharCode(...u8.slice(offset, offset + len));
  const u32 = (offset) =>
    ((u8[offset] << 24) | (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3]) >>> 0;
  return {
    magic: ascii(0, 4),
    headerLength: u32(4),
    format: (u8[8] << 8) | u8[9],
    tracks: (u8[10] << 8) | u8[11],
    division: (u8[12] << 8) | u8[13],
    trackMagic: ascii(14, 4),
    trackLength: u32(18),
    totalLength: u8.length,
  };
}
