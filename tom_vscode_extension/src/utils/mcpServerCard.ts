/**
 * Status-page card for the standalone MCP server (plan §6, todo #10).
 *
 * Pure rendering helpers, deliberately free of `vscode` / the tool registry so
 * the card can be unit-tested in isolation (the statusPage handler has a heavy
 * import graph). `buildMcpServerCardModel` maps the resolved `mcpServer`
 * settings plus runtime state into a view-model; `renderMcpServerCard` turns
 * that view-model and the available tool names into an HTML fragment.
 * `buildMcpServerConfigFromMessage` (todo #11) is the inverse: it maps the
 * field payload the webview posts back into the on-disk `McpServerConfig`
 * shape, so the save handler can be a thin one-liner.
 *
 * The tool-name options are passed in by the caller — the handler supplies
 * `AVAILABLE_LLM_TOOLS`, the exact same option set the Anthropic profile
 * templates use (globalTemplateEditor-handler.ts `anthropicProfiles` case) — so
 * this module imports only TYPES from sendToChatConfig (erased at runtime).
 */

import type { McpServerConfig, ResolvedMcpServerSettings } from './sendToChatConfig';
import { categorizeTools } from './toolCategories';

/**
 * Live runtime state of the MCP server. The bound `host`/`port` are only
 * meaningful while `running` (the server probes upward from `basePort`, so the
 * actually-bound port is runtime state, not config). Wired to the real server
 * in plan todo #19; until then the handler passes `{ running: false }`.
 */
export interface McpServerRuntimeStatus {
    running: boolean;
    host?: string;
    port?: number;
}

/** View-model the card renders from: resolved config + runtime overlay. */
export interface McpServerCardModel extends ResolvedMcpServerSettings {
    /**
     * Start the server on activation. Machine-scoped, so it is NOT part of the
     * resolved config (which is machine-independent) — the handler reads it from
     * {@link extensionConfigStore} and passes it in.
     */
    autoStart: boolean;
    running: boolean;
    /** Live bound host while running (runtime state), else undefined. */
    boundHost?: string;
    /** Live bound port while running (runtime state), else undefined. */
    boundPort?: number;
}

/** Combine resolved settings with runtime state into the card view-model. */
export function buildMcpServerCardModel(
    settings: ResolvedMcpServerSettings,
    runtime: McpServerRuntimeStatus,
    autoStart: boolean,
): McpServerCardModel {
    return {
        ...settings,
        autoStart: autoStart === true,
        running: runtime.running === true,
        boundHost: runtime.running ? runtime.host : undefined,
        boundPort: runtime.running ? runtime.port : undefined,
    };
}

/**
 * Field payload the Status-Page webview posts when saving the MCP card. Values
 * arrive untyped (e.g. number inputs send strings, checkboxes send booleans),
 * so each field is `unknown` and normalised by {@link buildMcpServerConfigFromMessage}.
 */
export interface McpServerSavePayload {
    enabled?: unknown;
    autoStart?: unknown;
    host?: unknown;
    basePort?: unknown;
    apiKeyEnv?: unknown;
    allowWriteWithoutAuth?: unknown;
    toolsEnabled?: unknown;
    enabledTools?: unknown;
}

/**
 * The save gather-map: normalise the webview's field payload into the on-disk
 * `McpServerConfig`. Blank `host`/`apiKeyEnv` and invalid `basePort` are dropped
 * (left `undefined`) so {@link getMcpServerSettings} supplies the documented
 * defaults on read — the resolver remains the single source of defaults.
 * `toolsEnabled` is "all tools" unless the payload says explicitly `false`.
 */
export function buildMcpServerConfigFromMessage(payload: McpServerSavePayload): McpServerConfig {
    const host = typeof payload.host === 'string' ? payload.host.trim() : '';
    const apiKeyEnv = typeof payload.apiKeyEnv === 'string' ? payload.apiKeyEnv.trim() : '';
    const basePort = Number(payload.basePort);
    const enabledTools = Array.isArray(payload.enabledTools)
        ? payload.enabledTools.filter((t): t is string => typeof t === 'string')
        : [];
    return {
        enabled: payload.enabled === true,
        host: host || undefined,
        basePort: Number.isFinite(basePort) && basePort > 0 ? Math.floor(basePort) : undefined,
        apiKeyEnv: apiKeyEnv || undefined,
        allowWriteWithoutAuth: payload.allowWriteWithoutAuth === true,
        toolsEnabled: payload.toolsEnabled !== false,
        enabledTools,
    };
}

