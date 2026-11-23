// Интерфейс: два режима, прослушивание и скачивание файлов через Blob.

import { parseNotes, midiToName, midiToRussian } from '../src/notes.js';
import { parseTab, MAX_FRET } from '../src/tab.js';
import { notesToTabs } from '../src/solver.js';
import { buildMidi } from '../src/midi.js';
import { TUNINGS } from '../src/tuning.js';

const EXAMPLE_TAB = `e|----------------|
B|-------------0--|
G|-----0--2--0----|
D|--2-------------|
A|----------------|
E|----------------|`;

const EXAMPLE_NOTES = 'E4 E4 F4 G4 G4 F4 E4 D4';

const $ = (id) => document.getElementById(id);

/* ---------- скачивание ---------- */

function saveBlob(filename, parts, type) {
  const blob = new Blob(parts, { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function saveText(filename, text, type = 'text/plain;charset=utf-8') {
  saveBlob(filename, [text], type);
}

function saveMidi(filename, steps) {
  const bytes = buildMidi(steps);
  saveBlob(filename, [bytes], 'audio/midi');
}

/* ---------- звук ---------- */

let audioCtx = null;
let playingTimer = null;

function ctx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(midi, start, duration) {
  const ac = audioCtx;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const freq = 440 * 2 ** ((midi - 69) / 12);
  osc.type = 'sine';
  osc.frequency.value = freq;
  const peak = 0.22;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(peak * 0.55, start + duration * 0.5);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

/** steps — массив шагов, каждый шаг массив MIDI-нот. */
function playSteps(steps, button) {
  const ac = ctx();
  if (!ac) return;
  if (playingTimer) clearTimeout(playingTimer);
  const stepDur = 0.42;
  const start = ac.currentTime + 0.05;
  steps.forEach((chord, i) => {
    for (const midi of chord) tone(midi, start + i * stepDur, stepDur * 0.95);
  });
  if (button) {
    button.classList.add('playing');
    playingTimer = setTimeout(() => button.classList.remove('playing'), steps.length * stepDur * 1000 + 120);
  }
}

/* ---------- вкладки ---------- */

function activateTab(mode) {
  const isTab = mode === 'tab2notes';
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
  }
  $('panel-tab2notes').hidden = !isTab;
  $('panel-notes2tab').hidden = isTab;
}

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => activateTab(btn.dataset.mode));
}

/* ---------- ошибки ---------- */

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function clearError(id) {
  const el = $(id);
  el.textContent = '';
  el.hidden = true;
}

/* ---------- режим «Таб → ноты» ---------- */

let tabState = null;

function runTabToNotes() {
  clearError('tab-error');
  $('tab-result').hidden = true;
  try {
    const tuning = $('tuning-tab').value;
    const events = parseTab($('tab-input').value, tuning);

    // группируем по колонкам — так аккорды звучат вместе
    const columns = new Map();
    for (const e of events) {
      if (!columns.has(e.column)) columns.set(e.column, []);
      columns.get(e.column).push(e);
    }
    const steps = [...columns.values()].map((col) => col.map((e) => e.midi));

    tabState = { events, steps, tuning };
    renderTabTable(events);
    $('tab-result').hidden = false;
  } catch (err) {
    showError('tab-error', err.message);
  }
}

function octaveOf(midi) {
  return Math.floor(midi / 12) - 1;
}

function renderTabTable(events) {
  const tbody = $('tab-table').querySelector('tbody');
  tbody.textContent = '';
  events.forEach((e, i) => {
    const tr = document.createElement('tr');
    const cells = [
      [String(i + 1), 'num'],
      [midiToName(e.midi), 'name'],
      [String(octaveOf(e.midi)), 'num'],
      [String(e.midi), 'midi'],
      [String(e.string), 'num'],
      [String(e.fret), 'num'],
      [midiToRussian(e.midi), 'ru'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      td.className = cls;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  const notes = events.map((e) => midiToName(e.midi)).join(' ');
  $('tab-count').textContent = `— ${events.length} шт.`;
  $('tab-notes-line').textContent = notes;
}

function downloadTabNotes(kind) {
  if (!tabState) return;
  const { events, steps } = tabState;
  if (kind === 'mid') {
    saveMidi('melody.mid', steps);
    return;
  }
  if (kind === 'txt') {
    const text = events
      .map((e) => `${midiToName(e.midi)}\t${midiToRussian(e.midi)}\tструна ${e.string}, лад ${e.fret}`)
      .join('\n');
    saveText('melody.txt', `${text}\n`);
    return;
  }
  const rows = [['нота', 'октава', 'midi', 'струна', 'лад', 'название']];
  for (const e of events) {
    rows.push([midiToName(e.midi), octaveOf(e.midi), e.midi, e.string, e.fret, midiToRussian(e.midi)]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  saveText('melody.csv', `${csv}\r\n`, 'text/csv;charset=utf-8');
}

$('btn-tab-run').addEventListener('click', runTabToNotes);
$('btn-tab-example').addEventListener('click', () => {
  $('tab-input').value = EXAMPLE_TAB;
  runTabToNotes();
});
$('btn-tab-play').addEventListener('click', (e) => {
  if (tabState) playSteps(tabState.steps, e.currentTarget);
});
$('btn-tab-txt').addEventListener('click', () => downloadTabNotes('txt'));
$('btn-tab-csv').addEventListener('click', () => downloadTabNotes('csv'));
$('btn-tab-mid').addEventListener('click', () => downloadTabNotes('mid'));

/* ---------- режим «Ноты → таб» ---------- */

let variantsState = [];

function runNotesToTabs() {
  clearError('notes-error');
  $('variants').textContent = '';
  try {
    const tuning = $('tuning-notes').value;
    const maxFret = Number($('max-fret').value);
    const stretch = Number($('stretch').value);
    const notes = parseNotes($('notes-input').value);
    const variants = notesToTabs(notes, { tuning, maxFret, stretch });
    variantsState = variants;

    const wrap = document.createElement('div');
    wrap.className = 'cards';
    variants.forEach((variant, index) => wrap.appendChild(renderCard(variant, index, tuning)));
    $('variants').appendChild(wrap);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = `Найдено вариантов: ${variants.length}. Все аппликатуры равноправны — выберите ту, что удобнее руке.`;
    $('variants').prepend(hint);
  } catch (err) {
    showError('notes-error', err.message);
  }
}

function renderCard(variant, index, tuning) {
  const card = document.createElement('article');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const h3 = document.createElement('h3');
  h3.textContent = variant.title;
  const desc = document.createElement('p');
  desc.className = 'desc';
  desc.textContent = variant.description;
  head.append(h3, desc);

  const pre = document.createElement('pre');
  pre.textContent = variant.tab;

  const actions = document.createElement('div');
  actions.className = 'actions';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.textContent = '▶ Прослушать';
  playBtn.addEventListener('click', () => {
    playSteps(variant.positions.map((p) => [p.midi]), playBtn);
  });

  const txtBtn = document.createElement('button');
  txtBtn.type = 'button';
  txtBtn.textContent = '⬇ .txt';
  txtBtn.addEventListener('click', () => {
    const text = [
      `${variant.title} — ${variant.description}`,
      `Строй: ${TUNINGS[tuning].label}`,
      '',
      variant.tab,
      '',
      'Ноты по порядку:',
      ...variant.positions.map(
        (p) => `${p.name}\t${midiToRussian(p.midi)}\tструна ${p.string}, лад ${p.fret}`
      ),
    ].join('\n');
    saveText(`variant-${index + 1}.txt`, `${text}\n`);
  });

  const midBtn = document.createElement('button');
  midBtn.type = 'button';
  midBtn.textContent = '⬇ .mid';
  midBtn.addEventListener('click', () => {
    saveMidi(`variant-${index + 1}.mid`, variant.positions.map((p) => [p.midi]));
  });

  const jsonBtn = document.createElement('button');
  jsonBtn.type = 'button';
  jsonBtn.textContent = '⬇ .json';
  jsonBtn.addEventListener('click', () => {
    const payload = {
      title: variant.title,
      description: variant.description,
      tuning: { id: tuning, label: TUNINGS[tuning].label, midi: TUNINGS[tuning].midi },
      tab: variant.tab,
      notes: variant.positions.map((p) => ({
        name: p.name,
        russian: midiToRussian(p.midi),
        midi: p.midi,
        string: p.string,
        fret: p.fret,
      })),
    };
    saveText(`variant-${index + 1}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
  });

  actions.append(playBtn, txtBtn, midBtn, jsonBtn);
  card.append(head, pre, actions);
  return card;
}

$('btn-notes-run').addEventListener('click', runNotesToTabs);
$('btn-notes-example').addEventListener('click', () => {
  $('notes-input').value = EXAMPLE_NOTES;
  runNotesToTabs();
});

/* ---------- стартовое состояние ---------- */

$('tab-input').value = EXAMPLE_TAB;
$('notes-input').value = EXAMPLE_NOTES;
$('max-fret').value = '12';
$('stretch').value = '4';
// подсказка про диапазон ладов, чтобы ограничение не было сюрпризом
$('tab-input').setAttribute('data-max-fret', String(MAX_FRET));
$('tab-input').title = `Лады 0..${MAX_FRET}, только гитара (MIDI 38..86)`;
activateTab('tab2notes');
