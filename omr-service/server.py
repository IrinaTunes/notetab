#!/usr/bin/env python3
"""Локальный сервис распознавания PDF → таб для сайта notetab.

Только стандартная библиотека + numpy/pillow (их требуют PIL-операции в tabocr).
Слушает строго 127.0.0.1:8765 — наружу ничего не отдаётся, файлы не сохраняются
дольше одного запроса.

    GET  /health      → {"ok":true,"version":"0.1.0"}
    POST /tab/pdf     → JSON с распознанным табом
    POST /omr/pdf     → MusicXML (только если найден Audiveris, иначе 501)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import tabocr

HOST = "127.0.0.1"
PORT = int(os.environ.get("NOTETAB_OMR_PORT", "8765"))
MAX_UPLOAD = 40 * 1024 * 1024  # 40 MB
ALLOWED_ORIGIN_RE = re.compile(r"^(https://irinatunes\.github\.io|http://localhost(:\d+)?|http://127\.0\.0\.1(:\d+)?)$")


# ---------------------------------------------------------------- multipart


def parse_multipart(content_type: str, body: bytes) -> tuple[bytes, str]:
    """Достать первый файл из multipart/form-data. Возвращает (данные, имя файла)."""
    message = BytesParser(policy=email_policy).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\n\r\n" + body
    )
    for part in message.iter_parts():
        filename = part.get_filename() or ""
        payload = part.get_payload(decode=True)
        if payload:
            return bytes(payload), filename
    raise ValueError("В multipart-запросе нет файла.")


def extract_pdf(body: bytes, content_type: str, header_name: str) -> tuple[bytes, str]:
    ctype = (content_type or "").lower()
    if ctype.startswith("multipart/form-data"):
        return parse_multipart(content_type, body)
    return body, header_name or "upload.pdf"


# ---------------------------------------------------------------- Audiveris


def find_audiveris() -> Path | None:
    """Audiveris — экспериментальный путь для НОТНЫХ изданий; не обязателен."""
    candidates = []
    env = os.environ.get("AUDIVERIS_APP")
    if env:
        candidates.append(Path(env))
    candidates.append(Path("/Users/irina/projects/omr-spike/Audiveris.app"))
    candidates.append(Path("/Applications/Audiveris.app"))
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    found = shutil.which("audiveris")
    return Path(found) if found else None


def read_musicxml(path: Path) -> str:
    """MusicXML из файла; .mxl — это zip с META-INF/container.xml."""
    if path.suffix.lower() == ".mxl":
        import zipfile

        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            root = None
            if "META-INF/container.xml" in names:
                container = archive.read("META-INF/container.xml").decode("utf-8", "replace")
                match = re.search(r'full-path="([^"]+)"', container)
                if match:
                    root = match.group(1)
            if root is None or root not in names:
                candidates = [n for n in names if n.lower().endswith((".xml", ".musicxml"))]
                if not candidates:
                    raise RuntimeError("В .mxl нет XML-файла.")
                root = max(candidates, key=lambda n: archive.getinfo(n).file_size)
            return archive.read(root).decode("utf-8", "replace")
    return path.read_text(encoding="utf-8", errors="replace")


def run_audiveris(app: Path, pdf: Path, workdir: Path) -> str:
    """Batch-импорт PDF в MusicXML; возвращает текст MusicXML."""
    binary = app / "Contents" / "MacOS" / "Audiveris" if app.suffix == ".app" else app
    if not binary.exists():
        raise RuntimeError(f"Не найден исполняемый файл Audiveris: {binary}")
    # «--» обязателен: -sheets съедает следующий аргумент как номер листа.
    subprocess.run(
        [str(binary), "-batch", "-export", "-output", str(workdir), "--", str(pdf)],
        check=True, capture_output=True, timeout=900,
    )
    produced = (
        sorted(workdir.rglob("*.musicxml"))
        + sorted(workdir.rglob("*.mxl"))
        + sorted(workdir.rglob("*.xml"))
    )
    if not produced:
        raise RuntimeError("Audiveris не создал MusicXML.")
    # .mxl (zip) компактнее и появляется первым; .xml в папке — служебные book.xml
    ordered = sorted(produced, key=lambda p: (p.suffix.lower() != ".mxl", len(p.name)))
    return read_musicxml(ordered[0])


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = f"notetab-omr/{tabocr.VERSION}"
    protocol_version = "HTTP/1.1"

    # ---- служебное

    def log_message(self, format: str, *args) -> None:  # noqa: A002 — тише в консоли
        print(f"[omr] {self.address_string()} {format % args}")

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin and ALLOWED_ORIGIN_RE.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, X-Filename"
        )
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _xml(self, status: int, text: str) -> None:
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/vnd.recordare.musicxml+xml; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("Пустое тело запроса: приложите PDF.")
        if length > MAX_UPLOAD:
            raise ValueError(f"Файл больше {MAX_UPLOAD // (1024 * 1024)} МБ.")
        return self.rfile.read(length)

    # ---- методы

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/health/"):
            self._json(200, {"ok": True, "version": tabocr.VERSION, "tesseract": bool(shutil.which("tesseract"))})
            return
        self._json(404, {"ok": False, "error": "Неизвестный путь. Доступны /health, /tab/pdf, /omr/pdf."})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self._read_body()
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return

        if path in ("/tab/pdf", "/tab/pdf/"):
            self._handle_tab(body)
        elif path in ("/omr/pdf", "/omr/pdf/"):
            self._handle_omr(body)
        else:
            self._json(404, {"ok": False, "error": "Неизвестный путь. Доступны /health, /tab/pdf, /omr/pdf."})

    # ---- обработчики

    def _handle_tab(self, body: bytes) -> None:
        try:
            payload, filename = extract_pdf(body, self.headers.get("Content-Type", ""), self.headers.get("X-Filename", ""))
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return
        if not payload:
            self._json(400, {"ok": False, "error": "Пустой файл."})
            return

        pages_header = self.headers.get("X-Pages", "").strip()
        pages = None
        if pages_header:
            try:
                pages = [int(p) for p in pages_header.split(",") if p.strip()]
            except ValueError:
                self._json(400, {"ok": False, "error": "X-Pages должен быть списком номеров: 1,3,5"})
                return

        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / (Path(filename or "upload.pdf").name or "upload.pdf")
            if not pdf_path.suffix.lower() == ".pdf":
                pdf_path = pdf_path.with_suffix(".pdf")
            pdf_path.write_bytes(payload)
            try:
                result = tabocr.process_pdf(pdf_path, pages=pages)
            except tabocr.OcrError as error:
                self._json(422, {"ok": False, "error": str(error)})
                return
            except Exception as error:  # noqa: BLE001 — наружу отдаём текст, не трейс
                self._json(500, {"ok": False, "error": f"Сбой распознавания: {error}"})
                return

        self._json(200, result)

    def _handle_omr(self, body: bytes) -> None:
        app = find_audiveris()
        if app is None:
            self._json(501, {
                "ok": False,
                "error": (
                    "Audiveris не найден. Полный OMR (нотные издания) — экспериментальный путь: "
                    "скачайте Audiveris.app и укажите путь в env AUDIVERIS_APP. "
                    "Для гитарных ТАБ используйте /tab/pdf."
                ),
            })
            return
        try:
            payload, filename = extract_pdf(body, self.headers.get("Content-Type", ""), self.headers.get("X-Filename", ""))
        except ValueError as error:
            self._json(400, {"ok": False, "error": str(error)})
            return
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / (Path(filename or "upload.pdf").name or "upload.pdf")
            pdf_path.write_bytes(payload)
            try:
                xml_text = run_audiveris(app, pdf_path, Path(tmp))
            except Exception as error:  # noqa: BLE001
                self._json(500, {"ok": False, "error": f"Audiveris не справился: {error}"})
                return
        self._xml(200, xml_text)


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"notetab OMR: http://{HOST}:{PORT}  (health: /health, таб: POST /tab/pdf)")
    print("Остановить: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
