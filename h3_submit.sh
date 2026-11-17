#!/bin/bash
# zgci-h3 hub 直连：POST /v1/videos -> 轮询 GET /v1/videos/{id} -> 下载 /content
set -u
KEY="${SYNTHMEDIA_ZGCI_API_KEY:?未设置 SYNTHMEDIA_ZGCI_API_KEY}"
BASE="https://hub.zgci.org"
OUT_DIR="${OUT_DIR:?未设置 OUT_DIR}"
PROMPT_FILE="${PROMPT_FILE:?未设置 PROMPT_FILE}"
POLL_INTERVAL="${POLL_INTERVAL:-20}"
DEADLINE=$(( $(date +%s) + ${WAIT_SECONDS:-3600} ))

PROMPT=$(cat "$PROMPT_FILE")
REQ_FILE="$OUT_DIR/h3-request.json"
printf '{"model":"minimax-h3","prompt":%s,"seconds":"5","size":"1280x720"}' \
  "$(printf '%s' "$PROMPT" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" > "$REQ_FILE"

echo "提交: POST $BASE/v1/videos model=minimax-h3 seconds=5 size=1280x720"
RESP=$(curl -s -X POST "$BASE/v1/videos" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  --data-binary @"$REQ_FILE")
echo "提交响应: $RESP"
JOB_ID=$(printf '%s' "$RESP" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id") or d.get("task_id") or "")' 2>/dev/null)
[ -z "$JOB_ID" ] && { echo "E_SUBMIT: 未拿到任务 id"; exit 1; }
echo "task id: $JOB_ID"

while :; do
  S=$(curl -s "$BASE/v1/videos/$JOB_ID" -H "Authorization: Bearer $KEY")
  STATUS=$(printf '%s' "$S" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)
  PROG=$(printf '%s' "$S" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("progress",""))' 2>/dev/null || true)
  echo "[$(date '+%H:%M:%S')] status=$STATUS progress=$PROG"
  case "$STATUS" in
    completed|succeeded)
      curl -s "$BASE/v1/videos/$JOB_ID/content" -H "Authorization: Bearer $KEY" -o "$OUT_DIR/result.mp4"
      echo "已下载: $OUT_DIR/result.mp4 ($(wc -c < "$OUT_DIR/result.mp4") bytes)"
      exit 0 ;;
    failed|error)
      echo "E_FAILED: $S"; exit 1 ;;
  esac
  [ "$(date +%s)" -ge "$DEADLINE" ] && { echo "E_TIMEOUT: 超过等待上限"; exit 2; }
  sleep "$POLL_INTERVAL"
done
