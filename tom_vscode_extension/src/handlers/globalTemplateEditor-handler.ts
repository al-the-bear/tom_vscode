/**
 * Global Prompt Template Editor — full-screen webview panel.
 *
 * Unified editor for all template/profile types stored in the extension
 * config JSON.  Layout: top action bar with category selector + add/delete,
 * left column with template list, right column with multi-field editor.
 *
 * Categories:
 *   1. Copilot Templates       — config.copilot.templates
 *   2. Reminder Templates      — config.reminders.templates
 *   3. Tom AI Chat Templates   — config.tomAiChat.templates
 *   4. AI Conversation Profiles— config.aiConversation.profiles
 *   5. Local LLM Profiles      — config.localLlm.profiles
 *   6. Timed Requests          — config.timedRequests
 *   7. Self-Talk Profiles      — config.aiConversation.selfTalk
 */

import * as vscode from 'vscode';
import { loadSendToChatConfig, saveSendToChatConfig, SendToChatConfig } from '../utils/sendToChatConfig';
import { PLACEHOLDER_HELP } from './promptTemplate';
import { escapeHtml } from './handler_shared';
import { AVAILABLE_LLM_TOOLS } from '../utils/constants';

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
    | 'memoryExtraction';

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
};

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
            ],
        },
    );

    const webviewCodiconsUri = _panel.webview.asWebviewUri(codiconsUri);

    _panel.webview.onDidReceiveMessage(
        (msg) => _handleMessage(msg),
        undefined,
        context.subscriptions,
    );

    _panel.webview.html = _getHtml(webviewCodiconsUri.toString());

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
    }
}

