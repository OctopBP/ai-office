# Как запускать Blender

Скрипты отсюда запускаются только через обёртку:

```
tools/blender/run.sh tools/blender/<скрипт>.py -- <аргументы скрипта>
npm run scene -- studio          # уже идёт через run.sh
```

Обёртка запускает `Blender --background --factory-startup --python-exit-code 1`:
без окна, без аддонов и настроек владельца, с ненулевым кодом выхода при
ошибке в скрипте. Путь к Blender — `$BLENDER`, по умолчанию
`/Applications/Blender.app/Contents/MacOS/Blender`.

`npm run model` — исключение: он открывает Blender с окном для правки руками,
и запускает его человек в своём терминале, а не агент.

## Почему Blender падал с окном «Blender неожиданно завершился» (T-116)

Blender 4.3.2 при старте (`WM_init` → `GPU_backend_type_selection_detect` →
`MTLBackend::metal_is_supported`) спрашивает у macOS устройство Metal и не
проверяет, что оно есть. В песочнице агента доступа к GPU нет,
`MTLCreateSystemDefaultDevice()` возвращает nil, и Blender падает SIGSEGV в
`strstr` внутри `supports_barycentric_whitelist` — ещё до нашего скрипта и
даже с `--background --factory-startup`. На каждое падение macOS показывает
системное окно. Флаги не помогают: `--gpu-backend metal` эту проверку не
пропускает.

Поэтому `run.sh` сначала сам зовёт `MTLCreateSystemDefaultDevice()` и, если
устройства нет, Blender не запускает (код выхода 3, объяснение в stderr).

Чтобы Blender работал у агента, его надо запускать вне песочницы — например,
добавить путь к Blender в исключения песочницы Claude Code
(`sandbox.excludedCommands` в настройках). Это решает владелец.
