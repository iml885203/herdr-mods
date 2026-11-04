#!/bin/sh
# Read-only `kubectl proxy` for one context, shared by every copy of the kubernetes mod.
# Holds the cluster credentials (one exec credential plugin call instead of one
# per request) and stops itself once nothing has touched <heartbeat> for 10 minutes.
# usage: proxy.sh <context> <port> <heartbeat-file>
ctx=$1 port=$2 hb=$3
touch "$hb"
kubectl proxy --context "$ctx" --address 127.0.0.1 --port "$port" \
  --reject-methods='^(POST|PUT|PATCH|DELETE)$' --keepalive=60s >/dev/null 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null' EXIT INT TERM
while kill -0 "$pid" 2>/dev/null; do
  sleep 30
  [ -n "$(find "$hb" -mmin -10 2>/dev/null)" ] || exit 0
done
