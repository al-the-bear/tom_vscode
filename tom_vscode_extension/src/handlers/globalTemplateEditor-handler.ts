/**
 * Global Prompt Template Editor — full-screen webview panel.
 *
 * Unified editor for all template/profile types stored in the extension
 * config JSON.  Layout: top action bar with category selector + add/delete,
 * left column with template list, right column with multi-field editor.
 *
 * Categories:
 *   1. Copilot — Queue Wrapper       — config.copilot.queueWrapper (one item)
 *   2. Reminder Templates            — config.reminders.templates
 *   3. Timed Requests                — config.timedRequests
 *   4. Anthropic — Profiles          — config.anthropic.profiles
 *   5. Anthropic — User Message      — config.anthropic.userMessageTemplates
 *   6. Compaction                    — config.compaction.templates
 *   7. Memory Extraction             — config.compaction.memoryExtractionTemplates
 *   8. Transport Retry               — config.anthropic.transportRetry.templates
 *   9. Interactive Questions         — config.anthropic.interactiveQuestionsTemplates
 *  10. Assist Prompts                — config.assistPrompts.templates (which one each use
 *                                      runs is chosen on the Status Page)
 *
 * The category dropdown at the top of the editor is the user-facing
 * per-transport switcher mandated by multi_transport_prompt_queue_revised.md
 * §4.16. `Anthropic — User Message` is the one template store both
 * transports read from; `Copilot — Queue Wrapper` is the wrapper that goes
 * around the Copilot sends waiting for an answer (src/utils/copilotTemplates.ts). No separate `renderTransportPicker`
 * control is mounted here because this dropdown already does the job
 * and covers the larger set of stores the editor manages.
 */

import { DEFAULT_CORE_TOOLS } from '../utils/toolSelection';
import { parseSettingSources, parseSystemPromptMode, SETTING_SOURCES, type SettingSource } from '../utils/agentSdkSystemPrompt';
import { DEFAULT_LEGACY_THINKING_BUDGET, EFFORT_LEVELS, profileThinkingSettings, type EffortLevel, type ThinkingMode } from '../utils/thinkingAndEffort';
import * as vscode from 'vscode';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { loadSendToChatConfig, saveSendToChatConfig, SendToChatConfig, DEFAULT_TRANSPORT_RETRY_TEMPLATE_BODY } from '../utils/sendToChatConfig';
import { PLACEHOLDER_HELP } from './promptTemplate';
import { AVAILABLE_LLM_TOOLS } from '../utils/constants';
import { categorizeTools } from '../utils/toolCategories';
import { READ_ONLY_TOOLS } from '../tools/tool-executors';
import { copilotQueueWrapper, DEFAULT_ANSWER_FILE_TEMPLATE } from '../utils/copilotTemplates';
import { parseToolApprovalMode } from '../utils/agentSdkPermissionMode';
import { ASSIST_PROMPT_INFO, ASSIST_PROMPT_USES, assistPromptsHelp } from '../utils/assistPrompts';
import { ALWAYS_ON_TOOLS } from '../utils/roleTypes';

/** The one item of the Copilot — Queue Wrapper category. */
const QUEUE_WRAPPER_ITEM_ID = 'queueWrapper';

// ============================================================================
// Types
// ============================================================================

export type TemplateCategory =
    | 'copilotQueueWrapper'
    | 'reminder'
    | 'timedRequests'
    | 'anthropicProfiles'
    | 'anthropicUserMessage'
    | 'compaction'
    | 'memoryExtraction'
    | 'transportRetry'
    | 'interactiveQuestions'
    | 'assistPrompts';

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
    copilotQueueWrapper: 'Copilot — Queue Wrapper',
    reminder: 'Reminder',
    timedRequests: 'Timed Requests',
    anthropicProfiles: 'Anthropic — Profiles',
    anthropicUserMessage: 'Anthropic — User Message',
    compaction: 'Compaction',
    memoryExtraction: 'Memory Extraction',
    transportRetry: 'Anthropic Transport Retry',
    interactiveQuestions: 'Anthropic — Interactive Questions',
    assistPrompts: 'Assist Prompts',
};

/**
 * Default fallback body for a newly-added Interactive Questions template.
 * Mirrors `DEFAULT_INTERACTIVE_QUESTIONS_TEMPLATE` in
 * `agent-sdk-questions.ts` (kept as a literal here to avoid importing the
 * SDK service into the editor). References `${questions}`.
 */
const DEFAULT_INTERACTIVE_QUESTIONS_TEMPLATE_BODY =
    'The user is not available to answer interactive questions right now. ' +
    'Do not wait for a response — proceed autonomously using your best ' +
    'judgement and the recommendation you would otherwise have presented. ' +
    'If a choice is reversible, pick the most reasonable default and state ' +
    'the assumption you made in your answer.\n\n' +
    'Questions that were skipped:\n${questions}';

interface TemplateItem {
    id: string;
    label: string;
}

// ============================================================================
// Panel management
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;
// Stash the most recent (category, itemId) that `openGlobalTemplateEditor`
// was asked to land on. The webview's 'ready' handshake arrives AFTER we
// try to push the right category, so without this pin the ready handler
// would always fall back to 'copilot' and wipe the target. Cleared once
// the webview acks the initial allData push.
let _pendingInitialCategory: TemplateCategory | undefined;
let _pendingInitialItemId: string | undefined;

/**
 * Open the global template editor, optionally pre-selecting a category and item.
 */
export function openGlobalTemplateEditor(
    context: vscode.ExtensionContext,
    options?: { category?: TemplateCategory; itemId?: string },
): void {
    _context = context;

    if (_panel) {
        _panel.reveal();
        if (options?.category || options?.itemId) {
            _panel.webview.postMessage({
                type: 'selectItem',
                category: options.category,
                itemId: options.itemId,
            });
        }
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'tomAi.globalTemplateEditor',
        'Prompt Template Editor',
        vscode.ViewColumn.Active,
        {
            ...getGlobalTemplateEditorWebviewOptions(context),
            retainContextWhenHidden: true,
        },
    );
    bindGlobalTemplateEditorPanel(context, panel, options);
}

/** Webview options shared by the fresh-open and reload-restore paths. */
function getGlobalTemplateEditorWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
    };
}

/**
 * Wire a (freshly-created or reload-restored) Prompt Template editor panel:
 * install the message handler, paint the HTML, and push the template data from
 * config. Both `openGlobalTemplateEditor` and the reload serializer call this so
 * the wiring lives in one place. On restore `options` is undefined, so the
 * editor lands on the default category — it's a singleton that reloads all
 * templates from config, so no per-panel state is persisted.
 */
function bindGlobalTemplateEditorPanel(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    options?: { category?: TemplateCategory; itemId?: string },
): void {
    _context = context;
    _panel = panel;

    const codiconsUri = vscode.Uri.joinPath(
        context.extensionUri,
        'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
    );
    const webviewCodiconsUri = panel.webview.asWebviewUri(codiconsUri);

    panel.webview.onDidReceiveMessage(
        (msg) => _handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    panel.webview.html = loadWebviewHtml(panel.webview, 'globalTemplateEditor', {
        init: { codiconsUri: webviewCodiconsUri.toString() },
    });

    panel.onDidDispose(() => {
        _panel = undefined;
        _pendingInitialCategory = undefined;
        _pendingInitialItemId = undefined;
    });

    // Stash the target category/itemId so the 'ready' handshake (which
    // arrives async from the webview after HTML loads) lands on the same
    // pair instead of defaulting to 'copilot'.
    _pendingInitialCategory = options?.category;
    _pendingInitialItemId = options?.itemId;

    // Initial data push (after a tick so html is ready). Belt-and-braces:
    // if the webview is quick enough to fire 'ready' first, its handler
    // reads the same pending pair. Either path lands on the right state.
    setTimeout(() => {
        _sendAllData(options?.category, options?.itemId);
    }, 100);
}

export function registerGlobalTemplateEditorCommand(ctx: vscode.ExtensionContext): void {
    _context = ctx;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.promptTemplates', (args?: any) => {
            openGlobalTemplateEditor(ctx, {
                category: args?.category,
                itemId: args?.itemId,
            });
        }),
    );
    // Restore the panel after a window reload. Singleton that reloads all
    // templates from config on open, so no per-panel state is persisted — the
    // deserialize path re-binds the recreated panel (default category). Without
    // the serializer the tab silently vanishes on reload.
    ctx.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('tomAi.globalTemplateEditor', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
                if (_panel) { panel.dispose(); return; }
                const context = _context ?? ctx;
                panel.webview.options = getGlobalTemplateEditorWebviewOptions(context);
                bindGlobalTemplateEditorPanel(context, panel);
            },
        }),
    );
}

// ============================================================================
// Data helpers
// ============================================================================

