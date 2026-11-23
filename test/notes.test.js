import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNotes, midiToName, midiToRussian, MIDI_MIN, MIDI_MAX } from '../src/notes.js';

test('латинские ноты с октавами', () => {
  assert.deepEqual(parseNotes('E4 E4 F4 G4').map((n) => n.midi), [64, 64, 65, 67]);
  assert.deepEqual(parseNotes('C#4 Db4').map((n) => n.midi), [61, 61]);
  assert.deepEqual(parseNotes('E2').map((n) => n.midi), [40]);
});

test('слитная запись E4E4F4 разбирается', () => {
  assert.deepEqual(parseNotes('E4E4F4').map((n) => n.midi), [64, 64, 65]);
});

test('русские названия и -диез', () => {
  assert.deepEqual(parseNotes('ми4 фа4 соль4').map((n) => n.midi), [64, 65, 67]);
  assert.deepEqual(parseNotes('до-диез4').map((n) => n.midi), [61]);
  assert.deepEqual(parseNotes('до диез4').map((n) => n.midi), [61]);
  assert.deepEqual(parseNotes('ля-диез3').map((n) => n.midi), [58]);
});

test('нота без октавы считается четвёртой октавой', () => {
  assert.deepEqual(parseNotes('E').map((n) => n.midi), [64]);
});

test('запись нот в ответе', () => {
  assert.equal(midiToName(61), 'C#4');
  assert.equal(midiToRussian(61), 'до-диез первой октавы');
  assert.equal(midiToRussian(40), 'ми большой октавы');
});

test('ошибки: нота вне диапазона и неизвестная нота', () => {
  assert.throws(() => parseNotes('E7'), /вне диапазона гитары/);
  assert.throws(() => parseNotes('C1'), /вне диапазона гитары/);
  assert.throws(() => parseNotes('X4'), /Неизвестная нота/);
  assert.throws(() => parseNotes('   '), /хотя бы одну ноту/);
  assert.ok(MIDI_MIN === 38 && MIDI_MAX === 86);
});
