// Проверка экспортов на реальном результате OCR: те же модули, что и в UI.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseTab } from '../src/tab.js';
import { notesToTabs } from '../src/solver.js';
import { buildMidi } from '../src/midi.js';
import { buildMusicXML } from '../src/musicxml.js';
import { buildPrintHTML } from '../src/printable.js';

const outDir = '/tmp/notetab-exports';
mkdirSync(outDir, { recursive: true });

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const tab = data.combined_tab;
const events = parseTab(tab, 'standard');
const notes = events.map((e) => ({ midi: e.midi, string: e.string, fret: e.fret }));

const columns = new Map();
for (const e of events) {
  if (!columns.has(e.column)) columns.set(e.column, []);
  columns.get(e.column).push(e.midi);
}
const steps = [...columns.values()];
const variants = notesToTabs(events.map((e) => e.midi), { tuning: 'standard', maxFret: 12, stretch: 4 });

writeFileSync(`${outDir}/tab.txt`, tab + '\n');
writeFileSync(`${outDir}/tab.json`, JSON.stringify({ tab, notes, warnings: data.warnings }, null, 2));
writeFileSync(`${outDir}/tab.mid`, buildMidi(steps));
writeFileSync(`${outDir}/tab.musicxml`, buildMusicXML(notes, { title: 'Interstellar (OCR)', tuning: 'standard' }));
writeFileSync(`${outDir}/tab-print.html`, buildPrintHTML({
  title: 'Interstellar (OCR)',
  subtitle: 'notetab — распознано из PDF',
  tab,
  tuning: 'Стандартный (E A D G B E)',
  notes: notes.map((n) => ({ name: '', string: n.string, fret: n.fret })),
}));
writeFileSync(`${outDir}/variants.json`, JSON.stringify(variants.map((v) => ({ title: v.title, tab: v.tab })), null, 2));

console.log(JSON.stringify({
  events: events.length,
  notes: notes.length,
  variants: variants.length,
  midiBytes: buildMidi(steps).length,
  xmlBytes: buildMusicXML(notes).length,
  files: ['tab.txt', 'tab.json', 'tab.mid', 'tab.musicxml', 'tab-print.html', 'variants.json'],
}, null, 2));
