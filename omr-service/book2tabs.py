#!/usr/bin/env python3
"""Перевод книги с нотами (PDF) в табулатуры: пакетная обработка страниц.

Работает поверх локального сервиса omr-service (Audiveris) и модуля раскладки
из src/solver.js — той же логики, что в браузере, поэтому варианты совпадают.

Примеры:
    python3 book2tabs.py ~/Downloads/noty/book.pdf --pages 1-10
    python3 book2tabs.py ~/Downloads/noty/book.pdf --pages 1-3 --variants 2 --max-fret 12
    python3 book2tabs.py ~/Downloads/noty/book.pdf            # все страницы

Результат в --out (по умолчанию рядом с PDF, папка <имя>-tabs):
    page-004.tab.txt   — варианты табов для страницы
    page-004.notes.txt — список нот, если нужно поправить руками и пересчитать
    summary.md         — что получилось, где мало нот, сколько заняло времени
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
NODE_HELPER = ROOT / "scripts" / "notes-json-to-tabs.mjs"


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


def call_service(service: str, pdf: Path, page: int, timeout: int = 400) -> dict:
    data = pdf.read_bytes()
    request = urllib.request.Request(
        f"{service.rstrip('/')}/notes/pdf",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/pdf",
            "X-Filename": pdf.name,
            "X-Pages": str(page),
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def to_tabs(midis: list[int], tuning: str, max_fret: int, stretch: int) -> dict:
    payload = json.dumps({
        "notes": midis,
        "tuning": tuning,
        "maxFret": max_fret,
        "stretch": stretch,
    }).encode("utf-8")
    result = subprocess.run(
        ["node", str(NODE_HELPER)],
        input=payload,
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0:
        return {"variants": [], "error": result.stderr.decode("utf-8", "ignore")[:300]}
    return json.loads(result.stdout.decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="PDF с нотами → табы, пакетно")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--pages", default=None, help="например 1-10 или 1,3,5; по умолчанию все")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--service", default="http://127.0.0.1:8765")
    parser.add_argument("--variants", type=int, default=3, help="сколько вариантов писать в файл")
    parser.add_argument("--tuning", default="standard")
    parser.add_argument("--max-fret", type=int, default=12)
    parser.add_argument("--stretch", type=int, default=4)
    parser.add_argument("--skip-empty", action="store_true", help="не писать страницы без нот")
    args = parser.parse_args()

    pdf = args.pdf.expanduser().resolve()
    if not pdf.is_file():
        print(f"нет файла: {pdf}", file=sys.stderr)
        return 2

    try:
        with urllib.request.urlopen(f"{args.service.rstrip('/')}/health", timeout=5) as response:
            health = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError):
        print(
            "Локальный сервис не отвечает. Запустите:\n"
            f"  cd {ROOT / 'omr-service'} && ./run.sh",
            file=sys.stderr,
        )
        return 2

    if not health.get("audiveris"):
        print("Сервис запущен, но Audiveris не найден — распознавание нот недоступно.", file=sys.stderr)
        return 2

    total = total_pages(pdf)
    pages = parse_pages(args.pages, total)
    if not pages:
        print("не выбрано ни одной страницы", file=sys.stderr)
        return 2

    out_dir = args.out or (pdf.parent / f"{pdf.stem}-tabs")
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"{pdf.name}: страниц в файле {total}, обрабатываю {len(pages)} → {out_dir}")
    summary: list[dict[str, Any]] = []
    started = time.time()

    for index, page in enumerate(pages, start=1):
        print(f"[{index}/{len(pages)}] стр. {page} … ", end="", flush=True)
        page_started = time.time()
        try:
            payload = call_service(args.service, pdf, page)
        except Exception as exc:  # noqa: BLE001 — сеть/таймаут/500
            print(f"ошибка: {exc}")
            summary.append({"page": page, "notes": 0, "error": str(exc)[:200]})
            continue

        notes = []
        for chunk in payload.get("pages", []):
            notes.extend(chunk.get("notes", []))
        midis = [int(n["midi"]) for n in notes if n.get("midi")]
        elapsed = time.time() - page_started
        print(f"нот {len(midis)}, {elapsed:.0f} с")

        if not midis and args.skip_empty:
            summary.append({"page": page, "notes": 0, "seconds": round(elapsed, 1)})
            continue

        (out_dir / f"page-{page:03d}.notes.txt").write_text(
            " ".join(str(m) for m in midis) + "\n", encoding="utf-8"
        )

        if midis:
            result = to_tabs(midis, args.tuning, args.max_fret, args.stretch)
            variants = result.get("variants") or []
            body = [f"# {pdf.stem}, страница {page}", f"# нот: {len(midis)}", ""]
            for number, variant in enumerate(variants[: args.variants], start=1):
                body.append(f"== {number}. {variant.get('title')} — {variant.get('description')}")
                body.append(variant.get("tab", ""))
                body.append("")
            if not variants:
                body.append(f"# раскладка не удалась: {result.get('error', 'нет вариантов')}")
            (out_dir / f"page-{page:03d}.tab.txt").write_text("\n".join(body), encoding="utf-8")

        summary.append({
            "page": page,
            "notes": len(midis),
            "seconds": round(elapsed, 1),
            "warnings": payload.get("warnings", [])[:3],
        })

    total_seconds = time.time() - started
    lines = [
        f"# {pdf.name} → табы",
        "",
        f"Страниц: {len(pages)} из {total}. Время: {total_seconds / 60:.1f} мин.",
        "",
        "| Стр. | Нот | Сек | Замечания |",
        "|---|---|---|---|",
    ]
    for item in summary:
        warn = "; ".join(str(w) for w in (item.get("warnings") or []))[:80]
        if item.get("error"):
            warn = f"ошибка: {str(item['error'])[:80]}"
        lines.append(f"| {item['page']} | {item.get('notes', 0)} | {item.get('seconds', '')} | {warn} |")
    empty = [item["page"] for item in summary if not item.get("notes")]
    if empty:
        lines += ["", f"Страницы без нот (проверить глазами): {', '.join(map(str, empty))}"]
    lines += [
        "",
        "Ноты — черновик Audiveris: ритм и размер не переносятся, отдельные высоты могут ошибаться.",
        "Для правки: page-NNN.notes.txt → вкладка «Ноты → таб» на сайте или правка в «Ноты PDF → таб».",
    ]
    (out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"\nГотово за {total_seconds / 60:.1f} мин. Итог: {out_dir / 'summary.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
