// Модель списка нот для редактора: правка, вставка, удаление, шаги для прослушивания.
// Всё чистыми функциями — так редактор в браузере и тесты используют один код.

import { midiToName, MIDI_MIN, MIDI_MAX } from './notes.js';

/** Нормализованная нота: midi + подпись + исходные поля MusicXML (если были). */
export function makeNote(midi, extra = {}) {
  return {
    midi,
    name: midiToName(midi),
    duration: extra.duration ?? 1,
    type: extra.type ?? 'quarter',
    staff: extra.staff ?? 1,
    voice: extra.voice ?? '1',
    onset: extra.onset ?? 0,
    ...(extra.string !== undefined && extra.string !== null ? { string: extra.string } : {}),
    ...(extra.fret !== undefined && extra.fret !== null ? { fret: extra.fret } : {}),
    ...(extra.page !== undefined ? { page: extra.page } : {}),
  };
}

/** Пересчитать подписи и сквозные onset, сохранив группировку аккордов. */
export function renumber(notes) {
  let onset = -1;
  let previous = null;
  return (notes || []).map((note) => {
    const sameGroup = previous !== null && note.onset === previous.onset;
    if (!sameGroup) onset += 1;
    previous = note;
    return { ...note, onset, name: midiToName(note.midi) };
  });
}

/** Полутоновый сдвиг одной ноты. Выход за диапазон гитары — ошибка (её ловит UI). */
export function transposeNote(notes, index, semitones) {
  const list = [...(notes || [])];
  const note = list[index];
  if (!note) throw new Error(`Нет ноты №${index + 1}.`);
  const midi = note.midi + semitones;
  if (midi < MIDI_MIN || midi > MIDI_MAX) {
    throw new Error(`Нота ${midiToName(midi)} вне диапазона гитары (${midiToName(MIDI_MIN)}..${midiToName(MIDI_MAX)}).`);
  }
  list[index] = { ...note, midi, name: midiToName(midi) };
  return list;
}

export function removeNote(notes, index) {
  const list = [...(notes || [])];
  if (index < 0 || index >= list.length) throw new Error(`Нет ноты №${index + 1}.`);
  list.splice(index, 1);
  return renumber(list);
}

/** Вставить ноту после index (−1 — в начало). Новая нота — свой момент времени. */
export function insertNote(notes, index, midi) {
  const list = [...(notes || [])];
  const at = Math.min(Math.max(index + 1, 0), list.length);
  const previous = at > 0 ? list[at - 1] : null;
  const next = list[at];
  const onset = previous
    ? (next && next.onset > previous.onset ? (previous.onset + next.onset) / 2 : previous.onset + 0.5)
    : (next ? next.onset - 0.5 : 0);
  list.splice(at, 0, makeNote(midi, { onset }));
  return renumber(list);
}

/** Сдвинуть ноту на октаву (для правки грубых ошибок OMR). */
export function octaveNote(notes, index, direction) {
  return transposeNote(notes, index, direction > 0 ? 12 : -12);
}

/** Shag для прослушивания: массив аккордов [[midi, ...], ...]. */
export function toSteps(notes) {
  const steps = [];
  let current = null;
  for (const note of notes || []) {
    if (current === null || note.onset !== current.onset) {
      current = { onset: note.onset, midis: [] };
      steps.push(current);
    }
    current.midis.push(note.midi);
  }
  return steps.map((step) => step.midis);
}

/** Статистика для предупреждений в интерфейсе. */
export function stats(notes) {
  const list = notes || [];
  const outOfRange = [];
  list.forEach((note, index) => {
    if (note.midi < MIDI_MIN || note.midi > MIDI_MAX) outOfRange.push(index);
  });
  const midis = list.map((note) => note.midi);
  return {
    count: list.length,
    chords: toSteps(list).filter((step) => step.length > 1).length,
    outOfRange,
    low: midis.length ? Math.min(...midis) : null,
    high: midis.length ? Math.max(...midis) : null,
  };
}
