// Ноты → табулатура: beam search по кандидатам (струна, лад) с разными
// функциями стоимости + дедупликация вариантов по тексту таба.

import { getTuning } from './tuning.js';
import { parseNotes, midiToName } from './notes.js';
import { tabText, MAX_FRET } from './tab.js';

const BEAM_WIDTH = 8;
const FIXED_WINDOWS = [
  [1, 5],
  [3, 7],
  [5, 9],
  [7, 12],
];

export const PROFILES = {
  compact: {
    id: 'compact',
    title: 'Компактная позиция',
    openCost: 0,
    shiftPenalty: 1.0,
    shiftDistance: 0.5,
    lowFret: 0.02,
    stringWeight: 0.04,
    openStringCount: false,
  },
  open: {
    id: 'open',
    title: 'Открытые струны',
    openCost: -2.5,
    shiftPenalty: 0.8,
    shiftDistance: 0.4,
    lowFret: 0.12,
    stringWeight: 0.15,
    openStringCount: true,
  },
  upper: {
    id: 'upper',
    title: 'Мелодия на верхних струнах',
    openCost: -0.3,
    shiftPenalty: 0.7,
    shiftDistance: 0.35,
    lowFret: 0.03,
    stringWeight: 0.9,
    openStringCount: false,
  },
  lower: {
    id: 'lower',
    title: 'Нижние струны (густой тембр)',
    openCost: -0.2,
    shiftPenalty: 0.9,
    shiftDistance: 0.45,
    lowFret: 0.04,
    stringWeight: -0.45,
    openStringCount: false,
  },
};