function _getItemsForCategory(config: SendToChatConfig, category: TemplateCategory): TemplateItem[] {
    switch (category) {
        case 'copilotQueueWrapper':
            return [{ id: QUEUE_WRAPPER_ITEM_ID, label: 'Copilot Queue Wrapper' }];
        case 'reminder':
            return ((config as any).reminders?.templates || [])
                .map((t: any) => ({ id: t.id, label: t.name || t.id }));
        case 'timedRequests':
            return ((config as any).timedRequests || [])
                .map((t: any, i: number) => ({
                    id: t.id || String(i),
                    label: t.originalText?.substring(0, 40) || `Timed Request ${i + 1}`,
                }));
        case 'anthropicProfiles':
            return (config.anthropic?.profiles || [])
                .map(p => ({ id: p.id, label: p.name || p.id }));
        case 'anthropicUserMessage':
            return (config.anthropic?.userMessageTemplates || [])
                .map(t => ({ id: t.id, label: t.name || t.id }));
        case 'compaction':
            return (config.compaction?.templates || [])
                .map(t => ({ id: t.id, label: t.name || t.id }));
        case 'memoryExtraction':
            return (config.compaction?.memoryExtractionTemplates || [])
                .map(t => ({ id: t.id, label: t.name || t.id }));
        case 'transportRetry':
            return (config.anthropic?.transportRetry?.templates || [])
                .map(t => ({ id: t.id, label: t.name || t.id }));
        case 'interactiveQuestions':
            return (config.anthropic?.interactiveQuestionsTemplates || [])
                .map(t => ({ id: t.id, label: t.name || t.id }));
        case 'assistPrompts':
            return (config.assistPrompts?.templates || [])
                .map(t => ({ id: t.id, label: t.name || t.id }));
    }
}

