#!/usr/bin/env python3
"""PDF с НОТАМИ → JSON со списком нот (Audiveris → MusicXML → JSON).

Зачем отдельный модуль: tabocr читает ТАБ-станы по картинке, а здесь нужен
настоящий OMR нотного стана. Audiveris отдаёт MusicXML — его и разбираем на
чистом Python (только стандартная библиотека), чтобы результат можно было
править в браузере.

    notesxml.process_pdf(path, pages=[1]) → {pages, meta}

Что важно знать про данные:
* `<pitch>` в MusicXML — ЗВУЧАЩАЯ высота. `<clef-octave-change>` влияет только
  на запись, поэтому midi считается по pitch; сдвиг ключа отдаём отдельно
  (`octaveShift`, `sounding`), чтобы интерфейс мог предупредить.
* Ритм и размер Audiveris путает — duration отдаём как есть, но UI обязан
  предупредить и дать править.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

VERSION = "0.2.0"
DEFAULT_AUDIVERIS = "/Users/irina/projects/omr-spike/Audiveris.app"
PAGE_TIMEOUT = 180  # секунд на страницу
DPI = 300

STEP_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


class NotesError(RuntimeError):
    """Понятная человеку ошибка: текст уходит в JSON-ответ как есть."""


class AudiverisMissing(NotesError):
    """Audiveris не установлен — сервер отвечает 501 и командой установки."""


# ---------------------------------------------------------------- утилиты


def local_name(tag: str) -> str:
    """Имя тега без namespace: '{ns}note' → 'note'."""
    return tag.rsplit("}", 1)[-1]


def _text(element: ET.Element | None, name: str, default: str | None = None) -> str | None:
    if element is None:
        return default
    for child in element:
        if local_name(child.tag) == name:
            value = (child.text or "").strip()
            return value if value else default
    return default


def _children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if local_name(child.tag) == name]


def _int(value: str | None, default: int) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def midi_of(step: str, alter: float, octave: int) -> int:
    """C#4 → 61, Bb3 → 58. Альтерация дробная (четверть-тон) округляется."""
    step = (step or "C").strip().upper()[:1]
    if step not in STEP_SEMITONES:
        raise NotesError(f"Неизвестная ступень «{step}» в MusicXML.")
    return (int(octave) + 1) * 12 + STEP_SEMITONES[step] + int(round(float(alter or 0)))


# ---------------------------------------------------------------- поиск Audiveris


def find_audiveris() -> Path | None:
    """Путь к Audiveris.app: env AUDIVERIS_APP → известные места → PATH."""
    candidates: list[Path] = []
    env = os.environ.get("AUDIVERIS_APP")
    if env:
        candidates.append(Path(env).expanduser())
    candidates.append(Path(DEFAULT_AUDIVERIS))
    candidates.append(Path("/Applications/Audiveris.app"))
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    found = shutil.which("audiveris")
    return Path(found) if found else None


def audiveris_binary(app: Path) -> Path:
    if app.suffix == ".app":
        return app / "Contents" / "MacOS" / "Audiveris"
    return app


def audiveris_version(app: Path) -> str:
    """Версия из Info.plist; без неё — просто «Audiveris»."""
    plist = app / "Contents" / "Info.plist"
    try:
        text = plist.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "Audiveris"
    short = re.search(r"<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>", text)
    version = short.group(1).strip() if short else "5.x"
    return f"Audiveris {version}"


def _java_home() -> str | None:
    env = os.environ.get("JAVA_HOME")
    if env and Path(env).is_dir():
        return env
    for candidate in ("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
                      "/opt/homebrew/opt/openjdk@17",
                      "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"):
        if Path(candidate, "bin", "java").exists():
            return candidate
    return None


# ---------------------------------------------------------------- запуск Audiveris


def run_audiveris(
    app: Path, source: Path, workdir: Path, sheet: int | None = None, timeout: int = PAGE_TIMEOUT
) -> str:
    """Audiveris batch-экспорт в MusicXML.

    Вход — PDF (сам Audiveris рендерит страницу ≈300 dpi) или .omr. PNG-вход
    сознательно не используется: на одиночной картинке Audiveris падает на
    экспорте (Measure.purgeVoices NPE), а на PDF та же страница проходит.
    """
    binary = audiveris_binary(app)
    if not binary.exists():
        raise NotesError(f"Не найден исполняемый файл Audiveris: {binary}")
    env = dict(os.environ)
    java = _java_home()
    if java:
        env["JAVA_HOME"] = java

    args = [str(binary), "-batch", "-export"]
    if sheet is not None:
        args += ["-sheets", str(sheet)]
    # Без OCR: текст/заголовки нам не нужны, а отсутствующий tessdata иначе
    # валит весь экспорт («Tesseract (legacy) engine … components are not present»).
    args += ["-constant", "org.audiveris.omr.text.tesseract.TesseractOCR.useOCR=false"]
    # «--» обязателен: иначе -sheets может съесть путь как номер листа.
    args += ["-output", str(workdir), "--", str(source)]
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, env=env, check=False
        )
    except subprocess.TimeoutExpired as error:
        raise NotesError(
            f"Audiveris не успел обработать страницу за {timeout} с. "
            "Попробуйте одну страницу или PDF меньшего размера."
        ) from error

    produced = sorted(workdir.rglob("*.mxl")) or sorted(workdir.rglob("*.musicxml")) or sorted(
        workdir.rglob("*.xml")
    )
    if not produced:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        raise NotesError(
            "Audiveris не создал MusicXML. " + (" ".join(tail) if tail else "Лог пуст.")
        )
    # .mxl (zip) — основной результат; .xml в папке бывают служебными (book.xml).
    ordered = sorted(produced, key=lambda p: (p.suffix.lower() != ".mxl", len(p.name)))
    return read_musicxml(ordered[0])


