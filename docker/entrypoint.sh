#!/usr/bin/env bash
set -euo pipefail

secret_dir="${SWARM_SECRET_DIR_IN_CONTAINER:-/run/secrets}"
for name in \
  AZURE_OPENAI_API_KEY \
  AZURE_OPENAI_ENDPOINT \
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP \
  AZURE_OPENAI_API_VERSION \
  OPENAI_API_KEY \
  ANTHROPIC_API_KEY
do
  path="${secret_dir}/${name}"
  if [[ -f "$path" ]]; then
    value="$(<"$path")"
    export "${name}=${value}"
  fi
done

exec "$@"
