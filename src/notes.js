// Разбор и запись нот: латинские и русские названия, диезы, бемоли, октавы.

export const MIDI_MIN = 38; // D2 — нижняя граница гитары
export const MIDI_MAX = 86; // D6 — верхняя граница

const LATIN = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const RUS = { 'до': 0, 'ре': 2, 'ми': 4, 'фа': 5, 'соль': 7, 'ля': 9, 'си': 11 };

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const RU_NAMES = [
  'до', 'до-диез', 'ре', 'ре-диез', 'ми', 'фа',
  'фа-диез', 'соль', 'соль-диез', 'ля', 'ля-диез', 'си',
];

const OCTAVE_RU = {
  0: 'субконтроктавы',
  1: 'контроктавы',
  2: 'большой октавы',
  3: 'малой октавы',
  4: 'первой октавы',
  5: 'второй октавы',
  6: 'третьей октавы',
  7: 'четвёртой октавы',
};

// Русские названия — длиннее латинских, поэтому в альтернативе идут первыми.
const NOTE_AT = /(соль|до|ре|ми|фа|ля|си|[a-g])(?:(-?диез|#|♯)|(-?бемоль|b|♭))?(-?\d)?/y;

export function midiToName(midi) {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function midiToRussian(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${RU_NAMES[pc]} ${OCTAVE_RU[oct] || `${oct}-й октавы`}`;
}

/** Разбирает строку нот («E4 F4», «ми4 фа4», «E4E4F4») в массив {midi, name}. */
export function parseNotes(text) {
  if (typeof text !== 'string') throw new Error('Ноты должны быть строкой.');
  const src = text
    .toLowerCase()
    .replace(/[♯]/g, '#')
    .replace(/[♭]/g, 'b')
    .replace(/[–—−]/g, '-');

  // «до диез4» и «ми бемоль3» пишут через пробел — склеиваем перед разбором.
  const glued = src.replace(/\s+(диез|бемоль)/g, '$1');
  const tokens = glued.split(/[\s,;|/]+/).filter((t) => t !== '');
  if (tokens.length === 0) throw new Error('Введите хотя бы одну ноту, например: E4 F4 G4');

  const result = [];
  for (const token of tokens) {
    let index = 0;
    while (index < token.length) {
      NOTE_AT.lastIndex = index;
      const m = NOTE_AT.exec(token);
      if (!m || m.index !== index) {
        throw new Error(
          `Неизвестная нота «${token.slice(index)}». Пример: E4, C#4, ми4, соль-диез4.`
        );
      }
      const base = m[1] in LATIN ? LATIN[m[1]] : RUS[m[1]];
      const accidental = m[2] ? 1 : m[3] ? -1 : 0;
      const octave = m[4] === undefined ? 4 : parseInt(m[4], 10);
      const midi = (octave + 1) * 12 + base + accidental;
      if (!(midi >= MIDI_MIN && midi <= MIDI_MAX)) {
        throw new Error(
          `Нота ${midiToName(midi)} (MIDI ${midi}) вне диапазона гитары (MIDI ${MIDI_MIN}..${MIDI_MAX}).`
        );
      }
      result.push({ midi, name: midiToName(midi), russian: midiToRussian(midi) });
      index = NOTE_AT.lastIndex;
    }
  }
  return result;
}

/** Короткая запись массива MIDI. */
export function describeNotes(midis) {
  return midis.map((m) => midiToName(m)).join(' ');
}
