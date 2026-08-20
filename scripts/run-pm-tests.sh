#!/usr/bin/env bash
# Регрессионные проверки поведения PM.
# Каждый сценарий прогоняется на СВОЁМ сервере: общий сервер протекал —
# хвост предыдущего хода менеджера попадал на свежую доску, и проверки
# начинали плавать между прогонами.
set -u
PORT=3002
STATE=/tmp/office-pm-test-state.json
WORKDIR=/tmp/office-pm-test-workspace
LOG=/tmp/office-pm-test-server.log

kill_server() {
  for pid in $(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
  for _ in $(seq 1 20); do
    lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.3
  done
}

start_server() {
  rm -f "$STATE"; mkdir -p "$WORKDIR"
  OFFICE_PORT=$PORT OFFICE_STATE_FILE=$STATE OFFICE_PROJECT_DIR=$WORKDIR \
    OFFICE_DRY_RUN=1 OFFICE_DRY_RUN_DELAY=12000 \
    npx tsx src/server/index.ts >"$LOG" 2>&1 &
  for _ in $(seq 1 60); do
    lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "сервер не поднялся, смотрите $LOG"; return 1
}

FILTER="${1:-}"
FAILED=0
kill_server

while IFS= read -r name; do
  [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]] && continue
  start_server || exit 1
  OFFICE_PORT=$PORT npx tsx scripts/test-pm.ts "$name" || FAILED=1
  kill_server
done < <(npx tsx scripts/test-pm.ts --list)

[ "$FAILED" = "0" ] && echo "ИТОГ: все сценарии прошли" || echo "ИТОГ: есть провалы"
exit $FAILED
