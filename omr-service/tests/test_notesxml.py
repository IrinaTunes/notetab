"""Тесты разбора MusicXML и эндпоинта /notes/pdf.

Ни Audiveris, ни poppler здесь не нужны: парсер — чистая функция, а 501
проверяется на живом HTTP-сервере с подменённым поиском Audiveris.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import notesxml as N  # noqa: E402
import server  # noqa: E402

FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <identification><encoding><software>MuseScore</software></encoding></identification>
  <part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>
      </attributes>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>2</duration><voice>1</voice><type>quarter</type>
        <notations><technical><string>1</string><fret>0</fret></technical></notations>
      </note>
      <note>
        <chord/>
        <pitch><step>B</step><octave>4</octave></pitch>
        <duration>2</duration><voice>1</voice><type>quarter</type>
      </note>
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note>
        <pitch><step>C</step><alter>1</alter><octave>4</octave></pitch>
        <duration>4</duration><voice>2</voice><type>half</type><staff>1</staff>
      </note>
    </measure>
  </part>
</score-partwise>"""


# ---------------------------------------------------------------- парсер


def test_pitch_to_midi() -> None:
    assert N.midi_of("C", 1, 4) == 61
    assert N.midi_of("B", -1, 3) == 58
    assert N.midi_of("E", 0, 5) == 76
    assert N.note_name(61) == "C#4"
    with pytest.raises(N.NotesError):
        N.midi_of("H", 0, 4)


def test_chord_rest_and_notes() -> None:
    page = N.parse_musicxml(FIXTURE, page=1)
    assert page["page"] == 1
    assert len(page["notes"]) == 3, "две ноты аккорда + нота после паузы"
    assert page["rests"] == 1
    assert [n["midi"] for n in page["notes"]] == [71, 76, 61], "аккорд по возрастанию: B4, E5; затем C#4"
    assert [n["onset"] for n in page["notes"]] == [0, 0, 1]
    assert [n["name"] for n in page["notes"]] == ["B4", "E5", "C#4"]
    assert page["notes"][1]["duration"] == 1.0
    assert page["notes"][2]["duration"] == 2.0
    assert page["notes"][2]["voice"] == "2"


def test_octave_clef_shift() -> None:
    page = N.parse_musicxml(FIXTURE, page=1)
    e5 = next(n for n in page["notes"] if n["name"] == "E5")
    assert e5["octaveShift"] == -1
    assert e5["sounding"] == 64
    assert any("8vb" in warning for warning in page["warnings"])


def test_technical_string_and_fret() -> None:
    page = N.parse_musicxml(FIXTURE, page=1)
    e5 = next(n for n in page["notes"] if n["name"] == "E5")
    assert (e5["string"], e5["fret"]) == (1, 0)
    assert "string" not in next(n for n in page["notes"] if n["name"] == "C#4")


def test_several_parts_take_fullest() -> None:
    xml = FIXTURE.replace(
        '<part id="P1">',
        '<part id="P3"><measure number="1"><note><rest/><duration>1</duration></note></measure></part><part id="P1">',
        1,
    )
    page = N.parse_musicxml(xml, page=1)
    assert len(page["notes"]) == 3
    assert page["parts"][0]["id"] == "P1"
    assert {p["id"] for p in page["parts"]} == {"P1", "P3"}
    assert any("несколько партий" in warning for warning in page["warnings"])


def test_broken_xml_raises_readable_error() -> None:
    with pytest.raises(N.NotesError):
        N.parse_musicxml("<score-partwise><part>")
    with pytest.raises(N.NotesError):
        N.parse_musicxml("")


def test_parse_pages() -> None:
    assert N.parse_pages(None, 12) == [1]
    assert N.parse_pages("", 12) == [1]
    assert N.parse_pages("1-3", 12) == [1, 2, 3]
    assert N.parse_pages("2,4", 12) == [2, 4]
    assert N.parse_pages("99", 12) == [1], "страница вне PDF — откат на первую"
    with pytest.raises(N.NotesError):
        N.parse_pages("0", 12)


# ---------------------------------------------------------------- сервис


@pytest.fixture()
def live_server(monkeypatch):
    """Сервер на свободном порту с подменой Audiveris (его нет — ждём 501)."""
    monkeypatch.setattr(N, "find_audiveris", lambda: None)
    monkeypatch.setattr(server, "find_audiveris", lambda: None)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_notes_pdf_without_audiveris_returns_501(live_server: str) -> None:
    request = urllib.request.Request(
        f"{live_server}/notes/pdf",
        data=b"%PDF-1.4 fake",
        headers={"Content-Type": "application/pdf", "X-Filename": "scan.pdf"},
        method="POST",
    )
    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(request, timeout=10)
    assert caught.value.code == 501
    payload = json.loads(caught.value.read().decode("utf-8"))
    assert payload["ok"] is False
    assert "Audiveris не найден" in payload["error"]
    assert payload["error"], "ошибка должна содержать команду установки"


def test_health_reports_audiveris_false(live_server: str) -> None:
    with urllib.request.urlopen(f"{live_server}/health", timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    assert payload["ok"] is True
    assert payload["audiveris"] is False


def test_notes_pdf_rejects_empty_body(live_server: str) -> None:
    request = urllib.request.Request(f"{live_server}/notes/pdf", data=b"", method="POST")
    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(request, timeout=10)
    assert caught.value.code == 400


def test_audiveris_env_precedence(monkeypatch, tmp_path: Path) -> None:
    fake = tmp_path / "Audiveris.app"
    (fake / "Contents" / "MacOS").mkdir(parents=True)
    (fake / "Contents" / "MacOS" / "Audiveris").write_text("#!/bin/sh\n")
    monkeypatch.setenv("AUDIVERIS_APP", str(fake))
    assert N.find_audiveris() == fake
    assert N.audiveris_binary(fake).name == "Audiveris"


def test_audiveris_version_from_plist(tmp_path: Path) -> None:
    app = tmp_path / "Audiveris.app"
    (app / "Contents").mkdir(parents=True)
    (app / "Contents" / "Info.plist").write_text(
        "<plist><dict><key>CFBundleShortVersionString</key><string>5.11.0</string></dict></plist>"
    )
    assert N.audiveris_version(app) == "Audiveris 5.11.0"
