"""Тесты распознавания ТАБ: геометрия линий, фильтры, сборка колонок, ASCII-таб.

Реальный tesseract нужен только для теста OCR синтетической картинки — он
помечен skip, если бинарника нет (в голом CI без tesseract остальные тесты идут).
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tabocr as T  # noqa: E402


# ---------------------------------------------------------------- синтетика

FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)


def _font(size: int):
    for path in FONT_CANDIDATES:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def make_tab_image(path: Path, frets=(0, 3, 5, 7), with_music_staff: bool = False) -> list[int]:
    """6 линий TAB + цифры ладов на 3-й струне (и 5-я строка, если with_music_staff)."""
    width, height = 1200, 560
    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    font = _font(44)

    def staff(top: int, count: int, step: int) -> list[int]:
        for i in range(count):
            y = top + i * step
            draw.line((40, y, width - 40, y), fill=0, width=2)
        return [top + i * step for i in range(count)]

    tab_lines: list[int] = []
    tab_top = 120
    if with_music_staff:
        staff(20, 5, 20)
        tab_top = 220
    tab_lines = staff(tab_top, 6, 40)

    # цифры на 3-й струне = линия tab_lines[2]
    x = 200
    for fret in frets:
        text = str(fret)
        bbox = draw.textbbox((0, 0), text, font=font)
        draw.text((x - (bbox[2] - bbox[0]) // 2, tab_lines[2] - (bbox[3] - bbox[1]) // 2 - bbox[1]),
                  text, fill=0, font=font)
        x += 180
    image.save(path)
    return tab_lines


def token(value: int, x: int, y: int, conf: float = 90.0, **kwargs) -> T.Token:
    return T.Token(value=value, x=x, y=y, conf=conf, raw=str(value),
                   width=kwargs.pop("width", 18), height=kwargs.pop("height", 28), **kwargs)


# ---------------------------------------------------------------- геометрия


def test_six_lines_become_tab_staff(tmp_path: Path) -> None:
    png = tmp_path / "tab.png"
    expected = make_tab_image(png)
    gray = np.array(Image.open(png).convert("L"))
    lines = T.find_horizontal_lines(gray)
    staves = T.group_staves(lines)
    tab_staves = [s for s in staves if s.is_tab]
    assert len(tab_staves) == 1, f"ожидали один TAB-стан, получили {staves}"
    assert len(tab_staves[0].lines) == 6
    # координаты линий совпадают с нарисованными (±3 px на склейку толщины)
    assert all(abs(a - b) <= 3 for a, b in zip(tab_staves[0].lines, expected))


def test_five_line_staff_is_not_tab_and_table_survives(tmp_path: Path) -> None:
    png = tmp_path / "both.png"
    make_tab_image(png, with_music_staff=True)
    gray = np.array(Image.open(png).convert("L"))
    staves = T.group_staves(T.find_horizontal_lines(gray))
    kinds = sorted((len(s.lines), s.is_tab) for s in staves)
    assert (5, False) in kinds, f"нотный стан не распознан: {kinds}"
    assert (6, True) in kinds, f"TAB-стан не распознан: {kinds}"


def test_adaptive_gap_keeps_tab_whole() -> None:
    """Шаг TAB 28 px и нотного стана 19 px: оба стана должны остаться целыми."""
    lines = [100, 119, 138, 157, 176, 300, 328, 356, 384, 412, 440]
    staves = T.group_staves(lines)
    assert [len(s.lines) for s in staves] == [5, 6]
    assert [s.is_tab for s in staves] == [False, True]


# ---------------------------------------------------------------- токены


def test_parse_token_forms() -> None:
    assert T.parse_token("7") == (7, False)
    assert T.parse_token("<7>") == (7, True)
    assert T.parse_token("(12)") == (12, True)
    assert T.parse_token("12") == (12, False)
    assert T.parse_token("<>") is None
    assert T.parse_token("") is None
    assert T.parse_token("x") is None


def test_garbage_frets_dropped() -> None:
    staff = T.Staff(lines=[100, 128, 156, 184, 212, 240], is_tab=True)
    tokens = [
        token(0, 200, 156),    # 3-я струна
        token(3, 300, 156),
        token(34, 400, 156),   # мусор OCR: такого лада нет
        token(49, 500, 156),   # мусор OCR
        token(7, 600, 240, conf=20),  # низкая уверенность
    ]
    kept, dropped = T.filter_tokens(tokens, staff, body_start=0)
    assert [t.value for t in kept] == [0, 3]
    assert dropped == 3


def test_tokens_outside_band_and_left_of_body_dropped() -> None:
    staff = T.Staff(lines=[100, 128, 156, 184, 212, 240], is_tab=True)
    tokens = [
        token(5, 200, 600),    # далеко ниже стана (подпись/аппликатура)
        token(5, 20, 156),     # в служебной зоне слева («TAB», ключ)
        token(5, 300, 156),    # нормальная
    ]
    kept, dropped = T.filter_tokens(tokens, staff, body_start=100)
    assert [t.value for t in kept] == [5]
    assert dropped == 2


def test_string_by_nearest_line() -> None:
    staff = T.Staff(lines=[100, 128, 156, 184, 212, 240], is_tab=True)
    assert T.assign_string(102, staff) == 0
    assert T.assign_string(155, staff) == 2
    assert T.assign_string(239, staff) == 5


# ---------------------------------------------------------------- сборка


def test_columns_grouped_by_x_and_rendered() -> None:
    staff = T.Staff(lines=[100, 128, 156, 184, 212, 240], is_tab=True)
    tokens = [
        token(0, 200, 156), token(3, 206, 184),   # аккорд: x рядом
        token(5, 400, 156), token(7, 402, 184),   # второй аккорд
    ]
    for t in tokens:
        t.string = T.assign_string(t.y, staff)
    columns = T.build_columns(tokens, tolerance=12)
    assert len(columns) == 2
    assert columns[0] == [(2, 0), (3, 3)]
    tab = T.render_tab(columns)
    rows = tab.split("\n")
    assert len(rows) == 6
    assert rows[0].startswith("e|")
    assert "0-" in rows[2] and "3-" in rows[3]
    # после каждого лада дефис: никаких склеек
    assert "03" not in tab.replace("|", "")


def test_merge_tabs_builds_six_lines() -> None:
    a = T.render_tab([[(2, 0)], [(3, 2)]])
    b = T.render_tab([[(5, 7)]])
    merged = T.merge_tabs([a, b])
    rows = merged.split("\n")
    assert len(rows) == 6
    assert rows[2].count("0-") == 1 and rows[5].count("7-") == 1


def test_empty_columns_render_does_not_crash() -> None:
    tab = T.render_tab([])
    assert len(tab.split("\n")) == 6
    assert T.merge_tabs([]).split("\n")[0] == "e||"


# ---------------------------------------------------------------- реальный OCR


@pytest.mark.skipif(not shutil.which("tesseract"), reason="нет tesseract")
def test_ocr_reads_synthetic_digits(tmp_path: Path) -> None:
    png = tmp_path / "ocr.png"
    make_tab_image(png, frets=(0, 3, 5, 7))
    image = Image.open(png).convert("L")
    gray = np.array(image)
    staff = [s for s in T.group_staves(T.find_horizontal_lines(gray)) if s.is_tab][0]
    tokens = T.ocr_page_image(image)
    if not tokens:  # на идеально чёткой синтетике 2x иногда теряет глифы
        tokens = T.ocr_page_image(image, scale=1.0)
    kept, _ = T.filter_tokens(tokens, staff, body_start=0)
    values = {t.value for t in kept}
    assert len(kept) >= 3, f"OCR не прочитал цифры, получено {sorted(values)}"
    assert values <= set(range(25)), f"в табе оказался мусорный лад: {sorted(values)}"
    assert len(values & {3, 5, 7}) >= 2, f"цифры прочитаны неверно: {sorted(values)}"
    columns = T.build_columns(kept)
    assert len(columns) >= 3, f"колонок {len(columns)}: {columns}"
    assert all(len(c) == 1 and c[0][0] == 2 for c in columns), f"струна определена неверно: {columns}"
