import test from 'node:test';
import assert from 'node:assert/strict';

import { notesToTabs } from '../src/solver.js';
import { parseTab } from '../src/tab.js';
import { parseNotes, midiToName } from '../src/notes.js';
import { TUNINGS } from '../src/tuning.js';

const MELODY = 'E4 E4 F4 G4 G4 F4 E4 D4';
const SCALE = 'C4 D4 E4 F4 G4 A4 B4 C5';

test('notesToTabs: минимум 3 варианта, все тексты разные', () => {
  const variants = notesToTabs(MELODY);
  assert.ok(variants.length >= 3, `вариантов ${variants.length}`);
  assert.ok(variants.length <= 6, `вариантов ${variants.length}`);
  const tabs = variants.map((v) => v.tab);
  assert.equal(new Set(tabs).size, tabs.length, 'тексты табов должны различаться');
  for (const v of variants) {
    assert.ok(v.title.length > 0);
    assert.ok(v.description.length > 0);
    assert.equal(v.tab.split('\n').length, 6);
  }
});

test('round-trip: ноты → таб → ноты сохраняет высоты', () => {
  const notes = parseNotes(MELODY).map((n) => n.midi);
  for (const variant of notesToTabs(MELODY)) {
    const back = parseTab(variant.tab).map((e) => e.midi);
    assert.deepEqual(back, notes);
  }
});

test('round-trip на гамме и на другом строе', () => {
  for (const tuning of ['standard', 'drop-d', 'half-step-down']) {
    const notes = parseNotes(SCALE).map((n) => n.midi);
    const variants = notesToTabs(SCALE, { tuning });
    assert.ok(variants.length >= 3, `${tuning}: ${variants.length}`);
    for (const variant of variants) {
      const back = parseTab(variant.tab, tuning).map((e) => e.midi);
      assert.deepEqual(back, notes, tuning);
    }
  }
});

test('каждая нота варианта действительно есть на своей струне', () => {
  for (const tuning of Object.values(TUNINGS)) {
    for (const variant of notesToTabs(MELODY, { tuning: tuning.id })) {
      for (const pos of variant.positions) {
        assert.equal(
          tuning.midi[pos.string - 1] + pos.fret,
          pos.midi,
          `${pos.name}: струна ${pos.string}, лад ${pos.fret}, строй ${tuning.id}`
        );
        assert.ok(pos.fret >= 0 && pos.fret <= 12);
        assert.ok(pos.string >= 1 && pos.string <= 6);
      }
    }
  }
});

test('параметры максимального лада и растяжки соблюдаются', () => {
  for (const maxFret of [5, 7, 9, 12, 15]) {
    const variants = notesToTabs('G3 A3 B3 C4 D4', { maxFret, stretch: 4 });
    assert.ok(variants.length >= 3);
    for (const v of variants) {
      for (const p of v.positions) assert.ok(p.fret <= maxFret, `лад ${p.fret} > ${maxFret}`);
    }
  }
  const wide = notesToTabs(MELODY, { stretch: 5 });
  const narrow = notesToTabs(MELODY, { stretch: 3 });
  assert.ok(wide.length >= 3 && narrow.length >= 3);
});

test('мелодия с открытыми струнами: вариант с нулевым ладом есть', () => {
  const variants = notesToTabs('E4 B3 G4 D4 A3 E4');
  const openCount = (v) => v.positions.filter((p) => p.fret === 0).length;
  assert.ok(variants.some((v) => openCount(v) > 0));
  const openVariant = variants.find((v) => v.id === 'open');
  if (openVariant) {
    assert.equal(openCount(openVariant), Math.max(...variants.map(openCount)));
  }
});

test('ошибки: нота вне диапазона лада и неиграбельная нота', () => {
  assert.throws(() => notesToTabs('E7'), /вне диапазона гитары/);
  assert.throws(() => notesToTabs('D2 D2'), /не играется/);
});

test('ноты можно передать массивом MIDI', () => {
  const variants = notesToTabs([64, 65, 67, 69]);
  assert.ok(variants.length >= 3);
  assert.deepEqual(
    parseTab(variants[0].tab).map((e) => e.midi),
    [64, 65, 67, 69]
  );
  assert.equal(midiToName(64), 'E4');
});
