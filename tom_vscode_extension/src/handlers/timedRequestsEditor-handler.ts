/**
 * Timed Requests Editor (§3.3)
 *
 * A command-opened webview panel for managing scheduled/repeating
 * request entries.  Each entry has a prompt, schedule config
 * (interval or specific times), reminder overrides, and status.
 *
 * Opened via `tomAi.editor.timedRequests` command.
 */

import * as vscode from 'vscode';
import { TimerEngine, TimedRequest, ScheduledTime } from '../managers/timerEngine';
import { applyTemplateWrapping } from '../managers/promptQueueManager';
import { ReminderSystem, REMINDER_PLACEHOLDER_HELP } from '../managers/reminderSystem';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadSendToChatConfig, saveSendToChatConfig } from './handler_shared';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';

// ============================================================================
// State
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _timerListener: vscode.Disposable | undefined;
let _ctx: vscode.ExtensionContext | undefined;
const TIMED_COLLAPSED_STATE_KEY = 'tomAi.timedEditor.collapsedEntryIds';
let _collapsedEntryIds = new Set<string>();

function loadCollapsedTimedState(ctx: vscode.ExtensionContext): void {
  const stored = ctx.workspaceState.get<string[]>(TIMED_COLLAPSED_STATE_KEY, []);
  _collapsedEntryIds = new Set((stored || []).filter(id => typeof id === 'string' && id));
}

async function persistCollapsedTimedState(): Promise<void> {
  if (!_ctx) { return; }
  await _ctx.workspaceState.update(TIMED_COLLAPSED_STATE_KEY, Array.from(_collapsedEntryIds));
}

// ============================================================================
// Registration
// ============================================================================

export function registerTimedRequestsEditorCommand(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.timedRequests', () => openEditor(ctx))
    );
}

// ============================================================================
// Open / Reveal
// ============================================================================

