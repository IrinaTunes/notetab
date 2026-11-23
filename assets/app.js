// Интерфейс: два режима, прослушивание и скачивание файлов через Blob.

import { parseNotes, midiToName, midiToRussian } from '../src/notes.js';
import { parseTab, MAX_FRET } from '../src/tab.js';
import { notesToTabs } from '../src/solver.js';
import { buildMidi } from '../src/midi.js';
import { TUNINGS } from '../src/tuning.js';
import { buildMusicXML } from '../src/musicxml.js';
import { buildPrintHTML } from '../src/printable.js';

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
  $('ocr-badge').textContent = `— ${pages.length} стр., цифр ${tokens}, отброшено ${dropped}`;

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

/* ---------- стартовое состояние ---------- */

$('tab-input').value = EXAMPLE_TAB;
$('notes-input').value = EXAMPLE_NOTES;
$('max-fret').value = '12';
$('stretch').value = '4';
// подсказка про диапазон ладов, чтобы ограничение не было сюрпризом
$('tab-input').setAttribute('data-max-fret', String(MAX_FRET));
$('tab-input').title = `Лады 0..${MAX_FRET}, только гитара (MIDI 38..86)`;
activateTab('tab2notes');
