#!/usr/bin/env bash
# ── warpctrl.sh ── Warp Local Control Protocol bash 客户端 ──────────────────
# 用法: source src/warpctrl.sh; warp_tab_create
# 依赖: bash, curl, jq, nc

set -euo pipefail

# ── 依赖检查 ──────────────────────────────────────────────────────────────
for _cmd in jq curl nc; do
  command -v "$_cmd" >/dev/null || { echo "[warpctrl] ERROR: 缺少依赖: $_cmd" >&2; exit 1; }
done
unset _cmd

WARP_DISCOVERY_DIR="${WARP_LOCAL_CONTROL_DISCOVERY_DIR:-$HOME/.warp/local-control}"
PROTOCOL_VERSION=1
CONTROL_PATH="/v1/control"

_die() { echo "[warpctrl] ERROR: $*" >&2; return 1; }
_info() { echo "[warpctrl] $*" >&2; }

warp_discover() {
  local dir="$WARP_DISCOVERY_DIR"
  if [[ ! -d "$dir" ]]; then
    _die "发现目录不存在: $dir（Warp local control 未启用，请在 Settings 搜索 'outside warp control' 开启）"
    return 1
  fi
  local record_file
  record_file=$(ls -t "$dir"/inst_*.json 2>/dev/null | head -1)
  if [[ -z "$record_file" ]]; then
    _die "未找到实例记录"
    return 1
  fi
  _info "发现实例: $(basename "$record_file")"
  cat "$record_file"
}

_warp_get_endpoint_url() {
  local host port
  host=$(echo "$1" | jq -r '.endpoint.host')
  port=$(echo "$1" | jq -r '.endpoint.port')
  if [[ "$host" == "null" || "$port" == "null" ]]; then
    _die "实例未发布 endpoint"
    return 1
  fi
  echo "http://${host}:${port}${CONTROL_PATH}"
}

_warp_get_broker_path() {
  local socket_filename
  socket_filename=$(echo "$1" | jq -r '.credential_broker.socket_path')
  echo "${WARP_DISCOVERY_DIR}/${socket_filename}"
}

warp_credential() {
  local action_name="${1:-tab.create}"
  local record broker_path response

  record=$(warp_discover) || return 1
  broker_path=$(_warp_get_broker_path "$record") || return 1

  if [[ ! -S "$broker_path" ]]; then
    _die "Broker socket 不存在: $broker_path"
    return 1
  fi

  local credential_req
  credential_req=$(jq -n --arg action "$action_name" '{action:$action,invocation_context:"outside_warp"}')
  _info "请求 credential (action=${action_name})..."

  response=$(echo "$credential_req" | nc -U "$broker_path" 2>/dev/null) || {
    _die "Broker 无响应（需要 nc）"
    return 1
  }

  if echo "$response" | jq -e '.error' >/dev/null 2>&1; then
    _die "Credential 被拒绝: $(echo "$response" | jq -r '.error.message // .error')"
    return 1
  fi

  local cred
  cred=$(echo "$response" | jq -r '.credential // .token // empty')
  if [[ -z "$cred" ]]; then
    _die "Broker 未返回有效凭证"
    return 1
  fi
  echo "$cred"
}

warp_request() {
  local action_kind="${1:-app.ping}"
  local params="${2:-{}}"
  local record endpoint_url credential request_id body

  record=$(warp_discover) || return 1
  endpoint_url=$(_warp_get_endpoint_url "$record") || return 1
  credential=$(warp_credential "$action_kind") || return 1

  request_id=$(uuidgen 2>/dev/null || echo "00000000-0000-0000-0000-000000000000")

  body=$(jq -n \
    --argjson protocol_version "$PROTOCOL_VERSION" \
    --arg request_id "$request_id" \
    --argjson target '{"window":{"type":"active"},"tab":{"type":"active"}}' \
    --arg kind "$action_kind" \
    --argjson params "$params" \
    '{protocol_version:$protocol_version,request_id:$request_id,target:$target,action:{kind:$kind,params:$params}}')

  _info "POST ${action_kind} ..."
  local resp_file
  resp_file=$(mktemp /tmp/warpctrl.XXXXXX.json)
  local http_code
  http_code=$(curl -s -o "$resp_file" -w '%{http_code}' \
    -X POST "$endpoint_url" \
    -H "Authorization: Bearer ${credential}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null)

  local response
  response=$(cat "$resp_file" 2>/dev/null || echo "{}")
  rm -f "$resp_file"

  if [[ "$http_code" != "200" ]]; then
    _die "HTTP ${http_code}: ${response}"
    return 1
  fi

  if echo "$response" | jq -e '.response.status == "error"' >/dev/null 2>&1; then
    _die "失败: $(echo "$response" | jq -r '.response.error.message // .response.error')"
    return 1
  fi

  _info "OK"
  echo "$response" | jq '.'
}

warp_ping()    { warp_request "app.ping" "{}"; }
warp_version() { warp_request "app.version" "{}"; }
warp_tab_create() { warp_request "tab.create" "{}"; }

warp_status() {
  echo "=== Warp Local Control ==="
  echo "Dir: $WARP_DISCOVERY_DIR"
  if [[ ! -d "$WARP_DISCOVERY_DIR" ]]; then
    echo "状态: ❌ 未启用 — Warp Settings → 'outside warp control' → ON"
    return 1
  fi
  local count
  count=$(ls "$WARP_DISCOVERY_DIR"/inst_*.json 2>/dev/null | wc -l | tr -d ' ')
  echo "实例: $count"
  [[ "$count" -gt 0 ]] && echo "状态: ✅" || echo "状态: ❌"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-status}" in
    status)   warp_status ;;
    ping)     warp_ping ;;
    version)  warp_version ;;
    tab-new)  warp_tab_create ;;
    *) echo "用法: $0 {status|ping|version|tab-new}" >&2; exit 1 ;;
  esac
fi