function _getFieldsForItem(config: SendToChatConfig, category: TemplateCategory, itemId: string): { fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number' | 'select' | 'multi-checkbox'; value: string; readonly?: boolean; help?: string; options?: Array<{ value: string; label: string; readOnly?: boolean }>; optionGroups?: Array<{ category: string; tools: Array<{ value: string; label: string; readOnly?: boolean }> }>; disabledWhen?: { field: string; equals: string }; lockedOptions?: string[] }>; } {
    const fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number' | 'select' | 'multi-checkbox'; value: string; readonly?: boolean; help?: string; options?: Array<{ value: string; label: string; readOnly?: boolean }>; optionGroups?: Array<{ category: string; tools: Array<{ value: string; label: string; readOnly?: boolean }> }>; disabledWhen?: { field: string; equals: string }; lockedOptions?: string[] }> = [];

    switch (category) {
        case 'copilotQueueWrapper': {
            if (itemId !== QUEUE_WRAPPER_ITEM_ID) break;
            fields.push(
                { name: 'template', label: 'Wrapper', type: 'textarea', value: copilotQueueWrapper(config), help: PLACEHOLDER_HELP + '<br><br>Goes around every Copilot send that waits for an answer: queue items, the todo buttons, <code>tomAi_askCopilot</code>, and the Copilot panel\'s Send when its Wrap box is on. <strong>Use ${originalPrompt}</strong> for the prompt (after its template), <code>${copilotAnswerFile}</code> and <code>${requestId}</code> for the answer file Copilot writes. Saving it empty, or Delete, returns it to the default.' },
            );
            break;
        }
        case 'reminder': {
            const templates: any[] = (config as any).reminders?.templates || [];
            const tpl = templates.find((t: any) => t.id === itemId);
            if (!tpl) break;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'prompt', label: 'Prompt Template', type: 'textarea', value: tpl.prompt || '', help: 'Use {{timeoutMinutes}} for the timeout value.' },
                { name: 'isDefault', label: 'Is Default', type: 'checkbox', value: String(tpl.isDefault === true) },
            );
            break;
        }
        case 'timedRequests': {
            const requests: any[] = (config as any).timedRequests || [];
            const req = requests.find((r: any) => (r.id || '') === itemId);
            if (!req) break;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: req.id || '', readonly: true },
                { name: 'enabled', label: 'Enabled', type: 'checkbox', value: String(req.enabled !== false) },
                { name: 'template', label: 'Template', type: 'text', value: req.template || '' },
                { name: 'originalText', label: 'Prompt Text', type: 'textarea', value: req.originalText || '' },
                { name: 'scheduleMode', label: 'Schedule Mode', type: 'text', value: req.scheduleMode || 'interval' },
                { name: 'intervalMinutes', label: 'Interval (minutes)', type: 'number', value: String(req.intervalMinutes ?? 30) },
                { name: 'status', label: 'Status', type: 'text', value: req.status || 'active' },
            );
            break;
        }
        case 'anthropicProfiles': {
            const profile = (config.anthropic?.profiles || []).find(p => p.id === itemId);
            if (!profile) break;
            // Configuration dropdown — per multi_transport_prompt_queue_revised.md
            // §4.3, sources from both anthropic.configurations[] and
            // localLlm.configurations[] so a profile can reference either
            // kind. Labels are prefixed by backing type so the user can
            // tell them apart.
            const labelType = (t?: string): string => {
                if (t === 'agentSdk') { return '[agentSdk]'; }
                if (t === 'vscodeLm') { return '[vscodeLm]'; }
                return '[direct]';
            };
            const anthropicConfigOpts = (config.anthropic?.configurations || [])
                .filter((c) => c && typeof c.id === 'string')
                .map((c) => ({
                    value: c.id,
                    label: `${labelType(c.transport)} ${c.name ? `${c.name} (${c.id})` : c.id}`,
                }));
            const localLlmConfigOpts = ((config as { localLlm?: { configurations?: Array<{ id?: string; name?: string }> } }).localLlm?.configurations || [])
                .filter((c) => c && typeof c.id === 'string')
                .map((c) => ({
                    value: c.id as string,
                    label: `[localLlm] ${c.name ? `${c.name} (${c.id})` : c.id}`,
                }));
            const configurationOptions = [
                { value: '', label: '(inherit default)' },
                ...anthropicConfigOpts,
                ...localLlmConfigOpts,
            ];
            // Tool picker options — every tool the extension knows about,
            // whether or not the configuration already enables it. Empty
            // selection + allToolsEnabled=false means "no tools".
            const toolOptions = AVAILABLE_LLM_TOOLS.map((tool) => ({ value: tool, label: tool }));
            // Categorised view of the same tools — used by the webview's
            // grouped multi-checkbox renderer for per-group bulk-select
            // buttons. `readOnly` flags are seeded from the tool registry
            // so the "Select Read-Only" button can target them directly.
            const readOnlyToolNames = new Set(READ_ONLY_TOOLS.map((t) => t.name));
            const toolOptionGroups = categorizeTools(AVAILABLE_LLM_TOOLS, readOnlyToolNames);
            // Profile-level enabledTools override. We stash the list as
            // JSON in the field value so the multi-checkbox renderer can
            // pre-select the right rows without a second hidden field.
            const profileEnabledTools = Array.isArray((profile as unknown as { enabledTools?: string[] }).enabledTools)
                ? (profile as unknown as { enabledTools: string[] }).enabledTools
                : [];
            // `toolsEnabled === true` (default) means "all tools"; when the
            // user unchecks it, the picker below is enabled and its subset
            // becomes the active set.
            const allToolsEnabled = profile.toolsEnabled !== false && profileEnabledTools.length === 0;
            // Profile-level overrides (default "on" for promptCaching so
            // the field resolves to true when absent).
            const p = profile as unknown as {
                promptCachingEnabled?: boolean;
                toolApprovalMode?: string;
                useBuiltInTools?: boolean;
                autoInjectMemory?: boolean;
                allowInteractiveQuestions?: boolean;
                interactiveQuestionsTemplateId?: string;
            };
            const approvalMode = parseToolApprovalMode(p.toolApprovalMode);
            // Out of budget (src/utils/outOfBudget.ts): which profile to continue on, and whether by itself.
            const outOfBudget = (profile as { outOfBudget?: { fallbackProfileId?: string; autoSwitch?: boolean } }).outOfBudget;
            const outOfBudgetOptions = [
                { value: '', label: '(ask)' },
                ...((config.anthropic?.profiles || [])
                    .filter((o) => o && typeof o.id === 'string' && o.id !== profile.id)
                    .map((o) => ({ value: o.id, label: o.name ? `${o.name} (${o.id})` : o.id }))),
            ];
            const promptCachingDefaultOn = p.promptCachingEnabled !== false;
            const thinkingSettings = profileThinkingSettings(profile as unknown as Record<string, unknown>);
            // Fallback-template dropdown for the AskUserQuestion interception.
            const interactiveQuestionsTemplateOptions = [
                { value: '', label: '(built-in default)' },
                ...((config.anthropic?.interactiveQuestionsTemplates || [])
                    .filter((t) => t && typeof t.id === 'string')
                    .map((t) => ({ value: t.id, label: t.name || t.id }))),
            ];
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: profile.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: profile.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: profile.description || '' },
                { name: 'systemPrompt', label: 'System Prompt', type: 'textarea', value: profile.systemPrompt || '', help: PLACEHOLDER_HELP + '<br><br>Sent as the Anthropic <code>system</code> parameter. Supports <code>${role-description}</code> and <code>${quest-description}</code>.' },
                { name: 'userPromptWrapper', label: 'User Prompt Wrapper', type: 'textarea', value: (profile as { userPromptWrapper?: string }).userPromptWrapper || '', help: 'Profile-level wrapper applied <strong>after</strong> the user-message template has expanded — meant for "system-like" injections kept at the user-prompt layer so the system prompt can stay byte-identical across turns (prompt-caching friendly).<br><br><strong>Must contain <code>${wrappedPrompt}</code></strong> where the user-message-template result should appear. Also has access to <code>${compactedSummary}</code>, <code>${rawTurns}</code>, <code>${rawTurnCount}</code>, and the full workspace placeholder set (<code>${memory}</code>, <code>${instructions}</code>, <code>${role-description}</code>, …).<br><br>Leave empty to skip this wrapping stage.<br><br>Expansion order:<br>1. raw user text<br>2. User Message Template wraps it (<code>${userMessage}</code>) → <code>wrappedPrompt</code><br>3. this wrapper wraps <code>wrappedPrompt</code> → final message sent to Anthropic.' },
                { name: 'configurationId', label: 'Configuration', type: 'select', value: profile.configurationId || '', options: configurationOptions, help: 'Which <code>anthropic.configurations[]</code> entry this profile uses. "(inherit default)" falls back to the configuration marked <code>isDefault</code>.' },
                { name: 'allToolsEnabled', label: 'All Tools Enabled', type: 'checkbox', value: String(allToolsEnabled), help: 'When checked, <strong>every</strong> tool the extension knows about (all of <code>ALL_SHARED_TOOLS</code>) is exposed to the model. Uncheck to pick a profile-specific subset below.' },
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(profileEnabledTools), options: toolOptions, optionGroups: toolOptionGroups, lockedOptions: [...ALWAYS_ON_TOOLS], disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: `Profile-level tool subset. Active only when "All Tools Enabled" is off. Empty subset → no tools. The greyed tools are always on (${ALWAYS_ON_TOOLS.map((n) => `<code>${n}</code>`).join(', ')}): a subset gets them too. A prompt run as a role whose role type selects tools gets those instead (Role Type Editor). Use the global toolbar (Select All / None / Read-Only) or per-group buttons for bulk picks.` },
                { name: 'coreTools', label: 'Core Tools (added)', type: 'multi-checkbox', value: JSON.stringify(Array.isArray((profile as { coreTools?: unknown }).coreTools) ? (profile as { coreTools: string[] }).coreTools : []), options: toolOptions, optionGroups: toolOptionGroups, help: `Tools added to the core set, which is always sent in full: ${DEFAULT_CORE_TOOLS.map((n) => `<code>${n}</code>`).join(', ')}. On the direct transport every other tool is deferred and found by tool search; a prompt may name more with a <code>&lt;!-- tools: name, Family, prefix* --&gt;</code> line. On Local LLM and VS Code LM a prompt with such a line gets the core set plus its tools.` },
                { name: 'toolSearch', label: 'Tool Search (direct)', type: 'checkbox', value: String((profile as { toolSearch?: boolean }).toolSearch !== false), help: 'Direct transport: send the core set in full and defer the other tools, found by the server-side BM25 tool search. Off: every tool in full, as before.' },
                { name: 'thinking', label: 'Thinking', type: 'select', value: thinkingSettings.thinking ?? '', options: [{ value: '', label: "(model's default)" }, { value: 'adaptive', label: 'Adaptive — the model decides how much to think' }, { value: 'off', label: 'Off' }], help: 'Sends <code>thinking: { type: "adaptive" }</code> on current models; models without adaptive thinking (Haiku 4.5 and older) get <code>{ type: "enabled", budget_tokens }</code> with the budget below. <strong>Off</strong> is not possible on Opus 5.5 and Fable (thinking is always on there; lower the effort instead) nor on Opus 5 at effort xhigh / max: no thinking parameter is sent then, and the payload dump says so. Passed to the Agent SDK as its <code>thinking</code> option.' },
                { name: 'effort', label: 'Effort', type: 'select', value: thinkingSettings.effort ?? '', options: [{ value: '', label: "(model's default)" }, ...EFFORT_LEVELS.map((l) => ({ value: l, label: l }))], help: 'Sent as <code>output_config.effort</code> on the direct transport and as the Agent SDK\'s <code>effort</code> option. How much the model thinks and how many tokens it spends; the default is <code>medium</code> on Opus 5.5 and <code>high</code> elsewhere. A level the model does not take (xhigh on 4.6 models, any on Haiku 4.5) is left out and named in the payload dump.' },
                { name: 'legacyThinkingBudgetTokens', label: 'Thinking Budget (older models)', type: 'number', value: String(thinkingSettings.legacyThinkingBudgetTokens ?? DEFAULT_LEGACY_THINKING_BUDGET), help: 'Token budget used only on models without adaptive thinking (Haiku 4.5, the 4.5 models and older) when Thinking is Adaptive. Minimum 1024; must stay below the configuration\'s max tokens.' },
                { name: 'promptCachingEnabled', label: 'Prompt Caching', type: 'checkbox', value: String(promptCachingDefaultOn), help: 'Enable prompt caching for this profile. Overrides <code>configuration.promptCachingEnabled</code>. Defaults to on.' },
                { name: 'toolApprovalMode', label: 'Tool Approval', type: 'select', value: approvalMode, options: [{ value: 'always', label: 'Always — prompt before every write tool call' }, { value: 'acceptEdits', label: 'Accept edits — file edits go through, commands and other writers ask' }, { value: 'never', label: 'Never — skip the approval gate (dangerous)' }], help: toolApprovalHelp(profile.configurationId, config.anthropic?.configurations) },
                { name: 'useBuiltInTools', label: 'Use Built-In Agent SDK Tools', type: 'checkbox', value: String(p.useBuiltInTools === true), help: 'Agent SDK transport only: expose Claude Code\'s built-in tool preset (Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch, …; the task-tracking tools TaskCreate/TaskUpdate are default only on models up to Opus 4.7 / Sonnet 4.6) and automatically suppress extension tools that duplicate them. No effect on the direct Anthropic SDK.' },
                { name: 'systemPromptMode', label: 'System Prompt (Agent SDK)', type: 'select', value: parseSystemPromptMode((profile as { systemPromptMode?: unknown }).systemPromptMode), options: [{ value: 'replace', label: 'Replace — the system prompt above is the whole prompt' }, { value: 'append', label: "Append — Claude Code's default prompt, then the system prompt above" }], help: "Agent SDK transport only. <strong>Replace</strong> sends this profile's system prompt instead of Claude Code's own; <strong>Append</strong> keeps Claude Code's default system prompt (its tools, conventions, environment) and adds this profile's after it (the SDK's <code>claude_code</code> preset with <code>append</code>). Profiles made before the choice existed replace." },
                { name: 'settingSources', label: 'Setting Sources (Agent SDK)', type: 'multi-checkbox', value: JSON.stringify(parseSettingSources((profile as { settingSources?: unknown }).settingSources) ?? []), options: SETTING_SOURCES.map((s) => ({ value: s, label: s })), help: "Agent SDK transport only: which of Claude Code's settings the SDK loads — <code>user</code> (~/.claude: settings, CLAUDE.md, agents, commands), <code>project</code> (the workspace's .claude/ and CLAUDE.md), <code>local</code> (.claude/settings.local.json, CLAUDE.local.md). Ticked here they win over the configuration's <code>agentSdk.settingSources</code>; none ticked, the configuration's apply." },
                { name: 'allowInteractiveQuestions', label: 'Allow Interactive Questions', type: 'checkbox', value: String(p.allowInteractiveQuestions === true), help: 'Agent SDK transport only: when the agent calls the built-in <code>AskUserQuestion</code> tool, show a VS Code QuickPick per question and feed your selections back to the model. When unchecked (default), the questions are answered with the fallback template below, telling the agent to proceed autonomously. Requires "Use Built-In Agent SDK Tools"; has no effect when Tool Approval is "Never" (the SDK does not fire the approval callback under <code>bypassPermissions</code>).' },
                { name: 'interactiveQuestionsTemplateId', label: 'Interactive Questions Fallback', type: 'select', value: p.interactiveQuestionsTemplateId || '', options: interactiveQuestionsTemplateOptions, help: 'Fallback template (from the "Anthropic — Interactive Questions" category) returned to the agent when interactive questions are off or you dismiss the picker. Bodies may reference <code>${questions}</code>. "(built-in default)" uses the hard-coded autonomous fallback.' },
                { name: 'autoInjectMemory', label: 'Auto-inject Memory', type: 'checkbox', value: String(p.autoInjectMemory === true), help: 'When checked, append a <code>## Memory</code> section with <code>${memory}</code> to the resolved system prompt automatically. When unchecked (default), memory is only included when the profile explicitly references <code>${memory}</code> / <code>${memory-shared}</code> / <code>${memory-quest}</code> in its System Prompt, User Prompt Wrapper, or user-message template.<br><br><strong>Caveat:</strong> file-injection placeholders (<code>${role-description}</code>, <code>${quest-description}</code>, <code>${guidelines-*}</code>) recursively expand any <code>${memory*}</code> tokens that appear inside the injected file. Leaving this off does NOT prevent that. Audit those files if you want zero memory in the prompt.' },
                { name: 'maxRounds', label: 'Max Rounds', type: 'number', value: String(profile.maxRounds ?? ''), help: 'Override <code>configuration.maxRounds</code> for this profile. Leave empty to inherit.' },
                { name: 'maxTokens', label: 'Max Tokens', type: 'number', value: String((profile as { maxTokens?: number }).maxTokens ?? ''), help: 'Override <code>configuration.maxTokens</code> for this profile. Leave empty to inherit.' },
                { name: 'historyMode', label: 'History Mode', type: 'text', value: profile.historyMode ?? '', help: 'one of: none, full, last, summary, trim_and_summary, llm_extract — leave empty to inherit from configuration' },
                { name: 'backgroundWaitLimitMinutes', label: 'Background Wait Limit (min)', type: 'number', value: String((profile as { backgroundWaitLimitMinutes?: number }).backgroundWaitLimitMinutes ?? ''), help: 'The longest a prompt-queue turn waits for its own background work (Agent SDK background tasks; direct API / Local LLM command streams) before it ends with a hint naming what still runs. Blank = 360 (6 hours); 0 = do not wait. A queue item can set its own.' },
                { name: 'retryMaxTotalWaitMinutes', label: 'Retry Budget (min)', type: 'number', value: String((profile as { retryMaxTotalWaitMinutes?: number }).retryMaxTotalWaitMinutes ?? ''), help: 'Maximum total minutes the retry-on-busy loop is allowed to wait after the first transient error (HTTP 429 / 503 / 529 / rate-limit / overloaded). Applies uniformly to Anthropic, Ollama, and vLLM. Defaults to 10. Use 240 (4h) to survive Claude session-limit resets.' },
                { name: 'outOfBudgetFallbackProfileId', label: 'Out of Budget: Continue On', type: 'select', value: outOfBudget?.fallbackProfileId ?? '', options: outOfBudgetOptions, help: 'When a queued prompt on this profile stops because the API credit balance is too low, continue on this profile: the stopped stage is sent there with a note naming this profile, the session it ran in and that session\'s live trail. "(ask)" leaves the item stopped; the queue editor then offers a profile picker (preset to this choice), <strong>Continue on profile</strong> and <strong>Resend</strong>.' },
                { name: 'outOfBudgetAutoSwitch', label: 'Out of Budget: Switch Automatically', type: 'checkbox', value: String(outOfBudget?.autoSwitch === true), disabledWhen: { field: 'outOfBudgetFallbackProfileId', equals: '' }, help: 'Continue on the profile above without asking, so an unattended walk is not interrupted. Off: the item stops and waits for you, with the picker preset to the profile above.' },
                { name: 'isDefault', label: 'Is Default', type: 'checkbox', value: String(profile.isDefault === true) },
            );
            break;
        }
        case 'anthropicUserMessage': {
            const tpl = (config.anthropic?.userMessageTemplates || []).find(t => t.id === itemId);
            if (!tpl) break;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Template', type: 'textarea', value: tpl.template || '${userMessage}', help: PLACEHOLDER_HELP + '<br><br><strong>Must contain <code>${userMessage}</code></strong> — the raw text the user typed.<br><br>A line <code>&lt;!-- tools: tomAi_specApplyEdits, TomSpecs (edit), tomAi_spec* --&gt;</code> names the tools its prompts need (tool names, families as the profile editor groups them, <code>prefix*</code>): on the direct transport they are sent in full next to the core set, the rest is found by tool search; on Local LLM and VS Code LM the core set plus these tools are the whole list. The line is removed before sending.' },
                { name: 'isDefault', label: 'Is Default', type: 'checkbox', value: String(tpl.isDefault === true) },
            );
            break;
        }
        case 'compaction': {
            const tpl = (config.compaction?.templates || []).find(t => t.id === itemId);
            if (!tpl) break;
            const compToolOptions = AVAILABLE_LLM_TOOLS.map((tool) => ({ value: tool, label: tool }));
            const compEnabled = Array.isArray((tpl as { enabledTools?: unknown }).enabledTools) ? (tpl as { enabledTools: string[] }).enabledTools : [];
            const compAllEnabled = (tpl as { toolsEnabled?: boolean }).toolsEnabled !== false && compEnabled.length === 0;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Template', type: 'textarea', value: tpl.template || '', help: PLACEHOLDER_HELP + '<br><br><strong>Compaction placeholders</strong> (only resolved during the compaction call — empty everywhere else):<br>'
                    + '<code>${existingSummary}</code> – the compacted summary as it stood at the end of the previous turn (or the string <em>"(empty …)"</em> on the first turn / in batch modes)<br>'
                    + '<code>${lastTurn}</code> – the new content to integrate (one user/assistant pair in incremental mode; the whole overflow slice in batch modes)<br>'
                    + '<code>${lastTurnCharCount}</code> – character count of <code>${lastTurn}</code><br>'
                    + '<code>${maxHistoryTokens}</code> – target token budget for the summary (from the Compaction Max History Tokens setting, or per-configuration override)<br>'
                    + '<code>${maxHistorySize}</code> – same budget expressed in characters (<code>maxHistoryTokens × 4</code>) — use this to steer the LLM\'s verbosity<br>'
                    + '<code>${historyMaxChars}</code> – hard char cap the summary should fit within, from the History Max Chars setting (e.g. 24000). Mention this in the prompt so the LLM keeps the output within budget, especially on MoE / local models with limited working context<br>'
                    + '<br><strong>How this template is invoked:</strong> on every turn whose <code>rawTurns</code> overflow <code>rawTurnsKept × 2</code> messages, the handler folds the oldest overflow into <code>${existingSummary}</code> by calling this template with the overflow as <code>${lastTurn}</code>. The output replaces <code>compactedSummary</code> for the next turn.<br>' },
                { name: 'targetMode', label: 'Target Mode', type: 'text', value: tpl.targetMode || 'all', help: 'summary, trim_and_summary, llm_extract, or all' },
                { name: 'allToolsEnabled', label: 'All Tools Enabled', type: 'checkbox', value: String(compAllEnabled), help: 'When checked, the compaction call exposes every tool in <code>ALL_SHARED_TOOLS</code>. Uncheck to pick a template-specific subset.' },
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(compEnabled), options: compToolOptions, disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: 'Tool subset the compaction LLM may call. Only read-only tools are useful for a summary pass — <code>tomAi_readFile</code>, <code>tomAi_listMemory</code>, <code>tomAi_readMemory</code>, <code>tomAi_listGlobalGuidelines</code>, etc.' },
            );
            break;
        }
        case 'memoryExtraction': {
            const tpl = (config.compaction?.memoryExtractionTemplates || []).find(t => t.id === itemId);
            if (!tpl) break;
            const memToolOptions = AVAILABLE_LLM_TOOLS.map((tool) => ({ value: tool, label: tool }));
            const memEnabled = Array.isArray((tpl as { enabledTools?: unknown }).enabledTools) ? (tpl as { enabledTools: string[] }).enabledTools : [];
            const memAllEnabled = (tpl as { toolsEnabled?: boolean }).toolsEnabled !== false && memEnabled.length === 0;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Template', type: 'textarea', value: tpl.template || '', help: PLACEHOLDER_HELP + '<br><br><strong>Memory extraction placeholders</strong> (only resolved during the extraction call):<br>'
                    + '<code>${lastTurn}</code> – the exchange just completed (user/assistant pair)<br>'
                    + '<code>${compactedSummary}</code> – the running session summary (the same value that sits in the wire payload between raw turns and the current prompt)<br>'
                    + '<code>${existingMemory}</code> – current contents of the <em>Target File</em> in the <em>Scope</em> you picked below (capped to <code>memoryMaxChars</code> — the file is prepended newest-first, and only the head is fed to the LLM, so older entries fall off)<br>'
                    + '<code>${memoryFilePath}</code> – absolute path to that file, so the prompt can cite it<br>'
                    + '<code>${memoryScope}</code> – either <code>quest</code> or <code>shared</code><br>'
                    + '<code>${historyMaxChars}</code> – hard char cap on <code>${compactedSummary}</code> injection (from the History Max Chars setting)<br>'
                    + '<code>${memoryMaxChars}</code> – hard char cap on <code>${existingMemory}</code> injection (from the Memory Max Chars setting)<br>' },
                { name: 'targetFile', label: 'Target File', type: 'text', value: tpl.targetFile || 'facts.md' },
                { name: 'scope', label: 'Scope', type: 'text', value: tpl.scope || 'quest', help: 'quest, shared, or both' },
                { name: 'allToolsEnabled', label: 'All Tools Enabled', type: 'checkbox', value: String(memAllEnabled), help: 'When checked, the memory extraction call exposes every tool in <code>ALL_SHARED_TOOLS</code>. Uncheck to pick a template-specific subset — typically the memory read/write tools.' },
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(memEnabled), options: memToolOptions, disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: 'Tool subset the memory extraction LLM may call. Typical defaults: <code>tomAi_listMemory</code>, <code>tomAi_readMemory</code>, <code>tomAi_saveMemory</code>, <code>tomAi_updateMemory</code>.' },
            );
            break;
        }
        case 'transportRetry': {
            const tpl = (config.anthropic?.transportRetry?.templates || []).find(t => t.id === itemId);
            if (!tpl) break;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Continuation Prompt', type: 'textarea', value: tpl.template || '', help: PLACEHOLDER_HELP + '<br><br><strong>Transport-retry placeholders</strong> (resolved when an Agent SDK attempt fails and is resumed):<br>'
                    + '<code>${errorText}</code> – the error message from the failed attempt; inject it so the agent knows what went wrong<br>'
                    + '<code>${userMessage}</code> / <code>${originalPrompt}</code> – the original prompt being retried<br>'
                    + '<br><strong>How this template is invoked:</strong> when an Agent SDK request errors and the session can be resumed, the handler expands this template and sends it as the continuation prompt on the resumed session. Fresh-session retries (no session id, or a "no session" / "unknown session id" error) replay the original prompt instead and do not use this template.<br>' },
                { name: 'isDefault', label: 'Is Default', type: 'checkbox', value: String(tpl.isDefault === true), help: 'When checked, this template is the one the "use default" selection resolves to. Setting it un-marks any other default.' },
            );
            break;
        }
        case 'interactiveQuestions': {
            const tpl = (config.anthropic?.interactiveQuestionsTemplates || []).find(t => t.id === itemId);
            if (!tpl) break;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Fallback Answer', type: 'textarea', value: tpl.template || '', help: PLACEHOLDER_HELP + '<br><br><strong>Interactive-questions placeholder</strong> (resolved when the Agent SDK calls the built-in <code>AskUserQuestion</code> tool and interactive answering is off, or the user dismisses the picker):<br>'
                    + '<code>${questions}</code> – a digest of the skipped questions (one bullet per question with its options)<br>'
                    + '<br><strong>How this template is invoked:</strong> the body is returned to the agent as the <code>AskUserQuestion</code> tool result, so it should instruct the agent to proceed autonomously rather than wait for an answer.<br>' },
            );
            break;
        }
        case 'assistPrompts': {
            const tpl = (config.assistPrompts?.templates || []).find(t => t.id === itemId);
            if (!tpl) { break; }
            const usedBy = ASSIST_PROMPT_USES.filter((u) => (config.assistPrompts?.selected?.[u] || ASSIST_PROMPT_INFO[u].defaultId) === tpl.id)
                .map((u) => ASSIST_PROMPT_INFO[u].label);
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Prompt', type: 'textarea', value: tpl.template || '', help: (usedBy.length ? `<strong>Runs for:</strong> ${usedBy.join(', ')} (chosen on the Status Page, Assist prompts).<br><br>` : '<strong>Runs for:</strong> no use yet — choose it on the Status Page (Assist prompts).<br><br>')
                    + '<strong>The placeholders of each use</strong> (filled before the prompt expands; a placeholder of another use stays as written):<br><br>'
                    + assistPromptsHelp() + '<br><br>' + PLACEHOLDER_HELP },
            );
            break;
        }
    }
    return { fields };
}

