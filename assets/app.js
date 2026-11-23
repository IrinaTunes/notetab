// Интерфейс: два режима, прослушивание и скачивание файлов через Blob.

import { parseNotes, midiToName, midiToRussian } from '../src/notes.js';
import { parseTab, MAX_FRET } from '../src/tab.js';
import { notesToTabs } from '../src/solver.js';
import { buildMidi } from '../src/midi.js';
import { TUNINGS } from '../src/tuning.js';
import { buildMusicXML } from '../src/musicxml.js';
import { buildPrintHTML } from '../src/printable.js';
import { parseMusicXml, flattenPages } from '../src/musicxml-import.js';
import { extractMusicXml } from '../src/mxl.js';
import {
  transposeNote, removeNote, insertNote, octaveNote, toSteps, stats, renumber,
} from '../src/notelist.js';

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

const PANELS = {
  tab2notes: 'panel-tab2notes',
  notes2tab: 'panel-notes2tab',
  pdf2tab: 'panel-pdf2tab',
  pdfnotes: 'panel-pdfnotes',
};

function activateTab(mode) {
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
  }
  for (const [key, id] of Object.entries(PANELS)) {
    const panel = $(id);
    if (panel) panel.hidden = key !== mode;
  }
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

  const xmlBtn = document.createElement('button');
  xmlBtn.type = 'button';
  xmlBtn.textContent = '⬇ .musicxml';
  xmlBtn.addEventListener('click', () => {
    const xml = buildMusicXML(
      variant.positions.map((p) => ({ midi: p.midi, string: p.string, fret: p.fret })),
      { title: `${variant.title} — notetab`, tuning }
    );
    saveText(`variant-${index + 1}.musicxml`, xml, 'application/vnd.recordare.musicxml+xml');
  });

  const pdfBtn = document.createElement('button');
  pdfBtn.type = 'button';
  pdfBtn.textContent = '🖨 PDF';
  pdfBtn.addEventListener('click', () => {
    printDocument(buildPrintHTML({
      title: variant.title,
      subtitle: 'notetab — вариант аппликатуры',
      tab: variant.tab,
      tuning: TUNINGS[tuning].label,
      position: variant.description,
      notes: variant.positions.map((p) => ({
        name: p.name, russian: midiToRussian(p.midi), string: p.string, fret: p.fret,
      })),
    }));
  });

  actions.append(playBtn, txtBtn, midBtn, jsonBtn, xmlBtn, pdfBtn);
  card.append(head, pre, actions);
  return card;
}