function _getFieldsForItem(config: SendToChatConfig, category: TemplateCategory, itemId: string): { fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number' | 'select' | 'multi-checkbox'; value: string; readonly?: boolean; help?: string; options?: Array<{ value: string; label: string }>; disabledWhen?: { field: string; equals: string } }>; } {
    const fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number' | 'select' | 'multi-checkbox'; value: string; readonly?: boolean; help?: string; options?: Array<{ value: string; label: string }>; disabledWhen?: { field: string; equals: string } }> = [];

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
            fields.push(
                { name: 'name', label: 'Profile Key', type: 'text', value: itemId },
                { name: 'label', label: 'Display Label', type: 'text', value: profile.label || '' },
                { name: 'description', label: 'Description', type: 'text', value: profile.description || '' },
                { name: 'goal', label: 'Goal', type: 'text', value: profile.goal || '' },
                { name: 'maxTurns', label: 'Max Turns', type: 'number', value: String(profile.maxTurns || 10) },
                { name: 'initialPromptTemplate', label: 'Initial Prompt Template', type: 'textarea', value: profile.initialPromptTemplate || '', help: PLACEHOLDER_HELP },
                { name: 'followUpTemplate', label: 'Follow-Up Template', type: 'textarea', value: profile.followUpTemplate || '', help: PLACEHOLDER_HELP },
                { name: 'temperature', label: 'Temperature', type: 'number', value: String(profile.temperature ?? '') },
                { name: 'selfTalkPersonASystemPrompt', label: 'Self-Talk A Prompt', type: 'textarea', value: stA.systemPrompt || '' },
                { name: 'selfTalkPersonAModelConfig', label: 'Self-Talk A Model', type: 'text', value: stA.modelConfig || '' },
                { name: 'selfTalkPersonATemperature', label: 'Self-Talk A Temp', type: 'number', value: String(stA.temperature ?? '') },
                { name: 'selfTalkPersonBSystemPrompt', label: 'Self-Talk B Prompt', type: 'textarea', value: stB.systemPrompt || '' },
                { name: 'selfTalkPersonBModelConfig', label: 'Self-Talk B Model', type: 'text', value: stB.modelConfig || '' },
                { name: 'selfTalkPersonBTemperature', label: 'Self-Talk B Temp', type: 'number', value: String(stB.temperature ?? '') },
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
            fields.push(
                { name: 'name', label: 'Profile Key', type: 'text', value: itemId },
                { name: 'label', label: 'Display Label', type: 'text', value: profile.label || '' },
                { name: 'systemPrompt', label: 'System Prompt', type: 'textarea', value: profile.systemPrompt || '', help: PLACEHOLDER_HELP },
                { name: 'resultTemplate', label: 'Result Template', type: 'textarea', value: profile.resultTemplate || '' },
                { name: 'temperature', label: 'Temperature', type: 'number', value: String(profile.temperature ?? '') },
                { name: 'modelConfig', label: 'Model Config', type: 'text', value: profile.modelConfig || '' },
                { name: 'allToolsEnabled', label: 'All Tools Enabled', type: 'checkbox', value: String(llmAllToolsEnabled), help: 'When checked, <strong>every</strong> tool the extension knows about (all of <code>ALL_SHARED_TOOLS</code>) is exposed to the model. Uncheck to pick a profile-specific subset below — empty subset then means no tools.' },
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(llmProfileEnabledTools), options: llmToolOptions, disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: 'Profile-level tool subset. Active only when "All Tools Enabled" is off.' },
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
            // Configuration dropdown — options come from the user's
            // anthropic.configurations[] list, plus a blank entry that
            // means "inherit the default".
            const configurationOptions = [
                { value: '', label: '(inherit default)' },
                ...((config.anthropic?.configurations || [])
                    .filter((c) => c && typeof c.id === 'string')
                    .map((c) => ({ value: c.id, label: c.name ? `${c.name} (${c.id})` : c.id }))),
            ];
            // Tool picker options — every tool the extension knows about,
            // whether or not the configuration already enables it. Empty
            // selection + allToolsEnabled=false means "no tools".
            const toolOptions = AVAILABLE_LLM_TOOLS.map((tool) => ({ value: tool, label: tool }));
            // Profile-level enabledTools override. We stash the list as
            // JSON in the field value so the multi-checkbox renderer can
            // pre-select the right rows without a second hidden field.
            const profileEnabledTools = Array.isArray((profile as unknown as { enabledTools?: string[] }).enabledTools)
                ? (profile as unknown as { enabledTools: string[] }).enabledTools
                : [];
            // `toolsEnabled` on the stored profile is legacy shorthand for
            // "allow every tool from the configuration". We map it onto a
            // clearer `allToolsEnabled` toggle here; when that toggle is
            // on, the per-tool picker below is disabled.
            const allToolsEnabled = profile.toolsEnabled !== false && profileEnabledTools.length === 0;
            // Profile-level overrides (default "on" for promptCaching so
            // the field resolves to true when absent).
            const p = profile as unknown as {
                thinkingEnabled?: boolean;
                thinkingBudgetTokens?: number;
                promptCachingEnabled?: boolean;
                autoApproveAll?: boolean;
                useBuiltInTools?: boolean;
            };
            const promptCachingDefaultOn = p.promptCachingEnabled !== false;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: profile.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: profile.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: profile.description || '' },
                { name: 'systemPrompt', label: 'System Prompt', type: 'textarea', value: profile.systemPrompt || '', help: PLACEHOLDER_HELP + '<br><br>Sent as the Anthropic <code>system</code> parameter. Supports <code>${role-description}</code> and <code>${quest-description}</code>.' },
                { name: 'configurationId', label: 'Configuration', type: 'select', value: profile.configurationId || '', options: configurationOptions, help: 'Which <code>anthropic.configurations[]</code> entry this profile uses. "(inherit default)" falls back to the configuration marked <code>isDefault</code>.' },
                { name: 'allToolsEnabled', label: 'All Tools Enabled', type: 'checkbox', value: String(allToolsEnabled), help: 'When checked, <strong>every</strong> tool the extension knows about (all of <code>ALL_SHARED_TOOLS</code>) is exposed to the model. Uncheck to pick a profile-specific subset below — when off and the subset is empty, the configuration\'s own <code>enabledTools</code> list is used as a fallback.' },
                { name: 'enabledTools', label: 'Tools', type: 'multi-checkbox', value: JSON.stringify(profileEnabledTools), options: toolOptions, disabledWhen: { field: 'allToolsEnabled', equals: 'true' }, help: 'Profile-level tool subset. Active only when "All Tools Enabled" is off. Empty subset → falls back to the configuration\'s <code>enabledTools</code> list.' },
                { name: 'thinkingEnabled', label: 'Extended Thinking', type: 'checkbox', value: String(p.thinkingEnabled === true), help: 'Enable Claude extended thinking. Sends <code>thinking: { type: "enabled", budget_tokens }</code> on the direct SDK; forwarded to the Agent SDK where supported.' },
                { name: 'thinkingBudgetTokens', label: 'Thinking Budget (tokens)', type: 'number', value: String(p.thinkingBudgetTokens ?? 8192), help: 'Token budget for extended thinking. Minimum 1024. Ignored when Extended Thinking is off.', disabledWhen: { field: 'thinkingEnabled', equals: 'false' } },
                { name: 'promptCachingEnabled', label: 'Prompt Caching', type: 'checkbox', value: String(promptCachingDefaultOn), help: 'Enable prompt caching for this profile. Overrides <code>configuration.promptCachingEnabled</code>. Defaults to on.' },
                { name: 'autoApproveAll', label: 'Auto-Approve All Tools', type: 'checkbox', value: String(p.autoApproveAll === true), help: 'Skip the approval gate for every tool call in this profile. Forces <code>toolApprovalMode = "never"</code>. Dangerous — the model can delete, edit, and run commands without confirmation.' },
                { name: 'useBuiltInTools', label: 'Use Built-In Agent SDK Tools', type: 'checkbox', value: String(p.useBuiltInTools === true), help: 'Agent SDK transport only: expose Claude Code\'s built-in tool preset (Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite, …) and automatically suppress extension tools that duplicate them. No effect on the direct Anthropic SDK.' },
                { name: 'maxRounds', label: 'Max Rounds', type: 'number', value: String(profile.maxRounds ?? '') },
                { name: 'historyMode', label: 'History Mode', type: 'text', value: profile.historyMode ?? '', help: 'one of: none, full, last, summary, trim_and_summary, llm_extract — leave empty to inherit from configuration' },
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
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Template', type: 'textarea', value: tpl.template || '', help: PLACEHOLDER_HELP + '<br><br>Compaction placeholders: <code>${compactionHistory}</code>, <code>${turnCount}</code>, <code>${tokenEstimate}</code>, <code>${compactionMode}</code>, <code>${turnsDropped}</code>, <code>${keptTurnCount}</code>, <code>${turnIndex}</code>.' },
                { name: 'targetMode', label: 'Target Mode', type: 'text', value: tpl.targetMode || 'all', help: 'summary, trim_and_summary, llm_extract, or all' },
            );
            break;
        }
        case 'memoryExtraction': {
            const tpl = (config.compaction?.memoryExtractionTemplates || []).find(t => t.id === itemId);
            if (!tpl) break;
            fields.push(
                { name: 'id', label: 'ID', type: 'text', value: tpl.id, readonly: true },
                { name: 'name', label: 'Name', type: 'text', value: tpl.name || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'template', label: 'Template', type: 'textarea', value: tpl.template || '', help: PLACEHOLDER_HELP + '<br><br>Memory placeholders: <code>${recentHistory}</code>, <code>${existingMemory}</code>, <code>${memoryFilePath}</code>, <code>${memoryScope}</code>.' },
                { name: 'targetFile', label: 'Target File', type: 'text', value: tpl.targetFile || 'facts.md' },
                { name: 'scope', label: 'Scope', type: 'text', value: tpl.scope || 'quest', help: 'quest, shared, or both' },
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
                    },
                    personB: {
                        systemPrompt: values.selfTalkPersonBSystemPrompt || '',
                        modelConfig: values.selfTalkPersonBModelConfig || null,
                        temperature: values.selfTalkPersonBTemperature ? parseFloat(values.selfTalkPersonBTemperature) : undefined,
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
            const autoApproveAll = values.autoApproveAll === 'true';
            const useBuiltInTools = values.useBuiltInTools === 'true';
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                systemPrompt: values.systemPrompt || '',
                configurationId: values.configurationId || undefined,
                toolsEnabled: allToolsEnabled,
                ...(allToolsEnabled ? {} : { enabledTools: enabledTools ?? [] }),
                thinkingEnabled,
                ...(thinkingEnabled && thinkingBudgetTokens ? { thinkingBudgetTokens } : {}),
                promptCachingEnabled,
                autoApproveAll,
                useBuiltInTools,
                maxRounds: values.maxRounds ? parseInt(values.maxRounds, 10) : undefined,
                historyMode: values.historyMode || null,
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
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '',
                targetMode: values.targetMode || 'all',
            };
            if (idx >= 0) {
                templates[idx] = { ...templates[idx], ...next };
            } else {
                templates.push(next);
            }
            config.compaction.templates = templates;
            break;
        }
        case 'memoryExtraction': {
            if (!config.compaction) config.compaction = {};
            const templates = config.compaction.memoryExtractionTemplates ?? [];
            const idx = templates.findIndex(t => t.id === itemId);
            const scope = (values.scope === 'shared' || values.scope === 'both') ? values.scope : 'quest';
            const next = {
                id: itemId,
                name: values.name || itemId,
                description: values.description || '',
                template: values.template || '',
                targetFile: values.targetFile || 'facts.md',
                scope: scope as 'quest' | 'shared' | 'both',
            };
            if (idx >= 0) {
                templates[idx] = { ...templates[idx], ...next };
            } else {
                templates.push(next);
            }
            config.compaction.memoryExtractionTemplates = templates;
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
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category, name);
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
    }

    if (saveSendToChatConfig(config)) {
        _sendAllData(category);
    }
}