// ============================================================================
// Message handling
// ============================================================================

async function _handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
        case 'ready':
            // Honour a pending (category, itemId) stashed by a just-opened
            // editor call; then clear it so subsequent 'ready' signals
            // (e.g. after a retainContextWhenHidden reveal) don't keep
            // snapping back to an old selection.
            _sendAllData(_pendingInitialCategory, _pendingInitialItemId);
            _pendingInitialCategory = undefined;
            _pendingInitialItemId = undefined;
            break;
        case 'requestData':
            _sendAllData(msg.category, msg.itemId);
            break;
        case 'selectCategory':
            _sendCategoryItems(msg.category);
            break;
        case 'selectItem':
            _sendItemFields(msg.category, msg.itemId);
            break;
        case 'save':
            await _saveItem(msg.category, msg.itemId, msg.values);
            break;
        case 'add':
            await _addItem(msg.category);
            break;
        case 'copy':
            await _copyItem(msg.category, msg.itemId);
            break;
        case 'rename':
            await _renameItem(msg.category, msg.itemId);
            break;
        case 'delete':
            await _deleteItem(msg.category, msg.itemId);
            break;
    }
}

function _sendAllData(initialCategory?: string, initialItemId?: string): void {
    const config = loadSendToChatConfig();
    if (!config) return;

    const categories = Object.entries(CATEGORY_LABELS).map(([key, label]) => ({
        id: key,
        label,
        items: _getItemsForCategory(config, key as TemplateCategory),
    }));

    _panel?.webview.postMessage({
        type: 'allData',
        categories,
        initialCategory: initialCategory || 'anthropicUserMessage',
        initialItemId: initialItemId || '',
    });
}

