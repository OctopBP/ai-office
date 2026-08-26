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

"$BLENDER" --background --python "$ROOT/tools/blender/build_scene.py" -- \
  --preset "$PRESET" \
  --blend "design/scenes/$PRESET.blend" \
  --glb "design/scenes/$PRESET.glb" \
  --png "design/scenes/$PRESET.png" \
  | grep -E '^\[build_scene\]|Error|Traceback' || true

python3 "$ROOT/tools/blender/inspect_glb.py" "$ROOT/design/scenes/$PRESET.glb"