function openEditor(ctx: vscode.ExtensionContext): void {
    if (_panel) { _panel.reveal(); return; }
  _ctx = ctx;
  loadCollapsedTimedState(ctx);

    const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

    _panel = vscode.window.createWebviewPanel(
        'tomAi.timedRequestsEditor',
        'Timed Requests',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(ctx.extensionUri, 'media'),
                vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        },
    );

    const webviewCodiconsUri = _panel.webview.asWebviewUri(codiconsUri);

    // Register message handler BEFORE setting html so no messages are lost
    _panel.webview.onDidReceiveMessage(handleMessage);
    // Shared textarea completion (/skill + @file) for the prompt + repeat fields.
    wireCompletionMessages(_panel.webview);

    // Build initial state and pass it as first-paint data (window.__INIT__.state).
    const initialState = buildState();
    _panel.webview.html = loadWebviewHtml(_panel.webview, 'timedRequestsEditor', {
        init: { codiconsUri: webviewCodiconsUri.toString(), state: initialState },
    });

    // Also push state via message (belt & suspenders)
    sendState();
    setTimeout(() => sendState(), 500);

    try {
        const te = TimerEngine.instance;
        _timerListener = te.onDidChange(() => sendState());
    } catch (e) {
        console.error('[TimedRequestsEditor] Failed to bind onDidChange:', e);
    }

    _panel.onDidDispose(() => {
        _panel = undefined;
        _timerListener?.dispose();
        _timerListener = undefined;
    });
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
    // Handle non-timer messages first
    switch (msg.type) {
        case 'getState':
            sendState();
            return;
        case 'openContextSettings':
            await vscode.commands.executeCommand('tomAi.editor.contextSettings');
            return;
        case 'openChatVariablesEditor':
            await vscode.commands.executeCommand('tomAi.editor.chatVariables');
            return;
        case 'showFile': {
            const { openPanelFile } = await import('../utils/panelYamlStore.js');
            await openPanelFile('timed');
            return;
        }
        case 'setDetailsExpanded': {
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) { return; }
          const expanded = msg.expanded !== false;
          if (expanded) {
            _collapsedEntryIds.delete(id);
          } else {
            _collapsedEntryIds.add(id);
          }
          await persistCollapsedTimedState();
          return;
        }
        case 'setAllDetailsExpanded': {
          const ids = Array.isArray(msg.ids) ? msg.ids.filter((id: unknown) => typeof id === 'string' && !!id) as string[] : [];
          const expanded = msg.expanded !== false;
          if (expanded) {
            ids.forEach(id => _collapsedEntryIds.delete(id));
          } else {
            ids.forEach(id => _collapsedEntryIds.add(id));
          }
          await persistCollapsedTimedState();
          return;
        }
        case 'previewEntry': {
            const { showPreviewPanel } = await import('./handler_shared.js');
            const { expandTemplate } = await import('./promptTemplate.js');
            let previewContent = msg.text || '';
            const template = msg.template || '';
            const answerWrapper = msg.answerWrapper || false;

            // Use the exact same expansion logic as real prompt processing
            previewContent = await expandTemplate(previewContent);
            previewContent = await applyTemplateWrapping(previewContent, template, answerWrapper);
            
            await showPreviewPanel('Timed Request Preview', previewContent);
            return;
        }
          case 'addReminderTemplate':
            await addReminderTemplate();
            sendState();
            return;
          case 'editReminderTemplate':
            await editReminderTemplate(msg.id);
            sendState();
            return;
          case 'deleteReminderTemplate':
            await deleteReminderTemplate(msg.id);
            sendState();
            return;
          case 'addPromptTemplate':
            await addPromptTemplate();
            sendState();
            return;
          case 'editPromptTemplate':
            await editPromptTemplate(msg.name);
            sendState();
            return;
          case 'deletePromptTemplate':
            await deletePromptTemplate(msg.name);
            sendState();
            return;
    }

    // Timer-dependent messages
    let te: TimerEngine;
    try { te = TimerEngine.instance; } catch {
        vscode.window.showWarningMessage('Timer engine not available');
        return;
    }

    switch (msg.type) {
        case 'addEntry':
            try {
                console.log('[TimedRequestsEditor] addEntry received, text length:', msg.text?.length);
                te.addEntry({
                    enabled: true,
                    template: msg.template || '(None)',
                    answerWrapper: msg.answerWrapper || false,
                    originalText: msg.text || '',
                    scheduleMode: msg.scheduleMode || 'interval',
                    intervalMinutes: msg.intervalMinutes ?? 30,
                    intervalWeekdays: Array.isArray(msg.intervalWeekdays)
                        ? msg.intervalWeekdays.filter((d: unknown) => typeof d === 'number' && d >= 0 && d <= 6)
                        : [],
                    sendMaximum: Number.isFinite(msg.sendMaximum) ? Math.max(0, Math.round(msg.sendMaximum)) : 0,
                    answerWaitMinutes: Number.isFinite(msg.answerWaitMinutes) ? Math.max(0, Math.round(msg.answerWaitMinutes)) : 0,
                    scheduledTimes: msg.scheduledTimes ?? [],
                  reminderEnabled: !!msg.reminderEnabled,
                    reminderTemplateId: msg.reminderTemplateId,
                    reminderTimeoutMinutes: msg.reminderTimeoutMinutes,
                    repeatCount: Number.isFinite(msg.repeatCount) ? Math.max(1, Math.round(msg.repeatCount)) : 1,
                    repeatPrefix: typeof msg.repeatPrefix === 'string' ? msg.repeatPrefix : '',
                    repeatSuffix: typeof msg.repeatSuffix === 'string' ? msg.repeatSuffix : '',
                });
                console.log('[TimedRequestsEditor] addEntry created successfully');
                _panel?.webview.postMessage({ type: 'addSuccess' });
                sendState(); // Explicit state push after add
            } catch (e: any) {
                console.error('[TimedRequestsEditor] addEntry error:', e);
                _panel?.webview.postMessage({ type: 'addError', error: e?.message || 'Failed to add entry' });
            }
            break;
        case 'updateEntry':
            te.updateEntry(msg.id, msg.patch);
            break;
        case 'removeEntry':
            te.removeEntry(msg.id);
            break;
        case 'confirmRemoveEntry': {
            const id = typeof msg.id === 'string' ? msg.id : '';
            if (!id) { break; }
            const rawSnippet = typeof msg.snippet === 'string' ? msg.snippet : '';
            const snippet = rawSnippet.length > 0 ? `"${rawSnippet}..."` : id;
            const answer = await vscode.window.showWarningMessage(
                `Delete timed request?\n\n${snippet}`,
                { modal: true },
                'Delete',
            );
            if (answer === 'Delete') {
                te.removeEntry(id);
            }
            break;
        }
        case 'toggleTimer':
            te.timerActivated = !te.timerActivated;
            sendState();
            break;
        case 'enableAll':
            te.enableAll();
            break;
        case 'disableAll':
            te.disableAll();
            break;
    }
}

const REMINDER_TEMPLATE_HELP = REMINDER_PLACEHOLDER_HELP;

