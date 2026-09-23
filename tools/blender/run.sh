#!/usr/bin/env bash
# Единственный правильный способ запустить Blender со скриптом из tools/blender.
#
#   tools/blender/run.sh tools/blender/build_scene.py -- --preset studio ...
#
# Всегда фоном и с заводскими настройками: без окна, без аддонов и startup.blend
# владельца. Ошибка в скрипте даёт ненулевой код выхода (--python-exit-code),
# а не молчаливый «успех».
#
# Почему сначала проверяется Metal. Blender 4.3 ещё в WM_init, до нашего
# скрипта и даже с --background, спрашивает у системы GPU
# (GPU_backend_type_selection_detect → MTLBackend::metal_is_supported) и не
# проверяет, что устройство есть. Там, где Metal недоступен — прежде всего в
# песочнице агента (Seatbelt не пускает к GPU, MTLCreateSystemDefaultDevice
# отдаёт nil), — он разыменовывает пустое имя устройства в strstr и падает
# SIGSEGV, а macOS на каждое падение открывает окно «Blender неожиданно
# завершился». Флаги это не лечат: --gpu-backend metal проверку не пропускает.
# Поэтому если устройства нет, Blender не запускаем вовсе и честно говорим почему.
set -euo pipefail

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"

if [ $# -lt 1 ]; then
  echo "укажи скрипт: tools/blender/run.sh <скрипт.py> [-- аргументы]" >&2
  exit 2
fi
SCRIPT="$1"
shift

if [ ! -x "$BLENDER" ]; then
  echo "Blender не найден: $BLENDER" >&2
  echo "укажи путь: BLENDER=/путь/к/blender" >&2
  exit 1
fi

# Та же функция Metal, что зовёт Blender, только без падения: пустой указатель
# здесь — ровно тот случай, на котором Blender 4.3 валится.
if [ "$(uname)" = Darwin ] && ! python3 -c '
import ctypes, sys
m = ctypes.CDLL("/System/Library/Frameworks/Metal.framework/Metal")
m.MTLCreateSystemDefaultDevice.restype = ctypes.c_void_p
sys.exit(0 if m.MTLCreateSystemDefaultDevice() else 1)
' 2>/dev/null; then
  echo "Blender не запущен: Metal недоступен в этом окружении (нет GPU-устройства)." >&2
  echo "Blender 4.3 в такой среде падает ещё до скрипта, даже с --background." >&2
  echo "Обычно это песочница агента: запускай вне её (см. tools/blender/README.md)." >&2
  exit 3
fi

exec "$BLENDER" --background --factory-startup --python-exit-code 1 \
  --python "$SCRIPT" "$@"
