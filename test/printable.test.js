import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrintHTML, wrapTabRows } from '../src/printable.js';

test('PDF-макет: не падает на пустом списке нот', () => {
  const html = buildPrintHTML();
  assert.equal(typeof html, 'string');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /Таб пуст/);
});

test('PDF-макет: пустой таб и пустые варианты тоже дают документ', () => {
  const html = buildPrintHTML({ tab: '', notes: [], variants: [], title: 'Пусто' });
  assert.match(html, /<title>Пусто — печать<\/title>/);
  assert.match(html, /@page \{ size: A4/);
});

test('PDF-макет: A4, @media print и кнопка печати', () => {
  const html = buildPrintHTML({ tab: 'e|--0--|', title: 'Interstellar' });
  assert.match(html, /@page \{ size: A4 portrait/);
  assert.match(html, /@media print/);
  assert.match(html, /window\.print\(\)/);
  assert.match(html, /Печать \/ Сохранить в PDF/);
  assert.match(html, /none !important/);
});

test('PDF-макет: таб, строй, позиция и ноты попадают в разметку', () => {
  const html = buildPrintHTML({
    title: 'Песня',
    tab: 'e|--0--3--|\nB|--------|',
    tuning: 'Стандартный (E A D G B E)',
    position: 'позиция 1–4',
    notes: [{ name: 'E4', russian: 'ми первой октавы', string: 1, fret: 0 }],
  });
  assert.match(html, /e\|--0--3--\|/);
  assert.match(html, /Стандартный/);
  assert.match(html, /позиция 1–4/);
  assert.match(html, /ми первой октавы/);
});

test('PDF-макет: варианты аппликатуры печатаются отдельными блоками', () => {
  const html = buildPrintHTML({
    variants: [
      { title: 'Компактная позиция', description: 'позиция 2–5', tab: 'e|--3--|' },
      { title: 'Открытые струны', description: '', tab: 'e|--0--|' },
    ],
  });
  assert.match(html, /Вариант 1\. Компактная позиция/);
  assert.match(html, /Вариант 2\. Открытые струны/);
  assert.equal((html.match(/<pre class="tab">/g) || []).length, 2);
});

test('PDF-макет: HTML в данных экранируется', () => {
  const html = buildPrintHTML({ title: '<script>alert(1)</script>', tab: 'e|<b>|' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /e\|&lt;b&gt;\|/);
});

test('PDF-макет: длинный таб режется по системам и влезает в A4', () => {
  const cell = '-'.repeat(40);
  const row = (label) => `${label}|${Array.from({ length: 10 }, () => cell).join('|')}|`;
  const tab = ['e', 'B', 'G', 'D', 'A', 'E'].map(row).join('\n');
  const blocks = wrapTabRows(tab, 84);
  assert.ok(blocks.length > 1, `блоков ${blocks.length}`);
  for (const block of blocks) {
    assert.equal(block.length, 6);
    for (const line of block) assert.ok(line.length <= 86, `строка ${line.length} символов`);
  }
  const html = buildPrintHTML({ tab });
  assert.ok((html.match(/<pre class="tab">/g) || []).length > 1);
});

test('PDF-макет: wrapTabRows не рушится на пустом и коротком табе', () => {
  assert.deepEqual(wrapTabRows(''), []);
  assert.deepEqual(wrapTabRows('e|--0--|'), [['e|--0--|']]);
});
