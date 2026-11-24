#!/usr/bin/env python3
"""OMR → MusicXML с многоголосием и табулатурой (без потери нот).

Отличия от первой версии:
* каждый голос OMR (1..4) переносится как отдельный голос MusicXML;
  голоса 2–4 сводятся во второй голос (бас), чтобы таб читался;
* паузы не рисуются вообще: время двигается через <forward>, иначе MuseScore
  выводит их отдельными закорючками под табом;
* ноты, выходящие за тактовую черту, обрезаются (без лиг): иначе в табе
  появляются «лишние залигованные» повторы;
* у второго голоса `stem: none` — штили и флажки баса под станом не рисуются;
* считается статистика: сколько нот на входе, сколько записано, сколько
  отброшено как неиграбельные.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

TUNING = [64, 59, 55, 50, 45, 40]      # 1..6 струна, MIDI звучания
DIVISIONS = 12
MEASURE = 4.0                           # четверти в такте
MAX_FRET = 15
STEP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
TYPE_BY_DURATION = {
    4.0: "whole", 3.0: "half", 2.0: "half", 1.5: "quarter",
    1.0: "quarter", 0.75: "eighth", 0.5: "eighth", 0.25: "16th", 1 / 3: "eighth",
}


def type_for(duration: float) -> str:
    return TYPE_BY_DURATION.get(round(duration, 3), "eighth")


def pitch_xml(midi: int) -> str:
    name = STEP_NAMES[midi % 12]
    alter = 1 if name.endswith("#") else 0
    alter_xml = f"<alter>{alter}</alter>" if alter else ""
    return f"<pitch><step>{name[0]}</step>{alter_xml}<octave>{midi // 12 - 1}</octave></pitch>"


def fret_for(midi: int, previous: int | None) -> tuple[int, int] | None:
    options = [(index, midi - open_midi) for index, open_midi in enumerate(TUNING, start=1)
               if 0 <= midi - open_midi <= MAX_FRET]
    if not options:
        return None
    return min(options, key=lambda item: (0 if previous is None else abs(item[1] - previous), item[1]))


def build_voice_events(notes: list[dict]) -> dict[int, list[dict]]:
    """voice → список событий {onset, duration, notes[]} с аккордами."""
    voices: dict[int, dict[float, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for note in notes:
        voice = int(note.get("voice") or 1)
        bucket = 1 if voice == 1 else 2          # 2..4 → второй голос (бас)
        voices[bucket][round(float(note["onset"]), 3)].append(note)

    result: dict[int, list[dict]] = {}
    for bucket, onsets in voices.items():
        events = []
        for onset in sorted(onsets):
            chunk = onsets[onset]
            duration = max(round(float(n["duration"]), 3) for n in chunk)
            # Обрезаем по тактовой черте: иначе нота «переезжает» в следующий такт
            # и превращается в лишнюю залигованную ноту в табе.
            to_bar_end = MEASURE - (onset % MEASURE)
            duration = min(max(duration, 0.25), round(to_bar_end, 3))
            events.append({"onset": onset, "duration": duration, "notes": chunk})
        result[bucket] = events
    return result


def segments_for_measure(events: list[dict], measure_index: int) -> list[dict]:
    """Нарезать события голоса в пределах такта: (kind, start, duration, notes)."""
    bar_start = measure_index * MEASURE
    bar_end = bar_start + MEASURE
    segments: list[dict] = []
    cursor = bar_start

    for event in events:
        start = max(event["onset"], bar_start)
        end = min(event["onset"] + event["duration"], bar_end)
        if end <= bar_start or start >= bar_end:
            continue
        if start > cursor + 1e-6:
            segments.append({"kind": "rest", "duration": start - cursor})
        clipped = round(end - start, 3)
        segments.append({
            "kind": "note",
            "duration": clipped,
            "notes": event["notes"],
            "continues": event["onset"] + event["duration"] > bar_end + 1e-6,
            "continued": event["onset"] < bar_start - 1e-6,
        })
        cursor = end

    if cursor < bar_end - 1e-6:
        segments.append({"kind": "rest", "duration": bar_end - cursor})
    return segments


def render_measure(segments: list[dict], voice_number: int, previous_fret: int | None,
                   stats: dict[str, int]) -> tuple[str, int | None]:
    out: list[str] = []
    for segment in segments:
        quarters = int(round(segment["duration"] * DIVISIONS))
        if quarters <= 0:
            continue
        if segment["kind"] == "rest":
            # <forward> двигает время без значка паузы: в табе любые паузы рисуются
            # отдельными закорючками под станом и выглядят как мусор.
            out.append(
                f"      <forward><duration>{quarters}</duration>"
                f"<voice>{voice_number}</voice></forward>\n"
            )
            continue

        for index, note in enumerate(sorted(segment["notes"], key=lambda n: int(n["midi"]))):
            sounding = int(note["midi"]) - 12
            placement = fret_for(sounding, previous_fret)
            if placement is None:
                stats["dropped"] += 1
                continue
            string, fret = placement
            previous_fret = fret
            stats["written"] += 1
            tie = ""  # лиги не ставим: они появлялись только из-за нот через тактовую черту
            head = "        <note>\n"
            if index > 0:
                head += "          <chord/>\n"
            out.append(
                head
                + f"          {pitch_xml(sounding)}\n"
                + f"          <duration>{quarters}</duration>\n"
                + (f"          {tie}\n" if tie else "")
                + f"          <voice>{voice_number}</voice>\n"
                + f"          <type>{type_for(segment['duration'])}</type>\n"
                # У второго голоса штили и флажки рисуются под станом и выглядят мусором
                + ("          <stem>none</stem>\n" if voice_number == 2 else "")
                + f"          <notations><technical><string>{string}</string><fret>{fret}</fret></technical></notations>\n"
                + "        </note>\n"
            )
    return "".join(out), previous_fret


def build(notes: list[dict], title: str, subtitle: str, tempo: int) -> tuple[str, dict[str, int]]:
    stats = {"input": len(notes), "written": 0, "dropped": 0}
    voices = build_voice_events(notes)
    last_onset = max(float(n["onset"]) + float(n["duration"]) for n in notes)
    measures = max(1, int(-(-last_onset // MEASURE)))

    header = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>{title}</work-title></work>
  <movement-title>{title}</movement-title>
  <identification><creator type="composer">{subtitle}</creator>
    <encoding><software>notetab omr2musicxml v2 (multi-voice)</software></encoding></identification>
  <part-list><score-part id="P1"><part-name>Guitar</part-name>
    <score-instrument id="P1-I1"><instrument-name>Guitar</instrument-name></score-instrument>
    <midi-instrument id="P1-I1"><midi-program>25</midi-program></midi-instrument>
  </score-part></part-list>
  <part id="P1">
'''
    body: list[str] = []
    frets = {1: None, 2: None}

    for measure_index in range(measures):
        body.append(f'    <measure number="{measure_index + 1}">\n')
        if measure_index == 0:
            body.append(
                "      <attributes>\n"
                f"        <divisions>{DIVISIONS}</divisions>\n"
                "        <key><fifths>0</fifths></key>\n"
                "        <time><beats>4</beats><beat-type>4</beat-type></time>\n"
                "        <staves>1</staves>\n"
                "        <clef><sign>TAB</sign><line>5</line></clef>\n"
                "        <staff-details><staff-lines>6</staff-lines>"
                "<staff-tuning line=\"1\"><tuning-step>E</tuning-step><tuning-octave>2</tuning-octave></staff-tuning>"
                "<staff-tuning line=\"2\"><tuning-step>A</tuning-step><tuning-octave>2</tuning-octave></staff-tuning>"
                "<staff-tuning line=\"3\"><tuning-step>D</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>"
                "<staff-tuning line=\"4\"><tuning-step>G</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>"
                "<staff-tuning line=\"5\"><tuning-step>B</tuning-step><tuning-octave>3</tuning-octave></staff-tuning>"
                "<staff-tuning line=\"6\"><tuning-step>E</tuning-step><tuning-octave>4</tuning-octave></staff-tuning>"
                "</staff-details>\n      </attributes>\n"
                f"      <direction placement=\"above\"><direction-type><metronome>"
                f"<beat-unit>quarter</beat-unit><per-minute>{tempo}</per-minute></metronome>"
                "</direction-type></direction>\n"
            )

        for voice_number in (1, 2):
            events = voices.get(voice_number, [])
            segments = segments_for_measure(events, measure_index)
            if not segments:
                if voice_number == 1:
                    body.append(
                        f"      <note><rest/><duration>{int(MEASURE * DIVISIONS)}</duration>"
                        "<voice>1</voice><type>whole</type></note>\n"
                    )
                continue
            if voice_number == 2:
                body.append(f"      <backup><duration>{int(MEASURE * DIVISIONS)}</duration></backup>\n")
            rendered, frets[voice_number] = render_measure(segments, voice_number, frets[voice_number], stats)
            body.append(rendered)

        body.append("    </measure>\n")

    return header + "".join(body) + "  </part>\n</score-partwise>\n", stats


def main() -> int:
    parser = argparse.ArgumentParser(description="JSON OMR → MusicXML с голосами и табулатурой")
    parser.add_argument("json_path", type=Path)
    parser.add_argument("-o", "--out", type=Path, required=True)
    parser.add_argument("--title", default="Без названия")
    parser.add_argument("--subtitle", default="")
    parser.add_argument("--tempo", type=int, default=96)
    args = parser.parse_args()

    payload = json.loads(args.json_path.read_text(encoding="utf-8"))
    notes = [n for page in payload.get("pages", []) for n in page.get("notes", [])]
    if not notes:
        raise SystemExit("в JSON нет нот")

    xml, stats = build(notes, args.title, args.subtitle, args.tempo)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(xml, encoding="utf-8")
    print(
        f"{args.out}: нот в JSON {stats['input']}, записано {stats['written']}, "
        f"отброшено как неиграбельные {stats['dropped']}, тактов {xml.count('<measure ')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
