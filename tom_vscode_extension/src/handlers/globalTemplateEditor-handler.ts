/**
 * Global Prompt Template Editor — full-screen webview panel.
 *
 * Unified editor for all template/profile types stored in the extension
 * config JSON.  Layout: top action bar with category selector + add/delete,
 * left column with template list, right column with multi-field editor.
 *
 * Categories:
 *   1. Copilot Templates       — config.templates
 *   2. Reminder Templates      — config.reminderTemplates
 *   3. Tom AI Chat Templates   — config.tomAiChat.templates
 *   4. AI Conversation Profiles— config.botConversation.profiles
 *   5. Local LLM Profiles      — config.promptExpander.profiles
 *   6. Timed Requests          — config.timedRequests
 *   7. Self-Talk Profiles      — config.botConversation.selfTalk
 */

import * as vscode from 'vscode';
import { loadSendToChatConfig, saveSendToChatConfig, SendToChatConfig } from '../utils/sendToChatConfig';
import { PLACEHOLDER_HELP } from './promptTemplate';
import { escapeHtml } from './handler_shared';

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
    | 'selfTalk';

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
    copilot: 'Copilot',
    reminder: 'Reminder',
    tomAiChat: 'Tom AI Chat',
    conversation: 'AI Conversation',
    localLlm: 'Local LLM',
    timedRequests: 'Timed Requests',
    selfTalk: 'Self-Talk',
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
        'dartscript.globalTemplateEditor',
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

    _panel.onDidDispose(() => { _panel = undefined; });

    // Initial data push (after a tick so html is ready)
    setTimeout(() => {
        _sendAllData(options?.category, options?.itemId);
    }, 100);
}