// ============================================================================
// HTML
// ============================================================================

function _getHtml(codiconsUri: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${codiconsUri}">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    height: 100vh;
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    overflow: hidden;
}

/* ── Action bar ── */
.action-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.action-bar select {
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px;
    font-size: 13px;
}
.action-bar .spacer { flex: 1; }
.icon-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
}
.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-btn .codicon { font-size: 16px; }

/* ── Main layout ── */
.main {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* ── Vertical splitter ── */
.v-splitter {
    width: 4px;
    cursor: col-resize;
    background: var(--vscode-panel-border);
    flex-shrink: 0;
}
.v-splitter:hover, .v-splitter.dragging { background: var(--vscode-focusBorder); }

/* ── Left list ── */
.file-list {
    width: 240px;
    min-width: 180px;
    border-right: 1px solid var(--vscode-panel-border);
    overflow-y: auto;
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.file-list .item {
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-left: 3px solid transparent;
}
.file-list .item:hover { background: var(--vscode-list-hoverBackground); }
.file-list .item.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-focusBorder);
}
.file-list .empty {
    padding: 16px 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 12px;
}

/* ── Right editor ── */
.editor-area {
    flex: 1;
    overflow-y: auto;
    padding: 16px 24px;
    display: flex;
    flex-direction: column;
}
.editor-area .no-selection {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding-top: 40px;
    text-align: center;
}
.field { margin-bottom: 16px; flex-shrink: 0; }
.field.field-grow { flex: 1; display: flex; flex-direction: column; margin-bottom: 0; }
.field.field-grow textarea { flex: 1; min-height: 100px; resize: none; }
.field label {
    display: block;
    margin-bottom: 4px;
    font-weight: 500;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
}
.field input[type="text"],
.field input[type="number"],
.field textarea {
    width: 100%;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    padding: 6px 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    border-radius: 3px;
}
.field textarea { min-height: 100px; resize: vertical; line-height: 1.5; }
.field input:focus, .field textarea:focus { border-color: var(--vscode-focusBorder); outline: none; }
/* Inline row: name + checkbox on same line */
.field-inline-row {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    margin-bottom: 16px;
    flex-shrink: 0;
}
.field-inline-row .field { margin-bottom: 0; flex: 1; }
.field-inline-row .field.checkbox-field { flex: 0 0 auto; padding-bottom: 6px; }
/* Help overlay triggered by ? icon */
.label-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.label-row label { margin-bottom: 0; }
.help-icon {
    width: 18px; height: 18px; border-radius: 50%;
    border: 1px solid var(--vscode-descriptionForeground);
    background: transparent; color: var(--vscode-descriptionForeground);
    font-size: 11px; font-weight: 700; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0; line-height: 1; flex-shrink: 0;
}
.help-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
.help-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.3); z-index: 1000;
    align-items: center; justify-content: center;
}
.help-overlay.visible { display: flex; }
.help-overlay-content {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; padding: 16px 20px;
    width: 90%; max-width: 90%; max-height: 70vh; overflow-y: auto;
    font-size: 12px; line-height: 1.5;
    color: var(--vscode-foreground);
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
}
.help-overlay-content code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px; border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace);
}
.help-overlay-close {
    float: right; background: transparent; border: none;
    color: var(--vscode-foreground); cursor: pointer;
    font-size: 16px; padding: 0 4px; margin: -4px -4px 0 8px;
}
.field.checkbox-field {
    display: flex;
    align-items: center;
    gap: 8px;
}
.field.checkbox-field input[type="checkbox"] { width: auto; }
.field.checkbox-field label { margin-bottom: 0; }
.field input[readonly], .field textarea[readonly] { opacity: 0.6; cursor: not-allowed; }