/** Открыть печатный макет в новом окне (A4, кнопка «Печать / Сохранить в PDF»). */
function printDocument(html) {
  const win = window.open('', '_blank');
  if (!win) {
    showError('ocr-error', 'Браузер заблокировал новое окно: разрешите всплывающие окна для сайта.');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}

$('btn-notes-run').addEventListener('click', runNotesToTabs);
$('btn-notes-example').addEventListener('click', () => {
  $('notes-input').value = EXAMPLE_NOTES;
  runNotesToTabs();
});

/* ---------- режим «PDF → таб» ---------- */

const SERVICE_URL = 'http://127.0.0.1:8765';
const SERVICE_TIMEOUT_MS = 2500;

let ocrState = { data: null, title: 'Табулатура из PDF', name: 'tab' };
let ocrVariants = [];

function setStatus(text) {
  const el = $('pdf-status');
  el.textContent = text;
  el.hidden = !text;
}

function setProgress(percent) {
  const box = $('pdf-progress');
  if (percent === null) {
    box.hidden = true;
    box.firstElementChild.style.width = '0%';
    return;
  }
  box.hidden = false;
  box.firstElementChild.style.width = `${Math.max(2, Math.min(100, percent))}%`;
}

async function checkService() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(`${SERVICE_URL}/health`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.ok ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function baseName(filename) {
  const clean = String(filename || 'tab').replace(/\.[^.]+$/, '');
  return clean.replace(/[^\wа-яА-ЯёЁ.-]+/g, '_').slice(0, 60) || 'tab';
}

function isPdf(file) {
  return Boolean(file) && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

/** Отправка PDF через XHR: fetch не даёт прогресс отправки. */
function uploadPdf(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SERVICE_URL}/tab/pdf`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'upload.pdf'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    xhr.addEventListener('load', () => {
      const data = xhr.response || null;
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data);
        return;
      }
      const message = (data && data.error) || `Сервис ответил кодом ${xhr.status}.`;
      reject(new Error(message));
    });
    xhr.addEventListener('error', () => reject(new Error(
      'Не удалось связаться с локальным сервисом. Проверьте, что он запущен: cd omr-service && ./run.sh'
    )));
    xhr.addEventListener('timeout', () => reject(new Error('Сервис слишком долго не отвечает (10 минут).')));
    xhr.send(file);
  });
}

async function handlePdfFile(file) {
  clearError('pdf-error');
  $('ocr-result').hidden = true;
  $('service-block').hidden = true;

  if (!isPdf(file)) {
    showError('pdf-error', 'Нужен файл PDF: перетащите .pdf или выберите его в диалоге.');
    return;
  }

  setStatus('Проверяю локальный сервис…');
  const health = await checkService();
  if (!health) {
    setStatus('');
    $('service-block').hidden = false;
    showError('pdf-error', 'Локальный сервис не отвечает на http://127.0.0.1:8765/health.');
    return;
  }

  setStatus('Распознаю страницы: рендер 300 dpi, поиск ТАБ-станов, OCR цифр…');
  setProgress(3);
  try {
    const data = await uploadPdf(file, (pct) => setProgress(5 + pct * 0.9));
    setProgress(null);
    renderOcrResult(data, file);
    setStatus(`Готово: ${data.pages ? data.pages.length : 0} стр., сервис ${health.version || ''}`.trim());
  } catch (error) {
    setProgress(null);
    setStatus('');
    if (/связаться|Failed/i.test(error.message)) $('service-block').hidden = false;
    showError('pdf-error', error.message);
  }
}

function renderOcrResult(data, file) {
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const tokens = pages.reduce((sum, page) => sum + (page.tokens || 0), 0);
  const dropped = pages.reduce((sum, page) => sum + (page.dropped || 0), 0);
  const withTab = pages.filter((page) => page.tokens > 0).length;

  ocrState = { data, title: baseName(file && file.name), name: baseName(file && file.name) };
  ocrVariants = [];
  $('ocr-tab').value = data.combined_tab || '';
  $('ocr-badge').textContent = `— ${pages.length} стр., цифр ${tokens}, отброшено токенов ${dropped}`;

  const warnings = [...(data.warnings || [])];
  if (!withTab) {
    warnings.unshift('Ни на одной странице не нашлось ТАБ-стана с цифрами. Похоже, это нотное издание — нужен другой инструмент.');
  } else if (!warnings.length) {
    warnings.push('Замечаний нет — но всё равно сверьте таб с исходником глазами.');
  }
  const list = $('ocr-warnings');
  list.textContent = '';
  for (const text of warnings) {
    const item = document.createElement('li');
    item.textContent = text;
    list.appendChild(item);
  }

  $('ocr-variants').textContent = '';
  $('ocr-result').hidden = false;
  const textarea = $('ocr-tab');
  if (!textarea.value.trim()) {
    showError('ocr-error', 'Таб пустой: добавьте цифры ладов вручную или загрузите другой PDF.');
  }
}

function ocrEvents() {
  return parseTab($('ocr-tab').value, $('tuning-pdf').value);
}

function ocrNotesForExport(events) {
  return events.map((e) => ({
    name: midiToName(e.midi),
    russian: midiToRussian(e.midi),
    midi: e.midi,
    string: e.string,
    fret: e.fret,
  }));
}

function exportOcr(kind) {
  clearError('ocr-error');
  try {
    const tuning = $('tuning-pdf').value;
    const events = ocrEvents();
    const notes = ocrNotesForExport(events);
    const name = ocrState.name || 'tab';

    if (kind === 'txt') {
      const text = [
        'Распознанный таб (проверьте перед использованием)',
        `Строй: ${TUNINGS[tuning].label}`,
        '',
        $('ocr-tab').value.trimEnd(),
        '',
        'Ноты по порядку:',
        ...notes.map((n) => `${n.name}\t${n.russian}\tструна ${n.string}, лад ${n.fret}`),
      ].join('\n');
      saveText(`${name}.txt`, `${text}\n`);
      return;
    }
    if (kind === 'json') {
      const payload = {
        source: 'notetab-pdf-ocr',
        tuning: { id: tuning, label: TUNINGS[tuning].label, midi: TUNINGS[tuning].midi },
        tab: $('ocr-tab').value.trimEnd(),
        notes,
        warnings: (ocrState.data && ocrState.data.warnings) || [],
        pages: (ocrState.data && ocrState.data.pages) || [],
      };
      saveText(`${name}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
      return;
    }
    if (kind === 'musicxml') {
      const xml = buildMusicXML(
        notes.map((n) => ({ midi: n.midi, string: n.string, fret: n.fret })),
        { title: ocrState.title, tuning }
      );
      saveText(`${name}.musicxml`, xml, 'application/vnd.recordare.musicxml+xml');
      return;
    }
    if (kind === 'mid') {
      const columns = new Map();
      for (const e of events) {
        if (!columns.has(e.column)) columns.set(e.column, []);
        columns.get(e.column).push(e.midi);
      }
      saveMidi(`${name}.mid`, [...columns.values()]);
    }
  } catch (error) {
    showError('ocr-error', error.message);
  }
}

