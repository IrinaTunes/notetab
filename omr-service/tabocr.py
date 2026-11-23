"""Распознавание гитарных ТАБ-станов со скана: не OMR, а OCR цифр по линиям.

Почему не полный OMR (Audiveris): он не читает ТАБ-станы и путает высоты, а
цифры ладов печатаются обычным шрифтом и ошибка сразу видна (несуществующий лад).

Конвейер страницы:
1) pdftoppm → PNG 300 dpi;
2) поиск горизонтальных линий по «тёмным» строкам;
3) адаптивная группировка в станы: 5 линий = нотный стан, 6 линий = TAB;
4) OCR цифр СО ВСЕЙ СТРАНИЦЫ целиком (psm 11, whitelist), т.к. узкие полосы
   и psm 7 на цифрах между линиями дают пустоту;
5) фильтр: цифра внутри TAB-полосы, правее грифа, conf >= 50, лад 0..24;
6) y-координата → ближайшая линия TAB-стана = струна;
7) сборка колонок по x (допуск 12 px) → ASCII-таб с разделителем после лада.
"""

from __future__ import annotations

import csv
import io
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

VERSION = "0.1.0"

#: Максимальный лад, который считается осмысленным при OCR. Верхний порог
#: намеренно выше, чем MAX_FRET=15 у конвертера: у сканов бывают лады 17–24,
#: отбрасываем только очевидный мусор вроде 34/49/72.
MAX_OCR_FRET = 24
CONF_MIN = 50.0
#: Допуск по x при сборке колонок (px при 300 dpi).
COLUMN_TOLERANCE = 12
#: Увеличение перед OCR. Проверено: 2x заметно лучше 1x и 3x.
OCR_SCALE = 2.0
WHITELIST = "0123456789<>"

LABELS = ("e", "B", "G", "D", "A", "E")

#: `<7>`, `(12)`, `7`, `<12` — цифра либо флажолет в скобках.
TOKEN_RE = re.compile(r"^[<(]\s*(\d{1,3})\s*[>)]?$|^(\d{1,3})$")


class OcrError(RuntimeError):
    """Понятная человеку ошибка распознавания."""


@dataclass
class Staff:
    lines: list[int] = field(default_factory=list)
    is_tab: bool = False

    @property
    def top(self) -> int:
        return self.lines[0]

    @property
    def bottom(self) -> int:
        return self.lines[-1]

    @property
    def spacing(self) -> float:
        return (self.lines[-1] - self.lines[0]) / max(1, len(self.lines) - 1)


@dataclass
class Token:
    value: int
    x: int
    y: int
    conf: float
    raw: str = ""
    width: int = 0
    height: int = 0
    harmonic: bool = False
    string: int | None = None


# ---------------------------------------------------------------- геометрия


def find_horizontal_lines(gray: np.ndarray, threshold: float = 0.55) -> list[int]:
    """Строки, где «чернил» больше threshold от ширины страницы — это линии стана."""
    dark = np.asarray(gray) < 128
    ratio = dark.mean(axis=1)
    rows = np.where(ratio > threshold)[0]
    merged: list[list[int]] = []
    for row in rows:
        if merged and row - merged[-1][-1] <= 2:
            merged[-1].append(int(row))
        else:
            merged.append([int(row)])
    return [int(round(sum(group) / len(group))) for group in merged]


def group_staves(lines: list[int], min_gap: int = 6) -> list[Staff]:
    """Разбить линии на станы с АДАПТИВНЫМ порогом разрыва.

    Шаг внутри стана у разных изданий разный (5-линейный стан ~19 px, TAB на той
    же странице ~28 px), поэтому фиксированный зазор непригоден: он либо склеивает
    соседние станы, либо рвёт TAB на отдельные линии.
    """
    if not lines:
        return []
    if len(lines) < 4:
        return []
    gaps = [b - a for a, b in zip(lines, lines[1:])]
    # Медиана, а не «половина самых маленьких»: при двух станах на странице
    # (нотный + таб) меньшая половина состоит только из зазоров одного из них.
    ordered = sorted(gaps)
    mid = len(ordered) // 2
    median = ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2
    inside = max(min_gap, int(1.6 * median))

    groups: list[list[int]] = [[lines[0]]]
    for line in lines[1:]:
        if line - groups[-1][-1] <= inside:
            groups[-1].append(line)
        else:
            groups.append([line])

    staves: list[Staff] = []
    for group in groups:
        if len(group) < 4:
            continue
        # 6 линий = табулатура, 5 = нотный стан. Больше 6 — склейка, не трогаем.
        staves.append(Staff(lines=group, is_tab=(len(group) == 6)))
    return staves


