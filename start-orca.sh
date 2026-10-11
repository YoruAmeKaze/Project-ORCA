#!/usr/bin/env bash
set -Eeuo pipefail

# Ubuntu one-command launcher for the Ollama container and ORCA.
# Usage: bash start-orca.sh [start|status|stop]

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/app-cordis"
RUN_DIR="$APP_DIR/run"
LOG_DIR="$APP_DIR/logs"
PID_FILE="$RUN_DIR/orca.pid"
LOG_FILE="$LOG_DIR/orca.log"
OLLAMA_CONTAINER="${OLLAMA_CONTAINER:-ollama}"
OLLAMA_URL="${OLLAMA_HOST:-http://127.0.0.1:11434}"

say() { printf '[orca-launcher] %s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }

is_running() {
  [[ -s "$PID_FILE" ]] || return 1
  local pid
  pid="$(<"$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

start_orca() {
  [[ -d "$APP_DIR" ]] || fail "找不到目录：$APP_DIR"
  [[ -f "$APP_DIR/.env" || -f "$ROOT_DIR/.env" ]] || fail "未找到 app-cordis/.env 或仓库根目录 .env，请先配置 Ollama 与飞书等环境变量。"
  command -v docker >/dev/null || fail "未安装 Docker。"
  command -v node >/dev/null || fail "未安装 Node.js。"
  command -v npm >/dev/null || fail "未安装 npm。"

  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( node_major >= 20 )) || fail "需要 Node.js 20 或更高版本；当前为 $(node --version)。"

  docker info >/dev/null 2>&1 || fail "Docker 不可用；确认 Docker 已启动，并且当前用户有 Docker 权限。"
  docker container inspect "$OLLAMA_CONTAINER" >/dev/null 2>&1 || fail "找不到名为 '$OLLAMA_CONTAINER' 的 Ollama 容器。可用 OLLAMA_CONTAINER 环境变量指定容器名。"

  mkdir -p "$RUN_DIR" "$LOG_DIR"
  if is_running; then
    say "ORCA 已在运行（PID $(<"$PID_FILE")），日志：$LOG_FILE"
    return
  fi
  rm -f "$PID_FILE"

  if [[ "$(docker inspect -f '{{.State.Running}}' "$OLLAMA_CONTAINER")" != "true" ]]; then
    say "启动 Ollama 容器：$OLLAMA_CONTAINER"
    docker start "$OLLAMA_CONTAINER" >/dev/null
  fi

  local ready=0
  for _ in {1..30}; do
    if curl --silent --fail --max-time 2 "${OLLAMA_URL%/}/api/tags" >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  (( ready == 1 )) || fail "Ollama 在 $OLLAMA_URL 尚未就绪。检查容器端口映射（应包含 11434:11434）。"

  cd "$APP_DIR"
  if [[ ! -d node_modules ]]; then
    say "首次安装 Node 依赖（npm ci）"
    npm ci
  fi
  say "构建 ORCA"
  npm run build

  say "后台启动 ORCA"
  nohup node dist/index.js >>"$LOG_FILE" 2>&1 </dev/null &
  local pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    fail "ORCA 启动失败；查看日志：$LOG_FILE"
  fi
  say "ORCA 已启动（PID $pid）；Dashboard: http://127.0.0.1:8200/dashboard"
  say "查看日志：tail -f '$LOG_FILE'"
}

show_status() {
  if is_running; then
    say "ORCA 正在运行（PID $(<"$PID_FILE")）"
  else
    say "ORCA 未运行"
  fi
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    docker ps --filter "name=^/${OLLAMA_CONTAINER}$" --format '{{.Names}}: {{.Status}}' | sed 's/^/[ollama] /'
  fi
  if command -v curl >/dev/null && curl --silent --fail --max-time 2 http://127.0.0.1:8200/dashboard >/dev/null; then
    say "ORCA Dashboard 正常（http://127.0.0.1:8200/dashboard）"
  fi
}

stop_orca() {
  if ! is_running; then
    rm -f "$PID_FILE"
    say "ORCA 未运行"
    return
  fi
  local pid
  pid="$(<"$PID_FILE")"
  kill -TERM "$pid"
  for _ in {1..15}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  say "ORCA 已停止（Ollama 容器保持运行）"
}

case "${1:-start}" in
  start) start_orca ;;
  status) show_status ;;
  stop) stop_orca ;;
  *) fail "用法：bash start-orca.sh [start|status|stop]" ;;
esac