function _sendCategoryItems(category: TemplateCategory): void {
    const config = loadSendToChatConfig();
    if (!config) return;
    const items = _getItemsForCategory(config, category);
    _panel?.webview.postMessage({ type: 'categoryItems', category, items });
}

function _sendItemFields(category: TemplateCategory, itemId: string): void {
    const config = loadSendToChatConfig();
    if (!config) return;
    const { fields } = _getFieldsForItem(config, category, itemId);
    _panel?.webview.postMessage({ type: 'itemFields', category, itemId, fields });
}

async function _saveItem(category: TemplateCategory, itemId: string, values: Record<string, string>): Promise<void> {
    const config = loadSendToChatConfig();
    if (!config) return;

    switch (category) {
        case 'copilotQueueWrapper': {
            const body = values.template ?? '';
            if (!body.trim() || body === DEFAULT_ANSWER_FILE_TEMPLATE) {
                if (config.copilot) { delete config.copilot.queueWrapper; }
            } else {
                config.copilot = { ...(config.copilot ?? {}), queueWrapper: body };
            }
            break;
        }
        case 'reminder': {
            if (!(config as any).reminders) (config as any).reminders = {};
            const templates: any[] = (config as any).reminders.templates || [];
            const idx = templates.findIndex((t: any) => t.id === itemId);
            if (idx >= 0) {
                templates[idx] = {
                    ...templates[idx],
                    name: values.name || templates[idx].name,
                    prompt: values.prompt || '',
                    isDefault: values.isDefault === 'true',
                };
                // If marked as default, un-default others
                if (values.isDefault === 'true') {
                    templates.forEach((t: any, i: number) => { if (i !== idx) t.isDefault = false; });
                }
            }
            break;
        }
        case 'timedRequests': {
            const requests: any[] = (config as any).timedRequests || [];
            const idx = requests.findIndex((r: any) => r.id === itemId);
            if (idx >= 0) {
                requests[idx] = {
                    ...requests[idx],
                    enabled: values.enabled === 'true',
                    template: values.template,
                    originalText: values.originalText,
                    scheduleMode: values.scheduleMode,
                    intervalMinutes: parseInt(values.intervalMinutes) || 30,
                    status: values.status,
                };
            }
            break;
        }
        case 'anthropicProfiles': {
            if (!config.anthropic) config.anthropic = {};
            const profiles = config.anthropic.profiles ?? [];
            const idx = profiles.findIndex(p => p.id === itemId);
            // New tools UX: "All Tools Enabled" checkbox + a multi-checkbox
            // picker whose value arrives as a JSON-encoded string[]. When
            // "All Tools Enabled" is on, we normalise by clearing the
            // picker (enabledTools stored as undefined) and keeping the
            // legacy toolsEnabled=true shorthand.
            const allToolsEnabled = values.allToolsEnabled === 'true';
            let enabledTools: string[] | undefined;
            try {
                const parsed = JSON.parse(values.enabledTools || '[]');
                if (Array.isArray(parsed)) {
                    enabledTools = parsed.filter((t): t is string => typeof t === 'string');
                }
            } catch {
                enabledTools = undefined;
            }
            let coreTools: string[] = [];
            try {
                const parsed = JSON.parse(values.coreTools || '[]');
                if (Array.isArray(parsed)) { coreTools = parsed.filter((t): t is string => typeof t === 'string' && !DEFAULT_CORE_TOOLS.includes(t)); }
            } catch { coreTools = []; }
            const toolSearch = values.toolSearch !== 'false';
            const thinking: ThinkingMode | undefined = values.thinking === 'adaptive' || values.thinking === 'off' ? values.thinking : undefined;
            const effort = (EFFORT_LEVELS as readonly string[]).includes(values.effort) ? values.effort as EffortLevel : undefined;
            const legacyBudget = values.legacyThinkingBudgetTokens ? parseInt(values.legacyThinkingBudgetTokens, 10) : NaN;
            const legacyThinkingBudgetTokens = Number.isInteger(legacyBudget) && legacyBudget >= 1024 && legacyBudget !== DEFAULT_LEGACY_THINKING_BUDGET ? legacyBudget : undefined;
            const promptCachingEnabled = values.promptCachingEnabled !== 'false'; // default on
            const toolApprovalMode = parseToolApprovalMode(values.toolApprovalMode);
            const useBuiltInTools = values.useBuiltInTools === 'true';
            const systemPromptMode = parseSystemPromptMode(values.systemPromptMode);
            let settingSources: SettingSource[] = [];
            try { settingSources = parseSettingSources(JSON.parse(values.settingSources || '[]')) ?? []; } catch { settingSources = []; }
            const autoInjectMemory = values.autoInjectMemory === 'true';
            const allowInteractiveQuestions = values.allowInteractiveQuestions === 'true';
            const interactiveQuestionsTemplateId = (values.interactiveQuestionsTemplateId || '').trim();
            const userPromptWrapper = (values.userPromptWrapper || '').trim();
            const outOfBudgetFallback = (values.outOfBudgetFallbackProfileId || '').trim();
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                systemPrompt: values.systemPrompt || '',
                ...(userPromptWrapper ? { userPromptWrapper } : {}),
                configurationId: values.configurationId || undefined,
                toolsEnabled: allToolsEnabled,
                ...(allToolsEnabled ? {} : { enabledTools: enabledTools ?? [] }),
                ...(coreTools.length > 0 ? { coreTools } : {}),
                ...(toolSearch ? {} : { toolSearch: false }),
                ...(thinking ? { thinking } : {}),
                ...(effort ? { effort } : {}),
                ...(legacyThinkingBudgetTokens ? { legacyThinkingBudgetTokens } : {}),
                promptCachingEnabled,
                toolApprovalMode,
                useBuiltInTools,
                // Written only when not the defaults, so profiles that never chose stay as they are.
                ...(systemPromptMode === 'append' ? { systemPromptMode } : {}),
                ...(settingSources.length > 0 ? { settingSources } : {}),
                autoInjectMemory,
                allowInteractiveQuestions,
                ...(interactiveQuestionsTemplateId ? { interactiveQuestionsTemplateId } : {}),
                ...(outOfBudgetFallback
                    ? { outOfBudget: { fallbackProfileId: outOfBudgetFallback, autoSwitch: values.outOfBudgetAutoSwitch === 'true' } }
                    : {}),
                maxRounds: values.maxRounds ? parseInt(values.maxRounds, 10) : undefined,
                maxTokens: values.maxTokens ? parseInt(values.maxTokens, 10) : undefined,
                historyMode: values.historyMode || null,
                retryMaxTotalWaitMinutes: values.retryMaxTotalWaitMinutes
                    ? parseInt(values.retryMaxTotalWaitMinutes, 10)
                    : undefined,
                backgroundWaitLimitMinutes: values.backgroundWaitLimitMinutes !== undefined && values.backgroundWaitLimitMinutes.trim() !== ''
                    && Number.isFinite(Number(values.backgroundWaitLimitMinutes)) && Number(values.backgroundWaitLimitMinutes) >= 0
                    ? Math.round(Number(values.backgroundWaitLimitMinutes))
                    : undefined,
                isDefault: values.isDefault === 'true',
            };
            if (idx >= 0) {
                const existing = profiles[idx] as unknown as Record<string, unknown>;
                // Drop a stale enabledTools from the old entry when
                // allToolsEnabled is on — otherwise a re-save wouldn't
                // clear it from disk.
                if (allToolsEnabled && 'enabledTools' in existing) {
                    delete existing.enabledTools;
                }
                // Drop a stale userPromptWrapper when the user cleared
                // it. `next` omits the field when empty (see above), so
                // without this the spread would preserve the old value.
                if (!userPromptWrapper && 'userPromptWrapper' in existing) {
                    delete existing.userPromptWrapper;
                }
                // Same for a cleared interactiveQuestionsTemplateId.
                if (!interactiveQuestionsTemplateId && 'interactiveQuestionsTemplateId' in existing) {
                    delete existing.interactiveQuestionsTemplateId;
                }
                // And for the Agent SDK prompt mode set back to replace, or the setting sources cleared.
                if (systemPromptMode === 'replace' && 'systemPromptMode' in existing) {
                    delete existing.systemPromptMode;
                }
                if (settingSources.length === 0 && 'settingSources' in existing) {
                    delete existing.settingSources;
                }
                // And for an out-of-budget policy set back to "(ask)".
                if (!outOfBudgetFallback && 'outOfBudget' in existing) {
                    delete existing.outOfBudget;
                }
                profiles[idx] = { ...existing, ...next };
            } else {
                profiles.push(next);
            }
            if (next.isDefault) {
                profiles.forEach(p => { if (p.id !== itemId) p.isDefault = false; });
            }
            config.anthropic.profiles = profiles;
            break;
        }
        case 'anthropicUserMessage': {
            if (!config.anthropic) config.anthropic = {};
            const templates = config.anthropic.userMessageTemplates ?? [];
            const idx = templates.findIndex(t => t.id === itemId);
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '${userMessage}',
                isDefault: values.isDefault === 'true',
            };
            if (idx >= 0) {
                templates[idx] = { ...templates[idx], ...next };
            } else {
                templates.push(next);
            }
            if (next.isDefault) {
                templates.forEach(t => { if (t.id !== itemId) t.isDefault = false; });
            }
            config.anthropic.userMessageTemplates = templates;
            break;
        }
        case 'compaction': {
            if (!config.compaction) config.compaction = {};
            const templates = config.compaction.templates ?? [];
            const idx = templates.findIndex(t => t.id === itemId);
            const compAllTools = values.allToolsEnabled === 'true';
            let compTools: string[] | undefined;
            try {
                const parsed = JSON.parse(values.enabledTools || '[]');
                if (Array.isArray(parsed)) { compTools = parsed.filter((t): t is string => typeof t === 'string'); }
            } catch { compTools = undefined; }
            const next: Record<string, unknown> = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '',
                targetMode: values.targetMode || 'all',
                toolsEnabled: compAllTools,
                ...(compAllTools ? {} : { enabledTools: compTools ?? [] }),
            };
            if (idx >= 0) {
                const existing = templates[idx] as unknown as Record<string, unknown>;
                if (compAllTools && 'enabledTools' in existing) { delete existing.enabledTools; }
                templates[idx] = { ...existing, ...next } as typeof templates[number];
            } else {
                templates.push(next as typeof templates[number]);
            }
            config.compaction.templates = templates;
            break;
        }
        case 'memoryExtraction': {
            if (!config.compaction) config.compaction = {};
            const templates = config.compaction.memoryExtractionTemplates ?? [];
            const idx = templates.findIndex(t => t.id === itemId);
            const scope = (values.scope === 'shared' || values.scope === 'both') ? values.scope : 'quest';
            const memAllTools = values.allToolsEnabled === 'true';
            let memTools: string[] | undefined;
            try {
                const parsed = JSON.parse(values.enabledTools || '[]');
                if (Array.isArray(parsed)) { memTools = parsed.filter((t): t is string => typeof t === 'string'); }
            } catch { memTools = undefined; }
            const next: Record<string, unknown> = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '',
                targetFile: values.targetFile || 'facts.md',
                scope: scope as 'quest' | 'shared' | 'both',
                toolsEnabled: memAllTools,
                ...(memAllTools ? {} : { enabledTools: memTools ?? [] }),
            };
            if (idx >= 0) {
                const existing = templates[idx] as unknown as Record<string, unknown>;
                if (memAllTools && 'enabledTools' in existing) { delete existing.enabledTools; }
                templates[idx] = { ...existing, ...next } as typeof templates[number];
            } else {
                templates.push(next as typeof templates[number]);
            }
            config.compaction.memoryExtractionTemplates = templates;
            break;
        }
        case 'transportRetry': {
            if (!config.anthropic) config.anthropic = {};
            if (!config.anthropic.transportRetry) config.anthropic.transportRetry = {};
            const templates = config.anthropic.transportRetry.templates ?? [];
            const idx = templates.findIndex(t => t.id === itemId);
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '',
                isDefault: values.isDefault === 'true',
            };
            if (idx >= 0) {
                templates[idx] = { ...templates[idx], ...next };
            } else {
                templates.push(next);
            }
            // At most one default: marking this one un-marks the others.
            if (next.isDefault) {
                templates.forEach(t => { if (t.id !== itemId) t.isDefault = false; });
            }
            config.anthropic.transportRetry.templates = templates;
            break;
        }
        case 'interactiveQuestions': {
            if (!config.anthropic) config.anthropic = {};
            const templates = config.anthropic.interactiveQuestionsTemplates ?? [];
            const idx = templates.findIndex(t => t.id === itemId);
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '',
            };
            if (idx >= 0) {
                templates[idx] = { ...templates[idx], ...next };
            } else {
                templates.push(next);
            }
            config.anthropic.interactiveQuestionsTemplates = templates;
            break;
        }
        case 'assistPrompts': {
            const section = (config.assistPrompts ??= {});
            const templates = section.templates ?? [];
            const idx = templates.findIndex(t => t.id === itemId);
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '',
            };
            if (idx >= 0) {
                templates[idx] = { ...templates[idx], ...next };
            } else {
                templates.push(next);
            }
            section.templates = templates;
            break;
        }
    }

    if (saveSendToChatConfig(config)) {
        vscode.window.showInformationMessage('Template saved');
        _sendAllData(category, values.name || itemId);
    }
}