def find_body_start(gray: np.ndarray, staff: Staff, threshold: float = 0.5) -> int:
    """x, где кончается служебная зона слева (ключ, надпись TAB, скобка).

    В этой зоне печатают «TAB» и ключ; цифры оттуда принимать нельзя, иначе
    буква «B» превратится в «8», а «T» в «1».
    """
    band = np.asarray(gray)[max(0, staff.top - 2) : staff.bottom + 3, :]
    if band.size == 0:
        return 0
    vertical = (band < 128).mean(axis=0)
    columns = np.where(vertical > threshold)[0]
    if columns.size == 0:
        return 0
    return int(columns[0])


def assign_string(y: int, staff: Staff) -> int | None:
    """Струна = ближайшая линия TAB-стана (цифры печатаются на линии)."""
    best, best_distance = None, 10 ** 9
    for index, line in enumerate(staff.lines):
        distance = abs(y - line)
        if distance < best_distance:
            best, best_distance = index, distance
    step = staff.spacing or 1
    if best is None or best_distance > step * 0.75:
        return None
    return best


# ---------------------------------------------------------------- OCR


def parse_token(raw: str) -> tuple[int, bool] | None:
    """'<7>' → (7, True), '(12)' → (12, True), '7' → (7, False), мусор → None."""
    text = (raw or "").strip().replace(" ", "")
    if not text:
        return None
    match = TOKEN_RE.match(text)
    if not match:
        return None
    digits = match.group(1) or match.group(2)
    if not digits:
        return None
    value = int(digits)
    harmonic = bool(match.group(1)) or text.startswith("<") or text.startswith("(")
    return value, harmonic


