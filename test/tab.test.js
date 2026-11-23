import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTab, generateTab, tabText, MAX_FRET } from '../src/tab.js';
import { TUNINGS } from '../src/tuning.js';

// Гамма до мажор на грифе: D-струна 5..15, G-струна 12, 14.
const SCALE = [
  [{ string: 4, fret: 5 }],
  [{ string: 4, fret: 7 }],
  [{ string: 4, fret: 9 }],
  [{ string: 4, fret: 10 }],
  [{ string: 4, fret: 12 }],
  [{ string: 4, fret: 14 }],
  [{ string: 4, fret: 15 }],
  [{ string: 3, fret: 12 }],
  [{ string: 3, fret: 14 }],
];
const SCALE_MIDI = [55, 57, 59, 60, 62, 64, 65, 67, 69];

test('таб гаммы до мажор → точно [55,57,59,60,62,64,65,67,69]', () => {
  const text = tabText(SCALE);
  const events = parseTab(text);
  assert.deepEqual(events.map((e) => e.midi), SCALE_MIDI);
});

test('после каждого лада стоит разделитель -', () => {
  const text = tabText([
    [{ string: 1, fret: 13 }],
    [{ string: 1, fret: 1 }],
    [{ string: 1, fret: 10 }],
    [{ string: 1, fret: 12 }],
  ]);
  const thin = text.split('\n')[0];
  assert.ok(thin.includes('13-'), 'лад 13 должен закрываться дефисом');
  assert.ok(thin.includes('1-'), 'лад 1 должен закрываться дефисом');
  assert.ok(thin.includes('10-'), 'лад 10 должен закрываться дефисом');
  assert.ok(!thin.includes('13' + '1-'), '1 и 3 не должны склеиваться');
  // и обратный разбор не путает 13/1 и 10/12
  const midis = parseTab(text).map((e) => e.midi);
  assert.deepEqual(midis, [77, 65, 74, 76]);
});

test('типичный рукописный таб (одна цифра на колонку)', () => {
  const text = [
    'e|--------------|',
    'B|--------------|',
    'G|----------12--|',
    'D|5-7-9-10------|',
    'A|--------------|',
    'E|--------------|',
  ].join('\n');
  const events = parseTab(text);
  assert.deepEqual(events.map((e) => e.midi), [55, 57, 59, 60, 67]);
});

test('аккорд в одной колонке сортируется по высоте', () => {
  const text = [
    'e|0-|',
    'B|1-|',
    'G|0-|',
    'D|2-|',
    'A|3-|',
    'E|-|',
  ].join('\n');
  const events = parseTab(text);
  assert.deepEqual(events.map((e) => e.midi), [45 + 3, 50 + 2, 55, 59 + 1, 64]);
});

test('разбор работает для drop D и half-step-down', () => {
  const dropD = tabText([[{ string: 6, fret: 0 }]], 'drop-d');
  assert.equal(parseTab(dropD, 'drop-d')[0].midi, 38);
  const low = tabText([[{ string: 1, fret: 0 }]], 'half-step-down');
  assert.equal(parseTab(low, 'half-step-down')[0].midi, 63);
  assert.equal(low.split('\n').length, 6);
  assert.deepEqual(TUNINGS['drop-d'].midi.slice(4), [45, 38]);
});

test('ошибки таба', () => {
  assert.throws(() => parseTab('e|0-|\nB|1-|'), /ровно 6 строк/);
  assert.throws(
    () => parseTab(['e|17-|', 'B|-|', 'G|-|', 'D|-|', 'A|-|', 'E|-|'].join('\n')),
    new RegExp(`0\\.\\.${MAX_FRET}`)
  );
  assert.throws(
    () => parseTab(['e|-|', 'B|-|', 'G|-|', 'D|-|', 'A|-|', 'E|-|'].join('\n')),
    /не найдено ни одной ноты/
  );
});

test('generateTab проверяет лад и струну', () => {
  assert.throws(() => generateTab([[{ string: 1, fret: 16 }]]), /вне диапазона/);
  assert.throws(() => generateTab([[{ string: 7, fret: 1 }]]), /Струна/);
});
