#!/bin/sh
# Isolated runtime smoke. Never mounts an installed app or mainnet data.
set -eu
image=${1:-rbitcoin:dashboard}
nginx_image=${NGINX_IMAGE:-nginx:1.30-alpine@sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576}
name="rbitcoin-dashboard-test-$$"
work=$(mktemp -d)
cleanup() {
  result=$?
  if [ "$result" != 0 ]; then
    docker logs --tail 40 "$name-node" || true
    docker logs --tail 40 "$name-settings" || true
    docker logs --tail 40 "$name-web" || true
  fi
  docker rm -f "$name-node" "$name-settings" "$name-web" "$name-proxy" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  docker volume rm "$name-web" "$name-settings" "$name-data" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker network create "$name" >/dev/null
for volume in web settings data; do docker volume create "$name-$volume" >/dev/null; done
docker run -d --platform linux/amd64 --name "$name-node" --network "$name" \
  -e RBITCOIN_IO=pread -e APP_VERSION=dashboard-test \
  -v "$name-web:/web" -v "$name-settings:/settings" -v "$name-data:/data" \
  "$image" --datadir /data --network regtest --no-seeds --sh-index \
  --electrum-listen 0.0.0.0:50001 --health-listen 0.0.0.0:9332 --metrics >/dev/null
docker run -d --platform linux/amd64 --name "$name-settings" --network "$name" \
  -e WEB_HOST="$name-web" -e APP_PROXY_HOSTS="$name-proxy" \
  -v "$name-settings:/settings" "$image" settings-server >/dev/null
docker run -d --name "$name-web" --network "$name" \
  -e LAN_HOST=umbrel.local -e PUBLIC_PORT=50011 -e APP_VERSION=dashboard-test \
  -e NODE_HOST="$name-node" -e SETTINGS_HOST="$name-settings" \
  -e NGINX_ENVSUBST_TEMPLATE_DIR=/web/templates -e NGINX_ENVSUBST_TEMPLATE_SUFFIX=.tmpl \
  -e 'NGINX_ENVSUBST_FILTER=^(LAN_HOST|PUBLIC_PORT|APP_VERSION|NODE_HOST|SETTINGS_HOST)$' \
  -v "$name-web:/web:ro" "$nginx_image" /bin/sh -c \
  'until [ "$(cat /web/.version 2>/dev/null)" = "$APP_VERSION" ]; do sleep 1; done; exec /docker-entrypoint.sh nginx -g "daemon off;"' >/dev/null
# Model Umbrel's app proxy as a distinct TCP source, preserving the public Host.
cat > "$work/proxy.conf" <<CONF
server { listen 80; location / { proxy_pass http://$name-web; proxy_set_header Host \$http_host; } }
CONF
docker create --name "$name-proxy" --network "$name" -p 127.0.0.1::80 "$nginx_image" >/dev/null
docker cp "$work/proxy.conf" "$name-proxy:/etc/nginx/conf.d/default.conf"
docker start "$name-proxy" >/dev/null
port=$(docker port "$name-proxy" 80/tcp | sed 's/.*://')
origin="http://127.0.0.1:$port"
for i in $(seq 1 60); do
  if curl -fsS "$origin/node/healthz" > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$origin/node/healthz" >/dev/null
curl -fsS "$origin/" > "$work/index.html"
grep -q 'Your node, at a glance' "$work/index.html"
curl -fsSI "$origin/dashboard.mjs" | grep -qi 'content-type: application/javascript'
curl -fsS "$origin/api/settings" > "$work/settings.json"
# An unrelated container cannot bypass the app proxy through nginx.
docker exec "$name-node" python3 -c '
import sys, urllib.error, urllib.request
try:
    urllib.request.urlopen(sys.argv[1])
    raise SystemExit("unexpected access outside the app proxy")
except urllib.error.HTTPError as error:
    assert error.code == 403
' "http://$name-web/api/settings"
python3 - "$work" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
settings = json.loads((path / 'settings.json').read_text())
assert settings['saved']['maxOutbound'] == 16
assert settings['restartRequired'] is False
assert settings['lastLaunched'] == settings['saved']
settings['saved'].update(maxOutbound=8, mempoolSize=400, logLevel='warn')
(path / 'request.json').write_text(json.dumps({'settings': settings['saved'], 'revision': settings['revision']}))
PY
# Cross-origin and plain form writes must fail, including through nginx.
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
  -H 'Origin: https://another.example' -H 'X-Requested-With: rbitcoin-dashboard' \
  --data-binary "@$work/request.json" "$origin/api/settings")
[ "$code" = 403 ]
curl -fsS -X PUT -H 'Content-Type: application/json' -H "Origin: $origin" \
  -H 'X-Requested-With: rbitcoin-dashboard' --data-binary "@$work/request.json" \
  "$origin/api/settings" > "$work/saved.json"
python3 - "$work/saved.json" <<'PY'
import json, sys
saved = json.load(open(sys.argv[1]))
assert saved['restartRequired'] is True
assert saved['saved']['maxOutbound'] == 8
assert saved['lastLaunched']['maxOutbound'] == 16
PY
# Saving does not restart the node. Explicit restart must preserve a clean stop.
docker stop -t 120 "$name-node" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$name-node")" = 0 ]
docker start "$name-node" >/dev/null
for i in $(seq 1 60); do
  if curl -fsS "$origin/node/metrics" > "$work/metrics" 2>/dev/null && grep -q '^rbitcoin_mempool_max_weight 400000000' "$work/metrics"; then break; fi
  sleep 1
done
grep -q '^rbitcoin_mempool_max_weight 400000000' "$work/metrics"
curl -fsS "$origin/api/settings" > "$work/applied.json"
python3 - "$work/applied.json" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1]))
assert settings['restartRequired'] is False
assert settings['saved']['maxOutbound'] == 8
assert settings['saved'] == settings['lastLaunched']
PY
# Recreating the settings service must not lose persisted preferences.
docker restart "$name-settings" >/dev/null
for i in $(seq 1 15); do curl -fsS "$origin/api/settings" > "$work/reloaded.json" 2>/dev/null && break; sleep 1; done
python3 - "$work/reloaded.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))['saved']['maxOutbound'] == 8
PY
# A clean final shutdown is part of the runtime contract.
docker stop -t 120 "$name-node" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$name-node")" = 0 ]
printf '%s\n' 'Runtime smoke passed: assets, module MIME, API protections, persistence, clean restart, and live mempool setting.'
