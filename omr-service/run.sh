#!/usr/bin/env bash
# Одна команда: поднимает локальный сервис «PDF → таб» на 127.0.0.1:8765.
# При первом запуске создаёт .venv и ставит numpy + pillow.
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Не найден python3. Установите Python 3.9+ и повторите." >&2
  exit 1
fi

if [ ! -d .venv ]; then
  echo "Первый запуск: создаю .venv и ставлю зависимости…"
  "$PYTHON" -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

for bin in pdftoppm tesseract; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Внимание: не найден $bin. Нужен для рендера PDF/OCR:" >&2
    echo "  macOS: brew install poppler tesseract" >&2
    echo "  Debian/Ubuntu: sudo apt install poppler-utils tesseract-ocr" >&2
  fi
done

exec ./.venv/bin/python server.py
