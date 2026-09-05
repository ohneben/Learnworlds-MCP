# ohneben's LearnWorlds MCP

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ohneben-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/ohneben)

[![CI](https://github.com/ohneben/Learnworlds-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/ohneben/Learnworlds-MCP/actions/workflows/ci.yml)
[![Publish Docker image](https://github.com/ohneben/Learnworlds-MCP/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/ohneben/Learnworlds-MCP/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE.md)
[![Learnworlds-MCP MCP server](https://glama.ai/mcp/servers/ohneben/Learnworlds-MCP/badges/score.svg)](https://glama.ai/mcp/servers/ohneben/Learnworlds-MCP)

Run your [LearnWorlds](https://www.learnworlds.com/) school in plain language from AI
assistants like **Claude**, **Cursor**, and any other
[MCP](https://modelcontextprotocol.io) client.

This [Model Context Protocol](https://modelcontextprotocol.io) server exposes the
**LearnWorlds public API** — all **94 endpoints**, generated straight from the
OpenAPI spec into MCP tools. Every tool is **safety-categorized**
(🟢 read-only / 🟡 write / 🔴 destructive) so your assistant knows what an action does
*before* it calls it. It runs over **stdio** (Claude Desktop and other local launchers)
or **Streamable HTTP** (hosted in Docker), and ships with retries, client-side rate
limiting, and request timeouts so it holds up against a live school.

## Why you'll want this

Some MCP servers just forward an API. This one is built to be **safe to hand to an
LLM** and **easy to run for real**:

| What you get | Why it matters |
| --- | --- |
| **All 94 endpoints, spec-driven** | Full coverage of courses, users, enrollments, payments, subscriptions, coupons, certificates, seats, community and reporting — nothing hand-picked or left behind. |
| **Every tool is safety-categorized** 🟢 / 🟡 / 🔴 | A banner at the top of each tool description tells the model exactly what it does — read, create, update or delete — before it acts. |
| **Descriptions written for agents, not humans** | Every tool spells out its side effects, auth and rate-limit behavior, return shape, error codes, when *not* to reach for it, and which sibling tools are the alternatives. |
| **Machine-readable MCP annotations** (`readOnlyHint`, `destructiveHint`) | Hosts that honor annotations (Claude included) can auto-trust reads and demand confirmation before anything destructive. |
| **Automatic retries with backoff** | Transient `429` / `5xx` responses are retried with jittered exponential backoff, honoring the server's `Retry-After` header. |
| **Built-in rate limiting** | Self-throttles under LearnWorlds' **30 requests / 10 s** cap so a burst of tool calls never trips a `429`. |
| **Per-request timeouts** | A hung upstream call is aborted and retried instead of freezing the server. |
| **Two transports: stdio *and* Streamable HTTP** | Use it locally in Claude Desktop, or run one always-on server that any number of MCP clients reach over HTTP. |
| **Docker + docker-compose, health check, auto-restart** | Production-style deployment out of the box: `docker compose up` and it stays up. |
| **Optional bearer-token auth** on the HTTP endpoint | Put the server behind a shared secret the moment it's reachable beyond localhost. |
| **Your secrets never reach the model** | Credentials live in the server's environment and are injected on every request — the assistant only ever sees tool inputs and API responses. |
| **Drop-in spec updates** | LearnWorlds ships a newer YAML? Replace one file and rebuild — new endpoints become new tools automatically, no code changes. |

### How it compares

At the time of writing this appears to be the only dedicated LearnWorlds MCP server.
You *could* instead point a generic OpenAPI→MCP wrapper at the spec — here's what
that leaves on the table:

| Capability | **This project** | Generic OpenAPI→MCP wrapper\* |
| --- | :---: | :---: |
| All 94 LearnWorlds endpoints as tools | ✅ | ✅ |
| Per-tool 🟢 / 🟡 / 🔴 safety category + banner | ✅ | ❌ |
| `readOnlyHint` / `destructiveHint` MCP annotations | ✅ | ➖ |
| `$ref` dereferencing + recursion-safe schemas | ✅ | ➖ |
| Automatic retries on `429` / `5xx` (honors `Retry-After`) | ✅ | ❌ |
| Client-side rate limiting (stays under 30 req / 10 s) | ✅ | ❌ |
| Per-request timeout with abort | ✅ | ➖ |
| `stdio` transport | ✅ | ✅ |
| **Streamable-HTTP transport** | ✅ | ➖ |
| **Docker + docker-compose**, health check, auto-restart | ✅ | ❌ |
| **Optional bearer-token auth** on the endpoint | ✅ | ❌ |
| Credentials injected server-side, never sent to the model | ✅ | ➖ |
| License | MIT | varies |

<sub>\*Generic OpenAPI→MCP wrappers turn any Swagger/OpenAPI spec into MCP tools. They
can reach the same endpoints, but treat every operation identically — no safety
categories, no resilience, no deployment story, and no guardrails tuned for live
school data. "➖" = varies by tool / not guaranteed. Snapshot from July 2026.</sub>

## What you can do

Once it's connected, ask your assistant things like:

- "List the 10 most recent users who signed up this month."
- "Create a user for jane@example.com and enroll her in the 'Pro' bundle."
- "Show me this month's payments and total revenue."
- "Which users haven't completed the 'Onboarding' course yet?"
- "Create a 20%-off coupon for the annual subscription plan."
- "Pull completion analytics for our top 5 courses."

Tools are generated automatically from the API and grouped into 🟢 read-only,
🟡 write, and 🔴 destructive — so a well-behaved host can treat each group differently.

## How it works

```
Claude / Cursor / any MCP client  ──MCP──►  this server  ──HTTPS──►  LearnWorlds API (your school)
```

The server parses the bundled OpenAPI spec into MCP tools (resolving `$ref`s and
guarding against recursive schemas), tags each with its safety category, and injects
your bearer token and `Lw-Client` header on every outgoing request. Your credentials
stay in the server's environment — the model never sees or handles them.

## Requirements

- A **LearnWorlds school with API access** — an **access token** and a **Client ID**
  (admin → Settings → Integrations → Developers), plus your school's API base URL.
  See [Get your API credentials](#get-your-api-credentials).
- **Docker** (Docker Desktop on macOS/Windows) for the quick start below — or
  **Node.js ≥ 18** to [run from source](#run-from-source-stdio-no-docker).

## Quick start (Docker)

**1. Add your credentials.** Copy the example config and fill it in:

```bash
cp .env.example .env
# edit .env → set LEARNWORLDS_BASE_URL, LEARNWORLDS_API_TOKEN, LEARNWORLDS_CLIENT_ID
#           → set MCP_SHARED_TOKEN to a long random string if reachable beyond localhost
```

**2. Start the server:**

```bash
docker compose up -d --build
```

The bundled `docker-compose.yml` binds to `127.0.0.1:8765` only, so the server is
reachable from your machine but not the network.

**3. Confirm it's running:**

```bash
curl -s http://localhost:8765/health
# → {"status":"ok","server":"learnworlds-mcp","tools":94}
```

**4. Connect your MCP client.** The MCP endpoint is `http://localhost:8765/mcp`.

- **Claude Desktop** — add a **custom connector** (Settings → Connectors) pointing at
  the URL, or bridge it locally with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).
  Add this under `mcpServers` in your config, then fully quit and reopen the app:

  ```json
  {
    "mcpServers": {
      "learnworlds": {
        "command": "npx",
        "args": [
          "mcp-remote",
          "http://localhost:8765/mcp",
          "--header", "Authorization: Bearer YOUR_MCP_SHARED_TOKEN"
        ]
      }
    }
  }
  ```

  (Drop the `--header` line if you left `MCP_SHARED_TOKEN` empty.)

- **Claude Code** — one command:

  ```bash
  claude mcp add --transport http learnworlds http://localhost:8765/mcp
  ```

- **Claude Cowork** — shares Claude Code's MCP config, so the command above makes the
  tools available there too.

### Prefer a prebuilt image?

Every push to `main` publishes a ready-to-run image to the GitHub Container Registry,
so you can skip the local build entirely:

```bash
docker run -d --name learnworlds-mcp -p 127.0.0.1:8765:8765 --env-file .env \
  ghcr.io/ohneben/learnworlds-mcp:latest
```

### Find it in a registry

The server publishes itself to the [official MCP Registry](https://registry.modelcontextprotocol.io)
as `io.github.ohneben/learnworlds-mcp`, so MCP clients that browse the registry can
install it without cloning anything:

```bash
curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.ohneben/learnworlds-mcp"
```

[`server.json`](./server.json) holds the registry metadata and
[`glama.json`](./glama.json) the [Glama](https://glama.ai/mcp/servers/ohneben/Learnworlds-MCP)
directory entry. Pushing a `v*` tag builds the image, then publishes the matching
version to the registry via GitHub OIDC — no tokens to store. The
`io.modelcontextprotocol.server.name` label in the [Dockerfile](./Dockerfile) is what
proves the image belongs to that name, so keep it in step with `name` in `server.json`.

## Get your API credentials

1. Log in to your LearnWorlds school admin.
2. Go to **Settings → Integrations → Developers** (the API screen).
3. Copy your **Access Token** → `LEARNWORLDS_API_TOKEN`, and your **Client ID** →
   `LEARNWORLDS_CLIENT_ID`.
4. Set `LEARNWORLDS_BASE_URL` to your school's API base:
   `https://<your-school>.learnworlds.com/admin/api`. If your school uses a custom
   domain, use that host instead (e.g. `https://academy.example.com/admin/api`).

Put all three in `.env`. The server injects them on every request, so your assistant
never sees them.

## Configuration

Everything is set in `.env` (copied from `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `LEARNWORLDS_BASE_URL` | ✅ | — | Your school's API base URL |
| `LEARNWORLDS_API_TOKEN` | ✅ | — | Bearer access token |
| `LEARNWORLDS_CLIENT_ID` | ✅ | — | Sent as the `Lw-Client` header |
| `MCP_TRANSPORT` | — | `stdio` | `stdio` or `http` (the Docker image defaults to `http`) |
| `PORT` | — | `8765` | HTTP listen port |
| `HOST` | — | `0.0.0.0` | HTTP bind address |
| `MCP_HTTP_PATH` | — | `/mcp` | HTTP MCP route |
| `MCP_SHARED_TOKEN` | — | _(off)_ | Require `Authorization: Bearer <token>` on `/mcp` |
| `LEARNWORLDS_MAX_REQUESTS` | — | `25` | Client-side requests per window (`0` disables throttling) |
| `LEARNWORLDS_RATE_WINDOW_MS` | — | `10000` | Rate-limit window in ms |
| `LEARNWORLDS_MAX_RETRIES` | — | `3` | Retries on `429` / `5xx` / network errors |
| `LEARNWORLDS_TIMEOUT_MS` | — | `30000` | Per-attempt request timeout |
| `LEARNWORLDS_OPENAPI_PATH` | — | _(bundled)_ | Load a different OpenAPI YAML |

After changing `.env`, reload with `docker compose up -d --force-recreate`.

## Tool safety categories

Each tool's description starts with one of these banners and carries the matching
[MCP annotations](https://modelcontextprotocol.io/docs/concepts/tools#tool-annotations):

| Banner | Count | `readOnlyHint` | `destructiveHint` | Meaning |
|---|:---:|:---:|:---:|---|
| 🟢 **READ-ONLY** | 59 | `true` | `false` | Fetches data only. Safe. |
| 🟡 **WRITE · creates data** | — | `false` | `false` | `POST` — creates records (not idempotent; may duplicate). |
| 🟡 **WRITE · updates data** | — | `false` | `false` | `PUT` — modifies existing records in place (idempotent). |
| 🔴 **DESTRUCTIVE · deletes** | 8 | `false` | `true` | `DELETE` — removes a record. Confirm first. |

The 🟡 write tools total **27** (17 create + 10 update). Hosts that respect annotations
(Claude included) can require confirmation for `destructiveHint` tools and trust
`readOnlyHint` tools automatically.

Under the banner, every description follows the same layout so an agent can act on the
first read instead of probing:

| Line | What it answers |
|---|---|
| *(purpose)* | What the endpoint does, straight from the OpenAPI spec, stated once. |
| **Behavior** | What the call does to the live school, whether it is idempotent, and how auth, throttling and retries are handled for it. |
| **Parameters** | Only what the input schema cannot say — the `body` wrapper, paging, and any renamed argument. |
| **Returns** | The `HTTP <status>` + JSON result shape and the error codes that can come back. |
| **Use when** | When to reach for it, when not to, and up to five sibling tools in the same area. |

> Run `npm run list-tools` (no credentials needed) to print the full catalog and the
> per-category counts at any time.

<details>
<summary><strong>Coverage by area (read / write / delete)</strong></summary>

| Area | 🟢 Read | 🟡 Write | 🔴 Delete |
|---|:---:|:---:|:---:|
| Users | 10 | 7 | 1 |
| Affiliates | 7 | 1 | 0 |
| Community | 6 | 3 | 2 |
| Courses | 5 | 3 | 0 |
| Promotions (coupons) | 4 | 3 | 0 |
| Reporting | 4 | 0 | 0 |
| Payments | 3 | 0 | 0 |
| Multiple seats | 3 | 3 | 2 |
| User groups | 3 | 3 | 2 |
| Bundles | 2 | 0 | 0 |
| Assessments | 2 | 1 | 0 |
| Subscription plans | 2 | 0 | 0 |
| Certificates | 1 | 1 | 1 |
| User subscriptions | 1 | 0 | 0 |
| User roles | 1 | 0 | 0 |
| Installments | 1 | 0 | 0 |
| Leads | 1 | 0 | 0 |
| Calendar | 1 | 0 | 0 |
| Event logs | 1 | 0 | 0 |
| Asynchronous actions | 1 | 0 | 0 |
| Update user progress | 0 | 2 | 0 |
| **Total** | **59** | **27** | **8** |
</details>

## Run from source (stdio, no Docker)

Prefer the classic stdio mode for Claude Desktop? Build it locally:

```bash
npm install
npm run build
```

Then point Claude Desktop at the compiled entrypoint in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "learnworlds": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/Learnworlds-MCP/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "LEARNWORLDS_BASE_URL": "https://your-school.learnworlds.com/admin/api",
        "LEARNWORLDS_API_TOKEN": "your-access-token",
        "LEARNWORLDS_CLIENT_ID": "your-client-id"
      }
    }
  }
}
```

## Keeping the spec current

The bundled `spec/learnworlds-openapi.yaml` is the source of truth for the tools. To
refresh against a newer API version, drop the new YAML in its place (or point
`LEARNWORLDS_OPENAPI_PATH` at it) and rebuild:

```bash
docker compose up -d --build   # Docker
# or
npm run build                  # from source
```

New paths become new tools automatically — no code changes needed.

## Development

```bash
npm install
npm run build      # compile TypeScript → dist/
npm test           # run the Vitest suite
npm run list-tools # print the categorized tool catalog (no credentials needed)
```

CI builds and tests every push across Node 20 and 22; pushes to `main` also publish a
Docker image to the GitHub Container Registry. Pushing a `v*` tag publishes that image
and then the matching version to the official MCP Registry.

## Notes & conventions

- **Transports**: `MCP_TRANSPORT=stdio` (default) for local launchers; `MCP_TRANSPORT=http`
  for the always-on Streamable-HTTP server the Docker image runs.
- **Paging**: most `get` tools accept `page` (and endpoint-specific filters); LearnWorlds
  paginates list responses (commonly 20–50 items per page).
- **Rate limit**: LearnWorlds allows 30 requests / 10 s; the server self-throttles at
  `LEARNWORLDS_MAX_REQUESTS` per `LEARNWORLDS_RATE_WINDOW_MS` (default 25 / 10 s) and
  retries any `429` it still receives.
- **Request bodies**: write tools take a `body` argument; its schema is resolved from the
  spec and shown to the model.

## Security

- Your API credentials live only in `.env`, which is git-ignored. **Never commit real
  secrets.** If the token leaks, rotate it in
  **LearnWorlds admin → Settings → Integrations → Developers (API)**.
- The HTTP endpoint is unauthenticated by default (fine on localhost). To expose it
  beyond your machine, set `MCP_SHARED_TOKEN` and send it as an
  `Authorization: Bearer <token>` header — ideally behind TLS.

See [SECURITY.md](./SECURITY.md) for the full policy and how to report a vulnerability.

## Credits & license

An unofficial community integration for [LearnWorlds](https://www.learnworlds.com/);
not affiliated with or endorsed by LearnWorlds. Built on the
[Model Context Protocol](https://modelcontextprotocol.io). Licensed under the
[MIT License](./LICENSE.md).
