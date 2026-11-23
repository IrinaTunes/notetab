// Разбор MusicXML (ноты, аккорды, паузы, TAB-аппликатура) без внешних библиотек.
// Работает и в браузере (DOMParser), и в Node (свой минимальный разбор XML),
// чтобы один и тот же парсер можно было проверять тестами.

import { midiToName, MIDI_MIN, MIDI_MAX } from './notes.js';

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** step/alter/octave → MIDI. C#4 → 61, Bb3 → 58. */
export function pitchToMidi(step, alter = 0, octave = 4) {
  const semi = STEP[String(step || 'C').trim().toUpperCase()[0]];
  if (semi === undefined) throw new Error(`MusicXML: неизвестная ступень «${step}».`);
  const shift = Math.round(Number(alter) || 0);
  return (Number(octave) + 1) * 12 + semi + shift;
}

/* ---------------------------------------------------------------- XML */

function node(tagName, attrs = {}, children = [], text = '') {
  return { tagName, attrs, children, text };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] !== undefined ? ENTITIES[body] : whole;
  });
}

/**
 * Минимальный XML-разбор в дерево {tagName, attrs, children, text}.
 * Нужен только для MusicXML: без CDATA-хрупкости, без DTD-валидации.
 */
export function parseXmlLite(source) {
  const text = String(source || '')
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?>/gi, '');

  const root = node('#document');
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attrRe = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let last = 0;
  let match;

  while ((match = tagRe.exec(text)) !== null) {
    const between = text.slice(last, match.index);
    if (between.trim()) stack[stack.length - 1].text += decodeEntities(between);
    last = tagRe.lastIndex;
    const [, closing, tagName, rawAttrs, selfClosing] = match;

    if (closing) {
      if (stack.length === 1) throw new Error(`MusicXML: лишний закрывающий тег </${tagName}>.`);
      const open = stack.pop();
      if (open.tagName !== tagName) {
        throw new Error(`MusicXML: ожидали </${open.tagName}>, встретили </${tagName}>.`);
      }
      continue;
    }

    const attrs = {};
    let attr;
    attrRe.lastIndex = 0;
    while ((attr = attrRe.exec(rawAttrs)) !== null) {
      attrs[attr[1]] = decodeEntities(attr[2] !== undefined ? attr[2] : attr[3]);
    }
    const element = node(tagName, attrs);
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
  }

  const tail = text.slice(last);
  if (tail.trim()) stack[stack.length - 1].text += decodeEntities(tail);
  if (stack.length !== 1) throw new Error(`MusicXML: не закрыты теги: ${stack.slice(1).map((n) => n.tagName).join(', ')}.`);
  const first = root.children[0];
  if (!first) throw new Error('MusicXML: пустой документ.');
  return first;
}

function fromDom(dom) {
  const attrs = {};
  for (const attribute of Array.from(dom.attributes || [])) attrs[attribute.name] = attribute.value;
  const children = [];
  let text = '';
  for (const child of Array.from(dom.childNodes || [])) {
    if (child.nodeType === 1) children.push(fromDom(child));
    else if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue || '';
  }
  return node(dom.tagName ? dom.tagName.replace(/^.*:/, '') : '', attrs, children, text);
}

/** Дерево из строки: DOMParser в браузере, свой разбор в Node. */
export function parseXml(source) {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(String(source), 'application/xml');
    const error = doc.getElementsByTagName('parsererror')[0];
    if (error) throw new Error(`MusicXML не разбирается: ${(error.textContent || '').slice(0, 200)}`);
    if (!doc.documentElement) throw new Error('MusicXML: пустой документ.');
    return fromDom(doc.documentElement);
  }
  return parseXmlLite(source);
}

/* ---------------------------------------------------------------- доступ к узлам */

const kids = (element, name) => (element ? element.children.filter((c) => c.tagName === name) : []);

function textOf(element, name, fallback = undefined) {
  const child = kids(element, name)[0];
  if (!child) return fallback;
  const value = String(child.text || '').trim();
  return value || fallback;
}

function intOf(value, fallback) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

/** Все <part> документа (рекурсивно — score-partwise и вложенные). */
export function partsOf(root) {
  const parts = [];
  const walk = (element) => {
    for (const child of element.children) {
      if (child.tagName === 'part') parts.push(child);
      else walk(child);
    }
  };
  walk(root);
  return parts;
}

/* ---------------------------------------------------------------- ноты */

function clefShifts(attributes) {
  const shifts = {};
  for (const clef of kids(attributes, 'clef')) {
    const staff = intOf(textOf(clef, 'staff', '1'), 1);
    shifts[staff] = intOf(textOf(clef, 'clef-octave-change', '0'), 0);
  }
  return shifts;
}