async function addReminderTemplate(): Promise<void> {
  if (_ctx) {
    openGlobalTemplateEditor(_ctx, { category: 'reminder' });
  }
}

async function editReminderTemplate(id?: string): Promise<void> {
  if (!_ctx) return;
  if (id) {
    openGlobalTemplateEditor(_ctx, { category: 'reminder', itemId: id });
  } else {
    openGlobalTemplateEditor(_ctx, { category: 'reminder' });
  }
}

async function deleteReminderTemplate(id?: string): Promise<void> {
  const templates = ReminderSystem.instance.templates;
  if (templates.length === 0) {
    vscode.window.showWarningMessage('No reminder templates available.');
    return;
  }

  let template = id ? templates.find(t => t.id === id) : undefined;
  if (!template) {
    const picked = await vscode.window.showQuickPick(
      templates.map(t => ({ label: t.name, description: t.id, id: t.id })),
      { placeHolder: 'Select reminder template to delete' },
    );
    if (!picked?.id) {
      return;
    }
    template = templates.find(t => t.id === picked.id);
  }
  if (!template) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Delete reminder template "${template.name}"?`,
    { modal: true },
    'Delete',
  );
  if (answer !== 'Delete') {
    return;
  }
  ReminderSystem.instance.removeTemplate(template.id);
}

async function addPromptTemplate(): Promise<void> {
  if (_ctx) {
    openGlobalTemplateEditor(_ctx, { category: 'copilot' });
  }
}

async function editPromptTemplate(currentName?: string): Promise<void> {
  if (!_ctx) return;
  if (currentName) {
    openGlobalTemplateEditor(_ctx, { category: 'copilot', itemId: currentName });
  } else {
    openGlobalTemplateEditor(_ctx, { category: 'copilot' });
  }
}

async function deletePromptTemplate(currentName?: string): Promise<void> {
  const config = loadSendToChatConfig();
  if (!config) {
    vscode.window.showWarningMessage('Send-to-chat config is not available.');
    return;
  }
  const templateNames = Object.keys(config.copilot?.templates || {});
  if (templateNames.length === 0) {
    vscode.window.showWarningMessage('No prompt templates available.');
    return;
  }

  const templates = config.copilot?.templates;
  let name = currentName;
  if (!name || !templates?.[name]) {
    const picked = await vscode.window.showQuickPick(templateNames, { placeHolder: 'Select template to delete' });
    if (!picked) {
      return;
    }
    name = picked;
  }

  if (!name) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Delete prompt template "${name}"?`,
    { modal: true },
    'Delete',
  );
  if (answer !== 'Delete') {
    return;
  }

  delete templates?.[name];
  saveSendToChatConfig(config);
}

// ============================================================================
// State builder & push
// ============================================================================

function buildState(): Record<string, unknown> {
    let entries: readonly TimedRequest[] = [];
    let reminderTemplates: { id: string; name: string }[] = [];
    let timerActivated = true;

    try {
        const te = TimerEngine.instance;
        entries = te.entries;
        timerActivated = te.timerActivated;
        console.log('[TimedRequestsEditor] buildState: entries count =', entries.length);
    } catch (e) {
        console.error('[TimedRequestsEditor] buildState: TimerEngine not ready:', e);
    }
    try {
        reminderTemplates = ReminderSystem.instance.templates.map(t => ({ id: t.id, name: t.name }));
    } catch { /* */ }

    let quest = '';
    let role = '';
    let activeProjects: string[] = [];
    try {
        const store = ChatVariablesStore.instance;
        quest = store.quest || '';
        role = store.role || '';
        activeProjects = store.activeProjects || [];
    } catch { /* */ }

    let promptTemplates: string[] = [];
    try {
        const config = loadSendToChatConfig();
      const templates = config?.copilot?.templates;
      if (templates) {
        promptTemplates = Object.keys(templates).filter(k => templates[k].showInMenu !== false);
        }
    } catch { /* */ }

    return {
        type: 'state',
        entries: [...entries],  // spread to plain array for serialisation
        timerActivated,
        reminderTemplates,
        promptTemplates,
      collapsedIds: Array.from(_collapsedEntryIds),
        context: { quest, role, activeProjects },
    };
}

function sendState(): void {
    if (!_panel) { return; }
    const state = buildState();
    console.log('[TimedRequestsEditor] sendState posting to webview, entries:', (state.entries as unknown[]).length);
    _panel.webview.postMessage(state).then(
        ok => console.log('[TimedRequestsEditor] postMessage result:', ok),
        err => console.error('[TimedRequestsEditor] postMessage failed:', err),
    );
}