async function _addItem(category: TemplateCategory): Promise<void> {
    if (category === 'copilotQueueWrapper') {
        vscode.window.showInformationMessage('There is one Copilot Queue Wrapper: edit it. Templates are added under Anthropic — User Message.');
        return;
    }
    const name = await vscode.window.showInputBox({
        prompt: `New ${CATEGORY_LABELS[category]} name`,
        placeHolder: 'my_template',
    });
    if (!name) return;

    const config = loadSendToChatConfig();
    if (!config) return;

    switch (category) {
        case 'reminder': {
            if (!(config as any).reminders) (config as any).reminders = {};
            const templates: any[] = (config as any).reminders.templates || [];
            templates.push({ id: name, name, prompt: '', isDefault: false });
            (config as any).reminders.templates = templates;
            break;
        }
        case 'timedRequests': {
            const requests: any[] = (config as any).timedRequests || [];
            const { v4: uuidv4 } = require('uuid');
            requests.push({
                id: uuidv4(), enabled: true, template: '(None)',
                originalText: name, scheduleMode: 'interval',
                intervalMinutes: 30, scheduledTimes: [], status: 'active',
            });
            (config as any).timedRequests = requests;
            break;
        }
        case 'anthropicProfiles': {
            if (!config.anthropic) config.anthropic = {};
            const profiles = config.anthropic.profiles ?? [];
            profiles.push({
                id: name,
                name,
                description: '',
                systemPrompt: '',
            });
            config.anthropic.profiles = profiles;
            break;
        }
        case 'anthropicUserMessage': {
            if (!config.anthropic) config.anthropic = {};
            const templates = config.anthropic.userMessageTemplates ?? [];
            templates.push({
                id: name,
                name,
                description: '',
                template: '${userMessage}',
            });
            config.anthropic.userMessageTemplates = templates;
            break;
        }
        case 'compaction': {
            if (!config.compaction) config.compaction = {};
            const templates = config.compaction.templates ?? [];
            templates.push({
                id: name,
                name,
                description: '',
                template: '${compactionHistory}',
                targetMode: 'all',
            });
            config.compaction.templates = templates;
            break;
        }
        case 'memoryExtraction': {
            if (!config.compaction) config.compaction = {};
            const templates = config.compaction.memoryExtractionTemplates ?? [];
            templates.push({
                id: name,
                name,
                description: '',
                template: '${recentHistory}',
                targetFile: 'facts.md',
                scope: 'quest',
            });
            config.compaction.memoryExtractionTemplates = templates;
            break;
        }
        case 'transportRetry': {
            if (!config.anthropic) config.anthropic = {};
            if (!config.anthropic.transportRetry) config.anthropic.transportRetry = {};
            const templates = config.anthropic.transportRetry.templates ?? [];
            templates.push({
                id: name,
                name,
                description: '',
                template: DEFAULT_TRANSPORT_RETRY_TEMPLATE_BODY,
            });
            config.anthropic.transportRetry.templates = templates;
            break;
        }
        case 'interactiveQuestions': {
            if (!config.anthropic) config.anthropic = {};
            const templates = config.anthropic.interactiveQuestionsTemplates ?? [];
            templates.push({
                id: name,
                name,
                description: '',
                template: DEFAULT_INTERACTIVE_QUESTIONS_TEMPLATE_BODY,
            });
            config.anthropic.interactiveQuestionsTemplates = templates;
            break;
        }
        case 'assistPrompts': {
            // A new one starts from Grill me's default; the Status Page chooses where it runs.
            const section = (config.assistPrompts ??= {});
            (section.templates ??= []).push({
                id: name,
                name,
                description: '',
                template: ASSIST_PROMPT_INFO.grillMe.defaultBody,
            });
            break;
        }
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category, name);
    }
}