function candidatesFor(midi, tuning, maxFret) {
  const result = [];
  for (let s = 0; s < 6; s += 1) {
    const fret = midi - tuning.midi[s];
    if (fret >= 0 && fret <= maxFret) result.push({ string: s + 1, fret });
  }
  return result;
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function initial() {
  return { lo: 0, hi: 0, anchor: 0, openCount: 0, shifts: 0, cost: 0, picks: [] };
}

function advance(state, cand, profile, stretch) {
  const { fret, string } = cand;
  let lo = state.lo;
  let hi = state.hi;
  let anchor = state.anchor;
  let shifts = state.shifts;
  let openCount = state.openCount;
  let cost = state.cost;

  cost += profile.stringWeight * (string - 1);

  if (fret === 0) {
    openCount += 1;
    cost += profile.openCost;
  } else {
    let nlo = hi === 0 ? fret : Math.min(lo, fret);
    let nhi = hi === 0 ? fret : Math.max(hi, fret);
    if (nhi - nlo > stretch - 1) {
      // Рука переезжает: окно сбрасывается на новую позицию.
      const prev = anchor || fret;
      cost += profile.shiftPenalty + Math.abs(fret - prev) * profile.shiftDistance;
      shifts += 1;
      nlo = fret;
      nhi = fret;
    }
    lo = nlo;
    hi = nhi;
    anchor = fret;
    cost += profile.lowFret * fret;
  }

  return {
    lo,
    hi,
    anchor,
    shifts,
    openCount,
    cost,
    picks: state.picks.concat([cand]),
  };
}

function beamSearch(candidateSets, profile, stretch, window) {
  let beam = [initial()];
  for (const set of candidateSets) {
    const allowed = window
      ? set.filter((c) => c.fret === 0 || (c.fret >= window[0] && c.fret <= window[1]))
      : set;
    if (allowed.length === 0) return null;

    const next = [];
    for (const state of beam) {
      for (const cand of allowed) {
        next.push(advance(state, cand, profile, stretch));
      }
    }
    next.sort((a, b) => a.cost - b.cost);

    const seen = new Set();
    const pruned = [];
    for (const state of next) {
      const key = `${state.lo}:${state.hi}:${state.anchor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pruned.push(state);
      if (pruned.length >= BEAM_WIDTH) break;
    }
    beam = pruned;
  }
  return beam[0];
}

function frettedRange(picks) {
  const frets = picks.filter((p) => p.fret > 0).map((p) => p.fret);
  if (frets.length === 0) return [0, 0];
  return [Math.min(...frets), Math.max(...frets)];
}

function describe(state, profile, window) {
  const [lo, hi] = window || frettedRange(state.picks);
  const openPhrase = `открытых струн: ${state.openCount}`;
  if (profile.openStringCount) {
    return lo === hi ? `${openPhrase}, лад ${lo}` : `${openPhrase}, позиция ${lo}–${hi}`;
  }
  const shiftPhrase = `${state.shifts} ${plural(state.shifts, 'переход', 'перехода', 'переходов')}`;
  if (lo === 0 && hi === 0) return `${openPhrase}, ${shiftPhrase}`;
  return lo === hi
    ? `позиция ${lo}, ${shiftPhrase}`
    : `позиция ${lo}–${hi}, ${shiftPhrase}`;
}

function makeVariant(id, title, state, notes, tuningId, window) {
  return variantFromPicks(
    id,
    title,
    state.picks,
    notes,
    tuningId,
    describe(state, PROFILES[id] || PROFILES.compact, window)
  );
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function variantFromPicks(id, title, picks, notes, tuningId, description) {
  const columns = picks.map((p) => [{ string: p.string, fret: p.fret }]);
  return {
    id,
    title,
    description,
    tab: tabText(columns, tuningId),
    positions: picks.map((p, i) => ({
      midi: notes[i].midi,
      name: midiToName(notes[i].midi),
      russian: notes[i].russian,
      string: p.string,
      fret: p.fret,
    })),
  };
}

/**
 * Основная функция: ноты (строка или массив) → 3–6 вариантов аппликатуры.
 * @param {string|Array} input
 * @param {{tuning?: string, maxFret?: number, stretch?: number}} options
 */
export function notesToTabs(input, options = {}) {
  const tuningId = options.tuning || 'standard';
  const tuning = getTuning(tuningId);
  const maxFret = clampInt(options.maxFret, 5, MAX_FRET, 12);
  const stretch = clampInt(options.stretch, 3, 5, 4);

  const notes = typeof input === 'string'
    ? parseNotes(input)
    : (input || []).map((n) => (typeof n === 'number' ? { midi: n } : n));
  if (notes.length === 0) throw new Error('Введите ноты, например: E4 E4 F4 G4');

  const candidateSets = notes.map((note) => {
    const set = candidatesFor(note.midi, tuning, maxFret);
    if (set.length === 0) {
      throw new Error(
        `Нота ${midiToName(note.midi)} не играется на этом строе в пределах ${maxFret}-го лада. Увеличьте максимальный лад.`
      );
    }
    return set;
  });

  const variants = [];
  const seenTabs = new Set();

  const push = (variant) => {
    if (!variant || seenTabs.has(variant.tab)) return false;
    seenTabs.add(variant.tab);
    variants.push(variant);
    return true;
  };

  const compact = beamSearch(candidateSets, PROFILES.compact, stretch, null);
  if (compact) push(makeVariant('compact', PROFILES.compact.title, compact, notes, tuningId, null));

  const open = beamSearch(candidateSets, PROFILES.open, stretch, null);
  if (open) push(makeVariant('open', PROFILES.open.title, open, notes, tuningId, null));

  // Фиксированные позиции: перебираем окна, берём два лучших по стоимости.
  const fixedResults = [];
  for (const [rawLo, rawHi] of FIXED_WINDOWS) {
    const lo = Math.min(rawLo, maxFret);
    const hi = Math.min(rawHi, maxFret);
    if (hi - lo < 1) continue;
    const state = beamSearch(candidateSets, PROFILES.compact, stretch, [lo, hi]);
    if (state) fixedResults.push({ window: [lo, hi], state });
  }
  fixedResults.sort((a, b) => a.state.cost - b.state.cost);
  const fixedPushed = new Set();
  const fixedVariant = ({ window, state }) =>
    makeVariant('fixed', `Фиксированная позиция ${window[0]}–${window[1]}`, state, notes, tuningId, window);

  // Берём два лучших окна, но не считаем «лучшим» окно, давшее тот же таб.
  for (const result of fixedResults) {
    if (fixedPushed.size >= 2) break;
    if (push(fixedVariant(result))) fixedPushed.add(result.window.join('-'));
  }

  const upper = beamSearch(candidateSets, PROFILES.upper, stretch, null);
  if (upper) push(makeVariant('upper', PROFILES.upper.title, upper, notes, tuningId, null));

  const lower = beamSearch(candidateSets, PROFILES.lower, stretch, null);
  if (lower) push(makeVariant('lower', PROFILES.lower.title, lower, notes, tuningId, null));

  // Если после дедупликации вариантов мало — добираем оставшиеся окна.
  for (const result of fixedResults) {
    if (variants.length >= 6) break;
    if (fixedPushed.has(result.window.join('-'))) continue;
    if (push(fixedVariant(result))) fixedPushed.add(result.window.join('-'));
  }

  // Последний резерв: показываем другую струну для одной ноты — так находятся
  // варианты для коротких мелодий, где позиции почти не отличаются.
  if (variants.length < 3) {
    for (let i = 0; i < notes.length && variants.length < 6; i += 1) {
      for (const cand of candidateSets[i]) {
        if (variants.length >= 6) break;
        const current = variants[0].positions[i];
        if (cand.string === current.string && cand.fret === current.fret) continue;
        const picks = variants[0].positions.map((p) => ({ string: p.string, fret: p.fret }));
        picks[i] = cand;
        push(
          variantFromPicks(
            'alt',
            'Альтернативная аппликатура',
            picks,
            notes,
            tuningId,
            `${notes[i].name} на ${cand.string}-й струне (${cand.fret}-й лад)`
          )
        );
        if (variants.length >= 3) break;
      }
    }
  }

  if (variants.length < 3) {
    throw new Error(
      'Не удалось построить три разных варианта: слишком мало нот. Добавьте ноты (например, целую фразу).'
    );
  }
  return variants.slice(0, 6);
}

/** Ноты → один вариант (первый), удобно для быстрых сценариев. */
export function notesToTab(input, options = {}) {
  return notesToTabs(input, options)[0];
}
