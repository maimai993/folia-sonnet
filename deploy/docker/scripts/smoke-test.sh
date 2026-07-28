#!/bin/sh
set -eu

# 当前文件：启动本地构建的完整 Compose 堆栈并验证公开入口和网络隔离。
compose_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
sync_data_dir="$(mktemp -d)"

export FOLIA_IMAGE_NAMESPACE=folia-local
export FOLIA_STACK_VERSION=check
export FOLIA_SYNC_VERSION=check
export FOLIA_HTTP_BIND=127.0.0.1
export FOLIA_HTTP_PORT="${FOLIA_HTTP_PORT:-18080}"
export FOLIA_SYNC_BIND=127.0.0.1
export FOLIA_SYNC_PORT="${FOLIA_SYNC_PORT:-13000}"
export FOLIA_SYNC_DATA_DIR="$sync_data_dir"
export SYNC_TOKEN="${SYNC_TOKEN:-docker-smoke-token}"

compose_files="-f $compose_dir/compose.yaml -f $compose_dir/compose.build.yaml"

cleanup() {
  docker compose $compose_files down --volumes --remove-orphans
  rm -rf "$sync_data_dir"
}
trap cleanup EXIT INT TERM

docker compose $compose_files up -d --wait
curl --fail --silent --show-error "http://127.0.0.1:$FOLIA_HTTP_PORT/healthz" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$FOLIA_HTTP_PORT/api/healthz" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$FOLIA_SYNC_PORT/health" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$FOLIA_HTTP_PORT/" | grep -q '<div id="root"></div>'
curl --fail --silent --show-error "http://127.0.0.1:$FOLIA_HTTP_PORT/runtime-config.js" | grep -q 'aiProvider:"gemini"'
curl --fail --silent --show-error "http://127.0.0.1:$FOLIA_HTTP_PORT/netease/" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$FOLIA_HTTP_PORT/kugou/" >/dev/null

for service in backend netease-api kugou-api; do
  container_id="$(docker compose $compose_files ps -q "$service")"
  bindings="$(docker inspect "$container_id" --format '{{json .HostConfig.PortBindings}}')"
  if [ "$bindings" != "{}" ] && [ "$bindings" != "null" ]; then
    echo "$service unexpectedly publishes a host port" >&2
    exit 1
  fi
done

sync_networks="$(docker inspect folia-sync-server-1 --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')"
if printf '%s' "$sync_networks" | grep -q 'folia-internal'; then
  echo "sync-server must not join the Web internal network" >&2
  exit 1
fi
