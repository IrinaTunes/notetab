#!/usr/bin/env node
/**
 * MusicXML → Guitar Pro 7 (.gp).
 *
 * Использует alphaTab: он умеет читать MusicXML и писать контейнер GP7
 * (это zip — файл начинается с «PK»). alphaTab не входит в зависимости
 * проекта, потому что в CI нет `npm install`; поставьте локально:
 *
 *   npm i @coderline/alphatab
 *   node scripts/musicxml-to-gp.mjs page-013.musicxml page-013.gp
 *
 * Если модуля нет — скрипт честно об этом скажет и выйдет с кодом 2.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

let alphaTab;
try {
  alphaTab = await import("@coderline/alphatab");
} catch {
  console.error("Нет пакета @coderline/alphatab — установите: npm i @coderline/alphatab");
  process.exit(2);
}

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("Использование: node scripts/musicxml-to-gp.mjs <in.musicxml> <out.gp>");
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(resolve(input)));
const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes);
// Вторым аргументом нужен Settings: без него Gp7Exporter падает на Beat.finish
// с «Cannot read properties of undefined (reading 'notationMode')».
const settings = new alphaTab.Settings();
const exported = new alphaTab.exporter.Gp7Exporter().export(score, settings);
writeFileSync(resolve(output), Buffer.from(exported));

const track = score.tracks[0];
const notes = track.staves.reduce(
  (sum, staff) =>
    sum +
    staff.bars.reduce(
      (barSum, bar) => barSum + bar.voices.reduce((voiceSum, voice) => voiceSum + voice.beats.reduce((beatSum, beat) => beatSum + beat.notes.length, 0), 0),
      0,
    ),
  0,
);
console.log(`${output}: трек 1, тактов ${score.masterBars.length}, нот ${notes}, ${exported.length} байт`);
