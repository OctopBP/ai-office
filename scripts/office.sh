#!/usr/bin/env bash
# Запуск офиса как приложения: собранный веб и WebSocket одним процессом
# на одном порту, без vite и без watch. Запущенный процесс держит код в
# памяти, поэтому команда может править исходники офиса, не роняя его.
#
#   npm run office              — запустить
#   npm run office -- --restart — перезапустить работающий
#   npm run office -- --force   — не спрашивать про задачи в работе
set -u
PORT="${OFFICE_PORT:-3001}"
RESTART=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --force) FORCE=1; RESTART=1 ;;
    *) echo "Неизвестный аргумент: $arg"; exit 2 ;;
  esac
done

busy() { lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

# Проверки идут ДО остановки старого процесса: если код не компилируется,
# офис остаётся работать на прежнем, а не падает вместе с правкой.
echo "🔎 Проверка типов…"
if ! npm run --silent typecheck; then
  echo "ОШИБКА: типы не сходятся. Офис не тронут."; exit 1
fi

echo "📦 Сборка веба…"
if ! npm run --silent build; then
  echo "ОШИБКА: сборка не прошла. Офис не тронут."; exit 1
fi

if busy; then
  if [ "$RESTART" = 0 ]; then
    echo "Порт $PORT занят — похоже, офис уже работает."
    echo "Перезапустить: npm run office -- --restart"
    exit 1
  fi
  # Перезапуск обрывает живые сессии исполнителей: их задачи вернутся как
  # прерванные, а наработки останутся в ветках. Молча так делать нельзя.
  if [ "$FORCE" = 0 ]; then
    RUNNING=$(python3 scripts/running-tasks.py 2>/dev/null || echo '')
    if [ -n "$RUNNING" ]; then
      echo "В работе задачи: $RUNNING"
      echo "Перезапуск оборвёт их сессии. Дождитесь или остановите задачи,"
      echo "либо запустите с --force."
      exit 1
    fi
  fi
  echo "⏹ Останавливаю прежний офис…"
  for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null; done
  for _ in $(seq 1 30); do busy || break; sleep 0.3; done
  if busy; then
    for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
    for _ in $(seq 1 20); do busy || break; sleep 0.3; done
  fi
  if busy; then echo "ОШИБКА: порт $PORT так и занят"; exit 1; fi
fi

echo "🏢 Запускаю офис на http://localhost:$PORT"
exec npx tsx src/server/index.ts
