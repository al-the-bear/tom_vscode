/**
 * Global Prompt Template Editor — full-screen webview panel.
 *
 * Unified editor for all template/profile types stored in the extension
 * config JSON.  Layout: top action bar with category selector + add/delete,
 * left column with template list, right column with multi-field editor.
 *
 * Categories:
 *   1. Copilot Templates             — config.copilot.templates
 *   2. Reminder Templates            — config.reminders.templates
 *   3. Tom AI Chat Templates         — config.tomAiChat.templates
 *   4. AI Conversation Profiles      — config.aiConversation.profiles
 *   5. Local LLM Profiles            — config.localLlm.profiles
 *   6. Timed Requests                — config.timedRequests
 *   7. Self-Talk Profiles            — config.aiConversation.selfTalk
 *   8. Anthropic — Profiles          — config.anthropic.profiles
 *   9. Anthropic — User Message      — config.anthropic.userMessageTemplates
 *
 * The category dropdown at the top of the editor is the user-facing
 * per-transport switcher mandated by multi_transport_prompt_queue_revised.md
 * §4.16 — `Copilot` + `Anthropic — User Message` are the two template
 * stores the queue reads from (routed through the `transport` field on
 * the prompt-template tools). No separate `renderTransportPicker`
 * control is mounted here because this dropdown already does the job
 * and covers the larger set of stores the editor manages.
 */

import * as vscode from 'vscode';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { loadSendToChatConfig, saveSendToChatConfig, SendToChatConfig, DEFAULT_TRANSPORT_RETRY_TEMPLATE_BODY } from '../utils/sendToChatConfig';
import { PLACEHOLDER_HELP } from './promptTemplate';
import { escapeHtml } from './handler_shared';
import { AVAILABLE_LLM_TOOLS } from '../utils/constants';
import { categorizeTools } from '../utils/toolCategories';
import { READ_ONLY_TOOLS } from '../tools/tool-executors';

// ============================================================================
// Types
// ============================================================================