def read_musicxml(path: Path) -> str:
    """Текст MusicXML; .mxl — это zip, где настоящий XML лежит внутри."""
    if path.suffix.lower() == ".mxl":
        import zipfile

        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            root = None
            if "META-INF/container.xml" in names:
                container = archive.read("META-INF/container.xml").decode("utf-8", "replace")
                match = re.search(r'full-path="([^"]+)"', container)
                if match and match.group(1) in names:
                    root = match.group(1)
            if root is None:
                candidates = [n for n in names if n.lower().endswith((".xml", ".musicxml"))]
                if not candidates:
                    raise NotesError("В .mxl нет XML-файла.")
                root = max(candidates, key=lambda n: archive.getinfo(n).file_size)
            return archive.read(root).decode("utf-8", "replace")
    return path.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------- разбор MusicXML


def _clefs(attributes: ET.Element) -> dict[int, int]:
    """staff → clef-octave-change (0, если ключ обычный)."""
    shifts: dict[int, int] = {}
    for clef in _children(attributes, "clef"):
        staff = _int(_text(clef, "staff"), 1)
        shifts[staff] = _int(_text(clef, "clef-octave-change"), 0)
    return shifts


def _part_notes(part: ET.Element) -> dict:
    """Ноты одной партии: плоский список, аккорды идут подряд по возрастанию midi."""
    divisions = 1
    clef_shift: dict[int, int] = {}
    onsets: list[list[dict]] = []
    rests = 0
    pending_chord = False

    for measure in _children(part, "measure"):
        for child in measure:
            name = local_name(child.tag)
            if name == "attributes":
                divisions = _int(_text(child, "divisions"), divisions) or divisions
                clef_shift.update(_clefs(child))
                continue
            if name != "note":
                continue
            if _children(child, "rest"):
                rests += 1
                pending_chord = False  # пауза закрывает предыдущий аккорд
                continue

            pitch = next(iter(_children(child, "pitch")), None)
            if pitch is None:
                continue  # <unpitched> (перкуссия) — не наша музыка

            step = _text(pitch, "step", "C")
            alter = float(_text(pitch, "alter", "0") or 0)
            octave = _int(_text(pitch, "octave"), 4)
            midi = midi_of(step, alter, octave)

            staff = _int(_text(child, "staff"), 1)
            voice = _text(child, "voice", "1")
            duration_units = _int(_text(child, "duration"), divisions)
            entry = {
                "midi": midi,
                "name": note_name(midi),
                "duration": round(duration_units / divisions, 3) if divisions else 1.0,
                "type": _text(child, "type", "quarter"),
                "staff": staff,
                "voice": voice,
                "octaveShift": clef_shift.get(staff, 0),
                "sounding": midi + 12 * clef_shift.get(staff, 0),
            }
            technical = None
            for notations in _children(child, "notations"):
                for tech in _children(notations, "technical"):
                    technical = tech
            if technical is not None:
                string = _text(technical, "string")
                fret = _text(technical, "fret")
                if string is not None and fret is not None:
                    entry["string"] = _int(string, 0)
                    entry["fret"] = _int(fret, 0)

            if _children(child, "chord") and onsets:
                onsets[-1].append(entry)  # продолжение предыдущего аккорда
            elif _children(child, "chord") and not onsets:
                onsets.append([entry])
            else:
                onsets.append([entry])

    notes: list[dict] = []
    for index, group in enumerate(onsets):
        group.sort(key=lambda n: n["midi"])
        for note in group:
            note["onset"] = index
            notes.append(note)
    return {"notes": notes, "rests": rests}