/**
 * Unique id generator: probe `${base}_copy`, `${base}_copy2`, …,
 * `${base}_copyN` until one is free. Used by `_copyItem` to pick a
 * default new id without collisions.
 */
function _uniqueIdFromBase(base: string, existingIds: Set<string>): string {
    let candidate = `${base}_copy`;
    if (!existingIds.has(candidate)) { return candidate; }
    for (let i = 2; i < 1000; i++) {
        candidate = `${base}_copy${i}`;
        if (!existingIds.has(candidate)) { return candidate; }
    }
    return `${base}_copy${Date.now()}`;
}

/**
 * List the existing ids for a category so rename/copy prompts can
 * validate uniqueness and suggest defaults. Returns an empty set for
 * unknown categories rather than throwing — the caller's switch handles
 * the actual per-category logic.
 */
function _listIds(config: NonNullable<ReturnType<typeof loadSendToChatConfig>>, category: TemplateCategory): Set<string> {
    switch (category) {
        case 'copilotQueueWrapper':   return new Set([QUEUE_WRAPPER_ITEM_ID]);
        case 'reminder':              return new Set(((config as any).reminders?.templates ?? []).map((t: any) => t.id));
        case 'timedRequests':         return new Set(((config as any).timedRequests ?? []).map((r: any) => r.id));
        case 'anthropicProfiles':     return new Set((config.anthropic?.profiles ?? []).map((p) => p.id));
        case 'anthropicUserMessage':  return new Set((config.anthropic?.userMessageTemplates ?? []).map((t) => t.id));
        case 'compaction':            return new Set((config.compaction?.templates ?? []).map((t) => t.id));
        case 'memoryExtraction':      return new Set((config.compaction?.memoryExtractionTemplates ?? []).map((t) => t.id));
        case 'transportRetry':        return new Set((config.anthropic?.transportRetry?.templates ?? []).map((t) => t.id));
        case 'interactiveQuestions':  return new Set((config.anthropic?.interactiveQuestionsTemplates ?? []).map((t) => t.id));
        case 'assistPrompts':         return new Set((config.assistPrompts?.templates ?? []).map((t) => t.id));
        default:                      return new Set();
    }
}

/**
 * Duplicate the selected item under a new id. The prompt defaults to
 * `<itemId>_copy` and increments (`_copy2`, `_copy3`, …) when that's
 * taken. Copy preserves every field from the source; only the id
 * (and its display name where the two are coupled) changes. Supports
 * every category except `selfTalk` (fixed-slot Person A / Person B).
 */
async function _copyItem(category: TemplateCategory, itemId: string): Promise<void> {
    if (category === 'copilotQueueWrapper') { return; }
    const config = loadSendToChatConfig();
    if (!config) return;

    const existing = _listIds(config, category);
    const suggested = _uniqueIdFromBase(itemId, existing);
    const newId = await vscode.window.showInputBox({
        prompt: `Copy "${itemId}" as…`,
        value: suggested,
        validateInput: (v) => {
            const trimmed = (v || '').trim();
            if (!trimmed) { return 'Name cannot be empty'; }
            if (trimmed === itemId) { return 'Pick a different name'; }
            if (existing.has(trimmed)) { return 'Already exists'; }
            return null;
        },
    });
    if (!newId) return;
    const targetId = newId.trim();

    switch (category) {
        case 'reminder': {
            const templates: any[] = (config as any).reminders?.templates || [];
            const src = templates.find((t: any) => t.id === itemId);
            if (!src) return;
            templates.push({ ...JSON.parse(JSON.stringify(src)), id: targetId, name: targetId, isDefault: false });
            break;
        }
        case 'timedRequests': {
            const requests: any[] = (config as any).timedRequests || [];
            const src = requests.find((r: any) => r.id === itemId);
            if (!src) return;
            requests.push({ ...JSON.parse(JSON.stringify(src)), id: targetId });
            break;
        }
        case 'anthropicProfiles': {
            const src = (config.anthropic?.profiles ?? []).find((p) => p.id === itemId);
            if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = targetId;
            clone.name = `${src.name} (copy)`;
            clone.isDefault = false;
            (config.anthropic!.profiles ??= []).push(clone);
            break;
        }
        case 'anthropicUserMessage': {
            const src = (config.anthropic?.userMessageTemplates ?? []).find((t) => t.id === itemId);
            if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = targetId;
            clone.name = `${src.name} (copy)`;
            clone.isDefault = false;
            (config.anthropic!.userMessageTemplates ??= []).push(clone);
            break;
        }
        case 'compaction': {
            const src = (config.compaction?.templates ?? []).find((t) => t.id === itemId);
            if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = targetId;
            clone.name = `${src.name} (copy)`;
            (config.compaction!.templates ??= []).push(clone);
            break;
        }
        case 'memoryExtraction': {
            const src = (config.compaction?.memoryExtractionTemplates ?? []).find((t) => t.id === itemId);
            if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = targetId;
            clone.name = `${src.name} (copy)`;
            (config.compaction!.memoryExtractionTemplates ??= []).push(clone);
            break;
        }
        case 'transportRetry': {
            const src = (config.anthropic?.transportRetry?.templates ?? []).find((t) => t.id === itemId);
            if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = targetId;
            clone.name = `${src.name} (copy)`;
            clone.isDefault = false;
            ((config.anthropic ??= {}).transportRetry ??= {}).templates ??= [];
            config.anthropic.transportRetry.templates!.push(clone);
            break;
        }
        case 'interactiveQuestions': {
            const src = (config.anthropic?.interactiveQuestionsTemplates ?? []).find((t) => t.id === itemId);
            if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = targetId;
            clone.name = `${src.name} (copy)`;
            (config.anthropic ??= {}).interactiveQuestionsTemplates ??= [];
            config.anthropic.interactiveQuestionsTemplates!.push(clone);
            break;
        }
        case 'assistPrompts': {
            const src = (config.assistPrompts?.templates ?? []).find((t) => t.id === itemId);
            if (!src) { return; }
            const clone = JSON.parse(JSON.stringify(src));
            clone.id = targetId;
            clone.name = `${src.name} (copy)`;
            ((config.assistPrompts ??= {}).templates ??= []).push(clone);
            break;
        }
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category, targetId);
    }
}

