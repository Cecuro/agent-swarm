#!/usr/bin/env bash
set -euo pipefail

vault_name="${1:?usage: refresh-secrets VAULT_NAME}"
secret_dir=/etc/agent-swarm/secrets
install -m 0750 -o root -g 10001 -d "$secret_dir"

token="$(curl -fsS -H Metadata:true \
  'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
  | jq -r .access_token)"

fetch() {
  local vault_secret="$1"
  local environment_name="$2"
  local temporary
  temporary="$(mktemp "${secret_dir}/.${environment_name}.XXXXXX")"
  if curl -fsS -H "Authorization: Bearer ${token}" \
    "https://${vault_name}.vault.azure.net/secrets/${vault_secret}?api-version=7.4" \
    | jq -er .value >"$temporary"
  then
    chown root:10001 "$temporary"
    chmod 0440 "$temporary"
    mv "$temporary" "${secret_dir}/${environment_name}"
  else
    rm -f "$temporary"
    return 1
  fi
}

fetch azure-openai-api-key AZURE_OPENAI_API_KEY
fetch azure-openai-endpoint AZURE_OPENAI_ENDPOINT
fetch azure-openai-deployment-name-map AZURE_OPENAI_DEPLOYMENT_NAME_MAP 2>/dev/null || true
fetch azure-openai-api-version AZURE_OPENAI_API_VERSION 2>/dev/null || true