export type TemplateCategory =
    | 'copilot'
    | 'reminder'
    | 'tomAiChat'
    | 'conversation'
    | 'localLlm'
    | 'timedRequests'
    | 'selfTalk'
    | 'anthropicProfiles'
    | 'anthropicUserMessage'
    | 'compaction'
    | 'memoryExtraction'
    | 'transportRetry'
    | 'interactiveQuestions';

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
    copilot: 'Copilot',
    reminder: 'Reminder',
    tomAiChat: 'Tom AI Chat',
    conversation: 'AI Conversation',
    localLlm: 'Local LLM',
    timedRequests: 'Timed Requests',
    selfTalk: 'Self-Talk',
    anthropicProfiles: 'Anthropic — Profiles',
    anthropicUserMessage: 'Anthropic — User Message',
    compaction: 'Compaction',
    memoryExtraction: 'Memory Extraction',
    transportRetry: 'Anthropic Transport Retry',
    interactiveQuestions: 'Anthropic — Interactive Questions',
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

    const codiconsUri = vscode.Uri.joinPath(
        context.extensionUri,
        'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
    );

    _panel = vscode.window.createWebviewPanel(
        'tomAi.globalTemplateEditor',
        'Prompt Template Editor',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                vscode.Uri.joinPath(context.extensionUri, 'media'),
            ],
        },
    );

    const webviewCodiconsUri = _panel.webview.asWebviewUri(codiconsUri);

    _panel.webview.onDidReceiveMessage(
        (msg) => _handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    _panel.webview.html = loadWebviewHtml(_panel.webview, 'globalTemplateEditor', {
        init: { codiconsUri: webviewCodiconsUri.toString() },
    });

    _panel.onDidDispose(() => {
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
}

// ============================================================================
// Data helpers
// ============================================================================

function _getItemsForCategory(config: SendToChatConfig, category: TemplateCategory): TemplateItem[] {
    switch (category) {
        case 'copilot':
            return Object.keys(config.copilot?.templates || {})
                .filter(k => k !== '__answer_file__')
                .map(k => ({ id: k, label: k }));
        case 'reminder':
            return ((config as any).reminders?.templates || [])
                .map((t: any) => ({ id: t.id, label: t.name || t.id }));
        case 'tomAiChat':
            return Object.keys(config.tomAiChat?.templates || {})
                .map(k => ({ id: k, label: (config.tomAiChat!.templates![k] as any).label || k }));
        case 'conversation':
            return Object.keys((config as any).aiConversation?.profiles || {})
                .map(k => ({ id: k, label: ((config as any).aiConversation.profiles[k] as any).label || k }));
        case 'localLlm':
            return Object.keys((config as any).localLlm?.profiles || {})
                .map(k => ({ id: k, label: ((config as any).localLlm.profiles[k] as any).label || k }));
        case 'timedRequests':
            return ((config as any).timedRequests || [])
                .map((t: any, i: number) => ({
                    id: t.id || String(i),
                    label: t.originalText?.substring(0, 40) || `Timed Request ${i + 1}`,
                }));
        case 'selfTalk':
            return Object.keys((config as any).aiConversation?.selfTalk || {})
                .map(k => ({
                    id: k,
                    label: k === 'personA' ? 'Person A (Creative)' : k === 'personB' ? 'Person B (Critical)' : k,
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
    }
}

function _getFieldsForItem(config: SendToChatConfig, category: TemplateCategory, itemId: string): { fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number' | 'select' | 'multi-checkbox'; value: string; readonly?: boolean; help?: string; options?: Array<{ value: string; label: string; readOnly?: boolean }>; optionGroups?: Array<{ category: string; tools: Array<{ value: string; label: string; readOnly?: boolean }> }>; disabledWhen?: { field: string; equals: string } }>; } {
    const fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number' | 'select' | 'multi-checkbox'; value: string; readonly?: boolean; help?: string; options?: Array<{ value: string; label: string; readOnly?: boolean }>; optionGroups?: Array<{ category: string; tools: Array<{ value: string; label: string; readOnly?: boolean }> }>; disabledWhen?: { field: string; equals: string } }> = [];

    switch (category) {
        case 'copilot': {
            const tpl = config.copilot?.templates?.[itemId];
            if (!tpl) break;
            fields.push(
                { name: 'name', label: 'Template Name', type: 'text', value: itemId },
                { name: 'template', label: 'Template', type: 'textarea', value: (tpl as any).template || '', help: PLACEHOLDER_HELP + '<br><br><strong>Use ${originalPrompt}</strong> where your prompt text should be inserted.' },
                { name: 'showInMenu', label: 'Show in Menu', type: 'checkbox', value: String((tpl as any).showInMenu !== false) },
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
        case 'tomAiChat': {
            const tpl = (config.tomAiChat?.templates as any)?.[itemId];
            if (!tpl) break;
            const tcToolOptions = AVAILABLE_LLM_TOOLS.map((tool) => ({ value: tool, label: tool }));
            const tcEnabledTools = Array.isArray(tpl.enabledTools) ? (tpl.enabledTools as string[]) : [];
            const tcAllToolsEnabled = tpl.toolsEnabled !== false && tcEnabledTools.length === 0;
            fields.push(
                { name: 'name', label: 'Template Key', type: 'text', value: itemId },
                { name: 'label', label: 'Display Label', type: 'text', value: tpl.label || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'contextInstructions', label: 'Context Instructions', type: 'textarea', value: tpl.contextInstructions || '', help: PLACEHOLDER_HELP },
                { name: 'systemPromptOverride', label: 'System Prompt Override', type: 'textarea', value: tpl.systemPromptOverride || '' },
                { name: 'allToolsEnabled', label: 'All Tools Enabled', type: 'checkbox', value: String(tcAllToolsEnabled), help: 'When checked, <strong>every</strong> tool the extension knows about (all of <code>ALL_SHARED_TOOLS</code>) is exposed to the model. Uncheck to pick a template-specific subset below.' },
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(tcEnabledTools), options: tcToolOptions, disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: 'Template-level tool subset. Active only when "All Tools Enabled" is off.' },
            );
            break;
        }
        case 'conversation': {
            const profile = (config as any).aiConversation?.profiles?.[itemId];
            if (!profile) break;
            const st = profile.selfTalk || {};
            const stA = st.personA || {};
            const stB = st.personB || {};
            const convToolOptions = AVAILABLE_LLM_TOOLS.map((tool) => ({ value: tool, label: tool }));
            // Self-Talk Model dropdown options come from the user's local LLM
            // configurations (the same list used elsewhere). "(default)" =
            // inherit the conversation-level modelConfig.
            const llmModelOptions = [
                { value: '', label: '(default — inherit conversation modelConfig)' },
                ...(((config as any).localLlm?.configurations ?? [])
                    .filter((c: any) => c && typeof c.id === 'string')
                    .map((c: any) => ({ value: c.id as string, label: c.name ? `${c.name} (${c.id})` : c.id }))),
            ];
            const stAEnabled = Array.isArray(stA.enabledTools) ? (stA.enabledTools as string[]) : [];
            const stAAll = stA.toolsEnabled !== false && stAEnabled.length === 0;
            const stBEnabled = Array.isArray(stB.enabledTools) ? (stB.enabledTools as string[]) : [];
            const stBAll = stB.toolsEnabled !== false && stBEnabled.length === 0;
            fields.push(
                { name: 'name', label: 'Profile Key', type: 'text', value: itemId },
                { name: 'label', label: 'Display Label', type: 'text', value: profile.label || '' },
                { name: 'description', label: 'Description', type: 'text', value: profile.description || '' },
                { name: 'goal', label: 'Goal', type: 'text', value: profile.goal || '' },
                { name: 'maxTurns', label: 'Max Turns', type: 'number', value: String(profile.maxTurns || 10) },
                { name: 'initialPromptTemplate', label: 'Initial Prompt Template', type: 'textarea', value: profile.initialPromptTemplate || '', help: PLACEHOLDER_HELP },
                { name: 'followUpTemplate', label: 'Follow-Up Template', type: 'textarea', value: profile.followUpTemplate || '', help: PLACEHOLDER_HELP },
                { name: 'temperature', label: 'Temperature', type: 'number', value: String(profile.temperature ?? '') },
                // ---- Person A ----
                { name: 'selfTalkPersonASystemPrompt', label: 'Self-Talk A Prompt', type: 'textarea', value: stA.systemPrompt || '' },
                { name: 'selfTalkPersonAModelConfig', label: 'Self-Talk A Model', type: 'select', value: stA.modelConfig || '', options: llmModelOptions, help: 'Local LLM configuration for Person A. "(default)" inherits the conversation-level <code>modelConfig</code>.' },
                { name: 'selfTalkPersonATemperature', label: 'Self-Talk A Temp', type: 'number', value: String(stA.temperature ?? '') },
                { name: 'selfTalkPersonAAllToolsEnabled', label: 'Self-Talk A — All Tools Enabled', type: 'checkbox', value: String(stAAll), help: 'When checked, Person A sees every tool in <code>ALL_SHARED_TOOLS</code>. Uncheck to pick a Person A subset below.' },
                { name: 'selfTalkPersonAEnabledTools', label: 'Self-Talk A — Tools', type: 'multi-checkbox', value: JSON.stringify(stAEnabled), options: convToolOptions, disabledWhen: { field: 'selfTalkPersonAAllToolsEnabled', equals: 'true' }, help: 'Person-A-only tool subset. Active only when "All Tools Enabled" is off.' },
                // ---- Person B ----
                { name: 'selfTalkPersonBSystemPrompt', label: 'Self-Talk B Prompt', type: 'textarea', value: stB.systemPrompt || '' },
                { name: 'selfTalkPersonBModelConfig', label: 'Self-Talk B Model', type: 'select', value: stB.modelConfig || '', options: llmModelOptions, help: 'Local LLM configuration for Person B.' },
                { name: 'selfTalkPersonBTemperature', label: 'Self-Talk B Temp', type: 'number', value: String(stB.temperature ?? '') },
                { name: 'selfTalkPersonBAllToolsEnabled', label: 'Self-Talk B — All Tools Enabled', type: 'checkbox', value: String(stBAll), help: 'When checked, Person B sees every tool in <code>ALL_SHARED_TOOLS</code>. Uncheck to pick a Person B subset below.' },
                { name: 'selfTalkPersonBEnabledTools', label: 'Self-Talk B — Tools', type: 'multi-checkbox', value: JSON.stringify(stBEnabled), options: convToolOptions, disabledWhen: { field: 'selfTalkPersonBAllToolsEnabled', equals: 'true' }, help: 'Person-B-only tool subset. Active only when "All Tools Enabled" is off.' },
            );
            break;
        }
        case 'localLlm': {
            const profile = (config as any).localLlm?.profiles?.[itemId];
            if (!profile) break;
            const llmToolOptions = AVAILABLE_LLM_TOOLS.map((tool) => ({ value: tool, label: tool }));
            const llmProfileEnabledTools = Array.isArray(profile.enabledTools)
                ? (profile.enabledTools as string[])
                : [];
            const llmAllToolsEnabled = profile.toolsEnabled !== false && llmProfileEnabledTools.length === 0;
            const llmExtras = profile as {
                historySuffix?: string;
                memorySuffix?: string;
                autoInjectMemory?: boolean;
            };
            fields.push(
                { name: 'name', label: 'Profile Key', type: 'text', value: itemId },
                { name: 'label', label: 'Display Label', type: 'text', value: profile.label || '' },
                { name: 'systemPrompt', label: 'System Prompt', type: 'textarea', value: profile.systemPrompt || '', help: PLACEHOLDER_HELP },
                { name: 'resultTemplate', label: 'Result Template', type: 'textarea', value: profile.resultTemplate || '' },
                { name: 'temperature', label: 'Temperature', type: 'number', value: String(profile.temperature ?? '') },
                { name: 'modelConfig', label: 'Model Config', type: 'text', value: profile.modelConfig || '' },
                { name: 'allToolsEnabled', label: 'All Tools Enabled', type: 'checkbox', value: String(llmAllToolsEnabled), help: 'When checked, <strong>every</strong> tool the extension knows about (all of <code>ALL_SHARED_TOOLS</code>) is exposed to the model. Uncheck to pick a profile-specific subset below — empty subset then means no tools.' },
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(llmProfileEnabledTools), options: llmToolOptions, disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: 'Profile-level tool subset. Active only when "All Tools Enabled" is off.' },
                { name: 'historySuffix', label: 'History Suffix', type: 'text', value: llmExtras.historySuffix || '', help: 'Optional suffix for the per-profile history snapshot. When set, the manager reads/writes <code>history-&lt;suffix&gt;.{json,md}</code> in <code>_ai/quests/&lt;quest&gt;/history/</code> instead of the canonical <code>history.{json,md}</code>. Leave empty to share the snapshot with other unsuffixed profiles (including the Anthropic panel).' },
                { name: 'memorySuffix', label: 'Memory Suffix', type: 'text', value: llmExtras.memorySuffix || '', help: 'Optional suffix for per-profile memory. When set, the <code>${memory}</code> placeholder injects only <code>facts-&lt;suffix&gt;.md</code> from each scope (shared + current quest). Leave empty to inject every memory file in the scope, matching the Anthropic-side default.' },
                { name: 'autoInjectMemory', label: 'Auto-inject Memory', type: 'checkbox', value: String(llmExtras.autoInjectMemory === true), help: 'When checked, append a <code>## Memory</code> section with <code>${memory}</code> to the resolved system prompt automatically. When unchecked (default), memory is only included when the System Prompt or Result Template explicitly references <code>${memory}</code> / <code>${memory-shared}</code> / <code>${memory-quest}</code>.' },
                { name: 'isDefault', label: 'Is Default', type: 'checkbox', value: String(profile.isDefault === true) },
                { name: 'stripThinkingTags', label: 'Strip Thinking Tags', type: 'checkbox', value: String(profile.stripThinkingTags === true) },
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
        case 'selfTalk': {
            const st = (config as any).aiConversation?.selfTalk?.[itemId];
            if (!st) break;
            fields.push(
                { name: 'name', label: 'Profile Key', type: 'text', value: itemId, readonly: true },
                { name: 'systemPrompt', label: 'System Prompt', type: 'textarea', value: st.systemPrompt || '', help: PLACEHOLDER_HELP },
                { name: 'modelConfig', label: 'Model Config', type: 'text', value: st.modelConfig || '' },
                { name: 'temperature', label: 'Temperature', type: 'number', value: String(st.temperature ?? '') },
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
                thinkingEnabled?: boolean;
                thinkingBudgetTokens?: number;
                promptCachingEnabled?: boolean;
                toolApprovalMode?: 'always' | 'never';
                useBuiltInTools?: boolean;
                autoInjectMemory?: boolean;
                allowInteractiveQuestions?: boolean;
                interactiveQuestionsTemplateId?: string;
            };
            const approvalMode: 'always' | 'never' = p.toolApprovalMode === 'never' ? 'never' : 'always';
            const promptCachingDefaultOn = p.promptCachingEnabled !== false;
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
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(profileEnabledTools), options: toolOptions, optionGroups: toolOptionGroups, disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: 'Profile-level tool subset. Active only when "All Tools Enabled" is off. Empty subset → no tools. Use the global toolbar (Select All / None / Read-Only) or per-group buttons for bulk picks.' },
                { name: 'thinkingEnabled', label: 'Extended Thinking', type: 'checkbox', value: String(p.thinkingEnabled === true), help: 'Enable Claude extended thinking. Sends <code>thinking: { type: "enabled", budget_tokens }</code> on the direct SDK; forwarded to the Agent SDK where supported.' },
                { name: 'thinkingBudgetTokens', label: 'Thinking Budget (tokens)', type: 'number', value: String(p.thinkingBudgetTokens ?? 8192), help: 'Token budget for extended thinking. Minimum 1024. Ignored when Extended Thinking is off.', disabledWhen: { field: 'thinkingEnabled', equals: 'false' } },
                { name: 'promptCachingEnabled', label: 'Prompt Caching', type: 'checkbox', value: String(promptCachingDefaultOn), help: 'Enable prompt caching for this profile. Overrides <code>configuration.promptCachingEnabled</code>. Defaults to on.' },
                { name: 'toolApprovalMode', label: 'Tool Approval', type: 'select', value: approvalMode, options: [{ value: 'always', label: 'Always — prompt before every write tool call' }, { value: 'never', label: 'Never — skip the approval gate (dangerous)' }], help: 'Approval gate for write tool calls. <strong>Always</strong> shows the approval bar; the user can elevate a single approval to the full session via the "Allow All (session)" button at the bar. <strong>Never</strong> skips the gate entirely (on the Agent SDK it also forces <code>permissionMode=bypassPermissions</code>).' },
                { name: 'useBuiltInTools', label: 'Use Built-In Agent SDK Tools', type: 'checkbox', value: String(p.useBuiltInTools === true), help: 'Agent SDK transport only: expose Claude Code\'s built-in tool preset (Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite, …) and automatically suppress extension tools that duplicate them. No effect on the direct Anthropic SDK.' },
                { name: 'allowInteractiveQuestions', label: 'Allow Interactive Questions', type: 'checkbox', value: String(p.allowInteractiveQuestions === true), help: 'Agent SDK transport only: when the agent calls the built-in <code>AskUserQuestion</code> tool, show a VS Code QuickPick per question and feed your selections back to the model. When unchecked (default), the questions are answered with the fallback template below, telling the agent to proceed autonomously. Requires "Use Built-In Agent SDK Tools"; has no effect when Tool Approval is "Never" (the SDK does not fire the approval callback under <code>bypassPermissions</code>).' },
                { name: 'interactiveQuestionsTemplateId', label: 'Interactive Questions Fallback', type: 'select', value: p.interactiveQuestionsTemplateId || '', options: interactiveQuestionsTemplateOptions, help: 'Fallback template (from the "Anthropic — Interactive Questions" category) returned to the agent when interactive questions are off or you dismiss the picker. Bodies may reference <code>${questions}</code>. "(built-in default)" uses the hard-coded autonomous fallback.' },
                { name: 'autoInjectMemory', label: 'Auto-inject Memory', type: 'checkbox', value: String(p.autoInjectMemory === true), help: 'When checked, append a <code>## Memory</code> section with <code>${memory}</code> to the resolved system prompt automatically. When unchecked (default), memory is only included when the profile explicitly references <code>${memory}</code> / <code>${memory-shared}</code> / <code>${memory-quest}</code> in its System Prompt, User Prompt Wrapper, or user-message template.<br><br><strong>Caveat:</strong> file-injection placeholders (<code>${role-description}</code>, <code>${quest-description}</code>, <code>${guidelines-*}</code>) recursively expand any <code>${memory*}</code> tokens that appear inside the injected file. Leaving this off does NOT prevent that. Audit those files if you want zero memory in the prompt.' },
                { name: 'maxRounds', label: 'Max Rounds', type: 'number', value: String(profile.maxRounds ?? ''), help: 'Override <code>configuration.maxRounds</code> for this profile. Leave empty to inherit.' },
                { name: 'maxTokens', label: 'Max Tokens', type: 'number', value: String((profile as { maxTokens?: number }).maxTokens ?? ''), help: 'Override <code>configuration.maxTokens</code> for this profile. Leave empty to inherit.' },
                { name: 'historyMode', label: 'History Mode', type: 'text', value: profile.historyMode ?? '', help: 'one of: none, full, last, summary, trim_and_summary, llm_extract — leave empty to inherit from configuration' },
                { name: 'retryMaxTotalWaitMinutes', label: 'Retry Budget (min)', type: 'number', value: String((profile as { retryMaxTotalWaitMinutes?: number }).retryMaxTotalWaitMinutes ?? ''), help: 'Maximum total minutes the retry-on-busy loop is allowed to wait after the first transient error (HTTP 429 / 503 / 529 / rate-limit / overloaded). Applies uniformly to Anthropic, Ollama, and vLLM. Defaults to 10. Use 240 (4h) to survive Claude session-limit resets.' },
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
                { name: 'template', label: 'Template', type: 'textarea', value: tpl.template || '${userMessage}', help: PLACEHOLDER_HELP + '<br><br><strong>Must contain <code>${userMessage}</code></strong> — the raw text the user typed.' },
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
        initialCategory: initialCategory || 'copilot',
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
        case 'copilot': {
            if (!config.copilot) config.copilot = {};
            if (!config.copilot.templates) config.copilot.templates = {};
            const newName = values.name || itemId;
            if (newName !== itemId) delete config.copilot.templates[itemId];
            config.copilot.templates[newName] = {
                template: values.template || '${originalPrompt}',
                showInMenu: values.showInMenu === 'true',
            };
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
        case 'tomAiChat': {
            if (!config.tomAiChat) config.tomAiChat = { templates: {} };
            if (!config.tomAiChat.templates) config.tomAiChat.templates = {};
            const newName = values.name || itemId;
            if (newName !== itemId) delete config.tomAiChat.templates[itemId];
            const tcAll = values.allToolsEnabled === 'true';
            let tcEnabled: string[] | undefined;
            try {
                const parsed = JSON.parse(values.enabledTools || '[]');
                if (Array.isArray(parsed)) {
                    tcEnabled = parsed.filter((t): t is string => typeof t === 'string');
                }
            } catch { tcEnabled = undefined; }
            config.tomAiChat.templates[newName] = {
                label: values.label || newName,
                description: values.description || '',
                contextInstructions: values.contextInstructions || '',
                systemPromptOverride: values.systemPromptOverride || null,
                toolsEnabled: tcAll,
                enabledTools: tcAll ? undefined : (tcEnabled ?? []),
            } as any;
            break;
        }
        case 'conversation': {
            const profiles = (config as any).aiConversation?.profiles;
            if (!profiles) break;
            const newName = values.name || itemId;
            if (newName !== itemId) delete profiles[itemId];
            const parseTools = (json: string): string[] | undefined => {
                try {
                    const parsed = JSON.parse(json || '[]');
                    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : undefined;
                } catch { return undefined; }
            };
            const personAAll = values.selfTalkPersonAAllToolsEnabled === 'true';
            const personBAll = values.selfTalkPersonBAllToolsEnabled === 'true';
            const personAEnabled = parseTools(values.selfTalkPersonAEnabledTools || '');
            const personBEnabled = parseTools(values.selfTalkPersonBEnabledTools || '');
            profiles[newName] = {
                ...(profiles[itemId] || profiles[newName] || {}),
                label: values.label || newName,
                description: values.description || '',
                goal: values.goal || '',
                maxTurns: parseInt(values.maxTurns) || 10,
                initialPromptTemplate: values.initialPromptTemplate || null,
                followUpTemplate: values.followUpTemplate || null,
                temperature: values.temperature ? parseFloat(values.temperature) : undefined,
                selfTalk: {
                    personA: {
                        systemPrompt: values.selfTalkPersonASystemPrompt || '',
                        modelConfig: values.selfTalkPersonAModelConfig || null,
                        temperature: values.selfTalkPersonATemperature ? parseFloat(values.selfTalkPersonATemperature) : undefined,
                        toolsEnabled: personAAll,
                        enabledTools: personAAll ? undefined : (personAEnabled ?? []),
                    },
                    personB: {
                        systemPrompt: values.selfTalkPersonBSystemPrompt || '',
                        modelConfig: values.selfTalkPersonBModelConfig || null,
                        temperature: values.selfTalkPersonBTemperature ? parseFloat(values.selfTalkPersonBTemperature) : undefined,
                        toolsEnabled: personBAll,
                        enabledTools: personBAll ? undefined : (personBEnabled ?? []),
                    },
                },
            };
            break;
        }
        case 'localLlm': {
            const profiles = (config as any).localLlm?.profiles;
            if (!profiles) break;
            const newName = values.name || itemId;
            if (newName !== itemId) delete profiles[itemId];
            const llmAll = values.allToolsEnabled === 'true';
            let llmEnabled: string[] | undefined;
            try {
                const parsed = JSON.parse(values.enabledTools || '[]');
                if (Array.isArray(parsed)) {
                    llmEnabled = parsed.filter((t): t is string => typeof t === 'string');
                }
            } catch { llmEnabled = undefined; }
            const trimOrUndef = (s: string | undefined): string | undefined => {
                const v = (s ?? '').trim();
                return v.length > 0 ? v : undefined;
            };
            profiles[newName] = {
                ...(profiles[itemId] || profiles[newName] || {}),
                label: values.label || newName,
                systemPrompt: values.systemPrompt || null,
                resultTemplate: values.resultTemplate || null,
                temperature: values.temperature ? parseFloat(values.temperature) : null,
                modelConfig: values.modelConfig || null,
                toolsEnabled: llmAll,
                enabledTools: llmAll ? undefined : (llmEnabled ?? []),
                isDefault: values.isDefault === 'true',
                stripThinkingTags: values.stripThinkingTags === 'true',
                // Persist as `undefined` when empty so the JSON stays
                // clean (no "historySuffix": "" noise) and downstream
                // reads with `?? defaults` keep behaving correctly.
                historySuffix: trimOrUndef(values.historySuffix),
                memorySuffix: trimOrUndef(values.memorySuffix),
                autoInjectMemory: values.autoInjectMemory === 'true',
            };
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
            const thinkingEnabled = values.thinkingEnabled === 'true';
            const thinkingBudgetTokens = values.thinkingBudgetTokens ? parseInt(values.thinkingBudgetTokens, 10) : undefined;
            const promptCachingEnabled = values.promptCachingEnabled !== 'false'; // default on
            const toolApprovalMode: 'always' | 'never' = values.toolApprovalMode === 'never' ? 'never' : 'always';
            const useBuiltInTools = values.useBuiltInTools === 'true';
            const autoInjectMemory = values.autoInjectMemory === 'true';
            const allowInteractiveQuestions = values.allowInteractiveQuestions === 'true';
            const interactiveQuestionsTemplateId = (values.interactiveQuestionsTemplateId || '').trim();
            const userPromptWrapper = (values.userPromptWrapper || '').trim();
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                systemPrompt: values.systemPrompt || '',
                ...(userPromptWrapper ? { userPromptWrapper } : {}),
                configurationId: values.configurationId || undefined,
                toolsEnabled: allToolsEnabled,
                ...(allToolsEnabled ? {} : { enabledTools: enabledTools ?? [] }),
                thinkingEnabled,
                ...(thinkingEnabled && thinkingBudgetTokens ? { thinkingBudgetTokens } : {}),
                promptCachingEnabled,
                toolApprovalMode,
                useBuiltInTools,
                autoInjectMemory,
                allowInteractiveQuestions,
                ...(interactiveQuestionsTemplateId ? { interactiveQuestionsTemplateId } : {}),
                maxRounds: values.maxRounds ? parseInt(values.maxRounds, 10) : undefined,
                maxTokens: values.maxTokens ? parseInt(values.maxTokens, 10) : undefined,
                historyMode: values.historyMode || null,
                retryMaxTotalWaitMinutes: values.retryMaxTotalWaitMinutes
                    ? parseInt(values.retryMaxTotalWaitMinutes, 10)
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
        case 'selfTalk': {
            const selfTalk = (config as any).aiConversation?.selfTalk;
            if (!selfTalk) break;
            selfTalk[itemId] = {
                ...selfTalk[itemId],
                systemPrompt: values.systemPrompt || '',
                modelConfig: values.modelConfig || null,
                temperature: values.temperature ? parseFloat(values.temperature) : undefined,
            };
            break;
        }
    }

    if (saveSendToChatConfig(config)) {
        vscode.window.showInformationMessage('Template saved');
        _sendAllData(category, values.name || itemId);
    }
}

async function _addItem(category: TemplateCategory): Promise<void> {
    if (category === 'selfTalk') {
        vscode.window.showWarningMessage('Self-Talk profiles are fixed (Person A / Person B).');
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
        case 'copilot':
            if (!config.copilot) config.copilot = {};
            if (!config.copilot.templates) config.copilot.templates = {};
            config.copilot.templates[name] = { template: '${originalPrompt}', showInMenu: true };
            break;
        case 'reminder': {
            if (!(config as any).reminders) (config as any).reminders = {};
            const templates: any[] = (config as any).reminders.templates || [];
            templates.push({ id: name, name, prompt: '', isDefault: false });
            (config as any).reminders.templates = templates;
            break;
        }
        case 'tomAiChat':
            if (!config.tomAiChat) config.tomAiChat = { templates: {} };
            if (!config.tomAiChat.templates) config.tomAiChat.templates = {};
            config.tomAiChat.templates[name] = { label: name, description: '', contextInstructions: '' } as any;
            break;
        case 'conversation': {
            if (!(config as any).aiConversation) (config as any).aiConversation = { profiles: {} };
            if (!(config as any).aiConversation.profiles) (config as any).aiConversation.profiles = {};
            (config as any).aiConversation.profiles[name] = {
                label: name, description: '', goal: '', maxTurns: 10,
                initialPromptTemplate: null, followUpTemplate: null,
                selfTalk: {
                    personA: { systemPrompt: '', modelConfig: null },
                    personB: { systemPrompt: '', modelConfig: null },
                },
            };
            break;
        }
        case 'localLlm': {
            if (!(config as any).localLlm) (config as any).localLlm = { profiles: {} };
            if (!(config as any).localLlm.profiles) (config as any).localLlm.profiles = {};
            (config as any).localLlm.profiles[name] = {
                label: name, systemPrompt: null, resultTemplate: null,
                temperature: null, toolsEnabled: true,
            };
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
        case 'copilot':               return new Set(Object.keys(config.copilot?.templates ?? {}));
        case 'tomAiChat':             return new Set(Object.keys(config.tomAiChat?.templates ?? {}));
        case 'conversation':          return new Set(Object.keys((config as any).aiConversation?.profiles ?? {}));
        case 'localLlm':              return new Set(Object.keys((config as any).localLlm?.profiles ?? {}));
        case 'reminder':              return new Set(((config as any).reminders?.templates ?? []).map((t: any) => t.id));
        case 'timedRequests':         return new Set(((config as any).timedRequests ?? []).map((r: any) => r.id));
        case 'anthropicProfiles':     return new Set((config.anthropic?.profiles ?? []).map((p) => p.id));
        case 'anthropicUserMessage':  return new Set((config.anthropic?.userMessageTemplates ?? []).map((t) => t.id));
        case 'compaction':            return new Set((config.compaction?.templates ?? []).map((t) => t.id));
        case 'memoryExtraction':      return new Set((config.compaction?.memoryExtractionTemplates ?? []).map((t) => t.id));
        case 'transportRetry':        return new Set((config.anthropic?.transportRetry?.templates ?? []).map((t) => t.id));
        case 'interactiveQuestions':  return new Set((config.anthropic?.interactiveQuestionsTemplates ?? []).map((t) => t.id));
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
    if (category === 'selfTalk') {
        vscode.window.showWarningMessage('Self-Talk profiles are fixed slots — nothing to copy.');
        return;
    }
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
        case 'copilot': {
            const src = config.copilot?.templates?.[itemId];
            if (!src) return;
            config.copilot!.templates![targetId] = JSON.parse(JSON.stringify(src));
            break;
        }
        case 'tomAiChat': {
            const src = config.tomAiChat?.templates?.[itemId];
            if (!src) return;
            config.tomAiChat!.templates![targetId] = JSON.parse(JSON.stringify(src));
            break;
        }
        case 'conversation': {
            const src = (config as any).aiConversation?.profiles?.[itemId];
            if (!src) return;
            (config as any).aiConversation.profiles[targetId] = JSON.parse(JSON.stringify(src));
            break;
        }
        case 'localLlm': {
            const src = (config as any).localLlm?.profiles?.[itemId];
            if (!src) return;
            const clone = JSON.parse(JSON.stringify(src));
            (config as any).localLlm.profiles[targetId] = { ...clone, label: clone.label || targetId };
            break;
        }
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
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category, targetId);
    }
}

/**
 * Change an item's id. All category shapes support it — for keyed
 * maps (`copilot.templates`, `tomAiChat.templates`, …) we re-key the
 * object; for arrays (`anthropic.profiles`, `compaction.templates`,
 * …) we update the `id` field on the matching entry. The `name`
 * field is also updated when it previously equalled the id (so the
 * display label follows the rename) unless it was already distinct.
 */
async function _renameItem(category: TemplateCategory, itemId: string): Promise<void> {
    if (category === 'selfTalk') {
        vscode.window.showWarningMessage('Self-Talk profiles cannot be renamed.');
        return;
    }
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
        case 'copilot': {
            const tpls = config.copilot?.templates;
            if (!tpls || !tpls[itemId]) return;
            tpls[targetId] = tpls[itemId];
            delete tpls[itemId];
            break;
        }
        case 'tomAiChat': {
            const tpls = config.tomAiChat?.templates;
            if (!tpls || !tpls[itemId]) return;
            tpls[targetId] = tpls[itemId];
            delete tpls[itemId];
            break;
        }
        case 'conversation': {
            const profs = (config as any).aiConversation?.profiles;
            if (!profs || !profs[itemId]) return;
            profs[targetId] = profs[itemId];
            delete profs[itemId];
            break;
        }
        case 'localLlm': {
            const profs = (config as any).localLlm?.profiles;
            if (!profs || !profs[itemId]) return;
            profs[targetId] = profs[itemId];
            delete profs[itemId];
            break;
        }
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
    if (category === 'selfTalk') {
        vscode.window.showWarningMessage('Self-Talk profiles cannot be deleted.');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Delete "${itemId}"?`, { modal: true }, 'Delete',
    );
    if (confirm !== 'Delete') return;

    const config = loadSendToChatConfig();
    if (!config) return;

    switch (category) {
        case 'copilot':
            delete config.copilot?.templates?.[itemId];
            break;
        case 'reminder': {
            const templates: any[] = (config as any).reminders?.templates || [];
            if (!(config as any).reminders) (config as any).reminders = {};
            (config as any).reminders.templates = templates.filter((t: any) => t.id !== itemId);
            break;
        }
        case 'tomAiChat':
            if (config.tomAiChat?.templates) delete config.tomAiChat.templates[itemId];
            break;
        case 'conversation':
            if ((config as any).aiConversation?.profiles) delete (config as any).aiConversation.profiles[itemId];
            break;
        case 'localLlm':
            if ((config as any).localLlm?.profiles) delete (config as any).localLlm.profiles[itemId];
            break;
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
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category);
    }
}
