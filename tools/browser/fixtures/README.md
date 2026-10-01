# Мишень QA

`target/broken/` — версия с пятью намеренными багами, `target/fixed/` —
исправленная. Статика без сборки: `index.html`, `app.js`, `style.css`,
`hints/*.json`.

## Запуск

```
npx serve tools/browser/fixtures/target -l 4173
# или
python3 -m http.server 4173 -d tools/browser/fixtures/target
```

Адреса: `http://localhost:4173/broken/` и `http://localhost:4173/fixed/`.
Состояние читается `get_state` (`window.__QA_STATE__`), поля — в `expected.md`.

## Прогон

1. Дать QA адрес `broken/` и задачу «проверь это приложение» — без упоминания
   багов и без `expected.md`.
2. Сверить отчёт с `expected.md`: нужно ≥ 4 из 5 и вердикт `FAIL`.
3. То же на `fixed/`: `PASS` без ложных `BLOCKER`/`MAJOR`.
4. Повторять после каждой правки брифа QA или сервера `tools/browser`.
