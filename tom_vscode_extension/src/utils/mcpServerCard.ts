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
): McpServerCardModel {
    return {
        ...settings,
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
        autoStart: payload.autoStart === true,
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

/** Render the tool multi-checkbox grid — same markup the page uses elsewhere. */
function renderToolCheckboxes(toolNames: readonly string[], enabledTools: readonly string[]): string {
    const selected = new Set(enabledTools);
    return toolNames
        .map((tool) => {
            const safe = escapeHtml(tool);
            const checked = selected.has(tool) ? ' checked' : '';
            const short = tool.replace('tomAi_', '').replace('tom_', '');
            return `<label class="sp-tool-checkbox" title="${safe}">
                <input type="checkbox" data-mcp-tool="${safe}"${checked}>
                ${escapeHtml(short)}
            </label>`;
        })
        .join('');
}

/**
 * Render the MCP Server status-page section. All controls carry stable
 * `data-mcp-field` / `data-mcp-tool` / `data-status-action` hooks so the save
 * handler (#11) and the client gather (#12) can read and persist them.
 */
export function renderMcpServerCard(model: McpServerCardModel, toolNames: readonly string[]): string {
    const statusText = model.running
        ? `Running on http://${escapeHtml(model.boundHost ?? model.host)}:${model.boundPort ?? ''}`
        : 'Stopped';
    const statusClass = model.running ? 'sp-running' : 'sp-stopped';
    const checked = (on: boolean): string => (on ? ' checked' : '');

    return `
    <!-- MCP Server Section -->
    <div class="sp-section" data-mcp-card>
        <div class="sp-section-header">
            <span class="sp-section-title">🔌 MCP Server</span>
            <span class="sp-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="sp-controls">
            <button class="sp-btn ${model.running ? '' : 'primary'}" data-status-action="startMcpServer">Start</button>
            <button class="sp-btn ${model.running ? 'primary' : ''}" data-status-action="stopMcpServer">Stop</button>
            <label style="margin-left:8px;font-size:12px;display:inline-flex;align-items:center;gap:3px">
                <input type="checkbox" data-mcp-field="enabled"${checked(model.enabled)} />
                Enabled
            </label>
            <label style="margin-left:8px;font-size:12px;display:inline-flex;align-items:center;gap:3px">
                <input type="checkbox" data-mcp-field="autoStart"${checked(model.autoStart)} />
                Autostart
            </label>
        </div>
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
            <label title="When on, expose every tool. Turn off to pick a subset below.">All Tools:</label>
            <select data-mcp-field="toolsEnabled">
                <option value="true"${model.toolsEnabled ? ' selected' : ''}>Enabled (all tools)</option>
                <option value="false"${!model.toolsEnabled ? ' selected' : ''}>Disabled (use subset)</option>
            </select>
        </div>
        <div class="sp-tools-section">
            <label style="font-weight:bold;margin-bottom:4px;display:block">Enabled Tools:</label>
            <div class="sp-tools-grid">${renderToolCheckboxes(toolNames, model.enabledTools)}</div>
        </div>
        <div class="sp-controls" style="margin-top:8px">
            <button class="sp-btn primary" data-status-action="saveMcpServer">Save MCP Settings</button>
        </div>
    </div>`;
}
