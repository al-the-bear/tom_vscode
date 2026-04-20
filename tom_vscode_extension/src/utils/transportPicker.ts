/**
 * Shared transport picker webview component (spec §4.15).
 *
 * Used by the queue editor (queue-default + per-item / per-stage
 * overrides) and any other surface that queues prompts. Produces an
 * HTML fragment with a primary transport dropdown and — when
 * `showTargets` is true — a secondary pair below:
 *
 *   - Profile dropdown (Anthropic only; lists anthropic.profiles[])
 *   - Template dropdown (per transport):
 *       * Anthropic  → anthropic.userMessageTemplates[]  (wraps user msg)
 *       * Copilot    → copilot.templates (keyed by name)  (wraps entire prompt)
 *
 * The old "Config" dropdown is gone: the configuration is derived from
 * the profile (anthropic.profiles[i].defaultConfigurationId), so picking
 * it here was redundant at best and misleading at worst.
 *
 * The fragment dispatches a single webview message of type
 * `options.onChangeEvent` on any field change, carrying:
 *   { transport, anthropicProfileId, messageTemplateId }
 *
 * This helper is HTML-only — the consuming webview is responsible for
 * wiring the event via `vscode.postMessage` inside its own script
 * block. See `queueEditor-handler.ts` for the wiring pattern.
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
    /**
     * Id (anthropic) or name (copilot) of the message-wrapping template.
     * Semantics depend on the current `transport`:
     *   - transport='anthropic' → an anthropic.userMessageTemplates[].id
     *   - transport='copilot'   → a key into copilot.templates
     */
    messageTemplateId?: string;
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

/**
 * Message-template options for the ANTHROPIC transport — pulls from
 * anthropic.userMessageTemplates[] (same list the chat panel's
 * "user message" dropdown uses). `transport='anthropic'` is the only
 * state that makes this list visible.
 */
function anthropicTemplateOptions(selectedId: string | undefined): string {
    const config = loadSendToChatConfig();
    const templates = (config?.anthropic?.userMessageTemplates ?? []) as Array<{
        id?: string;
        name?: string;
    }>;
    const entries: Array<{ value: string; label: string }> = [
        { value: '', label: '(none)' },
    ];
    for (const t of templates) {
        if (!t || !t.id) { continue; }
        const label = t.name ? `${t.name} (${t.id})` : t.id;
        entries.push({ value: t.id, label });
    }
    return entries
        .map((e) => {
            const sel = (selectedId ?? '') === e.value ? ' selected' : '';
            return `<option value="${escapeHtml(e.value)}"${sel}>${escapeHtml(e.label)}</option>`;
        })
        .join('');
}

/**
 * Message-template options for the COPILOT transport — pulls keys from
 * copilot.templates (spec §4.16). Mirrors the "Template:" dropdown in
 * the queue template editor so users can pick the same template at
 * queue level and have it stamp onto each main prompt.
 */
function copilotTemplateOptions(selectedName: string | undefined): string {
    const config = loadSendToChatConfig();
    const tpls = ((config as { copilot?: { templates?: Record<string, unknown> } })?.copilot?.templates ?? {}) as Record<string, unknown>;
    const entries: Array<{ value: string; label: string }> = [
        { value: '', label: '(none)' },
    ];
    for (const name of Object.keys(tpls).sort()) {
        entries.push({ value: name, label: name });
    }
    return entries
        .map((e) => {
            const sel = (selectedName ?? '') === e.value ? ' selected' : '';
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
    // Profile only makes sense for Anthropic; templates exist for both
    // transports. Hide the whole block only when showTargets is off or
    // when the transport isn't picked yet.
    const isAnthropic = options.value.transport === 'anthropic';
    const isCopilot = options.value.transport === 'copilot';
    const showTargetsBlock = options.showTargets && (isAnthropic || isCopilot);
    const targetsHidden = showTargetsBlock ? '' : ' style="display:none;"';
    const profileHidden = isAnthropic ? '' : ' style="display:none;"';
    // We render both template selects up-front and toggle visibility in
    // the onChange script so switching transport doesn't require a
    // server round-trip.
    const anthropicTplHidden = isAnthropic ? '' : ' style="display:none;"';
    const copilotTplHidden = isCopilot ? '' : ' style="display:none;"';
    return `
<div class="transport-picker" data-tp-prefix="${escapeHtml(options.idPrefix)}" data-tp-event="${escapeHtml(options.onChangeEvent)}"${options.inline ? ' style="display:inline-flex;gap:6px;align-items:center;"' : ''}>
    <label for="${id('t')}" style="white-space:nowrap;"><strong>Transport:</strong></label>
    <select id="${id('t')}" class="tp-transport">
        ${transportOptionsFor(options.context, options.value.transport)}
    </select>
    <span id="${id('targets')}" class="tp-targets"${targetsHidden}>
        <span id="${id('profile-wrap')}" class="tp-profile-wrap"${profileHidden}>
            <label for="${id('profile')}" style="white-space:nowrap;margin-left:6px;">Profile:</label>
            <select id="${id('profile')}" class="tp-profile">
                ${profileOptions(options.value.anthropicProfileId)}
            </select>
        </span>
        <label for="${id('tpl')}" style="white-space:nowrap;margin-left:6px;">Template:</label>
        <select id="${id('tpl-anthropic')}" class="tp-tpl-anthropic"${anthropicTplHidden}>
            ${anthropicTemplateOptions(isAnthropic ? options.value.messageTemplateId : undefined)}
        </select>
        <select id="${id('tpl-copilot')}" class="tp-tpl-copilot"${copilotTplHidden}>
            ${copilotTemplateOptions(isCopilot ? options.value.messageTemplateId : undefined)}
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
    var tplA = document.getElementById(prefix + '-transport-tpl-anthropic');
    var tplC = document.getElementById(prefix + '-transport-tpl-copilot');
    var pWrap = document.getElementById(prefix + '-transport-profile-wrap');
    var targets = document.getElementById(prefix + '-transport-targets');
    var warn = document.getElementById(prefix + '-transport-warn');
    function emit() {
        var t = tSel ? tSel.value : '';
        var tpl = '';
        if (t === 'anthropic' && tplA) { tpl = tplA.value; }
        else if (t === 'copilot' && tplC) { tpl = tplC.value; }
        vscode.postMessage({
            type: eventType,
            idPrefix: prefix,
            transport: t,
            anthropicProfileId: pSel ? pSel.value : '',
            messageTemplateId: tpl,
        });
        var isAnthropic = t === 'anthropic';
        var isCopilot = t === 'copilot';
        if (targets) { targets.style.display = (isAnthropic || isCopilot) ? '' : 'none'; }
        if (pWrap) { pWrap.style.display = isAnthropic ? '' : 'none'; }
        if (tplA) { tplA.style.display = isAnthropic ? '' : 'none'; }
        if (tplC) { tplC.style.display = isCopilot ? '' : 'none'; }
        if (warn) { warn.style.display = isAnthropic ? '' : 'none'; }
    }
    if (tSel) { tSel.addEventListener('change', emit); }
    if (pSel) { pSel.addEventListener('change', emit); }
    if (tplA) { tplA.addEventListener('change', emit); }
    if (tplC) { tplC.addEventListener('change', emit); }
});
`;
}