def run_tesseract(image_path: Path) -> list[Token]:
    """OCR всей страницы: psm 11 + whitelist цифр и скобок флажолета."""
    exe = shutil.which("tesseract")
    if not exe:
        raise OcrError(
            "Не найден tesseract. Установите его: brew install tesseract (macOS) "
            "или apt install tesseract-ocr."
        )
    proc = subprocess.run(
        [exe, str(image_path), "stdout", "--psm", "11",
         "-c", f"tessedit_char_whitelist={WHITELIST}", "tsv"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise OcrError(f"tesseract завершился с ошибкой: {proc.stderr.strip()[:400]}")

    tokens: list[Token] = []
    reader = csv.DictReader(io.StringIO(proc.stdout), delimiter="\t")
    for row in reader:
        parsed = parse_token(row.get("text") or "")
        if parsed is None:
            continue
        try:
            left, top = int(row["left"]), int(row["top"])
            width, height = int(row["width"]), int(row["height"])
            conf = float(row.get("conf") or -1)
        except (KeyError, ValueError):
            continue
        tokens.append(Token(
            value=parsed[0], harmonic=parsed[1], conf=conf,
            x=left + width // 2, y=top + height // 2,
            width=width, height=height, raw=(row.get("text") or "").strip(),
        ))
    return tokens


def ocr_page_image(image: Image.Image, scale: float = OCR_SCALE) -> list[Token]:
    """Увеличить страницу и распознать цифры; координаты возвращаются в исходных px."""
    enlarged = image.resize(
        (int(image.width * scale), int(image.height * scale)), Image.LANCZOS
    )
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "page.png"
        enlarged.save(png)
        tokens = run_tesseract(png)
    for token in tokens:
        token.x = int(round(token.x / scale))
        token.y = int(round(token.y / scale))
        token.width = int(round(token.width / scale))
        token.height = int(round(token.height / scale))
    return tokens


def ocr_page_multi(image: Image.Image, scales: tuple[float, ...] = (2.0, 2.5)) -> list[Token]:
    """Два прохода OCR с разным увеличением и объединение.

    Tesseract в psm 11 иногда ставит conf=0 целой системе, хотя те же цифры при
    другом масштабе читаются с уверенностью 90. Второй проход возвращает эти
    токены, дубликаты снимаются по (x, y).
    """
    merged: list[Token] = []
    for scale in scales:
        for token in ocr_page_image(image, scale):
            duplicate = any(
                other.value == token.value
                and abs(other.x - token.x) <= 8
                and abs(other.y - token.y) <= 8
                for other in merged
            )
            if not duplicate:
                merged.append(token)
    return merged


# ---------------------------------------------------------------- фильтры


def filter_tokens(
    tokens: list[Token],
    staff: Staff,
    body_start: int = 0,
    conf_min: float = CONF_MIN,
    max_fret: int = MAX_OCR_FRET,
) -> tuple[list[Token], int]:
    """Оставить только цифры внутри TAB-полосы; вернуть (годные, число отброшенных).

    Отбрасывается: лад > max_fret (34, 49, 72 — мусор OCR), низкая уверенность,
    цифра вне полосы стана, цифра в служебной зоне слева от грифа, «склейка»
    линии (токен шире, чем 4 высоты).
    """
    kept: list[Token] = []
    dropped = 0
    step = staff.spacing or 1
    for token in tokens:
        in_band = staff.top - step * 0.5 <= token.y <= staff.bottom + step * 0.5
        in_body = token.x >= body_start
        sane_size = token.height <= step * 1.3 and token.width <= max(4 * token.height, 12)
        if (not in_band or not in_body or not sane_size
                or token.value > max_fret or token.conf < conf_min):
            dropped += 1
            continue
        string = assign_string(token.y, staff)
        if string is None:
            dropped += 1
            continue
        token.string = string
        kept.append(token)
    return kept, dropped


# ---------------------------------------------------------------- сборка


def build_columns(tokens: list[Token], tolerance: int = COLUMN_TOLERANCE) -> list[list[tuple[int, int]]]:
    """Сгруппировать цифры по x в колонки → [[(струна, лад), ...], ...].

    Одна струна в колонке один раз: при двух кандидатах остаётся более уверенный.
    """
    columns: list[dict] = []
    for token in sorted(tokens, key=lambda t: t.x):
        if columns and abs(token.x - columns[-1]["x"]) <= tolerance:
            columns[-1]["items"].append(token)
            columns[-1]["x"] = int((columns[-1]["x"] + token.x) / 2)
        else:
            columns.append({"x": token.x, "items": [token]})

    result: list[list[tuple[int, int]]] = []
    for column in columns:
        by_string: dict[int, Token] = {}
        for token in column["items"]:
            current = by_string.get(token.string)  # type: ignore[index]
            if current is None or token.conf > current.conf:
                by_string[token.string] = token  # type: ignore[index]
        result.append([(s, t.value) for s, t in sorted(by_string.items())])
    return result


def _column_width(column: list[tuple[int, int]]) -> int:
    return max((len(str(fret)) for _, fret in column), default=1) + 1


def render_tab(columns: list[list[tuple[int, int]]], labels: tuple[str, ...] = LABELS) -> str:
    """ASCII-таб: 6 строк, после каждого лада — обязательный дефис-разделитель."""
    rows = ["" for _ in labels]
    for column in columns:
        width = _column_width(column)
        cells = ["-" * width for _ in labels]
        for string, fret in column:
            if not 0 <= string < len(labels):
                continue
            digits = str(fret)
            cells[string] = digits + "-" * (width - len(digits))
        for index in range(len(labels)):
            rows[index] += cells[index]
    return "\n".join(f"{labels[i]}|{rows[i]}|" for i in range(len(labels)))


def merge_tabs(tabs: list[str], labels: tuple[str, ...] = LABELS) -> str:
    """Склеить несколько 6-строчных блоков в один (системы/страницы подряд)."""
    blocks = [tab for tab in tabs if tab.strip()]
    if not blocks:
        return "\n".join(f"{label}||" for label in labels)
    bodies: list[list[str]] = []
    for tab in blocks:
        rows = tab.split("\n")
        body = []
        for row in rows[: len(labels)]:
            text = row
            if "|" in text:
                text = text[text.index("|") + 1:]
            if text.endswith("|"):
                text = text[:-1]
            body.append(text)
        bodies.append(body)
    lines = []
    for index, label in enumerate(labels):
        joined = "|".join(body[index] for body in bodies)
        lines.append(f"{label}|{joined}|")
    return "\n".join(lines)


# ---------------------------------------------------------------- страница и PDF


def _render_pdf_page(pdf: Path, page: int, dpi: int, out_dir: Path) -> Path:
    exe = shutil.which("pdftoppm")
    if not exe:
        raise OcrError("Не найден pdftoppm. Установите poppler: brew install poppler.")
    prefix = out_dir / f"page{page:03d}"
    proc = subprocess.run(
        [exe, "-r", str(dpi), "-png", "-f", str(page), "-l", str(page), str(pdf), str(prefix)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise OcrError(f"pdftoppm не смог отрендерить страницу {page}: {proc.stderr.strip()[:300]}")
    produced = sorted(out_dir.glob(f"{prefix.name}*.png"))
    if not produced:
        raise OcrError(f"pdftoppm не создал картинку для страницы {page}")
    return produced[0]


def pdf_page_count(pdf: Path) -> int:
    exe = shutil.which("pdfinfo")
    if not exe:
        raise OcrError("Не найден pdfinfo (poppler).")
    proc = subprocess.run([exe, str(pdf)], capture_output=True, text=True)
    for line in proc.stdout.splitlines():
        if line.lower().startswith("pages:"):
            try:
                return int(line.split(":", 1)[1].strip())
            except ValueError:
                break
    raise OcrError("Не удалось определить число страниц PDF.")


def process_page(image_path: Path, page_number: int) -> dict:
    """Распознать одну страницу. Возвращает словарь для JSON-ответа."""
    image = Image.open(image_path).convert("L")
    gray = np.array(image)
    lines = find_horizontal_lines(gray)
    staves = group_staves(lines)
    tab_staves = [s for s in staves if s.is_tab]

    if not tab_staves:
        return {
            "page": page_number, "staves": [], "tokens": 0, "dropped": 0,
            "tab": "", "has_tab": False,
        }

    tokens = ocr_page_multi(image)
    system_tabs: list[str] = []
    systems: list[dict] = []
    total_kept = total_dropped = 0
    for index, staff in enumerate(tab_staves):
        body_start = find_body_start(gray, staff)
        kept, dropped = filter_tokens(tokens, staff, body_start)
        columns = build_columns(kept)
        tab = render_tab(columns)
        total_kept += len(kept)
        total_dropped += dropped
        systems.append({
            "index": index,
            "lines": staff.lines,
            "columns": len(columns),
            "tokens": len(kept),
            "dropped": dropped,
            "tab": tab,
        })
        if columns:
            system_tabs.append(tab)

    return {
        "page": page_number,
        "staves": systems,
        "tokens": total_kept,
        "dropped": total_dropped,
        "tab": merge_tabs(system_tabs),
        "has_tab": bool(system_tabs),
    }


def process_pdf(
    pdf_path: Path,
    dpi: int = 300,
    max_pages: int | None = None,
    pages: list[int] | None = None,
) -> dict:
    """Полный конвейер PDF → JSON с табом по страницам и общим табом."""
    pdf_path = Path(pdf_path)
    if not pdf_path.is_file():
        raise OcrError("PDF не найден.")
    total = pdf_page_count(pdf_path)
    wanted = pages or list(range(1, total + 1))
    if max_pages:
        wanted = wanted[:max_pages]

    result_pages: list[dict] = []
    warnings: list[str] = []
    tabs: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        for number in wanted:
            png = _render_pdf_page(pdf_path, number, dpi, tmp_dir)
            page = process_page(png, number)
            result_pages.append(page)
            if page["has_tab"]:
                tabs.append(page["tab"])
            else:
                warnings.append(f"Стр. {number}: ТАБ-стана не найдено (только нотный стан или пустая).")
            if page["dropped"]:
                warnings.append(
                    f"Стр. {number}: отброшено токенов {page['dropped']} "
                    f"(вне ТАБ-полосы, низкая уверенность, лад > {MAX_OCR_FRET} или склейка линий)."
                )

    combined = merge_tabs(tabs)
    if not tabs:
        warnings.insert(0, "ТАБ не распознан ни на одной странице.")
    warnings.append("Проверьте распознанный таб глазами: OCR иногда склеивает соседние цифры.")
    return {
        "pages": result_pages,
        "combined_tab": combined,
        "warnings": warnings,
        "meta": {
            "pages_total": total,
            "pages_processed": len(result_pages),
            "dpi": dpi,
            "version": VERSION,
        },
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="PDF со скана → ASCII-таб (JSON на stdout)")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--pages", type=str, default=None, help="например 1,3")
    parser.add_argument("--max-pages", type=int, default=None)
    args = parser.parse_args(argv)

    pages = [int(p) for p in args.pages.split(",")] if args.pages else None
    try:
        data = process_pdf(args.pdf, dpi=args.dpi, max_pages=args.max_pages, pages=pages)
    except OcrError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