export function registerGlobalTemplateEditorCommand(ctx: vscode.ExtensionContext): void {
    _context = ctx;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('dartscript.openGlobalTemplateEditor', (args?: any) => {
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
            return Object.keys(config.templates || {})
                .filter(k => k !== '__answer_file__')
                .map(k => ({ id: k, label: k }));
        case 'reminder':
            return ((config as any).reminderTemplates || [])
                .map((t: any) => ({ id: t.id, label: t.name || t.id }));
        case 'tomAiChat':
            return Object.keys(config.tomAiChat?.templates || {})
                .map(k => ({ id: k, label: (config.tomAiChat!.templates![k] as any).label || k }));
        case 'conversation':
            return Object.keys((config as any).botConversation?.profiles || {})
                .map(k => ({ id: k, label: ((config as any).botConversation.profiles[k] as any).label || k }));
        case 'localLlm':
            return Object.keys((config as any).promptExpander?.profiles || {})
                .map(k => ({ id: k, label: ((config as any).promptExpander.profiles[k] as any).label || k }));
        case 'timedRequests':
            return ((config as any).timedRequests || [])
                .map((t: any, i: number) => ({
                    id: t.id || String(i),
                    label: t.originalText?.substring(0, 40) || `Timed Request ${i + 1}`,
                }));
        case 'selfTalk':
            return Object.keys((config as any).botConversation?.selfTalk || {})
                .map(k => ({
                    id: k,
                    label: k === 'personA' ? 'Person A (Creative)' : k === 'personB' ? 'Person B (Critical)' : k,
                }));
    }
}

function _getFieldsForItem(config: SendToChatConfig, category: TemplateCategory, itemId: string): { fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number'; value: string; readonly?: boolean; help?: string }>; } {
    const fields: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'number'; value: string; readonly?: boolean; help?: string }> = [];

    switch (category) {
        case 'copilot': {
            const tpl = config.templates?.[itemId];
            if (!tpl) break;
            fields.push(
                { name: 'name', label: 'Template Name', type: 'text', value: itemId },
                { name: 'template', label: 'Template', type: 'textarea', value: (tpl as any).template || '', help: PLACEHOLDER_HELP + '<br><br><strong>Use ${originalPrompt}</strong> where your prompt text should be inserted.' },
                { name: 'showInMenu', label: 'Show in Menu', type: 'checkbox', value: String((tpl as any).showInMenu !== false) },
            );
            break;
        }
        case 'reminder': {
            const templates: any[] = (config as any).reminderTemplates || [];
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
            fields.push(
                { name: 'name', label: 'Template Key', type: 'text', value: itemId },
                { name: 'label', label: 'Display Label', type: 'text', value: tpl.label || '' },
                { name: 'description', label: 'Description', type: 'text', value: tpl.description || '' },
                { name: 'contextInstructions', label: 'Context Instructions', type: 'textarea', value: tpl.contextInstructions || '', help: PLACEHOLDER_HELP },
                { name: 'systemPromptOverride', label: 'System Prompt Override', type: 'textarea', value: tpl.systemPromptOverride || '' },
            );
            break;
        }
        case 'conversation': {
            const profile = (config as any).botConversation?.profiles?.[itemId];
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
            const profile = (config as any).promptExpander?.profiles?.[itemId];
            if (!profile) break;
            fields.push(
                { name: 'name', label: 'Profile Key', type: 'text', value: itemId },
                { name: 'label', label: 'Display Label', type: 'text', value: profile.label || '' },
                { name: 'systemPrompt', label: 'System Prompt', type: 'textarea', value: profile.systemPrompt || '', help: PLACEHOLDER_HELP },
                { name: 'resultTemplate', label: 'Result Template', type: 'textarea', value: profile.resultTemplate || '' },
                { name: 'temperature', label: 'Temperature', type: 'number', value: String(profile.temperature ?? '') },
                { name: 'modelConfig', label: 'Model Config', type: 'text', value: profile.modelConfig || '' },
                { name: 'toolsEnabled', label: 'Tools Enabled', type: 'checkbox', value: String(profile.toolsEnabled !== false) },
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
            const st = (config as any).botConversation?.selfTalk?.[itemId];
            if (!st) break;
            fields.push(
                { name: 'name', label: 'Profile Key', type: 'text', value: itemId, readonly: true },
                { name: 'systemPrompt', label: 'System Prompt', type: 'textarea', value: st.systemPrompt || '', help: PLACEHOLDER_HELP },
                { name: 'modelConfig', label: 'Model Config', type: 'text', value: st.modelConfig || '' },
                { name: 'temperature', label: 'Temperature', type: 'number', value: String(st.temperature ?? '') },
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
            _sendAllData();
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
            const newName = values.name || itemId;
            if (newName !== itemId) delete config.templates[itemId];
            config.templates[newName] = {
                template: values.template || '${originalPrompt}',
                showInMenu: values.showInMenu === 'true',
            };
            break;
        }
        case 'reminder': {
            const templates: any[] = (config as any).reminderTemplates || [];
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
            config.tomAiChat.templates[newName] = {
                label: values.label || newName,
                description: values.description || '',
                contextInstructions: values.contextInstructions || '',
                systemPromptOverride: values.systemPromptOverride || null,
            } as any;
            break;
        }
        case 'conversation': {
            const profiles = (config as any).botConversation?.profiles;
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
            const profiles = (config as any).promptExpander?.profiles;
            if (!profiles) break;
            const newName = values.name || itemId;
            if (newName !== itemId) delete profiles[itemId];
            profiles[newName] = {
                ...(profiles[itemId] || profiles[newName] || {}),
                label: values.label || newName,
                systemPrompt: values.systemPrompt || null,
                resultTemplate: values.resultTemplate || null,
                temperature: values.temperature ? parseFloat(values.temperature) : null,
                modelConfig: values.modelConfig || null,
                toolsEnabled: values.toolsEnabled === 'true',
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
        case 'selfTalk': {
            const selfTalk = (config as any).botConversation?.selfTalk;
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
            config.templates[name] = { template: '${originalPrompt}', showInMenu: true };
            break;
        case 'reminder': {
            const templates: any[] = (config as any).reminderTemplates || [];
            templates.push({ id: name, name, prompt: '', isDefault: false });
            (config as any).reminderTemplates = templates;
            break;
        }
        case 'tomAiChat':
            if (!config.tomAiChat) config.tomAiChat = { templates: {} };
            if (!config.tomAiChat.templates) config.tomAiChat.templates = {};
            config.tomAiChat.templates[name] = { label: name, description: '', contextInstructions: '' } as any;
            break;
        case 'conversation': {
            if (!(config as any).botConversation) (config as any).botConversation = { profiles: {} };
            if (!(config as any).botConversation.profiles) (config as any).botConversation.profiles = {};
            (config as any).botConversation.profiles[name] = {
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
            if (!(config as any).promptExpander) (config as any).promptExpander = { profiles: {} };
            if (!(config as any).promptExpander.profiles) (config as any).promptExpander.profiles = {};
            (config as any).promptExpander.profiles[name] = {
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
            delete config.templates[itemId];
            break;
        case 'reminder': {
            const templates: any[] = (config as any).reminderTemplates || [];
            (config as any).reminderTemplates = templates.filter((t: any) => t.id !== itemId);
            break;
        }
        case 'tomAiChat':
            if (config.tomAiChat?.templates) delete config.tomAiChat.templates[itemId];
            break;
        case 'conversation':
            if ((config as any).botConversation?.profiles) delete (config as any).botConversation.profiles[itemId];
            break;
        case 'localLlm':
            if ((config as any).promptExpander?.profiles) delete (config as any).promptExpander.profiles[itemId];
            break;
        case 'timedRequests': {
            const requests: any[] = (config as any).timedRequests || [];
            (config as any).timedRequests = requests.filter((r: any) => r.id !== itemId);
            break;
        }
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
        if (f.type === 'checkbox') {
            return '<div class="field checkbox-field">' +
                '<input type="checkbox" id="field_' + f.name + '"' + (f.value === 'true' ? ' checked' : '') +
                (f.readonly ? ' disabled' : '') + '>' +
                '<label for="field_' + f.name + '">' + escapeText(f.label) + '</label></div>';
        }
        var ro = f.readonly ? ' readonly disabled' : '';
        var inputType = f.type === 'number' ? 'number' : 'text';
        var isTextarea = f.type === 'textarea';
        var growClass = isTextarea ? ' field-grow' : '';
        var helpBtn = f.help ? ' <button class="help-icon" type="button" data-help="' + escapeAttr(f.help) + '" title="Show help">?</button>' : '';
        var labelHtml = '<div class="label-row"><label for="field_' + f.name + '">' + escapeText(f.label) + '</label>' + helpBtn + '</div>';
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
}

function saveCurrentItem() {
    if (!currentCategory || !currentItemId || !currentFields.length) return;
    const values = {};
    currentFields.forEach(f => {
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
                currentCategory = msg.category;
                categorySelect.value = msg.category;
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
