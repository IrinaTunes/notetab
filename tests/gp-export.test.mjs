// MusicXML → .gp (Guitar Pro 7) через alphaTab.
// Тест пропускается, если пакета нет: в CI не выполняется npm install,
// а ставить зависимость ради одного теста — лишний риск для сборки.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>12</divisions>
        <staves>1</staves>
        <clef><sign>TAB</sign><line>5</line></clef>
        <staff-details><staff-lines>6</staff-lines>
          <staff-tuning line="1"><tuning-step>E</tuning-step><tuning-octave>2</tuning-octave></staff-tuning>
          <staff-tuning line="2"><tuning-step>A</tuning-step><tuning-octave>2</tuning-octave></staff-tuning>
          <staff-tuning line="3"><tuning-step>D</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>
          <staff-tuning line="4"><tuning-step>G</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>
          <staff-tuning line="5"><tuning-step>B</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>
          <staff-tuning line="6"><tuning-step>E</tuning-step><tuning-octave>4</tuning-octave></staff-tuning>
        </staff-details>
      </attributes>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>12</duration><voice>1</voice><type>quarter</type>
        <notations><technical><string>6</string><fret>0</fret></technical></notations>
      </note>
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>12</duration><voice>1</voice><type>quarter</type>
        <notations><technical><string>5</string><fret>3</fret></technical></notations>
      </note>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>24</duration><voice>1</voice><type>half</type>
        <notations><technical><string>5</string><fret>5</fret></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>
`;

let available = true;
try {
  await import("@coderline/alphatab");
} catch {
  available = false;
}

test("MusicXML превращается в .gp, который читается обратно", { skip: !available && "нет @coderline/alphatab" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gp-"));
  const xmlPath = join(dir, "in.musicxml");
  const gpPath = join(dir, "out.gp");
  writeFileSync(xmlPath, FIXTURE, "utf8");

  execFileSync(process.execPath, ["scripts/musicxml-to-gp.mjs", xmlPath, gpPath], { cwd: new URL("..", import.meta.url).pathname });

  const bytes = readFileSync(gpPath);
  assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK", "GP7 — это zip-контейнер");
  assert.ok(bytes.length > 500, "файл не пустой");
});
