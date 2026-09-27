#!/usr/bin/env bash
set -euo pipefail

resource_group="${AZURE_RESOURCE_GROUP:-rg-agent-swarm}"
vm_name="${AZURE_VM_NAME:-agent-swarm}"
location="${AZURE_LOCATION:-swedencentral}"
vm_size="${AZURE_VM_SIZE:-Standard_D8as_v5}"
admin_user="${AZURE_ADMIN_USER:-azureuser}"
ssh_public_key="${AZURE_SSH_PUBLIC_KEY:-${HOME}/.ssh/id_ed25519.pub}"
vault_name="${AZURE_KEY_VAULT_NAME:-}"
client_ip="${AZURE_SSH_SOURCE_IP:-$(curl -fsS https://api.ipify.org)}"

az account show --query id -o tsv >/dev/null
if ! az group show --name "$resource_group" >/dev/null 2>&1; then
  az group create --name "$resource_group" --location "$location" --output none
fi

if ! az vm show --resource-group "$resource_group" --name "$vm_name" >/dev/null 2>&1; then
  az vm create \
    --resource-group "$resource_group" \
    --name "$vm_name" \
    --location "$location" \
    --image Ubuntu2404 \
    --size "$vm_size" \
    --admin-username "$admin_user" \
    --ssh-key-values "$ssh_public_key" \
    --assign-identity \
    --public-ip-sku Standard \
    --nsg-rule SSH \
    --output none
else
  az vm identity assign --resource-group "$resource_group" --name "$vm_name" --output none
  current_size="$(az vm show --resource-group "$resource_group" --name "$vm_name" --query hardwareProfile.vmSize -o tsv)"
  if [[ "$current_size" != "$vm_size" ]]; then
    az vm deallocate --resource-group "$resource_group" --name "$vm_name" --no-wait
    az vm wait \
      --resource-group "$resource_group" \
      --name "$vm_name" \
      --custom "instanceView.statuses[?code=='PowerState/deallocated']" \
      --interval 10
    az vm resize --resource-group "$resource_group" --name "$vm_name" --size "$vm_size" --output none
  fi
fi

nic_id="$(az vm show --resource-group "$resource_group" --name "$vm_name" --query 'networkProfile.networkInterfaces[0].id' -o tsv)"
nsg_id="$(az network nic show --ids "$nic_id" --query 'networkSecurityGroup.id' -o tsv)"
nsg_group="$(cut -d/ -f5 <<<"$nsg_id")"
nsg_name="$(basename "$nsg_id")"
ssh_rule="$(az network nsg rule list --resource-group "$nsg_group" --nsg-name "$nsg_name" --query "[?destinationPortRange=='22'].name | [0]" -o tsv)"
az network nsg rule update \
  --resource-group "$nsg_group" \
  --nsg-name "$nsg_name" \
  --name "$ssh_rule" \
  --source-address-prefixes "${client_ip}/32" \
  --output none

if [[ -n "$vault_name" ]]; then
  if ! az keyvault show --name "$vault_name" >/dev/null 2>&1; then
    az keyvault create \
      --name "$vault_name" \
      --resource-group "$resource_group" \
      --location "$location" \
      --enable-rbac-authorization true \
      --output none
  fi
  principal_id="$(az vm identity show --resource-group "$resource_group" --name "$vm_name" --query principalId -o tsv)"
  vault_id="$(az keyvault show --name "$vault_name" --query id -o tsv)"
  if [[ "$(az role assignment list --assignee "$principal_id" --scope "$vault_id" --role 'Key Vault Secrets User' --query 'length(@)' -o tsv)" == "0" ]]; then
    az role assignment create \
      --assignee-object-id "$principal_id" \
      --assignee-principal-type ServicePrincipal \
      --role "Key Vault Secrets User" \
      --scope "$vault_id" \
      --output none
  fi
  if [[ "$(az account show --query user.type -o tsv)" == "user" ]]; then
    caller_id="$(az ad signed-in-user show --query id -o tsv)"
    if [[ "$(az role assignment list --assignee "$caller_id" --scope "$vault_id" --role 'Key Vault Secrets Officer' --query 'length(@)' -o tsv)" == "0" ]]; then
      az role assignment create \
        --assignee-object-id "$caller_id" \
        --assignee-principal-type User \
        --role "Key Vault Secrets Officer" \
        --scope "$vault_id" \
        --output none
    fi
  fi
fi

az vm start --resource-group "$resource_group" --name "$vm_name" --output none
az vm show --resource-group "$resource_group" --name "$vm_name" --show-details \
  --query '{publicIp:publicIps,size:hardwareProfile.vmSize,powerState:powerState}' -o json
