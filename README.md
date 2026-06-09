# PALUDEM — Meeting Intelligence Engine

PLAUD CLI integration, transcript parsing, BA document generation, and DOCX export.

## Requirements

- **Node.js >= 20**
- **PLAUD CLI** (`@plaud-ai/cli`) — installed globally or via npx

## Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Install PLAUD CLI globally
npm install -g @plaud-ai/cli@latest

# 3. Authenticate
plaud login

# 4. Verify
plaud files

# 5. Copy environment config
cp .env.example .env

# 6. Start
npm start
```

Open `http://localhost:3000`. The dashboard checks PLAUD CLI status automatically.

## PLAUD CLI Modes

### Global mode (default)

Requires the CLI installed in PATH:

```bash
npm install -g @plaud-ai/cli@latest
plaud login
```

```env
PLAUD_CLI_MODE=global
PLAUD_CLI_BIN=plaud
```

### npx mode

No global install needed — downloads on first use:

```env
PLAUD_CLI_MODE=npx
PLAUD_CLI_NPX_PACKAGE=@plaud-ai/cli@latest
```

Useful for Railway and other container environments where global installs are ephemeral.

## Railway Deployment

### Build Command

```bash
npm install && npm install -g @plaud-ai/cli@latest
```

### Start Command

```bash
npm start
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Server port (Railway sets this) |
| `NODE_ENV` | No | `production` | Environment |
| `PLAUD_INTEGRATION_MODE` | No | `cli` | `cli` or `legacy_debug` |
| `PLAUD_CLI_MODE` | No | `global` | `global` or `npx` |
| `PLAUD_CLI_BIN` | No | `plaud` | Binary name (global mode) |
| `PLAUD_CLI_NPX_PACKAGE` | No | `@plaud-ai/cli@latest` | Package (npx mode) |
| `PLAUD_HOME` | No | `/app/.plaud` (Railway) or `~/.plaud` | PLAUD data directory |
| `PLAUD_COMMAND_TIMEOUT_MS` | No | `60000` | CLI timeout (ms) |
| `PLAUD_TOKENS_JSON` | No | — | Contents of `~/.plaud/tokens.json` for headless auth |
| `PLAUD_AUTO_BOOTSTRAP_TOKENS` | No | `true` | Set `false` to disable token bootstrap |
| `N8N_WEBHOOK_URL` | No | — | n8n webhook for AI pipeline |
| `N8N_API_KEY` | No | — | n8n webhook auth key |
| `CALLBACK_BASE_URL` | No | — | Public URL for n8n callbacks |

### Token Bootstrap (headless auth for Railway)

Railway containers cannot run `plaud login` (it requires a browser). Instead, authenticate locally and inject the tokens via environment variable.

**Step 1 — Authenticate locally:**

```bash
npm install -g @plaud-ai/cli@latest
plaud login          # Opens browser, completes OAuth
plaud me             # Verify: should print your email
```

**Step 2 — Copy tokens:**

```bash
cat ~/.plaud/tokens.json
# Copy the entire JSON output
```

**Step 3 — Configure Railway:**

Add these environment variables in your Railway service settings:

```env
PLAUD_TOKENS_JSON={"access_token":"...","refresh_token":"...","expires_at":...}
PLAUD_CLI_MODE=global
```

> **Security:** `PLAUD_TOKENS_JSON` is a secret. Add it as a Railway secret variable, never commit it to source control. The server never logs token content.

At startup, the server writes `tokens.json` to `PLAUD_HOME` (auto-detected as `/app/.plaud` on Railway) before any CLI command runs. The `HOME` environment variable is aligned so the CLI finds the tokens at the correct path.

**Step 4 — Verify:**

After deploying, check the status endpoint:

```bash
curl https://your-app.railway.app/api/plaud/status
# Should return: {"connected":true,"status":"authenticated","bootstrapped":true,...}
```

### Railway with npx (no global install)

If your Railway plan doesn't persist global installs across deploys:

```env
PLAUD_CLI_MODE=npx
PLAUD_TOKENS_JSON={"access_token":"...","refresh_token":"...","expires_at":...}
```

The server auto-detects Railway and sets `PLAUD_HOME=/app/.plaud`. Token bootstrap works with both `global` and `npx` CLI modes.

### Token Refresh

If the status endpoint returns `not_authenticated` with `bootstrapped: true`, the tokens have likely expired. Re-run `plaud login` locally, copy the new `tokens.json`, and update `PLAUD_TOKENS_JSON` in Railway.

## API Endpoints

### PLAUD

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/plaud/status` | Connection status (three-state) |
| `GET` | `/api/plaud/files` | List recordings (`?skip=0&limit=20&q=`) |
| `GET` | `/api/plaud/files/:id` | File metadata |
| `GET` | `/api/plaud/files/:id/transcript` | Parsed transcript |
| `GET` | `/api/plaud/files/:id/note` | Summary + outline |
| `GET` | `/api/plaud/files/:id/full` | Full pipeline output |
| `POST` | `/api/plaud/files/:id/process-ba` | Trigger BA processing |
| `POST` | `/api/plaud/export-docx` | Generate DOCX from BA document |

### n8n AI Pipeline

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/n8n/trigger` | Trigger AI pipeline |
| `POST` | `/api/n8n/callback` | Receive n8n result |
| `GET` | `/api/n8n/status/:jobId` | Poll job status |
| `GET` | `/api/n8n/jobs` | List jobs |
| `GET` | `/api/n8n/config` | n8n config status |
| `POST` | `/api/n8n/config` | Set webhook URL |

### Status Response

`GET /api/plaud/status` returns one of:

```json
{"connected":false,"status":"cli_not_found","mode":"cli","cliMode":"global","bootstrapped":false,"reason":"..."}
```
```json
{"connected":false,"status":"not_authenticated","mode":"cli","cliMode":"global","cliVersion":"1.0.0","bootstrapped":true,"reason":"..."}
```
```json
{"connected":true,"status":"authenticated","mode":"cli","cliMode":"global","cliVersion":"1.0.0","bootstrapped":true,"user":"user@example.com"}
```

## Architecture

```
public/          → SPA frontend (vanilla JS)
server/
  config/        → Environment configuration
  utils/         → Logger, exec wrapper, error types
  services/
    plaud/       → Provider abstraction + adapters (CLI, legacy)
    legacy/      → Archived reverse-engineered API code
  routes/        → Express API routes
  parser/        → Transcript, summary, outline parsers
```