/** Escape a string for safe interpolation into an HTML attribute or text. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The three persisted tool-selection modes the "All Tools" dropdown offers.
 * `all` ⇒ expose every tool; `readonly` ⇒ exactly the read-only floor;
 * `custom` ⇒ the hand-picked `enabledTools` subset. The on-disk shape stays a
 * boolean `toolsEnabled` + `enabledTools` list (see
 * {@link buildMcpServerConfigFromMessage}); `readonly` is the subset that
 * happens to equal the read-only set, so no schema migration is needed.
 */
export type McpToolsMode = 'all' | 'readonly' | 'custom';

/**
 * Derive which dropdown option to pre-select. `all` when `toolsEnabled`;
 * otherwise `readonly` when the saved subset is exactly the read-only set
 * (so a one-click "Read-only" preset round-trips), else `custom`.
 */
export function deriveToolsMode(
    model: Pick<McpServerCardModel, 'toolsEnabled' | 'enabledTools'>,
    readOnlyToolNames?: ReadonlySet<string>,
): McpToolsMode {
    if (model.toolsEnabled) { return 'all'; }
    if (readOnlyToolNames && readOnlyToolNames.size > 0) {
        const enabled = new Set(model.enabledTools);
        if (enabled.size === readOnlyToolNames.size
            && [...enabled].every((t) => readOnlyToolNames.has(t))) {
            return 'readonly';
        }
    }
    return 'custom';
}

/**
 * Render the per-tool selection as grouped checkboxes — the same grouped layout
 * the Anthropic profile editor uses (`categorizeTools` + per-group all/none
 * buttons). Each checkbox keeps the stable `data-mcp-tool` hook the client
 * gather reads, plus `data-readonly` so the "Read-only" presets (dropdown +
 * bulk button) can target the read-only floor without a server round-trip.
 */
function renderToolGroups(
    toolNames: readonly string[],
    enabledTools: readonly string[],
    readOnlyToolNames?: ReadonlySet<string>,
): string {
    const selected = new Set(enabledTools);
    const groups = categorizeTools(toolNames, readOnlyToolNames);
    return groups
        .map((group) => {
            const safeCat = escapeHtml(group.category);
            const rows = group.tools
                .map((tool) => {
                    const safe = escapeHtml(tool.value);
                    const checked = selected.has(tool.value) ? ' checked' : '';
                    const readonlyAttr = tool.readOnly ? ' data-readonly="true"' : '';
                    const short = tool.value.replace('tomAi_', '').replace('tom_', '');
                    return `<label class="sp-tool-checkbox" title="${safe}">
                        <input type="checkbox" data-mcp-tool="${safe}"${readonlyAttr}${checked}>
                        ${escapeHtml(short)}
                    </label>`;
                })
                .join('');
            return `<div class="sp-tool-group" data-mcp-group="${safeCat}">
                <div class="sp-tool-group-header">
                    <span class="sp-tool-group-name">${safeCat}</span>
                    <button type="button" class="sp-btn sp-tool-group-btn" data-mcp-group-all="${safeCat}">all</button>
                    <button type="button" class="sp-btn sp-tool-group-btn" data-mcp-group-none="${safeCat}">none</button>
                </div>
                <div class="sp-tools-grid">${rows}</div>
            </div>`;
        })
        .join('');
}

/**
 * Render the MCP Server status-page sections. The fragment is split into two
 * sibling `sp-section` cards wrapped in a single `data-mcp-card` container:
 *
 * - **MCP Server** — the always-open control card: status badge, the
 *   Start/Stop/Restart lifecycle buttons, and the Enabled/Autostart checkboxes.
 *   It carries no collapse header so the controls are always directly reachable.
 * - **MCP Server Configuration** — a collapsible accordion (default collapsed)
 *   holding every remaining setting plus the Save button. The client closes it
 *   on save (`saveMcpServer`), matching the other status-page accordions.
 *
 * The shared `data-mcp-card` wrapper means the client gather (#12) still reaches
 * every `data-mcp-field` / `data-mcp-tool` control regardless of which card it
 * lives in, so the save handler (#11) persists the control checkboxes and the
 * configuration fields together in one round-trip.
 */
