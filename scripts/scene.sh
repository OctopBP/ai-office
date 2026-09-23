#!/usr/bin/env bash
# Собрать сцену офиса в Blender из нынешней раскладки и выгрузить glTF.
#
#   npm run scene -- studio
#
# Blender берётся из $BLENDER, иначе из обычного места установки на macOS.
# Запуск занимает пару минут: почти всё это время — старт самого Blender.
set -euo pipefail

PRESET="${1:-studio}"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -x "$BLENDER" ]; then
  echo "Blender не найден: $BLENDER" >&2
  echo "Укажи путь: BLENDER=/путь/к/blender npm run scene -- $PRESET" >&2
  exit 1
fi

# Запуск — только через обёртку: фон, заводские настройки и проверка Metal,
# без которой Blender 4.3 в песочнице падает с системным окном (T-116).
# Код выхода Blender не глотаем: раньше `|| true` выдавал падение за успех.
set +e
BLENDER="$BLENDER" "$ROOT/tools/blender/run.sh" "$ROOT/tools/blender/build_scene.py" -- \
  --preset "$PRESET" \
  --blend "design/scenes/$PRESET.blend" \
  --glb "design/scenes/$PRESET.glb" \
  --png "design/scenes/$PRESET.png" \
  | grep -E '^\[build_scene\]|Error|Traceback'
CODE=${PIPESTATUS[0]}
set -e
if [ "$CODE" -ne 0 ]; then
  echo "Blender завершился с кодом $CODE — сцена не собрана" >&2
  exit "$CODE"
fi

python3 "$ROOT/tools/blender/inspect_glb.py" "$ROOT/design/scenes/$PRESET.glb"
