#!/usr/bin/env bash
# Открыть модель предмета в Blender.
#
#   npm run model -- chair                 единственная модель пресета
#   npm run model -- desk computerScreen   когда моделей несколько
#
# Blender не открывает glTF как документ — открывать он умеет только .blend,
# а `.glb` надо импортировать. Поэтому запускаем его с готовым импортом:
# пустой файл плюс одна модель.
#
# Ровно одна модель за раз, и это намеренно. У стола их две (`desk` и
# `computerScreen`), и если втащить обе, экспорт обратно записал бы их в один
# файл — предмет склеился бы в одну модель, а `at` и `rot` из пресета потеряли
# бы смысл. Собранный предмет смотрят не здесь, а на стенде (`?fit=1`).
set -euo pipefail
# Глоб без совпадений должен давать пустой список, а не сам образец: ниже по
# нему бегут циклы, и `design/presets/*/*.glb` буквальной строкой выглядел бы
# как найденный файл. Через `ls` то же самое не сделать — под `pipefail` он
# роняет скрипт молча, раньше, чем успевает напечататься объяснение.
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
ID="${1:-}"
PART="${2:-}"

if [ -z "$ID" ]; then
  echo "укажи пресет: npm run model -- <id> [часть]" >&2
  echo "с моделями:" >&2
  for d in "$ROOT"/design/presets/*/; do
    parts=("$d"*.glb)
    [ ${#parts[@]} -gt 0 ] && echo "  $(basename "$d")" >&2
  done
  exit 1
fi

DIR="$ROOT/design/presets/$ID"
[ -d "$DIR" ] || { echo "нет пресета: $ID" >&2; exit 1; }

if [ -n "$PART" ]; then
  FILE="$DIR/${PART%.glb}.glb"
else
  PARTS=("$DIR"/*.glb)
  if [ ${#PARTS[@]} -eq 0 ]; then
    echo "у пресета $ID нет моделей — он рисуется примитивом (поле fallback)" >&2
    exit 1
  fi
  if [ ${#PARTS[@]} -gt 1 ]; then
    echo "у пресета $ID несколько моделей, назови нужную:" >&2
    for f in "${PARTS[@]}"; do echo "  $(basename "$f")" >&2; done
    exit 1
  fi
  FILE="${PARTS[0]}"
fi

[ -f "$FILE" ] || { echo "нет файла: $FILE" >&2; exit 1; }
[ -x "$BLENDER" ] || {
  echo "Blender не найден: $BLENDER" >&2
  echo "укажи путь: BLENDER=/путь/к/blender npm run model -- $ID" >&2
  exit 1
}

echo "открываю $FILE"
echo "сохранение: Ctrl+S — пишет .glb обратно в этот же файл"
echo "масштаб не менять: модель в единицах набора (единица = 2 м), офис множит сам"
echo "заставку Blender закрой щелчком — модель за ней, камера уже наведена"

# Питон живёт своим файлом, а не строкой внутри bash: он вырос до операторa с
# горячей клавишей, а Python внутри кавычек внутри shell не читается и не
# правится.
export OFFICE_MODEL="$FILE"
exec "$BLENDER" --python "$ROOT/tools/blender/edit_model.py"
