// Печатный макет A4: открывается в новом окне, печатается кнопкой (window.print).
// Никаких внешних библиотек — только HTML + CSS внутри @media print.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Разбить длинный таб на блоки по 6 строк, влезающие в ширину A4.
 * Разрез только по границе системы (по «|»), чтобы строки не разъезжались.
 */
export function wrapTabRows(tab, maxChars = 84) {
  const text = typeof tab === 'string' ? tab.trimEnd() : '';
  if (!text) return [];
  const rows = text.split('\n');
  if (rows.length !== 6) return [rows];

  const labels = [];
  const bodies = [];
  for (const row of rows) {
    const bar = row.indexOf('|');
    labels.push(bar >= 0 ? row.slice(0, bar) : '');
    let body = bar >= 0 ? row.slice(bar + 1) : row;
    if (body.endsWith('|')) body = body.slice(0, -1);
    bodies.push(body);
  }

  const segments = bodies.map((body) => body.split('|'));
  const count = segments[0].length;
  if (segments.some((parts) => parts.length !== count)) return [rows];

  const blocks = [];
  let start = 0;
  let width = 0;
  for (let i = 0; i < count; i += 1) {
    const size = segments[0][i].length + 1; // +1 на разделитель
    if (width > 0 && width + size > maxChars) {
      blocks.push(buildBlock(labels, segments, start, i));
      start = i;
      width = 0;
    }
    width += size;
  }
  if (start < count) blocks.push(buildBlock(labels, segments, start, count));
  return blocks.filter((block) => block.join('').trim() !== '');
}

function buildBlock(labels, segments, start, end) {
  return labels.map((label, row) => `${label}|${segments[row].slice(start, end).join('|')}|`);
}

/**
 * buildPrintHTML({ title, subtitle, tab, tuning, position, notes, variants })
 * → полный HTML-документ строкой. Пустые данные допустимы (печатается заглушка).
 */
export function buildPrintHTML(data = {}) {
  const {
    title = 'Табулатура',
    subtitle = 'notetab — ноты ↔ табулатура',
    tab = '',
    tuning = 'Стандартный (E A D G B E)',
    position = '',
    notes = [],
    variants = [],
  } = data || {};

  const tabText = typeof tab === 'string' ? tab.trimEnd() : '';
  const noteList = Array.isArray(notes) ? notes : [];
  const variantCards = Array.isArray(variants) ? variants : [];
  const tabBlocks = tabText ? wrapTabRows(tabText) : [];

  const notesBlock = noteList.length
    ? `<section class="block">
      <h2>Ноты по порядку</h2>
      <ol class="notes">
        ${noteList
          .map(
            (n) =>
              `<li><b>${escapeHtml(n.name ?? '')}</b>${n.russian ? ` — ${escapeHtml(n.russian)}` : ''}` +
              `<span class="meta"> струна ${escapeHtml(n.string ?? '')}, лад ${escapeHtml(n.fret ?? '')}</span></li>`
          )
          .join('\n        ')}
      </ol>
    </section>`
    : '';

  const variantsBlock = variantCards.length
    ? variantCards
        .map(
          (v, i) => `<section class="block variant">
      <h2>Вариант ${i + 1}. ${escapeHtml(v.title ?? '')}</h2>
      ${v.description ? `<p class="desc">${escapeHtml(v.description)}</p>` : ''}
      <pre class="tab">${escapeHtml(v.tab ?? '')}</pre>
    </section>`
        )
        .join('\n')
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — печать</title>
<style>
  @page { size: A4 portrait; margin: 16mm 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 28px; background: #fff; color: #111;
    font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 12pt;
  }
  h1 { font-size: 20pt; margin: 0 0 4px; }
  .subtitle { color: #555; margin: 0 0 14px; font-size: 10pt; }
  .meta { color: #333; font-size: 10pt; margin: 0 0 16px; }
  .meta b { font-weight: 600; }
  h2 { font-size: 11pt; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.06em; color: #444; }
  .block { margin: 0 0 18px; padding-top: 10px; border-top: 1px solid #ddd; }
  pre.tab {
    font-family: "SF Mono", Menlo, Consolas, "Courier New", monospace;
    font-size: 11pt; line-height: 1.45; margin: 0; white-space: pre; letter-spacing: 0.04em;
  }
  .desc { color: #555; font-size: 10pt; margin: 0 0 6px; }
  ol.notes { margin: 0; padding-left: 20px; font-size: 10pt; }
  ol.notes li { margin-bottom: 2px; }
  .variant { page-break-inside: avoid; }
  .toolbar {
    position: fixed; top: 12px; right: 12px; display: flex; gap: 8px;
    background: #f4f4f4; border: 1px solid #ddd; border-radius: 8px; padding: 6px;
  }
  .toolbar button {
    font: inherit; font-size: 11pt; padding: 8px 14px; border-radius: 6px;
    border: 1px solid #bbb; background: #fff; cursor: pointer;
  }
  .toolbar button.primary { background: #111; color: #fff; border-color: #111; }
  @media print {
    body { padding: 0; font-size: 11pt; }
    .toolbar, .no-print { display: none !important; }
    .block { border-color: #ccc; }
    pre.tab { font-size: 10.5pt; }
  }
</style>
</head>
<body>
<div class="toolbar no-print">
  <button type="button" class="primary" onclick="window.print()">Печать / Сохранить в PDF</button>
  <button type="button" onclick="window.close()">Закрыть</button>
</div>

<header>
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(subtitle)}</p>
  <p class="meta"><b>Строй:</b> ${escapeHtml(tuning)}${position ? ` &nbsp;·&nbsp; <b>Позиция:</b> ${escapeHtml(position)}` : ''}</p>
</header>

<section class="block">
  <h2>Табулатура</h2>
  ${tabBlocks.length
    ? tabBlocks.map((block) => `<pre class="tab">${escapeHtml(block.join('\n'))}</pre>`).join('\n  ')
    : '<p class="desc">Таб пуст — нечего печатать.</p>'}
</section>

${notesBlock}
${variantsBlock}

<footer class="meta">Сгенерировано notetab · https://irinatunes.github.io/notetab/</footer>
</body>
</html>`;
}
