import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMusicXML, splitPitch } from '../src/musicxml.js';

const NOTES = [
  { midi: 64, string: 1, fret: 0 },
  { midi: 65, string: 2, fret: 1 },
  { midi: 76, string: 1, fret: 12 },
];

function parseXml(text) {
  // В Node нет DOMParser — валидность проверяем сборкой тегов:
  // (1) один корневой элемент, (2) все теги закрыты, (3) вне тегов нет < и >.
  const body = text
    .replace(/^\s*<\?xml[^?]*\?>\s*/, '')
    .replace(/^\s*<!DOCTYPE[^>]*>\s*/, '');
  const stack = [];
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let lastIndex = 0;
  let match;
  let roots = 0;
  while ((match = tagRe.exec(body)) !== null) {
    const between = body.slice(lastIndex, match.index);
    if (between.includes('<') || between.includes('>')) {
      throw new Error(`Некорректный фрагмент XML: ${between.slice(0, 40)}`);
    }
    lastIndex = tagRe.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`Незакрытый тег: ${open}, встретился </${name}>`);
    } else if (!selfClosing) {
      if (stack.length === 0) roots += 1;
      stack.push(name);
    } else if (stack.length === 0) {
      roots += 1;
    }
  }
  const tail = body.slice(lastIndex);
  if (tail.includes('<') || tail.includes('>')) {
    throw new Error(`Мусор после последнего тега: ${tail.slice(0, 40)}`);
  }
  if (stack.length) throw new Error(`Незакрытые теги: ${stack.join(', ')}`);
  if (roots !== 1) throw new Error(`Ожидали один корневой элемент, нашли ${roots}`);
  return text;
}

test('MusicXML: документ собирается и валиден по структуре', () => {
  const xml = buildMusicXML(NOTES, { title: 'Тест' });
  parseXml(xml);
  assert.match(xml, /<score-partwise version="3\.1">/);
  assert.match(xml, /<!DOCTYPE score-partwise PUBLIC/);
  assert.ok(xml.trimEnd().endsWith('</score-partwise>'));
});

test('MusicXML: TAB-ключ, 6 линий, divisions, темп 120', () => {
  const xml = buildMusicXML(NOTES);
  assert.match(xml, /<clef><sign>TAB<\/sign><line>5<\/line><clef-octave-change>-1<\/clef-octave-change><\/clef>/);
  assert.match(xml, /<staff-details><staff-lines>6<\/staff-lines><\/staff-details>/);
  assert.match(xml, /<divisions>4<\/divisions>/);
  assert.match(xml, /<time><beats>4<\/beats><beat-type>4<\/beat-type><\/time>/);
  assert.match(xml, /<sound tempo="120"\/>/);
  assert.match(xml, /<per-minute>120<\/per-minute>/);
});

test('MusicXML: у каждой ноты есть pitch, string и fret', () => {
  const xml = buildMusicXML(NOTES);
  const noteCount = (xml.match(/<note>/g) || []).length;
  assert.equal(noteCount, NOTES.length);
  for (const note of NOTES) {
    assert.match(xml, new RegExp(`<string>${note.string}</string>`));
    assert.match(xml, new RegExp(`<fret>${note.fret}</fret>`));
  }
  // высоты: E4 (64), F4 (65), E5 (76)
  assert.match(xml, /<step>E<\/step><octave>4<\/octave>/);
  assert.match(xml, /<step>F<\/step><octave>4<\/octave>/);
  assert.match(xml, /<step>E<\/step><octave>5<\/octave>/);
});

test('MusicXML: диезы получают <alter>', () => {
  const xml = buildMusicXML([{ midi: 61, string: 2, fret: 1 }]);
  assert.match(xml, /<step>C<\/step><alter>1<\/alter><octave>4<\/octave>/);
});

test('MusicXML: пустой список нот — валидный документ без <note>', () => {
  const xml = buildMusicXML([]);
  parseXml(xml);
  assert.equal((xml.match(/<note>/g) || []).length, 0);
});

test('MusicXML: экранирование заголовка и ошибки на плохих данных', () => {
  const xml = buildMusicXML(NOTES, { title: 'A & B <test>' });
  assert.match(xml, /A &amp; B &lt;test&gt;/);
  assert.throws(() => buildMusicXML([{ midi: 64, string: 0, fret: 0 }]), /струна/);
  assert.throws(() => buildMusicXML([{ midi: 64, string: 1, fret: 99 }]), /лад/);
});

test('splitPitch: MIDI → ступень/альтерация/октава', () => {
  assert.deepEqual(splitPitch(60), { step: 'C', alter: 0, octave: 4 });
  assert.deepEqual(splitPitch(61), { step: 'C', alter: 1, octave: 4 });
  assert.deepEqual(splitPitch(40), { step: 'E', alter: 0, octave: 2 });
});
