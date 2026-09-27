#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace/repo /workspace/swarm
ln -sfn /opt/agent-swarm-harness/node_modules /workspace/swarm/node_modules
cp /opt/agent-swarm-harness/.agent-swarm-template-v1 /workspace/swarm/.agent-swarm-template-v1
printf 'ready\n' >/workspace/swarm/.agent-swarm-image-ready

exec "$@"