function partNotes(part) {
  let divisions = 1;
  let shifts = {};
  const onsets = [];
  let rests = 0;

  for (const measure of kids(part, 'measure')) {
    for (const child of measure.children) {
      if (child.tagName === 'attributes') {
        divisions = intOf(textOf(child, 'divisions', String(divisions)), divisions) || divisions;
        shifts = { ...shifts, ...clefShifts(child) };
        continue;
      }
      if (child.tagName !== 'note') continue;
      if (kids(child, 'rest').length) {
        rests += 1;
        continue;
      }
      const pitch = kids(child, 'pitch')[0];
      if (!pitch) continue; // <unpitched> — перкуссия, не наша музыка

      const midi = pitchToMidi(textOf(pitch, 'step', 'C'), textOf(pitch, 'alter', '0'), intOf(textOf(pitch, 'octave', '4'), 4));
      const staff = intOf(textOf(child, 'staff', '1'), 1);
      const shift = shifts[staff] || 0;
      const durationUnits = intOf(textOf(child, 'duration', String(divisions)), divisions);
      const note = {
        midi,
        name: midiToName(midi),
        duration: divisions ? Math.round((durationUnits / divisions) * 1000) / 1000 : 1,
        type: textOf(child, 'type', 'quarter'),
        staff,
        voice: textOf(child, 'voice', '1'),
        octaveShift: shift,
        sounding: midi + shift * 12,
      };

      const technical = kids(kids(child, 'notations')[0] || null, 'technical')[0];
      if (technical && textOf(technical, 'string') !== undefined && textOf(technical, 'fret') !== undefined) {
        note.string = intOf(textOf(technical, 'string'), 0);
        note.fret = intOf(textOf(technical, 'fret'), 0);
      }

      if (kids(child, 'chord').length && onsets.length) onsets[onsets.length - 1].push(note);
      else onsets.push([note]);
    }
  }

  const notes = [];
  onsets.forEach((group, index) => {
    group.sort((a, b) => a.midi - b.midi);
    for (const note of group) notes.push({ ...note, onset: index });
  });
  return { notes, rests };
}

/**
 * MusicXML → { notes, warnings, rests, parts, meta }.
 * Аккорды идут подряд по возрастанию midi, у них одинаковый `onset`.
 */
export function parseMusicXml(source) {
  const root = parseXml(source);
  const parts = partsOf(root);
  if (!parts.length) throw new Error('В MusicXML нет ни одной партии (<part>).');

  const parsed = parts.map((part, index) => {
    const id = part.attrs.id || `P${index + 1}`;
    return { id, ...partNotes(part) };
  });
  parsed.sort((a, b) => b.notes.length - a.notes.length);

  const best = parsed[0];
  const warnings = [];
  if (parsed.length > 1) {
    const others = parsed.slice(1).map((p) => `${p.id}: ${p.notes.length}`).join(', ');
    warnings.push(`В файле несколько партий — взята самая полная (${best.id}, ${best.notes.length} нот). Остальные: ${others}.`);
  }
  if (!best.notes.length) warnings.push('Нот не найдено: в MusicXML только паузы или перкуссия.');
  if (best.notes.some((note) => note.octaveShift)) {
    warnings.push('Ключ с переносом на октаву (8vb/8va): записанные ноты звучат ниже/выше — сверьте высоты.');
  }

  const range = best.notes.length
    ? { low: Math.min(...best.notes.map((n) => n.midi)), high: Math.max(...best.notes.map((n) => n.midi)) }
    : { low: null, high: null };

  return {
    notes: best.notes,
    warnings,
    rests: best.rests,
    parts: parsed.map((p) => ({ id: p.id, notes: p.notes.length, rests: p.rests })),
    meta: {
      source: 'MusicXML',
      part: best.id,
      software: textOf(kids(root, 'identification')[0] || null, 'software', ''),
      range,
      guitarRange: { min: MIDI_MIN, max: MIDI_MAX },
    },
  };
}

/** Несколько страниц OMR → один список нот (сохраняем номер страницы). */
export function flattenPages(pages) {
  const notes = [];
  const warnings = [];
  let offset = 0;
  for (const page of pages || []) {
    const pageNotes = Array.isArray(page.notes) ? page.notes : [];
    for (const note of pageNotes) notes.push({ ...note, onset: note.onset + offset, page: page.page });
    offset += pageNotes.reduce((max, note) => Math.max(max, (note.onset || 0) + 1), 0);
    for (const warning of page.warnings || []) {
      warnings.push(pages.length > 1 ? `Стр. ${page.page}: ${warning}` : warning);
    }
  }
  return { notes, warnings };
}
