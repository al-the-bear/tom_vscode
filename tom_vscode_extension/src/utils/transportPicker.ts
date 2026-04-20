/**
 * Shared transport picker webview component (spec §4.15).
 *
 * Used by both the queue editor (queue-default + per-item / per-stage
 * overrides) and the prompt template editor. Produces an HTML fragment
 * with a primary transport dropdown and — when `showTargets` is true —
 * conditional Anthropic profile + config dropdowns below.
 *
 * The config dropdown aggregates BOTH `anthropic.configurations[]` and
 * `localLlm.configurations[]` per §4.3; each option is labelled by
 * backing type so the user can tell them apart:
 *   [direct]    — anthropic.configurations with transport='direct'
 *   [agentSdk]  — anthropic.configurations with transport='agentSdk'
 *   [vscodeLm]  — anthropic.configurations with transport='vscodeLm'
 *   [localLlm]  — localLlm.configurations entries
 *
 * The fragment dispatches a single webview message of type
 * `options.onChangeEvent` on any field change, carrying
 * `{ transport, anthropicProfileId, anthropicConfigId }`.
 *
 * This helper is HTML-only — the consuming webview is responsible for
 * wiring the event via `vscode.postMessage` inside its own script
 * block. See `queueEditor-handler.ts` and
 * `globalTemplateEditor-handler.ts` for the wiring pattern.
 */

import { loadSendToChatConfig } from '../handlers/handler_shared';

export type TransportPickerContext =
    | 'queue-default'
    | 'queue-item'
    | 'queue-stage'
    | 'template-editor';