function printOcr() {
  clearError('ocr-error');
  const tuning = $('tuning-pdf').value;
  let notes = [];
  try {
    notes = ocrNotesForExport(ocrEvents());
  } catch {
    notes = []; // печатаем хотя бы таб, ошибку покажет кнопка вариантов
  }
  printDocument(buildPrintHTML({
    title: ocrState.title || 'Табулатура из PDF',
    subtitle: 'notetab — распознано из PDF, проверьте перед использованием',
    tab: $('ocr-tab').value,
    tuning: TUNINGS[tuning].label,
    notes,
  }));
}

function runOcrVariants() {
  clearError('ocr-error');
  $('ocr-variants').textContent = '';
  try {
    const tuning = $('tuning-pdf').value;
    const events = ocrEvents();
    const maxFret = Number($('max-fret') && $('max-fret').value) || 12;
    const stretch = Number($('stretch') && $('stretch').value) || 4;
    const variants = notesToTabs(events.map((e) => e.midi), { tuning, maxFret, stretch });
    ocrVariants = variants;

    const wrap = document.createElement('div');
    wrap.className = 'cards';
    variants.forEach((variant, index) => wrap.appendChild(renderCard(variant, index, tuning)));
    $('ocr-variants').appendChild(wrap);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = `Найдено вариантов: ${variants.length}. Ритм из PDF не переносится — только высоты нот.`;
    $('ocr-variants').prepend(hint);
  } catch (error) {
    showError('ocr-error', error.message);
  }
}

/* drag & drop + выбор файла */

const dropzone = $('dropzone');
const pdfInput = $('pdf-input');

function openFileDialog() {
  pdfInput.click();
}

dropzone.addEventListener('click', openFileDialog);
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openFileDialog();
  }
});
pdfInput.addEventListener('change', () => {
  const file = pdfInput.files && pdfInput.files[0];
  if (file) handlePdfFile(file);
  pdfInput.value = '';
});
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
  });
}
dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) handlePdfFile(file);
});

$('btn-service-recheck').addEventListener('click', async () => {
  setStatus('Проверяю локальный сервис…');
  const health = await checkService();
  if (health) {
    $('service-block').hidden = true;
    clearError('pdf-error');
    setStatus(`Сервис отвечает, версия ${health.version || '—'}. Можно загружать PDF.`);
  } else {
    setStatus('');
    showError('pdf-error', 'Сервис всё ещё не отвечает. Запустите: cd omr-service && ./run.sh');
  }
});