export function renderMcpServerCard(
    model: McpServerCardModel,
    toolNames: readonly string[],
    readOnlyToolNames?: ReadonlySet<string>,
): string {
    const statusText = model.running
        ? `Running on http://${escapeHtml(model.boundHost ?? model.host)}:${model.boundPort ?? ''}`
        : 'Stopped';
    const statusClass = model.running ? 'sp-running' : 'sp-stopped';
    const checked = (on: boolean): string => (on ? ' checked' : '');
    const toolsMode = deriveToolsMode(model, readOnlyToolNames);
    const modeSelected = (m: McpToolsMode): string => (toolsMode === m ? ' selected' : '');

    return `
    <!-- MCP Server (control + configuration) -->
    <div data-mcp-card>
        <!-- (a) Control card — always open for direct access -->
        <div class="sp-section">
            <div class="sp-section-header">
                <span class="sp-section-title">🔌 MCP Server</span>
                <span class="sp-badge ${statusClass}">${statusText}</span>
            </div>
            <div class="sp-controls">
                <button class="sp-btn ${model.running ? '' : 'primary'}" data-status-action="startMcpServer">Start</button>
                <button class="sp-btn ${model.running ? 'primary' : ''}" data-status-action="stopMcpServer">Stop</button>
                <button class="sp-btn" data-status-action="restartMcpServer">Restart</button>
                <label style="margin-left:8px;font-size:12px;display:inline-flex;align-items:center;gap:3px">
                    <input type="checkbox" data-mcp-field="enabled"${checked(model.enabled)} />
                    Enabled
                </label>
                <label style="margin-left:8px;font-size:12px;display:inline-flex;align-items:center;gap:3px">
                    <input type="checkbox" data-mcp-field="autoStart"${checked(model.autoStart)} />
                    Autostart
                </label>
            </div>
        </div>
        <!-- (b) Configuration card — accordion, opened on demand, closes on save -->
        <div class="sp-section">
            <div class="sp-section-header sp-collapsible" data-collapse="mcpConfig">
                <span class="sp-section-title"><span class="sp-collapse-icon">▶</span> ⚙️ MCP Server Configuration</span>
            </div>
            <div class="sp-collapse-content sp-collapsed" id="sp-mcpConfig-content">
                <div class="sp-settings-row">
                    <label title="Bind address. Default 0.0.0.0 is reachable over the VPN.">Host:</label>
                    <input type="text" data-mcp-field="host" value="${escapeHtml(model.host)}" placeholder="0.0.0.0" style="flex:1">
                    <label title="First port to try; the server probes upward to the first free port. The actually-bound port is shown in the status line above.">Base Port:</label>
                    <input type="number" data-mcp-field="basePort" value="${model.basePort}" min="1" max="65535" step="1" style="width:100px">
                </div>
                <div class="sp-settings-row">
                    <label title="Name of the env var holding the expected inbound bearer token clients must present. Empty = unauthenticated.">API Key Env:</label>
                    <input type="text" data-mcp-field="apiKeyEnv" value="${escapeHtml(model.apiKeyEnv)}" placeholder="(none, e.g. MCP_API_KEY)" style="flex:1">
                </div>
                <div class="sp-settings-row">
                    <label class="sp-tool-checkbox" title="Binding 0.0.0.0 exposes the server to every host on the VPN, and MCP calls bypass the approval gate. With this ON, any VPN host gets unattended file-write / shell-exec. The API key is the real boundary; leave this OFF unless you accept that.">
                        <input type="checkbox" data-mcp-field="allowWriteWithoutAuth"${checked(model.allowWriteWithoutAuth)}>
                        Allow write tool access if not authenticated
                    </label>
                </div>
                <div class="sp-settings-row">
                    <label title="Expose every tool, only the read-only floor, or a hand-picked subset.">All Tools:</label>
                    <select data-mcp-field="toolsEnabled">
                        <option value="all"${modeSelected('all')}>Enabled (all tools)</option>
                        <option value="readonly"${modeSelected('readonly')}>Read-only tools</option>
                        <option value="custom"${modeSelected('custom')}>Custom (use subset below)</option>
                    </select>
                </div>
                <div class="sp-tools-section">
                    <label style="font-weight:bold;margin-bottom:4px;display:block">Enabled Tools:</label>
                    <div class="sp-tool-bulk">
                        <button type="button" class="sp-btn sp-tool-bulk-btn" data-mcp-tools-all>Select All</button>
                        <button type="button" class="sp-btn sp-tool-bulk-btn" data-mcp-tools-none>Select None</button>
                        <button type="button" class="sp-btn sp-tool-bulk-btn" data-mcp-tools-readonly>Read-Only</button>
                    </div>
                    <div class="sp-tool-groups">${renderToolGroups(toolNames, model.enabledTools, readOnlyToolNames)}</div>
                </div>
                <div class="sp-controls" style="margin-top:8px">
                    <button class="sp-btn primary" data-status-action="saveMcpServer">Save MCP Settings</button>
                </div>
            </div>
        </div>
    </div>`;
}
