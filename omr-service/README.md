# omr-service — локальный распознаватель «PDF → таб» и «Ноты PDF → ноты»

Отдельный процесс для вкладки **«PDF → таб»** на сайте notetab. Работает только на `127.0.0.1:8765`, наружу не смотрит, файлы не хранит (временная папка живёт один запрос).

## Запуск

```bash
cd omr-service && ./run.sh
```

При первом запуске скрипт создаёт `.venv`, ставит `numpy` и `pillow`, проверяет наличие `pdftoppm` и `tesseract` и стартует сервер.

Внешние бинарники (ставятся один раз):

```bash
brew install poppler tesseract            # macOS
sudo apt install poppler-utils tesseract-ocr   # Debian/Ubuntu
```

Порт можно поменять: `NOTETAB_OMR_PORT=9100 ./run.sh` (тогда поправьте `SERVICE_URL` в `assets/app.js`).

## CORS и локальная сеть

Сервис отвечает заголовками `Access-Control-Allow-Origin` для `https://irinatunes.github.io` и `http://localhost:*` / `http://127.0.0.1:*`, плюс `Access-Control-Allow-Private-Network: true` (Private Network Access в Chrome).

Даже с этими заголовками новые Chrome/Safari могут блокировать запрос со страницы `https://…` к `127.0.0.1` до явного разрешения пользователя («Local network access»). Если браузер не спрашивает и запрос падает с `TypeError: Failed to fetch`, откройте сайт локально через `python3 -m http.server 8080` и работайте с `http://localhost:8080`.

## Проверка

```bash
curl -s http://127.0.0.1:8765/health
# {"ok": true, "version": "0.2.0", "tesseract": true, "audiveris": true, "engine": "Audiveris 5.11.0"}
```

## API

### `POST /tab/pdf`

Тело: PDF как `application/pdf` (необязательный заголовок `X-Filename`) **или** `multipart/form-data`.

Необязательный `X-Pages: 1,3` — распознать только указанные страницы.

```bash
curl -s -X POST --data-binary @scan.pdf \
     -H "Content-Type: application/pdf" \
     -H "X-Pages: 1" \
     http://127.0.0.1:8765/tab/pdf
```

Ответ:

```json
{
  "pages": [
    {
      "page": 1,
      "staves": [{"index": 0, "lines": [736, 764, 792, 820, 848, 876],
                  "columns": 9, "tokens": 9, "dropped": 41, "tab": "e|...|\nB|..."}],
      "tokens": 9,
      "dropped": 41,
      "tab": "e|0-...|",
      "has_tab": true
    }
  ],
  "combined_tab": "e|...|\nB|...|\n...",
  "warnings": ["Стр. 2: ТАБ-стана не найдено...", "Проверьте распознанный таб глазами..."],
  "meta": {"pages_total": 12, "pages_processed": 12, "dpi": 300, "version": "0.1.0"}
}
```

`combined_tab` — 6 строк ASCII-таба, который сразу разбирается `parseTab` на сайте (системы и страницы разделены `|`).

### `POST /notes/pdf`

Для нотных изданий: Audiveris → MusicXML → JSON со списком нот (см. `notesxml.py`).

```bash
curl -s -X POST --data-binary @theme.pdf -H "Content-Type: application/pdf" \
     -H "X-Pages: 1" http://127.0.0.1:8765/notes/pdf
```

Ответ: `{pages:[{page, notes:[{midi, name, duration, type, staff, voice, onset, octaveShift, sounding}], rests, warnings, parts}], meta:{engine, seconds, pages, dpi, totalPages}}`.

- `X-Pages` — `1`, `1-3` или `1,3`; по умолчанию первая страница.
- Таймаут **180 с на страницу**; одна A4-страница на этой машине — 27–29 с.
- `-sheets N` + `-constant …TesseractOCR.useOCR=false`: текст не распознаём (иначе отсутствующий `tessdata` валит экспорт).
- PNG-вход не используется: на одиночной картинке Audiveris падает на экспорте (`Measure.purgeVoices` NPE), на PDF та же страница проходит.
- Audiveris нет → **501** с командой установки; сервис продолжает работать.

### `POST /omr/pdf` (для отладки)

Отдаёт сырой MusicXML из Audiveris (весь файл). Если Audiveris нет — **501**. Для пользовательского пути используйте `/notes/pdf`, для гитарных табов — `/tab/pdf`.

## Как устроено распознавание

`tabocr.py`:

1. `pdftoppm -r 300 -png` → страница в градациях серого;
2. горизонтальные линии = строки, где «чернил» больше 55 % ширины;
3. группировка в станы с адаптивным порогом (медиана зазоров × 1.6): шаг нотного стана ~19 px, TAB на той же странице ~28 px — фиксированный зазор не работает;
4. 6 линий → TAB-стан, 5 → нотный стан;
5. OCR **всей страницы** при ×2 (`--psm 11`, `tessedit_char_whitelist=0123456789<>`); второй проход при ×2.5 добавляет цифры, которым tesseract в первом проходе поставил `conf=0`; узкие полосы по струнам и `--psm 7` на цифрах между линиями дают пустоту;
6. фильтр: цифра внутри полосы TAB-стана, правее грифа (ключ и надпись «TAB» отсекаются по вертикальным линиям), `conf >= 50`, лад 0..24, разумный размер глифа;
7. струна = ближайшая линия (допуск 0.75 шага);
8. колонки по x с допуском 12 px; на одной струне в колонке остаётся более уверенная цифра;
9. ASCII-таб: после каждого лада обязательный дефис (иначе `1` и `3` склеятся в `13`).

## Тесты

```bash
cd .. && python -m pytest omr-service/tests -q
```

23 теста: `test_notesxml.py` (12) — разбор MusicXML на фикстуре (аккорд, пауза, 8vb, `string`/`fret`, несколько партий, `X-Pages`) и 501 без Audiveris на живом HTTP-сервере; `test_tabocr.py` (11) — синтетическая картинка Pillow (6 линий + 0/3/5/7) → стан распознан как TAB, цифры извлечены, колонки собраны; мусорные лады 34/49, низкая уверенность и токены вне полосы отбрасываются; склейка систем в 6 строк. Тест реального OCR пропускается, если нет `tesseract`.

## Что не поддерживается

- нотный стан без таба в `/tab/pdf` — для него есть `/notes/pdf` (Audiveris);
- рукописные табы и нестандартные шрифты;
- ритм, штрихи, бенды, хаммеры — в ASCII-табе их нет;
- аппликатура пальцев под станом (цифры 1–4) — отбрасывается как шум;
- лады > 24 — считаются ошибкой OCR.
