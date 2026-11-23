// Строи гитары. Массив midi: индекс 0 — 1-я (тонкая) струна, индекс 5 — 6-я (толстая).

export const TUNINGS = {
  standard: {
    id: 'standard',
    label: 'Стандартный (E A D G B E)',
    midi: [64, 59, 55, 50, 45, 40],
    labels: ['e', 'B', 'G', 'D', 'A', 'E'],
  },
  'drop-d': {
    id: 'drop-d',
    label: 'Drop D (D A D G B E)',
    midi: [64, 59, 55, 50, 45, 38],
    labels: ['e', 'B', 'G', 'D', 'A', 'D'],
  },
  'half-step-down': {
    id: 'half-step-down',
    label: 'На полтона ниже (Eb Ab Db Gb Bb Eb)',
    midi: [63, 58, 54, 49, 44, 39],
    labels: ['d#', 'G#', 'C#', 'F#', 'A#', 'D#'],
  },
};

export const DEFAULT_TUNING = 'standard';

export function getTuning(id) {
  const t = TUNINGS[id];
  if (!t) {
    throw new Error(
      `Неизвестный строй «${id}». Доступны: ${Object.keys(TUNINGS).join(', ')}.`
    );
  }
  return t;
}

/** MIDI открытой струны (string: 1..6). */
export function openMidi(tuning, string) {
  return tuning.midi[string - 1];
}
