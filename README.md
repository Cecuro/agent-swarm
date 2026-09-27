# Agent Swarm

Agent Swarm runs coordinated AI coding agents in isolated Docker containers. Agents share coordination state and task artifacts through an S3-compatible store. A controller manages agents, runs, and their lifecycle.

## Requirements

- Node.js 22 or newer
- Docker Engine and Docker Compose
- Credentials for a model provider supported by Pi

## Quick start

```sh
npm install
cp .env.example .env
# Set credentials for your model provider in .env
npm run swarm -- --help
```

For local development, start the services with Docker Compose:

```sh
docker compose up --build
```

The CLI also supports configuring a remote repository and agent count. Run `npm run swarm -- --help` for command usage. Do not commit `.env`, provider credentials, runtime auth files, or generated swarm data.

## Azure deployment

Scripts for provisioning a VM and loading credentials from Azure Key Vault are in `deploy/azure/`. Review and set the `AZURE_*` configuration values for your own environment before running them.
