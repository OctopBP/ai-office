#!/usr/bin/env bash
# Надёжный перезапуск сервера офиса.
# pkill по имени watcher'а недостаточно: он оставляет дочерний процесс,
# который продолжает держать порт и выполнять СТАРЫЙ код.
set -u
PORT="${OFFICE_PORT:-3001}"
LOG="${1:-/tmp/office_server.log}"

pkill -f "tsx watch src/server" 2>/dev/null
pkill -f "npm exec tsx watch" 2>/dev/null
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done

for _ in $(seq 1 30); do
  lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.3
done
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ОШИБКА: порт $PORT занят после остановки"; exit 1
fi

nohup npx tsx watch src/server/index.ts >"$LOG" 2>&1 &
for _ in $(seq 1 60); do
  lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.5
done
NEW=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
[ -n "$NEW" ] && echo "сервер поднят, pid $NEW" || { echo "ОШИБКА: сервер не поднялся"; exit 1; }