export interface TransportPickerValue {
    transport?: 'copilot' | 'anthropic' | '';  // '' = inherit (when context supports it)
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

export interface TransportPickerOptions {
    idPrefix: string;
    context: TransportPickerContext;
    value: TransportPickerValue;
    showTargets: boolean;
    onChangeEvent: string;
    /** Inline styling hints; optional. */
    inline?: boolean;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function transportOptionsFor(context: TransportPickerContext, selected: string | undefined): string {
    const hasInherit = context === 'queue-item' || context === 'queue-stage';
    const inheritLabel = context === 'queue-item'
        ? 'Inherit (queue default)'
        : 'Inherit (item)';
    const entries: Array<{ value: string; label: string }> = [];
    if (hasInherit) {
        entries.push({ value: '', label: inheritLabel });
    }
    entries.push({ value: 'copilot', label: 'Copilot Chat' });
    entries.push({ value: 'anthropic', label: 'Anthropic' });
    return entries
        .map((e) => {
            const sel = (selected ?? '') === e.value ? ' selected' : '';
            return `<option value="${escapeHtml(e.value)}"${sel}>${escapeHtml(e.label)}</option>`;
        })
        .join('');
}

function profileOptions(selectedId: string | undefined): string {
    const config = loadSendToChatConfig();
    const profiles = config?.anthropic?.profiles ?? [];
    const entries: Array<{ value: string; label: string }> = [
        { value: '', label: '(default profile)' },
    ];
    for (const p of profiles) {
        if (!p || !p.id) { continue; }
        const label = p.name ? `${p.name} (${p.id})` : p.id;
        entries.push({ value: p.id, label });
    }
    return entries
        .map((e) => {
            const sel = (selectedId ?? '') === e.value ? ' selected' : '';
            return `<option value="${escapeHtml(e.value)}"${sel}>${escapeHtml(e.label)}</option>`;
        })
        .join('');
}

function configOptions(selectedId: string | undefined): string {
    const config = loadSendToChatConfig();
    const anthropic = (config?.anthropic?.configurations ?? []) as Array<{
        id?: string;
        name?: string;
        transport?: string;
    }>;
    const local = ((config as { localLlm?: { configurations?: Array<{ id?: string; name?: string }> } })?.localLlm?.configurations ?? []);
    const entries: Array<{ value: string; label: string }> = [
        { value: '', label: '(profile default)' },
    ];
    const labelType = (t?: string) => {
        if (t === 'agentSdk') { return '[agentSdk]'; }
        if (t === 'vscodeLm') { return '[vscodeLm]'; }
        return '[direct]';
    };
    for (const c of anthropic) {
        if (!c || !c.id) { continue; }
        const label = `${labelType(c.transport)} ${c.name ? `${c.name} (${c.id})` : c.id}`;
        entries.push({ value: c.id, label });
    }
    for (const c of local) {
        if (!c || !c.id) { continue; }
        const label = `[localLlm] ${c.name ? `${c.name} (${c.id})` : c.id}`;
        entries.push({ value: c.id, label });
    }
    return entries
        .map((e) => {
            const sel = (selectedId ?? '') === e.value ? ' selected' : '';
            return `<option value="${escapeHtml(e.value)}"${sel}>${escapeHtml(e.label)}</option>`;
        })
        .join('');
}

/**
 * Render the picker fragment. Caller must also inject
 * `transportPickerScript()` once into the webview's script block so
 * onChange handlers can post back to the extension host.
 */
export function renderTransportPicker(options: TransportPickerOptions): string {
    const id = (suffix: string) => `${options.idPrefix}-transport-${suffix}`;
    const warnAutoApprove = options.value.transport === 'anthropic'
        ? `<div id="${id('warn')}" style="font-size:11px;color:var(--vscode-notificationsWarningIcon-foreground);margin-top:4px;">⚠️ Queue runs auto-approve every tool call — the profile's approval setting is ignored.</div>`
        : `<div id="${id('warn')}" style="display:none;"></div>`;
    const targetsHidden = options.showTargets && options.value.transport === 'anthropic' ? '' : ' style="display:none;"';
    return `
<div class="transport-picker" data-tp-prefix="${escapeHtml(options.idPrefix)}" data-tp-event="${escapeHtml(options.onChangeEvent)}"${options.inline ? ' style="display:inline-flex;gap:6px;align-items:center;"' : ''}>
    <label for="${id('t')}" style="white-space:nowrap;"><strong>Transport:</strong></label>
    <select id="${id('t')}" class="tp-transport">
        ${transportOptionsFor(options.context, options.value.transport)}
    </select>
    <span id="${id('targets')}" class="tp-targets"${targetsHidden}>
        <label for="${id('profile')}" style="white-space:nowrap;margin-left:6px;">Profile:</label>
        <select id="${id('profile')}" class="tp-profile">
            ${profileOptions(options.value.anthropicProfileId)}
        </select>
        <label for="${id('config')}" style="white-space:nowrap;margin-left:6px;">Config:</label>
        <select id="${id('config')}" class="tp-config">
            ${configOptions(options.value.anthropicConfigId)}
        </select>
    </span>
    ${warnAutoApprove}
</div>
`;
}

/**
 * Shared webview-side script fragment. Drop this once into the
 * consuming editor's `<script>` block. It attaches change handlers
 * to every `.transport-picker` on the page and posts the declared
 * onChangeEvent back to the extension with the current selection.
 */
export function transportPickerScript(): string {
    return `
document.querySelectorAll('.transport-picker').forEach(function(root) {
    var prefix = root.getAttribute('data-tp-prefix') || '';
    var eventType = root.getAttribute('data-tp-event') || '';
    var tSel = document.getElementById(prefix + '-transport-t');
    var pSel = document.getElementById(prefix + '-transport-profile');
    var cSel = document.getElementById(prefix + '-transport-config');
    var targets = document.getElementById(prefix + '-transport-targets');
    var warn = document.getElementById(prefix + '-transport-warn');
    function emit() {
        vscode.postMessage({
            type: eventType,
            idPrefix: prefix,
            transport: tSel ? tSel.value : '',
            anthropicProfileId: pSel ? pSel.value : '',
            anthropicConfigId: cSel ? cSel.value : '',
        });
        var isAnthropic = tSel && tSel.value === 'anthropic';
        if (targets) { targets.style.display = isAnthropic ? '' : 'none'; }
        if (warn) { warn.style.display = isAnthropic ? '' : 'none'; }
    }
    if (tSel) { tSel.addEventListener('change', emit); }
    if (pSel) { pSel.addEventListener('change', emit); }
    if (cSel) { cSel.addEventListener('change', emit); }
});
`;
}
