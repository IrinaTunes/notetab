"""Тесты генератора MusicXML с табулатурой (musicxml_export).

Проверяем ровно те свойства, из-за которых таб раньше выглядел мусором:
* ни одна нота не теряется (включая бас во втором голосе);
* нет лиг: ноты обрезаются по тактовой черте, а не переносятся;
* паузы не рисуются (вместо них <forward>);
* у второго голоса нет штилей;
* неиграбельные ноты отбрасываются с подсчётом.
"""

from __future__ import annotations

import sys
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import musicxml_export as M  # noqa: E402


def _note(midi: int, onset: float, duration: float, voice: str = "1") -> dict:
    return {"midi": midi, "onset": onset, "duration": duration, "voice": voice}


def _parse(xml: str) -> ET.Element:
    return ET.fromstring(xml)


def test_two_voices_are_kept_and_bass_has_no_stem() -> None:
    notes = [
        _note(72, 0, 0.5, "1"), _note(74, 0.5, 0.5, "1"),
        _note(57, 0, 4, "2"),   # писаная A3: после сдвига на октаву звучит A2 (5-я струна, 0 лад)
    ]
    xml, stats = M.build(notes, "T", "S", 96)
    root = _parse(xml)
    pitches = [n for n in root.iter("note") if n.find("pitch") is not None]

    assert stats["input"] == 3
    assert stats["dropped"] == 0
    assert len(pitches) >= 3, "все ноты должны попасть в файл"
    voices = {n.findtext("voice") for n in pitches}
    assert voices == {"1", "2"}
    assert len(list(root.iter("backup"))) >= 1, "второй голос требует <backup>"
    bass = [n for n in pitches if n.findtext("voice") == "2"]
    assert all(n.findtext("stem") == "none" for n in bass)


def test_no_ties_and_notes_clipped_at_barline() -> None:
    notes = [_note(72, 3.5, 2.0, "1")]   # нота длиннее остатка такта
    xml, _ = M.build(notes, "T", "S", 96)
    root = _parse(xml)

    assert not list(root.iter("tie")), "лиг быть не должно"
    durations = [int(n.findtext("duration") or 0) for n in root.iter("note") if n.find("pitch") is not None]
    assert durations == [int(0.5 * M.DIVISIONS)], "нота обрезана до конца такта (0.5 четверти)"


def test_rests_not_drawn_forward_used() -> None:
    notes = [_note(72, 0, 0.5, "1"), _note(74, 2, 0.5, "1")]
    xml, _ = M.build(notes, "T", "S", 96)
    root = _parse(xml)

    drawn_rests = [n for n in root.iter("note") if n.find("rest") is not None]
    assert drawn_rests == [], "паузы не рисуем — иначе под табом появляются закорючки"
    assert len(list(root.iter("forward"))) >= 1, "пропуски времени идут через <forward>"


def test_unplayable_note_is_dropped_and_counted() -> None:
    # 120 → после сдвига на октаву вниз 108: таких нот на гитаре нет
    notes = [_note(72, 0, 1, "1"), _note(120, 0, 1, "1")]
    xml, stats = M.build(notes, "T", "S", 96)

    assert stats["dropped"] == 1
    assert stats["written"] == 1
    assert "<measure" in xml


def test_every_measure_is_complete() -> None:
    notes = [_note(60 + i, i * 0.5, 0.5, "1") for i in range(8)]
    xml, _ = M.build(notes, "T", "S", 96)
    root = _parse(xml)
    target = int(M.MEASURE * M.DIVISIONS)

    for measure in root.iter("measure"):
        total = 0
        for element in measure:
            if element.tag in ("note", "forward", "backup"):
                duration = element.findtext("duration")
                if duration:
                    total += int(duration) if element.tag != "backup" else -int(duration)
        assert total == target, f"такт {measure.get('number')} неполный: {total} вместо {target}"


def test_octave_is_guitar_written_pitch() -> None:
    """Писаная нота E4 (64) должна звучать как E3 (52) — иначе лады уезжают на 12."""
    notes = [_note(64, 0, 1, "1")]
    xml, _ = M.build(notes, "T", "S", 96)
    root = _parse(xml)
    pitch = next(p for p in (n.find("pitch") for n in root.iter("note")) if p is not None)
    assert pitch.findtext("octave") == "3"
