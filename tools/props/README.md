# tools/props — генерация пропсов через Nano Banana

Отдельный мини-пакет (свои зависимости), к коду офиса в `src/` не относится.
Список пропсов и стиль — из Figma-фрейма «09 · Пропсы для генерации».

```
props.json        список пропсов: id, категория, размер в тайлах, темы, приоритет, промпт
characters.json   позы персонажей и раскладка спрайт-листа
style.json        префиксы стиля, палитры тем, роли, хромакей, модели
picks.json        (создаёте сами) выбранные варианты: { "A/desk_south": 2, "characters/backend/idle_south": 3 }
refs/style_ref.png  якорь стиля — сделать руками (см. шаг 1)
raw/              всё, что сгенерировано (+ .json с промптом/моделью/референсами)
out/              принятые обработанные ассеты + manifest.json
board/            контакт-листы для ревью
```

## Установка

```bash
cd tools/props
npm install
cp .env.example .env   # вставить GEMINI_API_KEY
```

## Пайплайн

**1. Якорь стиля (руками, один раз).** В Gemini / AI Studio сгенерируйте hero-картинку (стол + стул + монитор + растение + персонаж в синем худи) по промпту из Figma-фрейма 09, доведите диалогом («толще обводку», «меньше наклон») и сохраните как `refs/style_ref.png`. Он прикладывается ко всем запросам — это главный рычаг консистентности.

**2. Генерация.**
```bash
npm run list                                     # что есть в базе (фильтры те же)
npm run gen -- --theme A --priority 1 --dry      # посмотреть промпты без запросов
npm run gen -- --theme A --cat floor,wall        # шаг за шагом по категориям
npm run gen -- --theme A --cat desk
npm run gen -- --theme A --cat object --model pro
npm run gen -- --theme A --cat decor
```
Флаги: `--variants 3` · `--only id1,id2` · `--priority 1|2|3` · `--model flash|pro` · `--force` · `--no-refs` · `--concurrency 2`.
Референсы подбираются сами: `style_ref.png` + до 2 уже принятых ассетов той же категории из `out/{theme}/` —
поэтому выгодно идти по категориям и принимать (post) лучшие перед следующей партией.

**3. Ревью.**
```bash
npm run board -- --theme A            # board/A/{cat}.png: слева raw, справа после хромакея/даунскейла
```
Закиньте PNG в Figma (фрейм «10 · Ревью пропсов») или откройте локально; выбранные номера запишите в `picks.json`.
Не понравилось — уточните промпт в `props.json` и `npm run gen -- --only <id> --force`.

**4. Постобработка.**
```bash
npm run post -- --theme A             # raw → out/A/{id}.png (хромакей → обрезка → вписать в box, якорь снизу → ≤32 цветов) + manifest.json
npm run board -- room --theme A       # board/A/room.png — принятые ассеты в куске комнаты: проверка обводки/наклона/масштаба
```

**5. Персонажи.**
```bash
npm run gen -- chars --role backend                  # anchor (idle_south, Pro) → остальные позы p=1 с anchor как референсом
npm run board -- chars --role backend                # выбрать варианты → picks.json
npm run post -- chars --role backend                 # out/characters/backend/{pose}.png (128×192)
npm run sheet -- --role backend                      # out/characters/backend.sheet.png + .sheet.json (атлас + анимации)
npm run gen -- chars --role backend --priority 2     # добить позы второй очереди
```
Совет: сначала сгенерируйте только anchor (`--poses idle_south --model pro --variants 4`), выберите лучший, `post`, и только потом остальные позы — они копируют anchor.

**6. Другие темы.** Тема C — те же промпты с палитрой C и уже принятыми ассетами темы A в референсах:
`npm run gen -- --theme C --priority 1`. (Edit-режим «перекрась в палитру C» — следующий шаг, если перегенерация даёт расхождения формы.)

## Как это работает
- Модели: `gemini-3.1-flash-image` (Nano Banana 2, по умолчанию) и `gemini-3-pro-image` (Pro — для `task_board`, anchor персонажей и всего, где `--model pro`). Переопределить: `PROPS_MODEL_FLASH/PRO` в `.env` или `style.json → models`.
- API: Interactions (`ai.interactions.create`) с фолбэком на `generateContent` для старых SDK.
- Прозрачности у модели нет → генерим на плоском фоне `key_color` (#FF00FF; для розовых/фиолетовых пропсов `bg: "#00FF00"`) и вырезаем хромакеем (`key_hard/key_soft` в style.json). Полупрозрачные края un-premultiply’ятся относительно цвета фона.
- Размер: `box` в тайлах × 32 px × `scale` 4 → например стол 2×1.5 → 256×192 px, якорь по нижнему краю. Тайлы пола — точный ресайз без хромакея.
- Seed у модели нет: воспроизводимость = промпт + референсы + `.json` рядом с каждым raw.

## Без API-биллинга: ручная генерация через чат (T3 Chat, Gemini, …)

```bash
npm run prompts -- --theme A --cat floor,wall --priority 1   # → prompts/A_floor-wall_p1.md (блоки для вставки) + .json
npm run prompts -- chars --role backend --poses idle_south   # anchor персонажа
# … генерите в чате с прикреплённым refs/style_ref.png, скачиваете картинки в ~/Downloads в том же порядке …
npm run import -- --pack A_floor-wall_p1 --from ~/Downloads --since 1h [--per 3] [--dry]
npm run board -- --theme A  →  picks.json  →  npm run post -- --theme A
```
Файлы, названные как id пропса (`desk_south.png`, `desk_south_2.png`), привязываются по имени; остальные — по времени скачивания в порядке пакета. Одиночный файл: `npm run import -- --file ~/Downloads/x.png --id desk_south --theme A`.
