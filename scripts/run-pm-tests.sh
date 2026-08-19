#!/usr/bin/env bash
# Поднимает изолированный тестовый сервер (свой порт, своя рабочая директория,
# своё состояние) и прогоняет сценарии поведения PM.
set -u
PORT=3002
STATE=/tmp/office-pm-test-state.json
WORKDIR=/tmp/office-pm-test-workspace
LOG=/tmp/office-pm-test-server.log

for pid in $(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
rm -f "$STATE"; mkdir -p "$WORKDIR"

OFFICE_PORT=$PORT OFFICE_STATE_FILE=$STATE OFFICE_PROJECT_DIR=$WORKDIR OFFICE_DRY_RUN=1 \
  npx tsx src/server/index.ts >"$LOG" 2>&1 &
SRV=$!
for _ in $(seq 1 60); do lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done

OFFICE_PORT=$PORT npx tsx scripts/test-pm.ts "$@"
CODE=$?
kill -9 $SRV 2>/dev/null; wait $SRV 2>/dev/null
for pid in $(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
exit $CODE
