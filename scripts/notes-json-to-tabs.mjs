#!/usr/bin/env node
// Читает {"notes":[60,62,...]} со stdin, печатает варианты табов как JSON.
// Используется batch-скриптом book2tabs.py: логика раскладки живёт в src/solver.js,
// чтобы браузер и CLI считали одинаково.

import { notesToTabs } from '../src/solver.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const notes = (payload.notes || []).filter((m) => Number.isInteger(m) && m >= 36 && m <= 90);
if (!notes.length) {
  console.log(JSON.stringify({ variants: [], error: 'нет нот в диапазоне гитары' }));
  process.exit(0);
}

const variants = notesToTabs(notes, {
  tuning: payload.tuning || 'standard',
  maxFret: payload.maxFret || 12,
  stretch: payload.stretch || 4,
});

console.log(JSON.stringify({
  count: notes.length,
  variants: variants.map((v) => ({ title: v.title, description: v.description, tab: v.tab })),
}));