$('btn-ocr-apply').addEventListener('click', runOcrVariants);
$('btn-ocr-txt').addEventListener('click', () => exportOcr('txt'));
$('btn-ocr-json').addEventListener('click', () => exportOcr('json'));
$('btn-ocr-xml').addEventListener('click', () => exportOcr('musicxml'));
$('btn-ocr-mid').addEventListener('click', () => exportOcr('mid'));
$('btn-ocr-pdf').addEventListener('click', printOcr);

/* ---------- режим «Ноты PDF → таб» ---------- */

let notesState = { notes: [], warnings: [], meta: null, title: 'notes', source: null };

function notesStatus(text) {
  const el = $('notes-status');
  el.textContent = text;
  el.hidden = !text;
}

function notesProgress(percent) {
  const box = $('notes-progress');
  if (percent === null) {
    box.hidden = true;
    box.firstElementChild.style.width = '0%';
    return;
  }
  box.hidden = false;
  box.firstElementChild.style.width = `${Math.max(2, Math.min(100, percent))}%`;
}

function notesSourceTitle(file) {
  return baseName(file && file.name ? file.name : 'notes');
}

/** PDF с нотами → локальный сервис → JSON со списком нот. */
function uploadNotesPdf(file, pages, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SERVICE_URL}/notes/pdf`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'upload.pdf'));
    if (pages) xhr.setRequestHeader('X-Pages', pages);
    xhr.timeout = 20 * 60 * 1000;
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => {
      const data = xhr.response || null;
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data);
        return;
      }
      if (xhr.status === 501) {
        $('notes-service').hidden = false;
      }
      reject(new Error((data && data.error) || `Сервис ответил кодом ${xhr.status}.`));
    });
    xhr.addEventListener('error', () => reject(new Error(
      'Не удалось связаться с локальным сервисом. Проверьте, что он запущен: cd omr-service && ./run.sh'
    )));
    xhr.addEventListener('timeout', () => reject(new Error('Сервис слишком долго не отвечает (20 минут).')));
    xhr.send(file);
  });
}

async function handleNotesPdf(file) {
  clearError('notes-error');
  clearError('notes-variants-error');
  $('notes-service').hidden = true;

  if (!isPdf(file)) {
    showError('notes-error', 'Нужен файл PDF: перетащите .pdf или выберите его в диалоге.');
    return;
  }

  notesStatus('Проверяю локальный сервис…');
  const health = await checkService();
  if (!health) {
    notesStatus('');
    $('notes-service').hidden = false;
    showError('notes-error', 'Локальный сервис не отвечает на http://127.0.0.1:8765/health.');
    return;
  }
  if (!health.audiveris) {
    $('notes-service').hidden = false;
    notesStatus('');
    showError('notes-error', health.error || 'Audiveris не найден — OMR нот недоступен. MusicXML работает всегда.');
    return;
  }

  const pages = $('notes-pages').value.trim() || '1';
  notesStatus(`Распознаю страницы ${pages}: рендер 300 dpi и Audiveris… одна страница ≈ 8–10 с.`);
  notesProgress(4);
  try {
    const data = await uploadNotesPdf(file, pages, (pct) => notesProgress(4 + pct * 0.2));
    notesProgress(null);
    const merged = flattenPages(data.pages);
    const count = merged.notes.length;
    renderNotesResult({
      notes: merged.notes,
      warnings: merged.warnings,
      meta: data.meta || {},
      title: notesSourceTitle(file),
      source: 'omr',
    });
    notesStatus(
      `Готово: ${count} нот за ${(data.meta && data.meta.seconds) || '—'} с, ` +
      `движок ${(data.meta && data.meta.engine) || 'Audiveris'}.`
    );
  } catch (error) {
    notesProgress(null);
    notesStatus('');
    if (/связаться|Failed|health/i.test(error.message)) $('notes-service').hidden = false;
    showError('notes-error', error.message);
  }
}

/** .musicxml / .xml / .mxl → JSON со списком нот (без сервиса). */
async function handleNotesXml(file) {
  clearError('notes-error');
  clearError('notes-variants-error');
  $('notes-xml-status').hidden = true;
  if (!file) return;
  try {
    const name = String(file.name || '').toLowerCase();
    const buffer = new Uint8Array(await file.arrayBuffer());
    let text;
    if (name.endsWith('.mxl')) {
      text = (await extractMusicXml(buffer)).text;
    } else if (name.endsWith('.musicxml') || name.endsWith('.xml') || /xml/.test(file.type || '')) {
      text = new TextDecoder('utf-8').decode(buffer);
    } else {
      throw new Error('Нужен файл .musicxml, .xml или .mxl (MusicXML).');
    }
    const parsed = parseMusicXml(text);
    renderNotesResult({
      notes: parsed.notes,
      warnings: parsed.warnings,
      meta: { engine: 'MusicXML', source: 'файл', seconds: null, pages: 1, software: parsed.meta.software },
      title: baseName(file.name),
      source: 'file',
    });
    $('notes-xml-status').textContent = `Загружено: ${name} · ${parsed.notes.length} нот`;
    $('notes-xml-status').hidden = false;
    notesStatus('');
  } catch (error) {
    $('notes-xml-status').textContent = '';
    showError('notes-error', error.message);
  }
}

function renderNotesResult({ notes, warnings, meta, title, source }) {
  notesState = { notes: renumber(notes), warnings: warnings || [], meta: meta || {}, title, source };
  $('notes-result').hidden = false;
  $('notes-variants').textContent = '';
  renderNotesWarnings();
  renderNoteRows();
  drawStaff();
  const info = stats(notesState.notes);
  const engine = meta.engine || 'Audiveris';
  const seconds = meta.seconds ? ` · ${meta.seconds} с` : '';
  const pages = meta.pages > 1 ? ` · ${meta.pages} стр.` : '';
  $('notes-badge').textContent = `— ${engine}${seconds}${pages} · нот ${info.count}`;
}

function renderNotesWarnings() {
  const list = $('notes-warnings');
  list.textContent = '';
  const messages = [...notesState.warnings];
  const info = stats(notesState.notes);
  if (!info.count) {
    messages.push('Список нот пуст: загрузите другой файл или вставьте ноты вручную.');
  }
  if (info.outOfRange.length) {
    messages.push(
      `Вне диапазона гитары (${midiToName(38)}..${midiToName(86)}): нот ${info.outOfRange.length} — ` +
      'они выделены красным, поправьте кнопками ↑/↓ или удалите.'
    );
  }
  if (!messages.length) messages.push('Замечаний нет — но сверьте высоты с исходником глазами.');
  for (const text of messages) {
    const item = document.createElement('li');
    item.textContent = text;
    list.appendChild(item);
  }
}

function renderNoteRows() {
  const host = $('notes-rows');
  host.textContent = '';
  const info = stats(notesState.notes);
  const out = new Set(info.outOfRange);
  const fragment = document.createDocumentFragment();

  notesState.notes.forEach((note, index) => {
    const row = document.createElement('div');
    row.className = `note-row${out.has(index) ? ' out-of-range' : ''}`;
    row.dataset.index = String(index);

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `${index + 1}`;

    const pitch = document.createElement('span');
    pitch.className = 'pitch';
    pitch.textContent = note.name;

    const ru = document.createElement('span');
    ru.className = 'ru';
    const fingering = note.string !== undefined ? ` · струна ${note.string}, лад ${note.fret}` : '';
    ru.textContent = `${midiToRussian(note.midi)}${fingering}`;

    const ops = document.createElement('span');
    ops.className = 'ops';
    for (const [act, label, title] of [
      ['down', '↓', 'На полтона ниже'],
      ['up', '↑', 'На полтона выше'],
      ['octave-down', '⇓', 'На октаву ниже'],
      ['octave-up', '⇑', 'На октаву выше'],
      ['insert', '＋', 'Вставить ноту после этой'],
      ['delete', '✕', 'Удалить ноту'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      button.dataset.act = act;
      ops.appendChild(button);
    }

    row.append(idx, pitch, ru, ops);
    fragment.appendChild(row);
  });
  host.appendChild(fragment);
}

/** Превью: 5 линий + точки по высоте + названия под ними. */
function drawStaff() {
  const canvas = $('notes-staff');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const notes = notesState.notes;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const gap = 12;
  const top = 34;
  const width = Math.max(640, Math.min(2400, 110 + Math.max(notes.length, 1) * 26));
  const height = 160;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = '#3d4a61';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = top + i * gap;
    ctx.beginPath();
    ctx.moveTo(14, y);
    ctx.lineTo(width - 14, y);
    ctx.stroke();
  }

  if (!notes.length) {
    ctx.fillStyle = '#93a1b8';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Нот пока нет', width / 2, top + gap * 2);
    return;
  }

  const bottomY = top + 4 * gap;
  const step = gap / 2; // шаг между соседними позициями (линия/междулинейка)
  const spacing = notes.length > 1
    ? Math.min(34, (width - 70) / (notes.length - 1))
    : 0;
  const info = stats(notes);
  const out = new Set(info.outOfRange);
  const rotate = spacing < 22;

  notes.forEach((note, index) => {
    const x = 40 + index * spacing;
    const y = bottomY - (note.midi - 64) * step;
    ctx.strokeStyle = '#3d4a61';
    if (y < top) {
      for (let ledger = top - gap; ledger >= y - 0.5; ledger -= gap) {
        ctx.beginPath();
        ctx.moveTo(x - 8, ledger);
        ctx.lineTo(x + 8, ledger);
        ctx.stroke();
      }
    } else if (y > bottomY) {
      for (let ledger = bottomY + gap; ledger <= y + 0.5; ledger += gap) {
        ctx.beginPath();
        ctx.moveTo(x - 8, ledger);
        ctx.lineTo(x + 8, ledger);
        ctx.stroke();
      }
    }

    ctx.fillStyle = out.has(index) ? '#ff8b8b' : '#7fd1b0';
    ctx.beginPath();
    ctx.ellipse(x, y, 4.4, 3.4, -0.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = out.has(index) ? '#ff8b8b' : '#93a1b8';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    if (rotate) {
      ctx.save();
      ctx.translate(x, height - 14);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillText(note.name, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(note.name, x, height - 12);
    }
  });
}

function applyNotesOperation(index, act) {
  clearError('notes-error');
  try {
    const list = notesState.notes;
    if (act === 'up') notesState.notes = transposeNote(list, index, 1);
    else if (act === 'down') notesState.notes = transposeNote(list, index, -1);
    else if (act === 'octave-up') notesState.notes = octaveNote(list, index, 1);
    else if (act === 'octave-down') notesState.notes = octaveNote(list, index, -1);
    else if (act === 'delete') notesState.notes = removeNote(list, index);
    else if (act === 'insert') notesState.notes = insertNote(list, index, list[index] ? list[index].midi : 64);
    else return;
    renderNoteRows();
    drawStaff();
    renderNotesWarnings();
    const info = stats(notesState.notes);
    $('notes-badge').textContent = `— нот ${info.count}`;
    $('notes-variants').textContent = '';
    clearError('notes-variants-error');
  } catch (error) {
    showError('notes-error', error.message);
  }
}

function playNotesPdf(event) {
  if (!notesState.notes.length) {
    showError('notes-variants-error', 'Список нот пуст — прослушивать нечего.');
    return;
  }
  playSteps(toSteps(notesState.notes), event && event.currentTarget);
}

function runNotesPdfVariants() {
  clearError('notes-variants-error');
  $('notes-variants').textContent = '';
  try {
    if (!notesState.notes.length) throw new Error('Список нот пуст — добавьте ноты или загрузите файл заново.');
    const tuning = $('notes-tuning').value;
    const maxFret = Number($('notes-maxfret').value);
    const stretch = Number($('notes-stretch').value);
    const variants = notesToTabs(notesState.notes.map((n) => n.midi), { tuning, maxFret, stretch });

    const wrap = document.createElement('div');
    wrap.className = 'cards';
    variants.forEach((variant, index) => wrap.appendChild(renderCard(variant, index, tuning)));
    $('notes-variants').appendChild(wrap);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = `Найдено вариантов: ${variants.length}. Основа — отредактированные ноты (${notesState.notes.length} шт.); ритм не переносится.`;
    $('notes-variants').prepend(hint);
  } catch (error) {
    showError('notes-variants-error', error.message);
  }
}

function exportNotesPdf(kind) {
  clearError('notes-variants-error');
  const notes = notesState.notes;
  if (!notes.length) {
    showError('notes-variants-error', 'Список нот пуст — экспортировать нечего.');
    return;
  }
  const name = notesState.title || 'notes';
  if (kind === 'txt') {
    const text = [
      'Ноты (OMR/MusicXML) — проверьте перед использованием',
      notesState.source === 'omr' ? 'Источник: Audiveris, ритм и размер ненадёжны' : 'Источник: MusicXML',
      '',
      ...notes.map((n, i) => `${i + 1}.\t${n.name}\t${midiToRussian(n.midi)}${n.string !== undefined ? `\tструна ${n.string}, лад ${n.fret}` : ''}`),
    ].join('\n');
    saveText(`${name}.txt`, `${text}\n`);
    return;
  }
  if (kind === 'json') {
    const payload = {
      source: notesState.source === 'omr' ? 'notetab-audiveris' : 'notetab-musicxml',
      meta: notesState.meta,
      warnings: notesState.warnings,
      notes: notes.map((n) => ({
        midi: n.midi,
        name: n.name,
        russian: midiToRussian(n.midi),
        duration: n.duration,
        type: n.type,
        staff: n.staff,
        voice: n.voice,
        onset: n.onset,
        ...(n.string !== undefined ? { string: n.string, fret: n.fret } : {}),
      })),
    };
    saveText(`${name}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
    return;
  }
  saveMidi(`${name}.mid`, toSteps(notes));
}

