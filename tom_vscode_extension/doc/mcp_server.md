# Standalone MCP Server

The extension can publish its shared tool registry as a real [Model Context Protocol](https://modelcontextprotocol.io) server over HTTP, so **external** MCP clients (Claude Desktop, other agents/editors, CLI tools) can call the same tools the in-editor LLM panels use. Full design record: `_ai/quests/vscode_extension/mcp_server_implementation_plan.md`.

## 1. Two surfaces, one registry

The extension exposes its tools through two independent MCP surfaces. They share the tool registry but nothing else — different lifecycle, auth, and tool selection:

| Surface | Where it runs | Who reaches it | Built by |
| --- | --- | --- | --- |
| **In-SDK MCP** (Anthropic Agent SDK) | In-process, for the ANTHROPIC panel's `agentSdk` transport | The local Claude agent only | `agent-sdk-transport.ts:buildMcpServer` (`createSdkMcpServer`) |
| **Standalone MCP server** (this doc) | A Streamable-HTTP listener bound to a TCP port | Any external MCP client on the host / VPN | `mcpServer-handler.ts:buildToolMcpServer` (`@modelcontextprotocol/sdk`) |

The standalone server is also **separate from the scripting-API / CLI bridge**: it has its own tool picker (not a chat profile), its own inbound API key, and its own start/stop lifecycle.

> **Security is enforced in the extension, never in any Dart/CLI client.** The effective tool set for every request is resolved server-side from the configured allow-list narrowed by the inbound auth decision. A client cannot widen its own access.

## 2. Enable it

The server is **off by default**. Turn it on from the **Status Page → MCP Server** card, or edit `.tom/tom_vscode_extension.json` directly:

```json
"mcpServer": {
  "enabled": true,
  "autoStart": true,
  "host": "0.0.0.0",
  "basePort": 19920,
  "apiKeyEnv": "TOM_MCP_KEY",
  "allowWriteWithoutAuth": false,
  "toolsEnabled": true,
  "enabledTools": []
}
```

All fields are optional; `getMcpServerSettings` applies the defaults below.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master on/off switch. |
| `autoStart` | boolean | `false` | Start on extension activation (only when `enabled`). |
| `host` | string | `0.0.0.0` | Bind address. `0.0.0.0` is reachable across the VPN; use `127.0.0.1` to keep it host-local. |
| `basePort` | number | `19920` | First port to try. The server probes **upward** to the first free port (clear of the CLI bridge's `19900`). |
| `apiKeyEnv` | string | `""` | **Name** of the env var holding the expected inbound bearer token — never the secret itself. Empty ⇒ no auth configured. |
| `allowWriteWithoutAuth` | boolean | `false` | When `true`, unauthenticated clients also get the write tools. **Read the security note in §5 first.** |
| `toolsEnabled` | boolean | `true` | `true` ⇒ expose all registry tools; `false` ⇒ expose only `enabledTools`. |
| `enabledTools` | string[] | `[]` | The independent allow-list (its own picker, not a chat profile). Honoured only when `toolsEnabled === false`. |

The actually-bound port is **runtime state** — when `basePort` is busy the server binds `basePort + 1`, `+2`, …, so it is surfaced in the UI and the log, never written back into the config.

### 2.1 Tool-picker UI (status page card)

The on-disk shape stays `toolsEnabled` (boolean) + `enabledTools` (list), but the
status-page **"All Tools" dropdown is tri-state** for usability, mirroring the
Anthropic profile editor:

| Dropdown option | Persisted as |
| --- | --- |
| **Enabled (all tools)** | `toolsEnabled: true` |
| **Read-only tools** | `toolsEnabled: false`, `enabledTools` = the read-only floor (`READ_ONLY_TOOLS`) |
| **Custom (use subset)** | `toolsEnabled: false`, `enabledTools` = the hand-picked subset |

"Read-only" is therefore the subset that *equals* the read-only set — no schema
migration. On re-render `deriveToolsMode()` reports `readonly` when the saved
subset exactly matches that set, so the choice round-trips. Below the dropdown,
the per-tool checkboxes are **grouped by category** (`categorizeTools`, shared
with the profile editor) with per-group `all`/`none` buttons and global
`Select All` / `Select None` / `Read-Only` bulk buttons. The client gather reads
the dropdown mode: `all` → `toolsEnabled: true`; `readonly` → collect the
`data-readonly` tools (robust even if the preset never ran); `custom` → collect
the checked boxes.

## 3. Architecture

`src/handlers/mcpServer-handler.ts` is deliberately `vscode`-free (so it is unit-testable under the `out/utils/__tests__/*.test.js` glob); only `extension.ts` composes the real `vscode` objects. It is built from four cooperating pieces:

1. **Effective-set resolution** — `resolveEffectiveMcpTools(settings, bearer, env)` resolves the configured allow-list with the **same** primitive the chat profiles use (`resolveProfileTools` over `toolsEnabled`/`enabledTools`), then narrows it by the auth + read-only floor (§4). `resolveMcpRequestTools` wraps it to additionally emit one audit line per decision.
2. **Port probing** — `bindFirstFreePort(basePort, maxAttempts, attempt, log)` walks upward from `basePort` (up to `MCP_PORT_PROBE_ATTEMPTS` = 100) until a bind succeeds, retrying only on `EADDRINUSE` and aborting on any other error (e.g. `EACCES`). The socket binder is injected, so the search logic is tested without real sockets.
3. **Stateless per-request server** — `startMcpHttpServer` binds one HTTP listener; `handleMcpRequest` extracts the bearer, resolves *that request's* effective tool set, builds a **fresh** `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`), serves the request, then closes both. Auth therefore gates every call, not just the first.
4. **Lifecycle controller** — `McpServerController` owns the single running server for the window. Start is idempotent (a start while already running, or while a bind is in flight, reuses the existing server — never a second listener); `stop`/`restart`/`dispose` guarantee the port is released; every transition fires `onChange` so the Status-Page card can show the live bound port.

`extension.ts` composes the production controller: the real `defaultMcpServerStarter` (with the `TrailService`-backed sink and the `mcpLog` channel), `autoStart` on activation, the palette commands, the config-file watcher (§6), and disposal on `deactivate`.

## 4. Auth + read-only floor

Authentication is a single comparison: a request is **authenticated** only when the operator configured an expected token (`apiKeyEnv` names a non-empty env var) **and** the client presents a matching bearer:

```
Authorization: Bearer <value of the env var named by apiKeyEnv>
```

A missing/empty/wrong bearer — or no configured token at all — is unauthenticated. The effective tool set is then:

| Authenticated? | `allowWriteWithoutAuth` | Effective tools |
| --- | --- | --- |
| ✅ yes | — | The full configured allow-list (read **and** write). |
| ❌ no | `false` (default) | **Read-only floor** — only tools flagged `readOnly`. |
| ❌ no | `true` | The full configured allow-list (read **and** write). |

The read-only floor is the safe default: an unconfigured or unauthenticated server still answers read queries but cannot mutate the workspace or run commands. The bearer token value is **never** logged — only the decision (authenticated / read-only floor) and the tool count.

## 5. Security warning — `0.0.0.0` + `allowWriteWithoutAuth`

The default `host` is `0.0.0.0`, which makes the server reachable by **every machine on the WireGuard VPN**, not just localhost. That is intentional (so other fleet hosts can drive it) but it means:

> **`host: "0.0.0.0"` together with `allowWriteWithoutAuth: true` exposes unattended write + command-execution tools to every VPN peer with no credential.** Anyone who can route to the port can edit files and run shell commands in this workspace.

There is a second reason the key matters here: **MCP calls bypass the `canUseTool` approval gate** that the Agent SDK transport applies to its in-SDK tools (`anthropic_handler.md` §2b). An MCP `tools/call` that lands in the effective set executes immediately — there is no interactive per-call confirmation. So the auth decision (and the read-only floor) is the *only* thing standing between a caller and an unattended mutation; nothing downstream will prompt for approval.

The API key is the real boundary. When you expose write tools:

- **Set `apiKeyEnv`** to a non-empty env var and keep `allowWriteWithoutAuth: false`. Authenticated clients then get write access; everyone else stays on the read-only floor.
- Treat `allowWriteWithoutAuth: true` as a localhost-only (`host: "127.0.0.1"`) or fully-trusted-network convenience, never as a VPN-wide default.

## 6. Operator guide

1. **Set the key** (only if you want write access for authenticated clients). Pick an env-var name, put it in `apiKeyEnv`, and export the secret in the environment VS Code is launched from:

   ```bash
   export TOM_MCP_KEY="$(openssl rand -hex 32)"
   ```

   The config stores the **name** (`TOM_MCP_KEY`), never the value.

2. **Enable + start.** Set `enabled: true` (and optionally `autoStart: true`) on the card or in JSON. Start/stop the server with either:
   - the **Status Page → MCP Server** card's **Start / Stop / Restart** buttons, or
   - the command palette: **`@T: Start Tom MCP Server`** (`tomAi.mcpServer.start`), **`@T: Stop Tom MCP Server`** (`tomAi.mcpServer.stop`), **`@T: Restart Tom MCP Server`** (`tomAi.mcpServer.restart`).

   On start, a toast reports the bound URL (`http://<host>:<port>`).

3. **Reach it.** Point the external MCP client at `http://<host>:<port>` over Streamable HTTP. With `host: 0.0.0.0`, use the host's VPN IP (`10.8.0.x`) from another fleet machine; with `127.0.0.1`, only local clients can connect. Add the `Authorization: Bearer …` header when authenticating.

4. **Edit settings live.** Saving the card reconciles the running server, and so does editing the `mcpServer` block in `.tom/tom_vscode_extension.json` from another window or by hand — a file-system watcher reloads the config and calls `reconcileMcpServerConfig` (disabled ⇒ stop; running ⇒ restart onto the new host/port/tools/auth).

## 7. Observability

- **Output channel** — lifecycle and per-request decisions stream to the **`Tom AI: MCP Server`** channel in the Output dropdown (`src/utils/mcpServerLog.ts`, ISO-timestamped). It logs each busy port probe and the finally-bound port, `started on <url>` / `stopped`, the auth decision per request (authenticated → full set vs read-only floor, **with the token redacted**), and per-request errors.
- **Trail** — every external tool call writes a request/answer pair to the per-window trail under **`${ai}/trail/mcp/${quest}`** (the `mcp` trail subsystem), and tags the resulting change-log entries with `source: 'mcp'`, so external mutations are attributable alongside the `anthropic`/`copilot` surfaces.

## 8. Related references

- `_ai/quests/vscode_extension/mcp_server_implementation_plan.md` — the full design record (todos 1–23) and the remaining-work list.
- `anthropic_handler.md` — the in-SDK MCP server used by the Agent SDK transport (§2b there).
- `llm_tools.md` — the shared tool registry the MCP server exposes.
- `../_copilot_guidelines/tom_status_page.md` — the Status-Page MCP card (controls + Start/Stop wiring).