/**
 * Change an item's id. All category shapes support it — for keyed
 * maps we re-key the
 * object; for arrays (`anthropic.profiles`, `compaction.templates`,
 * …) we update the `id` field on the matching entry. The `name`
 * field is also updated when it previously equalled the id (so the
 * display label follows the rename) unless it was already distinct.
 */
async function _renameItem(category: TemplateCategory, itemId: string): Promise<void> {
    if (category === 'copilotQueueWrapper') { return; }
    const config = loadSendToChatConfig();
    if (!config) return;

    const existing = _listIds(config, category);
    const newId = await vscode.window.showInputBox({
        prompt: `Rename "${itemId}" to…`,
        value: itemId,
        validateInput: (v) => {
            const trimmed = (v || '').trim();
            if (!trimmed) { return 'Name cannot be empty'; }
            if (trimmed === itemId) { return 'Name unchanged'; }
            if (existing.has(trimmed)) { return 'Already exists'; }
            return null;
        },
    });
    if (!newId) return;
    const targetId = newId.trim();

    switch (category) {
        case 'reminder': {
            const tpls: any[] = (config as any).reminders?.templates || [];
            const entry = tpls.find((t: any) => t.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            break;
        }
        case 'timedRequests': {
            const reqs: any[] = (config as any).timedRequests || [];
            const entry = reqs.find((r: any) => r.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            break;
        }
        case 'anthropicProfiles': {
            const entry = (config.anthropic?.profiles ?? []).find((p) => p.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            break;
        }
        case 'anthropicUserMessage': {
            const entry = (config.anthropic?.userMessageTemplates ?? []).find((t) => t.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            break;
        }
        case 'compaction': {
            const entry = (config.compaction?.templates ?? []).find((t) => t.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            break;
        }
        case 'memoryExtraction': {
            const entry = (config.compaction?.memoryExtractionTemplates ?? []).find((t) => t.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            break;
        }
        case 'transportRetry': {
            const entry = (config.anthropic?.transportRetry?.templates ?? []).find((t) => t.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            break;
        }
        case 'interactiveQuestions': {
            const entry = (config.anthropic?.interactiveQuestionsTemplates ?? []).find((t) => t.id === itemId);
            if (!entry) return;
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            break;
        }
        case 'assistPrompts': {
            const entry = (config.assistPrompts?.templates ?? []).find((t) => t.id === itemId);
            if (!entry) { return; }
            entry.id = targetId;
            if (entry.name === itemId) { entry.name = targetId; }
            // The uses that chose it follow the rename.
            const selected = config.assistPrompts!.selected ?? {};
            for (const use of ASSIST_PROMPT_USES) { if (selected[use] === itemId) { selected[use] = targetId; } }
            break;
        }
    }

    // Fix up profile → configuration cross-references when renaming a
    // config-like target. We only re-point ids that equalled the old
    // one (so nothing unrelated breaks).
    if (category === 'anthropicProfiles') {
        // Profile ids aren't referenced elsewhere; no-op.
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category, targetId);
    }
}

async function _deleteItem(category: TemplateCategory, itemId: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
        `Delete "${itemId}"?`, { modal: true }, 'Delete',
    );
    if (confirm !== 'Delete') return;

    const config = loadSendToChatConfig();
    if (!config) return;

    switch (category) {
        case 'copilotQueueWrapper':
            if (config.copilot) { delete config.copilot.queueWrapper; }
            break;
        case 'reminder': {
            const templates: any[] = (config as any).reminders?.templates || [];
            if (!(config as any).reminders) (config as any).reminders = {};
            (config as any).reminders.templates = templates.filter((t: any) => t.id !== itemId);
            break;
        }
        case 'timedRequests': {
            const requests: any[] = (config as any).timedRequests || [];
            (config as any).timedRequests = requests.filter((r: any) => r.id !== itemId);
            break;
        }
        case 'anthropicProfiles':
            if (config.anthropic?.profiles) {
                config.anthropic.profiles = config.anthropic.profiles.filter(p => p.id !== itemId);
            }
            break;
        case 'anthropicUserMessage':
            if (config.anthropic?.userMessageTemplates) {
                config.anthropic.userMessageTemplates = config.anthropic.userMessageTemplates.filter(t => t.id !== itemId);
            }
            break;
        case 'compaction':
            if (config.compaction?.templates) {
                config.compaction.templates = config.compaction.templates.filter(t => t.id !== itemId);
            }
            break;
        case 'memoryExtraction':
            if (config.compaction?.memoryExtractionTemplates) {
                config.compaction.memoryExtractionTemplates = config.compaction.memoryExtractionTemplates.filter(t => t.id !== itemId);
            }
            break;
        case 'transportRetry':
            if (config.anthropic?.transportRetry?.templates) {
                config.anthropic.transportRetry.templates = config.anthropic.transportRetry.templates.filter(t => t.id !== itemId);
            }
            break;
        case 'interactiveQuestions':
            if (config.anthropic?.interactiveQuestionsTemplates) {
                config.anthropic.interactiveQuestionsTemplates = config.anthropic.interactiveQuestionsTemplates.filter(t => t.id !== itemId);
            }
            break;
        case 'assistPrompts':
            if (config.assistPrompts?.templates) {
                config.assistPrompts.templates = config.assistPrompts.templates.filter(t => t.id !== itemId);
                // A use that chose it runs its default again.
                const selected = config.assistPrompts.selected ?? {};
                for (const use of ASSIST_PROMPT_USES) { if (selected[use] === itemId) { delete selected[use]; } }
            }
            break;
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category);
    }
}

/**
 * The Tool Approval field's help. The profile's setting decides approval on
 * both transports; on the Agent SDK the configuration's `permissionMode` does
 * not (utils/agentSdkPermissionMode.ts). When the profile's configuration
 * (else the default one) sets `bypassPermissions`, the help names it.
 */
function toolApprovalHelp(
    configurationId: string | undefined,
    configurations: Array<{ id?: string; isDefault?: boolean; transport?: string; agentSdk?: { permissionMode?: string } }> | undefined,
): string {
    const list = configurations ?? [];
    const conf = list.find((c) => c.id === configurationId) ?? list.find((c) => c.isDefault === true);
    const base = 'Approval gate for write tool calls. <strong>Always</strong> shows the approval bar; the user can elevate a single approval to the full session via the "Allow All (session)" button at the bar. <strong>Accept edits</strong> lets the file edits through without asking (edit, multi-edit, create, move, apply edit, notebook edit, rename; Claude Code\'s Edit, Write, MultiEdit, NotebookEdit) and asks for the rest — commands, git, deleting, every other writer — on every transport (on the Agent SDK it runs in <code>permissionMode=acceptEdits</code>). <strong>Never</strong> skips the gate entirely (on the Agent SDK it runs in <code>permissionMode=bypassPermissions</code>). '
        + 'This setting wins: the configuration\'s permission mode does not decide approval — with <strong>Always</strong> a configuration set to <code>bypassPermissions</code> runs in <code>default</code>, so the bar is shown. '
        + 'With Claude Code\'s built-in tools on, its writers (Bash, Write, Edit, MultiEdit, NotebookEdit, KillShell) ask the same way, and a configured <code>acceptEdits</code> or <code>auto</code> runs as <code>default</code>; its readers (Read, Grep, Glob, WebFetch, WebSearch, …) never ask. '
        + 'Queued prompts never ask: the prompt queue runs unattended and sends with approval off.';
    if (conf?.transport === 'agentSdk' && conf.agentSdk?.permissionMode === 'bypassPermissions') {
        return base + `<br><br><strong>Note:</strong> this profile's configuration <code>${conf.id ?? ''}</code> sets <code>permissionMode=bypassPermissions</code>; with <strong>Always</strong> that setting is ignored.`;
    }
    return base;
}