/* выбор файлов и drag & drop */

const notesDrop = $('notes-drop');
const notesPdfInput = $('notes-pdf');

notesDrop.addEventListener('click', () => notesPdfInput.click());
notesDrop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    notesPdfInput.click();
  }
});
notesPdfInput.addEventListener('change', () => {
  const file = notesPdfInput.files && notesPdfInput.files[0];
  if (file) handleNotesPdf(file);
  notesPdfInput.value = '';
});
for (const type of ['dragenter', 'dragover']) {
  notesDrop.addEventListener(type, (event) => {
    event.preventDefault();
    notesDrop.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  notesDrop.addEventListener(type, (event) => {
    event.preventDefault();
    notesDrop.classList.remove('dragover');
  });
}
notesDrop.addEventListener('drop', (event) => {
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) handleNotesPdf(file);
});

$('notes-xml').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) handleNotesXml(file);
  event.target.value = '';
});

$('notes-rows').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.note-row');
  applyNotesOperation(Number(row.dataset.index), button.dataset.act);
});

$('btn-notes-play').addEventListener('click', playNotesPdf);
$('btn-notes-variants').addEventListener('click', runNotesPdfVariants);
$('btn-notes-txt').addEventListener('click', () => exportNotesPdf('txt'));
$('btn-notes-json').addEventListener('click', () => exportNotesPdf('json'));
$('btn-notes-mid').addEventListener('click', () => exportNotesPdf('mid'));

$('btn-notes-recheck').addEventListener('click', async () => {
  notesStatus('Проверяю локальный сервис…');
  const health = await checkService();
  if (health) {
    $('notes-service').hidden = Boolean(health.audiveris);
    clearError('notes-error');
    notesStatus(health.audiveris
      ? `Сервис отвечает, ${health.engine || 'Audiveris'} готов. Можно загружать PDF.`
      : 'Сервис отвечает, но Audiveris не найден — доступна загрузка MusicXML.');
  } else {
    notesStatus('');
    $('notes-service').hidden = false;
    showError('notes-error', 'Сервис всё ещё не отвечает. Запустите: cd omr-service && ./run.sh');
  }
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