.save-bar {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 24px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.save-bar button {
    padding: 6px 16px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    border-radius: 3px;
    font-size: 13px;
}
.save-bar button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.save-bar button:hover { opacity: 0.9; }
</style>
</head>
<body>

<h2 id="panelHeadline" style="margin:12px 16px 0;font-weight:600;font-size:1.1em;color:var(--vscode-foreground);">Prompt Template Editor</h2>

<div class="action-bar">
    <select id="categorySelect"></select>
    <button class="icon-btn" id="btnAdd" title="Add new template">
        <span class="codicon codicon-add"></span>
    </button>
    <button class="icon-btn" id="btnDelete" title="Delete selected template">
        <span class="codicon codicon-trash"></span>
    </button>
    <div class="spacer"></div>
</div>

<div class="main">
    <div class="file-list" id="fileList"></div>
    <div class="v-splitter" id="vSplitter"></div>
    <div class="editor-area" id="editorArea">
        <div class="no-selection">Select a template from the left to edit</div>
    </div>
</div>

<div class="save-bar" id="saveBar" style="display:none">
    <button class="primary" id="btnSave">Save</button>
</div>

<script>
const vscode = acquireVsCodeApi();

let categories = [];
let currentCategory = '';
let currentItemId = '';
let currentFields = [];

const categorySelect = document.getElementById('categorySelect');
const fileList = document.getElementById('fileList');
const editorArea = document.getElementById('editorArea');
const saveBar = document.getElementById('saveBar');
const panelHeadline = document.getElementById('panelHeadline');

function updateHeadline() {
    const cat = categories.find(c => c.id === currentCategory);
    panelHeadline.textContent = cat ? cat.label + ' — Template Editor' : 'Prompt Template Editor';
}

// ── Category select ──
categorySelect.addEventListener('change', () => {
    currentCategory = categorySelect.value;
    currentItemId = '';
    updateHeadline();
    vscode.postMessage({ type: 'selectCategory', category: currentCategory });
    renderFileList();
    editorArea.innerHTML = '<div class="no-selection">Select a template from the left to edit</div>';
    saveBar.style.display = 'none';
});

document.getElementById('btnAdd').addEventListener('click', () => {
    vscode.postMessage({ type: 'add', category: currentCategory });
});
document.getElementById('btnDelete').addEventListener('click', () => {
    if (!currentItemId) return;
    vscode.postMessage({ type: 'delete', category: currentCategory, itemId: currentItemId });
});
document.getElementById('btnSave').addEventListener('click', () => {
    saveCurrentItem();
});

function renderCategories(initialCategory) {
    categorySelect.innerHTML = '';
    categories.forEach(cat => {
        const o = document.createElement('option');
        o.value = cat.id;
        o.textContent = cat.label;
        if (cat.id === initialCategory) o.selected = true;
        categorySelect.appendChild(o);
    });
    currentCategory = initialCategory || categories[0]?.id || '';
    updateHeadline();
}

function renderFileList(selectId) {
    const cat = categories.find(c => c.id === currentCategory);
    const items = cat?.items || [];
    if (items.length === 0) {
        fileList.innerHTML = '<div class="empty">No templates in this category</div>';
        return;
    }
    fileList.innerHTML = items.map(item =>
        '<div class="item' + (item.id === (selectId || currentItemId) ? ' selected' : '') +
        '" data-id="' + escapeAttr(item.id) + '">' + escapeText(item.label) + '</div>'
    ).join('');

    fileList.querySelectorAll('.item').forEach(el => {
        el.addEventListener('click', () => {
            currentItemId = el.dataset.id;
            fileList.querySelectorAll('.item').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
            vscode.postMessage({ type: 'selectItem', category: currentCategory, itemId: currentItemId });
        });
    });
}

var _helpOverlayAdded = false;
function ensureHelpOverlay() {
    if (_helpOverlayAdded) return;
    _helpOverlayAdded = true;
    var ov = document.createElement('div');
    ov.className = 'help-overlay';
    ov.id = 'helpOverlay';
    ov.innerHTML = '<div class="help-overlay-content"><button class="help-overlay-close" id="helpOverlayClose">&times;</button><div id="helpOverlayBody"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e) { if (e.target === ov) ov.classList.remove('visible'); });
    document.getElementById('helpOverlayClose').addEventListener('click', function() { ov.classList.remove('visible'); });
}
function showHelpOverlay(html) {
    ensureHelpOverlay();
    document.getElementById('helpOverlayBody').innerHTML = html;
    document.getElementById('helpOverlay').classList.add('visible');
}

function renderFields(fields) {
    currentFields = fields;
    if (!fields || fields.length === 0) {
        editorArea.innerHTML = '<div class="no-selection">No editable fields</div>';
        saveBar.style.display = 'none';
        return;
    }

    // Separate name + showInMenu for inline row, and find the textarea field
    var nameField = fields.find(function(f) { return f.name === 'name'; });
    var showInMenuField = fields.find(function(f) { return f.name === 'showInMenu'; });
    var otherFields = fields.filter(function(f) { return f.name !== 'name' && f.name !== 'showInMenu'; });

    var html = '';

    // Render name + showInMenu inline if both exist
    if (nameField && showInMenuField) {
        html += '<div class="field-inline-row">';
        html += '<div class="field"><label for="field_' + nameField.name + '">' + escapeText(nameField.label) + '</label>' +
            '<input type="text" id="field_' + nameField.name + '" value="' + escapeAttr(nameField.value || '') + '"' + (nameField.readonly ? ' readonly disabled' : '') + '></div>';
        html += '<div class="field checkbox-field">' +
            '<input type="checkbox" id="field_' + showInMenuField.name + '"' + (showInMenuField.value === 'true' ? ' checked' : '') +
            (showInMenuField.readonly ? ' disabled' : '') + '>' +
            '<label for="field_' + showInMenuField.name + '">' + escapeText(showInMenuField.label) + '</label></div>';
        html += '</div>';
    } else {
        // Render them normally if only one exists
        if (nameField) {
            html += '<div class="field"><label for="field_' + nameField.name + '">' + escapeText(nameField.label) + '</label>' +
                '<input type="text" id="field_' + nameField.name + '" value="' + escapeAttr(nameField.value || '') + '"' + (nameField.readonly ? ' readonly disabled' : '') + '></div>';
        }
        if (showInMenuField) {
            html += '<div class="field checkbox-field">' +
                '<input type="checkbox" id="field_' + showInMenuField.name + '"' + (showInMenuField.value === 'true' ? ' checked' : '') +
                (showInMenuField.readonly ? ' disabled' : '') + '>' +
                '<label for="field_' + showInMenuField.name + '">' + escapeText(showInMenuField.label) + '</label></div>';
        }
    }

    // Render remaining fields
    html += otherFields.map(function(f) {
        var helpBtn = f.help ? ' <button class="help-icon" type="button" data-help="' + escapeAttr(f.help) + '" title="Show help">?</button>' : '';
        var labelHtml = '<div class="label-row"><label for="field_' + f.name + '">' + escapeText(f.label) + '</label>' + helpBtn + '</div>';
        if (f.type === 'checkbox') {
            return '<div class="field checkbox-field">' +
                '<input type="checkbox" id="field_' + f.name + '"' + (f.value === 'true' ? ' checked' : '') +
                (f.readonly ? ' disabled' : '') + '>' +
                '<label for="field_' + f.name + '">' + escapeText(f.label) + '</label>' + helpBtn + '</div>';
        }
        if (f.type === 'select') {
            var opts = (f.options || []).map(function(o) {
                return '<option value="' + escapeAttr(o.value) + '"' + (o.value === f.value ? ' selected' : '') + '>' + escapeText(o.label) + '</option>';
            }).join('');
            return '<div class="field">' + labelHtml +
                '<select id="field_' + f.name + '"' + (f.readonly ? ' disabled' : '') + '>' + opts + '</select></div>';
        }
        if (f.type === 'multi-checkbox') {
            var checked = [];
            try { checked = JSON.parse(f.value || '[]'); } catch (e) { checked = []; }
            if (!Array.isArray(checked)) { checked = []; }
            var disabledWhen = f.disabledWhen || null;
            var disabledAttr = disabledWhen ? ' data-disabled-when-field="' + escapeAttr(disabledWhen.field) + '" data-disabled-when-equals="' + escapeAttr(disabledWhen.equals) + '"' : '';
            var rows = (f.options || []).map(function(o) {
                var id = 'field_' + f.name + '__' + o.value.replace(/[^a-zA-Z0-9_-]/g, '_');
                var isChecked = checked.indexOf(o.value) >= 0;
                return '<label class="multi-checkbox-row" style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-weight:normal">' +
                    '<input type="checkbox" class="field-multi-option" data-field="' + f.name + '" value="' + escapeAttr(o.value) + '" id="' + id + '"' + (isChecked ? ' checked' : '') + '>' +
                    escapeText(o.label) + '</label>';
            }).join('');
            return '<div class="field multi-checkbox-field" data-field-name="' + f.name + '"' + disabledAttr + '>' + labelHtml +
                '<div class="multi-checkbox-group" style="display:flex;flex-wrap:wrap;padding:4px 0">' + rows + '</div></div>';
        }
        var ro = f.readonly ? ' readonly disabled' : '';
        var inputType = f.type === 'number' ? 'number' : 'text';
        var isTextarea = f.type === 'textarea';
        var growClass = isTextarea ? ' field-grow' : '';
        var input = isTextarea
            ? '<textarea id="field_' + f.name + '"' + ro + '>' + escapeText(f.value || '') + '</textarea>'
            : '<input type="' + inputType + '" id="field_' + f.name + '" value="' + escapeAttr(f.value || '') + '"' + ro + '>';
        return '<div class="field' + growClass + '">' + labelHtml + input + '</div>';
    }).join('');

    editorArea.innerHTML = html;
    saveBar.style.display = 'flex';

    // Attach help icon click handlers
    editorArea.querySelectorAll('.help-icon').forEach(function(btn) {
        btn.addEventListener('click', function() { showHelpOverlay(btn.getAttribute('data-help')); });
    });

    // Wire conditional-disable for multi-checkbox fields that depend on
    // another field. Applies the current state now and re-runs whenever
    // the target field changes.
    function applyMultiCheckboxDisabled() {
        editorArea.querySelectorAll('.multi-checkbox-field[data-disabled-when-field]').forEach(function(group) {
            var srcName = group.getAttribute('data-disabled-when-field');
            var srcEquals = group.getAttribute('data-disabled-when-equals');
            var src = document.getElementById('field_' + srcName);
            if (!src) return;
            var srcVal = src.type === 'checkbox' ? String(!!src.checked) : src.value;
            var isDisabled = srcVal === srcEquals;
            group.style.opacity = isDisabled ? '0.45' : '';
            group.querySelectorAll('input.field-multi-option').forEach(function(cb) {
                cb.disabled = isDisabled;
            });
        });
    }
    editorArea.querySelectorAll('input[type="checkbox"], input[type="text"], input[type="number"], select').forEach(function(el) {
        el.addEventListener('change', applyMultiCheckboxDisabled);
    });
    applyMultiCheckboxDisabled();
}

function saveCurrentItem() {
    if (!currentCategory || !currentItemId || !currentFields.length) return;
    const values = {};
    currentFields.forEach(f => {
        if (f.type === 'multi-checkbox') {
            // Collect the checked values from the field's option rows,
            // serialize as JSON so the extension side gets a stable shape
            // regardless of ordering.
            const picked = [];
            document.querySelectorAll('input.field-multi-option[data-field="' + f.name + '"]').forEach(function(cb) {
                if (cb.checked) { picked.push(cb.value); }
            });
            values[f.name] = JSON.stringify(picked);
            return;
        }
        const el = document.getElementById('field_' + f.name);
        if (!el) return;
        if (f.type === 'checkbox') {
            values[f.name] = String(el.checked);
        } else {
            values[f.name] = el.value;
        }
    });
    vscode.postMessage({ type: 'save', category: currentCategory, itemId: currentItemId, values });
}

function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Messages from extension ──
window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
        case 'allData':
            categories = msg.categories;
            renderCategories(msg.initialCategory);
            renderFileList(msg.initialItemId);
            if (msg.initialItemId) {
                currentItemId = msg.initialItemId;
                vscode.postMessage({ type: 'selectItem', category: currentCategory, itemId: currentItemId });
            }
            break;
        case 'categoryItems': {
            const cat = categories.find(c => c.id === msg.category);
            if (cat) cat.items = msg.items;
            renderFileList();
            break;
        }
        case 'itemFields':
            renderFields(msg.fields);
            break;
        case 'selectItem':
            if (msg.category) {
                var categoryChanged = currentCategory !== msg.category;
                currentCategory = msg.category;
                categorySelect.value = msg.category;
                if (categoryChanged) {
                    // Items for this category may be stale if the file was
                    // edited since the editor was opened — fetch fresh,
                    // same code path as the categorySelect onchange handler
                    // (which the user confirmed recovers the correct list).
                    vscode.postMessage({ type: 'selectCategory', category: currentCategory });
                }
            }
            if (msg.itemId) {
                currentItemId = msg.itemId;
                renderFileList(msg.itemId);
                vscode.postMessage({ type: 'selectItem', category: currentCategory, itemId: currentItemId });
            }
            break;
    }
});

vscode.postMessage({ type: 'ready' });

// ── Splitter logic ──
(function() {
    const fileList = document.getElementById('fileList');
    const vSplitter = document.getElementById('vSplitter');
    let vDragging = false;
    vSplitter.addEventListener('mousedown', function(e) {
        vDragging = true;
        vSplitter.classList.add('dragging');
        e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
        if (vDragging) {
            const newWidth = Math.max(150, Math.min(e.clientX, window.innerWidth - 300));
            fileList.style.width = newWidth + 'px';
        }
    });
    document.addEventListener('mouseup', function() {
        if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
    });
})();
</script>
</body></html>`;
}
