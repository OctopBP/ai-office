#!/usr/bin/env bash
# Регрессионные проверки поведения PM.
# Каждый сценарий прогоняется на СВОЁМ сервере: общий сервер протекал —
# хвост предыдущего хода менеджера попадал на свежую доску, и проверки
# начинали плавать между прогонами.
set -u
set -o pipefail
PORT=3002
STATE=/tmp/office-pm-test-state.json
WORKDIR=/tmp/office-pm-test-workspace
LOG=/tmp/office-pm-test-server.log
# Файл для stderr вызова --list кладём в TMPDIR, а не жёстко в /tmp: именно там,
# где /tmp закрыт песочницей, этот stderr и нужен больше всего.
LIST_ERR="${TMPDIR:-/tmp}/office-pm-test-list.$$.err"
trap 'rm -f "$LIST_ERR"' EXIT

# Показать, что именно сказал упавший вызов --list. Молчаливого «список пуст»
# быть не должно ни в одной ветке.
show_list_stderr() {
  echo "── stderr ──"
  if [ -s "$LIST_ERR" ]; then cat "$LIST_ERR" >&2; else echo "(stderr пуст)"; fi
}

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

# Список сценариев получаем отдельным шагом, а не прямо в подстановке процесса:
# там код возврата tsx терялся. Если вызов падал (в песочнице tsx не может
# открыть свой unix-сокет в /tmp), список выходил пустым, цикл не делал ни
# одного витка, и прогон бодро печатал успех, не проверив ровно ничего.
LIST_OUT=$(npx tsx scripts/test-pm.ts --list 2>"$LIST_ERR")
LIST_RC=$?
if [ "$LIST_RC" != "0" ]; then
  echo "не удалось получить список сценариев: «npx tsx scripts/test-pm.ts --list» завершился с кодом $LIST_RC"
  show_list_stderr
  exit 1
fi

# Последняя строка списка — метка «#total=N» от самого test-pm.ts. Нет метки
# или не сходится число строк — вывод неполон или это вообще не список.
EXPECTED=$(printf '%s\n' "$LIST_OUT" | sed -n 's/^#total=\([0-9][0-9]*\)$/\1/p' | tail -1)
NAMES=$(printf '%s\n' "$LIST_OUT" | grep -v '^#total=' | grep -v '^[[:space:]]*$')
COUNT=$(printf '%s\n' "$NAMES" | grep -c '.')

if [ -z "$EXPECTED" ]; then
  echo "список сценариев испорчен: в выводе --list нет метки «#total=N»"
  echo "── что получили ──"
  printf '%s\n' "$LIST_OUT" | head -20
  show_list_stderr
  exit 1
fi
if [ "$EXPECTED" = "0" ] || [ "$COUNT" = "0" ]; then
  echo "сценариев не найдено: прогонять нечего, считаем это провалом"
  show_list_stderr
  exit 1
fi
if [ "$COUNT" != "$EXPECTED" ]; then
  echo "список сценариев неполон: получено строк $COUNT, а заявлено $EXPECTED"
  show_list_stderr
  exit 1
fi

SELECTED=()
while IFS= read -r name; do
  [ -z "$name" ] && continue
  if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then continue; fi
  SELECTED+=("$name")
done <<< "$NAMES"

TOTAL=${#SELECTED[@]}
if [ "$TOTAL" = "0" ]; then
  # Скобки вокруг имени обязательны: bash 3.2 приклеивает байты «»» к имени
  # переменной и падает на unbound variable.
  echo "сценариев не найдено: под фильтр «${FILTER}» не подошёл ни один из $EXPECTED"
  exit 1
fi

RAN=0
for name in "${SELECTED[@]}"; do
  start_server || exit 1
  OFFICE_PORT=$PORT npx tsx scripts/test-pm.ts "$name"
  RC=$?
  kill_server
  # 0 — прогнан и прошёл, 1 — прогнан и провалился, остальное — прогона не было.
  case "$RC" in
    0) RAN=$((RAN + 1)) ;;
    1) RAN=$((RAN + 1)); FAILED=1 ;;
    *) echo "сценарий «${name}» не прогнан: tsx завершился с кодом $RC"; FAILED=1 ;;
  esac
done

if [ "$RAN" != "$TOTAL" ]; then
  echo "ИТОГ: прогнано $RAN сценариев из $TOTAL — часть не запустилась, прогону верить нельзя"
  exit 1
fi
[ "$FAILED" = "0" ] \
  && echo "ИТОГ: прогнано $RAN сценариев из $TOTAL, все прошли" \
  || echo "ИТОГ: прогнано $RAN сценариев из $TOTAL, есть провалы"
exit $FAILED
