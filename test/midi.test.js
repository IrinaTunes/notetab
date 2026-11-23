import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMidi, inspectMidi, PPQ } from '../src/midi.js';

test('MIDI: корректный заголовок MThd, длина 6, один трек', () => {
  const bytes = buildMidi([64, 65, 67, 69]);
  const info = inspectMidi(bytes);
  assert.equal(info.magic, 'MThd');
  assert.equal(info.headerLength, 6);
  assert.equal(info.format, 0);
  assert.equal(info.tracks, 1);
  assert.equal(info.division, PPQ);
  assert.equal(info.division, 96);
  assert.equal(info.trackMagic, 'MTrk');
});

test('MIDI: длина трека и общий размер согласованы', () => {
  for (const steps of [[60], [64, 65, 67], Array.from({ length: 32 }, (_, i) => 60 + i)]) {
    const bytes = buildMidi(steps);
    const info = inspectMidi(bytes);
    assert.equal(info.totalLength, 14 + 8 + info.trackLength);
    assert.equal(info.totalLength, bytes.length);
  }
});

test('MIDI: аккорды и tempo-мета', () => {
  const bytes = buildMidi([[60, 64, 67], [62, 65, 69]]);
  const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  assert.ok(text.includes('\u00ffQ\u0003'), 'нет мета-события темпа');
  assert.ok(bytes.length > 22);
  assert.equal(inspectMidi(bytes).tracks, 1);
});

test('MIDI: ошибки на некорректных данных', () => {
  assert.throws(() => buildMidi([]), /Нет нот/);
  assert.throws(() => buildMidi([200]), /Некорректная MIDI-нота/);
});
