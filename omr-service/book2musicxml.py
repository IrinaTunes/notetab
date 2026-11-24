#!/usr/bin/env python3
"""Книга с нотами (PDF) → табулатуры: MusicXML + PDF на каждую страницу.

Использует локальный сервис notetab (/notes/pdf, 600 dpi) и
`musicxml_export.py` для сборки MusicXML с голосами. PDF собирается MuseScore
(`mscore -o …`), если он установлен.

Пример:
    python3 book2musicxml.py книга.pdf --out ~/Downloads/книга-tabs
    python3 book2musicxml.py книга.pdf --pages 13-14 --out /tmp/test

На каждую страницу:
    page-013.musicxml   — табулатура с голосами (открывается в Guitar Pro/MuseScore)
    page-013.pdf        — тот же таб, свёрстанный MuseScore
    page-013.notes.json — сырые ноты от OMR (для пересборки/правки)
Плюс summary.md: сколько нот на странице, время, страницы без нот.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPORT = ROOT / "musicxml_export.py"


def parse_pages(spec: str | None, total: int) -> list[int]:
    if not spec or spec == "all":
        return list(range(1, total + 1))
    pages: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start, end = chunk.split("-", 1)
            pages.extend(range(int(start), int(end) + 1))
        else:
            pages.append(int(chunk))
    return [p for p in pages if 1 <= p <= total]


def total_pages(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    return 0


def ascii_name(name: str) -> str:
    safe = name.encode("ascii", "ignore").decode().strip()
    return safe or "book.pdf"


def fetch_notes(service: str, pdf: Path, page: int, timeout: int = 600) -> dict:
    request = urllib.request.Request(
        f"{service.rstrip('/')}/notes/pdf",
        data=pdf.read_bytes(),
        method="POST",
        headers={
            "Content-Type": "application/pdf",
            "X-Filename": ascii_name(pdf.name),
            "X-Pages": str(page),
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def build_musicxml(notes_path: Path, out_path: Path, title: str, subtitle: str) -> str:
    result = subprocess.run(
        [sys.executable, str(EXPORT), str(notes_path), "-o", str(out_path),
         "--title", title, "--subtitle", subtitle, "--tempo", "96"],
        capture_output=True, text=True,
    )
    return (result.stdout or result.stderr).strip().splitlines()[-1] if (result.stdout or result.stderr) else ""


def render_pdf(musicxml: Path, pdf_out: Path, mscore: str | None) -> bool:
    if not mscore:
        return False
    result = subprocess.run([mscore, "-o", str(pdf_out), str(musicxml)],
                            capture_output=True, text=True, timeout=300)
    return result.returncode == 0 and pdf_out.exists()


def main() -> int:
    parser = argparse.ArgumentParser(description="PDF с нотами → табы (MusicXML + PDF)")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--pages", default=None, help="1-10 или 1,3,5; по умолчанию все")
    parser.add_argument("--service", default="http://127.0.0.1:8765")
    parser.add_argument("--title", default=None)
    parser.add_argument("--subtitle", default="")
    parser.add_argument("--no-pdf", action="store_true", help="не собирать PDF через MuseScore")
    parser.add_argument(
        "--reuse-json",
        action="store_true",
        help="не ходить в OMR заново, брать готовые page-NNN.notes.json из --out",
    )
    args = parser.parse_args()

    pdf = args.pdf.expanduser().resolve()
    if not pdf.is_file():
        print(f"нет файла: {pdf}", file=sys.stderr)
        return 2

    try:
        with urllib.request.urlopen(f"{args.service.rstrip('/')}/health", timeout=5) as response:
            health = json.loads(response.read().decode("utf-8"))
    except Exception:
        print(f"Сервис не отвечает. Запустите: cd {ROOT} && ./run.sh", file=sys.stderr)
        return 2
    if not health.get("audiveris"):
        print("Audiveris не найден — OMR недоступен.", file=sys.stderr)
        return 2

    mscore = None if args.no_pdf else (shutil.which("mscore") or shutil.which("musescore"))
    out_dir = args.out.expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    total = total_pages(pdf)
    pages = parse_pages(args.pages, total)
    title_base = args.title or pdf.stem

    print(f"{pdf.name}: страниц {total}, обрабатываю {len(pages)} → {out_dir}")
    rows: list[dict] = []
    started = time.time()

    for index, page in enumerate(pages, start=1):
        page_started = time.time()
        print(f"[{index}/{len(pages)}] стр. {page} … ", end="", flush=True)
        cached = out_dir / f"page-{page:03d}.notes.json"
        try:
            if args.reuse_json and cached.is_file():
                payload = json.loads(cached.read_text(encoding="utf-8"))
            else:
                payload = fetch_notes(args.service, pdf, page)
        except Exception as error:  # noqa: BLE001 — сеть, таймаут, 5xx
            print(f"ошибка: {error}")
            rows.append({"page": page, "notes": 0, "error": str(error)[:120]})
            continue

        notes = [n for chunk in payload.get("pages", []) for n in chunk.get("notes", [])]
        if not notes:
            print("нот нет")
            rows.append({"page": page, "notes": 0, "seconds": round(time.time() - page_started, 1)})
            continue

        notes_path = out_dir / f"page-{page:03d}.notes.json"
        notes_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

        xml_path = out_dir / f"page-{page:03d}.musicxml"
        build_musicxml(notes_path, xml_path, f"{title_base} — стр. {page}", args.subtitle)

        pdf_ok = render_pdf(xml_path, out_dir / f"page-{page:03d}.pdf", mscore)
        if not pdf_ok and mscore:
            # MuseScore иногда отказывается открывать двухголосный файл (exit 40),
            # если OMR выдал перекрывающиеся события. Тогда собираем PDF по одному
            # голосу: MusicXML с обоими голосами остаётся на диске, а печатный таб
            # всё равно получается.
            single = dict(payload)
            single["pages"] = [
                {**chunk, "notes": [n for n in chunk.get("notes", []) if str(n.get("voice", "1")) == "1"]}
                for chunk in payload.get("pages", [])
            ]
            single_path = out_dir / f"page-{page:03d}.notes-v1.json"
            single_path.write_text(json.dumps(single, ensure_ascii=False), encoding="utf-8")
            single_xml = out_dir / f"page-{page:03d}.v1.musicxml"
            build_musicxml(single_path, single_xml, f"{title_base} — стр. {page} (мелодия)", args.subtitle)
            pdf_ok = render_pdf(single_xml, out_dir / f"page-{page:03d}.pdf", mscore)
        elapsed = round(time.time() - page_started, 1)
        print(f"нот {len(notes)}, {elapsed} с" + ("" if pdf_ok or not mscore else " (PDF не собрался)"))
        rows.append({"page": page, "notes": len(notes), "seconds": elapsed, "pdf": pdf_ok})

    spent = time.time() - started
    lines = [
        f"# {pdf.name}: табы по страницам",
        "",
        f"Страниц обработано: {len(rows)} из {total}. Время: {spent / 60:.1f} мин.",
        "OMR: Audiveris на 600 dpi, MusicXML с двумя голосами, без лиг и пауз.",
        "",
        "| Стр. | Нот | Сек | PDF |",
        "|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['page']} | {row.get('notes', 0)} | {row.get('seconds', '')} | "
            f"{'да' if row.get('pdf') else '—'} |"
        )
    empty = [row["page"] for row in rows if not row.get("notes")]
    if empty:
        lines += ["", f"Без нот (титулы, текст, пустые): {', '.join(map(str, empty))}"]
    lines += [
        "",
        "Ограничения: ритм приблизительный (OMR), пальцы не проставлены,",
        "на плотных страницах возможны ошибки высот — правка в MuseScore/Guitar Pro.",
    ]
    (out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nГотово за {spent / 60:.1f} мин → {out_dir / 'summary.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
