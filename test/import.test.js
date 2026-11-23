import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { parseMusicXml, pitchToMidi, parseXmlLite, flattenPages } from '../src/musicxml-import.js';
import { extractMusicXml, readZipEntries } from '../src/mxl.js';
import {
  makeNote, transposeNote, removeNote, insertNote, octaveNote, toSteps, stats, renumber,
} from '../src/notelist.js';

// Та же фикстура, что и в Python-тестах: аккорд, пауза, ключ 8vb, TAB-аппликатура.
export const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <identification><encoding><software>MuseScore</software></encoding></identification>
  <part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>
      </attributes>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>2</duration><voice>1</voice><type>quarter</type>
        <notations><technical><string>1</string><fret>0</fret></technical></notations>
      </note>
      <note>
        <chord/>
        <pitch><step>B</step><octave>4</octave></pitch>
        <duration>2</duration><voice>1</voice><type>quarter</type>
      </note>
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note>
        <pitch><step>C</step><alter>1</alter><octave>4</octave></pitch>
        <duration>4</duration><voice>2</voice><type>half</type><staff>1</staff>
      </note>
    </measure>
  </part>
</score-partwise>`;

test('pitchToMidi: C#4 = 61, Bb3 = 58, E5 = 76', () => {
  assert.equal(pitchToMidi('C', 1, 4), 61);
  assert.equal(pitchToMidi('B', -1, 3), 58);
  assert.equal(pitchToMidi('E', 0, 5), 76);
  assert.equal(pitchToMidi('C', 0, 4), 60);
  assert.throws(() => pitchToMidi('H', 0, 4), /неизвестная ступень/i);
});

test('MusicXML: аккорд собирается в один onset, пауза не становится нотой', () => {
  const result = parseMusicXml(FIXTURE);
  assert.equal(result.notes.length, 3, 'две ноты аккорда + одна после паузы');
  assert.equal(result.rests, 1);
  assert.deepEqual(result.notes.map((n) => n.midi), [71, 76, 61], 'аккорд по возрастанию: B4, E5; затем C#4');
  assert.deepEqual(result.notes.map((n) => n.onset), [0, 0, 1]);
  assert.deepEqual(result.notes.map((n) => n.name), ['B4', 'E5', 'C#4']);
  assert.equal(result.notes[1].duration, 1);
  assert.equal(result.notes[2].duration, 2);
  assert.equal(result.notes[2].voice, '2');
});

test('MusicXML: 8vb ключ фиксируется, midi — по pitch, sounding — на октаву ниже', () => {
  const result = parseMusicXml(FIXTURE);
  const e5 = result.notes.find((n) => n.name === 'E5');
  assert.equal(e5.octaveShift, -1);
  assert.equal(e5.sounding, 64, 'записаное E5 с ключом 8vb звучит как E4');
  assert.ok(result.warnings.some((w) => /8vb/.test(w)));
});

test('MusicXML: <technical><string>/<fret> импортируются', () => {
  const result = parseMusicXml(FIXTURE);
  const e5 = result.notes.find((n) => n.name === 'E5');
  assert.equal(e5.string, 1);
  assert.equal(e5.fret, 0);
  assert.equal(result.notes.find((n) => n.name === 'C#4').string, undefined);
});

test('MusicXML: несколько партий — берётся самая полная, остальные в предупреждении', () => {
  const xml = FIXTURE
    .replace('</part>', '</part>')
    .replace('<part id="P1">', '<part id="P3"><measure number="1"><note><rest/><duration>1</duration></note></measure></part><part id="P1">');
  const result = parseMusicXml(xml);
  assert.equal(result.meta.part, 'P1');
  assert.ok(result.warnings.some((w) => /несколько партий/.test(w)));
  assert.deepEqual(result.parts.map((p) => p.id).sort(), ['P1', 'P3']);
});

test('parseXmlLite: сущности, атрибуты, самозакрывающиеся теги', () => {
  const root = parseXmlLite('<a x="1 &amp; 2"><b/>Текст &lt;ok&gt;</a>');
  assert.equal(root.tagName, 'a');
  assert.equal(root.attrs.x, '1 & 2');
  assert.equal(root.children[0].tagName, 'b');
  assert.match(root.text, /Текст <ok>/);
  assert.throws(() => parseXmlLite('<a><b></a>'), /ожидали<\/a>|ожидали/);
});

function buildZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, eocd]));
}

test('.mxl: ZIP распаковывается, container.xml ведёт к MusicXML', async () => {
  const container = `<?xml version="1.0"?><container><rootfiles>
    <rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>
  </rootfiles></container>`;
  const zip = buildZip([
    { name: 'META-INF/container.xml', data: container },
    { name: 'score.musicxml', data: FIXTURE },
  ]);
  assert.equal(readZipEntries(zip).length, 2);
  const { name, text } = await extractMusicXml(zip, { inflate: (bytes) => zlib.inflateRawSync(bytes) });
  assert.equal(name, 'score.musicxml');
  assert.equal(parseMusicXml(text).notes.length, 3);
});

test('.mxl: без container.xml берётся самый большой XML, мусор — понятная ошибка', async () => {
  const zip = buildZip([
    { name: 'META-INF/book.xml', data: '<book/>' },
    { name: 'song.xml', data: FIXTURE },
  ]);
  const { name } = await extractMusicXml(zip, { inflate: (bytes) => zlib.inflateRawSync(bytes) });
  assert.equal(name, 'song.xml');
  assert.throws(() => readZipEntries(new Uint8Array([1, 2, 3])), /не .mxl/);
  assert.throws(() => readZipEntries(new Uint8Array(30)), /не похож на ZIP/);
});

test('notelist: сдвиг на полутон, октава, удаление и вставка', () => {
  let notes = [makeNote(64, { onset: 0 }), makeNote(65, { onset: 1 })];
  notes = transposeNote(notes, 0, 1);
  assert.equal(notes[0].midi, 65);
  assert.equal(notes[0].name, 'F4');
  notes = removeNote(notes, 1);
  assert.equal(notes.length, 1);
  notes = insertNote(notes, 0, 67);
  assert.deepEqual(notes.map((n) => n.midi), [65, 67]);
  assert.deepEqual(notes.map((n) => n.onset), [0, 1], 'вставка — новый момент времени');
  notes = octaveNote(notes, 1, -1);
  assert.equal(notes[1].midi, 55);
  assert.throws(() => transposeNote([makeNote(38)], 0, -1), /вне диапазона/);
});

test('notelist: аккорды → шаги прослушивания, статистика', () => {
  const notes = renumber([
    makeNote(64, { onset: 0 }), makeNote(60, { onset: 0 }),
    makeNote(67, { onset: 5 }), makeNote(20, { onset: 6 }),
  ]);
  assert.deepEqual(toSteps(notes), [[64, 60], [67], [20]]);
  assert.deepEqual(notes.map((n) => n.onset), [0, 0, 1, 2]);
  const info = stats(notes);
  assert.equal(info.count, 4);
  assert.equal(info.chords, 1);
  assert.deepEqual(info.outOfRange, [3]);
});

test('flattenPages: страницы склеиваются без наложения onset', () => {
  const merged = flattenPages([
    { page: 1, notes: [{ midi: 64, onset: 0 }, { midi: 65, onset: 1 }], warnings: ['w1'] },
    { page: 2, notes: [{ midi: 67, onset: 0 }], warnings: [] },
  ]);
  assert.deepEqual(merged.notes.map((n) => n.onset), [0, 1, 2]);
  assert.deepEqual(merged.notes.map((n) => n.page), [1, 1, 2]);
  assert.deepEqual(merged.warnings, ['Стр. 1: w1']);
});
