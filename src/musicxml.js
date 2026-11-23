// Экспорт в MusicXML 3.1 (partwise) — партия для гитары в виде TAB.
// Одна мера на всю мелодию: ритм в табе не хранится, поэтому все ноты — четверти.
// Совместимо с MuseScore, Guitar Pro, Dorico и Finale.

import { getTuning } from './tuning.js';
import { MAX_FRET } from './tab.js';

const STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

/** MIDI → { step, alter, octave } по 12-ступенному звукоряду C C# D … B. */
export function splitPitch(midi) {
  const index = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return { step: STEPS[index], alter: ALTERS[index], octave };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * buildMusicXML(notes, options) → строка MusicXML.
 * notes: [{ midi, string (1..6), fret }].
 * options: { title, tuning, tempo, divisions, fifths }
 */
export function buildMusicXML(notes, options = {}) {
  const {
    title = 'notetab',
    tuning = 'standard',
    tempo = 120,
    divisions = 4,
    fifths = 0,
  } = options;

  getTuning(tuning); // строя нет — сразу падаем с понятной ошибкой

  const list = Array.isArray(notes) ? notes : [];
  const duration = divisions; // четверть
  const body = list
    .map((note) => {
      const midi = Number(note.midi);
      const string = Number(note.string);
      const fret = Number(note.fret);
      if (!Number.isInteger(string) || string < 1 || string > 6) {
        throw new Error(`MusicXML: струна ${note.string} вне диапазона 1..6.`);
      }
      if (!Number.isInteger(fret) || fret < 0 || fret > MAX_FRET) {
        throw new Error(`MusicXML: лад ${note.fret} вне диапазона 0..${MAX_FRET}.`);
      }
      const { step, alter, octave } = splitPitch(midi);
      const alterTag = alter ? `<alter>${alter}</alter>` : '';
      return [
        '      <note>',
        `        <pitch><step>${step}</step>${alterTag}<octave>${octave}</octave></pitch>`,
        `        <duration>${duration}</duration>`,
        '        <voice>1</voice>',
        '        <type>quarter</type>',
        '        <notations><technical>',
        `          <string>${string}</string>`,
        `          <fret>${fret}</fret>`,
        '        </technical></notations>',
        '      </note>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="3.1">',
    '  <work>',
    `    <work-title>${escapeXml(title)}</work-title>`,
    '  </work>',
    '  <identification>',
    '    <encoding>',
    '      <software>notetab</software>',
    '    </encoding>',
    '  </identification>',
    '  <part-list>',
    '    <score-part id="P1">',
    '      <part-name>Guitar</part-name>',
    '      <score-instrument id="P1-I1"><instrument-name>Acoustic Guitar</instrument-name></score-instrument>',
    '      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>25</midi-program></midi-instrument>',
    '    </score-part>',
    '  </part-list>',
    '  <part id="P1">',
    '    <measure number="1">',
    '      <attributes>',
    `        <divisions>${divisions}</divisions>`,
    `        <key><fifths>${fifths}</fifths><mode>major</mode></key>`,
    '        <time><beats>4</beats><beat-type>4</beat-type></time>',
    '        <clef><sign>TAB</sign><line>5</line><clef-octave-change>-1</clef-octave-change></clef>',
    '        <staff-details><staff-lines>6</staff-lines></staff-details>',
    '      </attributes>',
    '      <direction placement="above">',
    '        <direction-type>',
    `          <metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome>`,
    '        </direction-type>',
    `        <sound tempo="${tempo}"/>`,
    '      </direction>',
    body,
    '      <barline location="right"><bar-style>light-heavy</bar-style></barline>',
    '    </measure>',
    '  </part>',
    '</score-partwise>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
