#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl jq
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf '%s\n' \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

install -m 0755 -d /opt/agent-swarm
getent group 10001 >/dev/null || groupadd --gid 10001 agent-swarm
install -m 0755 -o 10001 -g 10001 -d /var/lib/agent-swarm
install -m 0755 -d /var/lib/agent-swarm/workspaces
install -m 0755 -d /var/lib/agent-swarm/contexts
install -m 0750 -o root -g 10001 -d /etc/agent-swarm/secrets
usermod -aG docker azureuser