def parse_musicxml(xml_text: str, page: int | None = None) -> dict:
    """MusicXML → {page, notes, warnings, rests, parts}. Аккорды — по возрастанию midi."""
    if not isinstance(xml_text, str) or "<" not in xml_text:
        raise NotesError("Пустой или повреждённый MusicXML.")
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as error:
        raise NotesError(f"MusicXML не разбирается: {error}") from error

    parts = [el for el in root.iter() if local_name(el.tag) == "part"]
    warnings: list[str] = []
    if not parts:
        raise NotesError("В MusicXML нет ни одной партии (<part>).")

    parsed = []
    for part in parts:
        data = _part_notes(part)
        parsed.append((part.get("id") or f"P{len(parsed) + 1}", data))

    # Партии в OMR-выводе бывают пустыми (TAB-стан, барабаны) — берём самую полную.
    parsed.sort(key=lambda item: len(item[1]["notes"]), reverse=True)
    part_id, best = parsed[0]
    if len(parsed) > 1:
        others = ", ".join(f"{pid}: {len(data['notes'])}" for pid, data in parsed[1:])
        warnings.append(
            f"В файле несколько партий — взята самая полная ({part_id}, {len(best['notes'])} нот). "
            f"Остальные: {others}."
        )

    notes = best["notes"]
    if not notes:
        warnings.append("Нот не найдено: Audiveris не увидел нотный стан на этой странице.")

    if any(note.get("octaveShift") for note in notes):
        warnings.append(
            "Ключ с переносом на октаву (8vb/8va): записанные ноты звучат ниже/выше — "
            "сверьте высоты, интерфейс показывает их как в MusicXML."
        )

    return {
        "page": page,
        "notes": notes,
        "warnings": warnings,
        "rests": best["rests"],
        "parts": [{"id": pid, "notes": len(data["notes"]), "rests": data["rests"]} for pid, data in parsed],
    }


# ---------------------------------------------------------------- PDF


def _render_page(pdf: Path, page: int, out_dir: Path, dpi: int = DPI) -> Path | None:
    """Не используется основным путём (см. run_audiveris), оставлено для отладки:
    PNG-страница в 300 dpi для ручной проверки распознавания."""
    exe = shutil.which("pdftoppm")
    if not exe:
        return None
    prefix = out_dir / f"page{page:03d}"
    proc = subprocess.run(
        [exe, "-r", str(dpi), "-png", "-f", str(page), "-l", str(page), str(pdf), str(prefix)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise NotesError(f"pdftoppm не смог отрендерить страницу {page}: {proc.stderr.strip()[:300]}")
    produced = sorted(out_dir.glob(f"{prefix.name}*.png"))
    if not produced:
        raise NotesError(f"pdftoppm не создал картинку для страницы {page}")
    return produced[0]


def pdf_page_count(pdf: Path) -> int:
    exe = shutil.which("pdfinfo")
    if not exe:
        raise NotesError("Не найден pdfinfo (poppler). Установите poppler: brew install poppler.")
    proc = subprocess.run([exe, str(pdf)], capture_output=True, text=True)
    for line in proc.stdout.splitlines():
        if line.lower().startswith("pages:"):
            return _int(line.split(":", 1)[1], 1)
    raise NotesError("Не удалось определить число страниц PDF.")


def parse_pages(header: str | None, total: int) -> list[int]:
    """«1», «1-3», «1,3» → список страниц. По умолчанию — первая."""
    if not header or not header.strip():
        return [1]
    pages: list[int] = []
    for chunk in header.replace(" ", "").split(","):
        if not chunk:
            continue
        if "-" in chunk:
            lo, _, hi = chunk.partition("-")
            start, end = _int(lo, 1), _int(hi, 0)
            if start < 1 or end < start:
                raise NotesError(f"Неверный диапазон страниц «{chunk}».")
            pages.extend(range(start, end + 1))
        else:
            pages.append(_int(chunk, 0))
    pages = sorted({p for p in pages if p >= 1})
    if not pages:
        raise NotesError("Неверный X-Pages: пример «1» или «1-3».")
    return [p for p in pages if p <= total] or [1]


def process_pdf(pdf_path: Path, pages: list[int] | None = None) -> dict:
    """PDF → {pages: [{page, notes, warnings}], meta: {engine, seconds, pages}}."""
    pdf_path = Path(pdf_path)
    if not pdf_path.is_file():
        raise NotesError("PDF не найден.")
    app = find_audiveris()
    if app is None:
        raise AudiverisMissing(
            "Audiveris не найден. Установите его и укажите путь в AUDIVERIS_APP:\n"
            "  brew install --cask audiveris\n"
            "  export AUDIVERIS_APP=/Applications/Audiveris.app\n"
            "Либо загрузите MusicXML из MuseScore/Guitar Pro — это работает без установки."
        )

    total = pdf_page_count(pdf_path)
    wanted = pages or [1]
    started = time.monotonic()
    result_pages: list[dict] = []
    for number in wanted:
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            try:
                xml_text = run_audiveris(app, pdf_path, workdir, sheet=number)
            except NotesError as error:
                result_pages.append({
                    "page": number, "notes": [], "rests": 0, "parts": [],
                    "warnings": [f"Стр. {number}: {error}"],
                })
                continue
            page = parse_musicxml(xml_text, page=number)
            result_pages.append(page)

    return {
        "ok": True,
        "pages": result_pages,
        "meta": {
            "engine": audiveris_version(app),
            "seconds": round(time.monotonic() - started, 1),
            "pages": len(result_pages),
            # Audiveris растеризует PDF сам: A4 = 2479×3508 px ≈ 300 dpi.
            "dpi": DPI,
            "rasterizer": "Audiveris",
            "totalPages": total,
        },
    }
