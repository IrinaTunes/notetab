// Генерация и разбор ASCII-табулатуры.

import { getTuning } from './tuning.js';
import { MIDI_MIN, MIDI_MAX, midiToName } from './notes.js';

export const MAX_FRET = 15;
export const STRINGS = 6;

/**
 * Строит таб. columns — массив колонок, каждая колонка — массив {string, fret}.
 * В каждой колонке цифры пишутся на своей струне, остальное — дефисы.
 * После каждого лада ВСЕГДА ставится дефис-разделитель, иначе «1» и «3»
 * склеятся в «13», а «10» и «12» — в «1012».
 */
export function generateTab(columns, tuningId = 'standard') {
  const tuning = getTuning(tuningId);
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('Нет нот для построения табулатуры.');
  }

  let width = 1;
  for (const column of columns) {
    for (const note of column) {
      const fret = Number(note.fret);
      if (!Number.isInteger(fret) || fret < 0 || fret > MAX_FRET) {
        throw new Error(`Лад ${note.fret} вне диапазона 0..${MAX_FRET}.`);
      }
      if (!Number.isInteger(note.string) || note.string < 1 || note.string > STRINGS) {
        throw new Error(`Струна ${note.string} вне диапазона 1..${STRINGS}.`);
      }
      width = Math.max(width, String(fret).length);
    }
  }

  const cellWidth = width + 1; // цифры + обязательный дефис
  const rows = Array.from({ length: STRINGS }, () => '');
  for (const column of columns) {
    const cells = Array.from({ length: STRINGS }, () => '-'.repeat(cellWidth));
    for (const note of column) {
      const digits = String(note.fret);
      cells[note.string - 1] = digits + '-'.repeat(cellWidth - digits.length);
    }
    for (let s = 0; s < STRINGS; s += 1) rows[s] += cells[s];
  }

  const lines = rows.map((row, i) => `${tuning.labels[i]}|${row}|`);
  return { tab: lines.join('\n'), width: cellWidth };
}

/** То же, но отдаёт только текст — удобно для тестов и UI. */
export function tabText(columns, tuningId = 'standard') {
  return generateTab(columns, tuningId).tab;
}

function cleanLine(line) {
  let body = line;
  const firstBar = body.indexOf('|');
  if (firstBar >= 0) body = body.slice(firstBar + 1);
  const lastBar = body.lastIndexOf('|');
  if (lastBar >= 0) body = body.slice(0, lastBar);
  return body.replace(/[^0-9-]/g, '-').trim();
}

/**
 * Разбирает ASCII-таб в события: [{midi, string, fret, column}].
 * Ноты одной колонки (аккорд) сортируются по высоте.
 */
export function parseTab(text, tuningId = 'standard') {
  const tuning = getTuning(tuningId);
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Вставьте табулатуру: 6 строк с подписями e B G D A E.');
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== STRINGS) {
    throw new Error(
      `Табулатура должна содержать ровно ${STRINGS} строк (по числу струн), получено ${lines.length}.`
    );
  }

  const bodies = lines.map(cleanLine);
  const maxLen = Math.max(...bodies.map((b) => b.length));
  const padded = bodies.map((b) => b.padEnd(maxLen, '-'));

  const byColumn = new Map();
  for (let string = 1; string <= STRINGS; string += 1) {
    const row = padded[string - 1];
    let i = 0;
    while (i < row.length) {
      if (row[i] >= '0' && row[i] <= '9') {
        let j = i;
        while (j < row.length && row[j] >= '0' && row[j] <= '9') j += 1;
        const fret = parseInt(row.slice(i, j), 10);
        if (fret > MAX_FRET) {
          throw new Error(
            `Лад ${fret} на струне ${string} вне допустимого диапазона 0..${MAX_FRET}.`
          );
        }
        const midi = tuning.midi[string - 1] + fret;
        if (midi < MIDI_MIN || midi > MIDI_MAX) {
          throw new Error(
            `Нота ${midiToName(midi)} (струна ${string}, лад ${fret}) вне диапазона гитары.`
          );
        }
        if (!byColumn.has(i)) byColumn.set(i, []);
        byColumn.get(i).push({ midi, string, fret, column: i });
        i = j;
      } else {
        i += 1;
      }
    }
  }

  const events = [];
  for (const column of [...byColumn.keys()].sort((a, b) => a - b)) {
    const notes = byColumn.get(column).sort((a, b) => a.midi - b.midi);
    events.push(...notes);
  }
  if (events.length === 0) {
    throw new Error('В табулатуре не найдено ни одной ноты.');
  }
  return events;
}
