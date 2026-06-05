/**
 * Queue Template Editor (§3.2e)
 *
 * A command-opened webview panel that shows queue.yaml templates.
 * Uses the same shared entry-editing component as the Prompt Queue Editor.
 *
 * Layout:
 *   - Left sidebar: list of templates (*.template.queue.yaml), + and trash buttons
 *   - Right panel: shared queue.yaml-editor for the selected template
 *   - Bottom: "Queue Prompt" button (copies template to queue) + "Save" button
 *
 * Opened via `tomAi.editor.queueTemplates` command.
 */

import * as vscode from 'vscode';
import {
  readAllTemplates,
  readTemplate,
  writeTemplate,
  writeEntry,
  deleteTemplate,
  QueueTemplateFile,
  QueueFileYaml,
  QueueMetaYaml,
  QueuePromptYaml,
  generateEntryFileName,
  entryIdFromFileName,
  generateId,
} from '../storage/queueFileStorage';
import { loadSendToChatConfig } from './handler_shared';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { ReminderSystem } from '../managers/reminderSystem';

// ============================================================================
// State
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _ctx: vscode.ExtensionContext | undefined;

// ============================================================================
// Registration
// ============================================================================

export function registerQueueTemplateEditorCommand(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('tomAi.editor.queueTemplates', () => openQueueTemplateEditor(ctx)),
  );
}

// ============================================================================
// Open / Reveal
// ============================================================================

function openQueueTemplateEditor(ctx: vscode.ExtensionContext): void {
  if (_panel) { _panel.reveal(); return; }
  _ctx = ctx;

  const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

  _panel = vscode.window.createWebviewPanel(
    'tomAi.queueTemplateEditor',
    'Queue Templates',
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

  _panel.webview.onDidReceiveMessage(handleMessage);

  // First-paint data flows through the loader's window.__INIT__ (state +
  // codicons URI). Live updates still arrive via postMessage (sendState).
  _panel.webview.html = loadWebviewHtml(_panel.webview, 'queueTemplateEditor', {
    init: {
      state: buildState(),
      codiconsUri: webviewCodiconsUri.toString(),
    },
  });

  sendState();

  _panel.onDidDispose(() => {
    _panel = undefined;
  });
}

// ============================================================================
// Message handling
// ============================================================================

async function handleMessage(msg: any): Promise<void> {
  switch (msg.type) {
    case 'getState':
      sendState();
      return;

    case 'loadTemplate':
      sendState(msg.templateId);
      return;

    case 'createTemplate': {
      // Use VS Code input box since browser prompt() doesn't work in webviews
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new queue template',
        placeHolder: 'e.g. code-review, bug-fix, feature-request',
        validateInput: (value) => {
          if (!value || !value.trim()) { return 'Template name is required'; }
          return null;
        },
      });
      if (!name) { return; }
      const templateId = generateId();
      const doc = buildEmptyDoc(name.trim());
      writeTemplate(templateId, doc);
      sendState(templateId);
      return;
    }

    case 'copyCurrentTemplate': {
      await copyCurrentTemplate(msg);
      return;
    }

    case 'renameCurrentTemplate': {
      await renameCurrentTemplate(msg);
      return;
    }

    case 'deleteCurrentTemplate': {
      const templateId = msg.templateId?.trim();
      if (!templateId) { return; }
      const ok = deleteTemplate(templateId);
      if (ok) { sendState(); }
      return;
    }

    case 'showTemplateFile': {
      const templateId = msg.templateId?.trim();
      if (!templateId) { return; }
      const template = readTemplate(templateId);
      if (!template?.filePath) {
        vscode.window.showWarningMessage(`Template file not found: ${templateId}`);
        return;
      }
      const uri = vscode.Uri.file(template.filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }

    case 'saveTemplate': {
      saveCurrentTemplate(msg);
      return;
    }

    case 'queuePrompt': {
      await queueFromTemplate(msg);
      return;
    }

    // Entry-level messages handled identically to queue editor
    case 'updateText':
      // In template mode, updates the template's main prompt text (the saved template, not the prompt-to-send)
      break;
    case 'updateItemTemplate':
    case 'updateItemReminder':
    case 'addEmptyFollowUp':
    case 'updateFollowUp':
    case 'removeFollowUp':
    case 'addPrePrompt':
    case 'updatePrePrompt':
    case 'removePrePrompt':
      // These all modify the current template's doc — forward to saveTemplate with full doc
      break;

    default:
      return;
  }
}

// ============================================================================
// Build state
// ============================================================================

function buildState(selectedId?: string): Record<string, unknown> {
  const templates = readAllTemplates();
  const ids = templates.map(t => t.templateId);

  let selected: string | undefined = selectedId;
  if (!selected && ids.length > 0) { selected = ids[0]; }

  let currentItem: Record<string, unknown> | undefined;
  if (selected) {
    const tpl = templates.find(t => t.templateId === selected);
    if (tpl) {
      currentItem = docToTemplateItem(tpl.templateId, tpl.data);
    }
  }

  let reminderTemplates: { id: string; name: string }[] = [];
  try {
    const rs = ReminderSystem.instance;
    reminderTemplates = rs.templates.map(t => ({ id: t.id, name: t.name }));
  } catch { /* not ready */ }

  let promptTemplates: string[] = [];
  try {
    const config = loadSendToChatConfig();
    const tpls = config?.copilot?.templates;
    if (tpls) {
      promptTemplates = Object.keys(tpls).filter(k => tpls[k].showInMenu !== false);
    }
  } catch { /* */ }

  // Build display info: { id, displayName }
  const templateEntries = templates.map(t => ({
    id: t.templateId,
    displayName: t.data.meta.name || t.templateId,
  }));

  return {
    type: 'state',
    templateEntries,
    templateNames: templateEntries.map(e => e.displayName),
    templateIds: ids,
    selectedId: selected || '',
    selectedName: selected ? (templateEntries.find(e => e.id === selected)?.displayName || selected) : '',
    currentItem,
    reminderTemplates,
    promptTemplates,
  };
}

function sendState(selectedId?: string): void {
  if (!_panel) { return; }
  const state = buildState(selectedId);
  _panel.webview.postMessage(state);
}

// ============================================================================
// Template helpers
// ============================================================================

function buildEmptyDoc(name?: string): QueueFileYaml {
  return {
    meta: {
      id: generateId(),
      name: name || 'Untitled',
      status: 'staged' as const,
    },
    'prompt-queue': [
      {
        id: 'P1',
        type: 'main',
        'prompt-text': '',
      } as QueuePromptYaml,
    ],
  };
}

/** Convert a QueueFileYaml doc into the item shape the webview expects. */
function docToTemplateItem(templateId: string, doc: QueueFileYaml): Record<string, unknown> {
  const mainPrompt = doc['prompt-queue']?.find(p => p.type === 'main');
  const prePrompts = (doc['prompt-queue'] || []).filter(p => p.type === 'preprompt');
  const followUps = (doc['prompt-queue'] || []).filter(p => p.type === 'followup');
  const meta = doc.meta || {};

  return {
    id: templateId,
    originalText: mainPrompt?.['prompt-text'] || '',
    template: mainPrompt?.template || '(None)',
    answerWrapper: mainPrompt?.['answer-wrapper'] || false,
    status: 'staged',
    type: 'normal',
    createdAt: (meta as any).created || new Date().toISOString(),
    reminderEnabled: mainPrompt?.reminder?.enabled || false,
    reminderTemplateId: mainPrompt?.reminder?.['template-id'] || '',
    reminderTimeoutMinutes: mainPrompt?.reminder?.['timeout-minutes'] || 60,
    reminderRepeat: mainPrompt?.reminder?.repeat || false,
    repeatCount: typeof mainPrompt?.['repeat-count'] === 'string' ? mainPrompt['repeat-count'] : Math.max(0, Math.round(Number(mainPrompt?.['repeat-count'] || 0))),
    repeatIndex: Math.max(0, Math.round(Number(mainPrompt?.['repeat-index'] || 0))),
    repeatPrefix: mainPrompt?.['repeat-prefix'] || '',
    repeatSuffix: mainPrompt?.['repeat-suffix'] || '',
    answerWaitMinutes: Math.max(0, Math.round(Number(mainPrompt?.['answer-wait-minutes'] || 0))),
    templateRepeatCount: typeof mainPrompt?.['template-repeat-count'] === 'string' ? mainPrompt['template-repeat-count'] : (mainPrompt?.['template-repeat-count'] ? Math.max(0, Math.round(Number(mainPrompt['template-repeat-count']))) : undefined),
    templateRepeatIndex: mainPrompt?.['template-repeat-index'] ? Math.max(0, Math.round(Number(mainPrompt['template-repeat-index']))) : undefined,
    prePrompts: prePrompts.map(pp => ({
      text: pp['prompt-text'] || '',
      template: pp.template || '',
      status: 'pending',
      repeatCount: pp['repeat-count'],
      answerWaitMinutes: pp['answer-wait-minutes'],
      reminderTemplateId: pp.reminder?.['template-id'],
      reminderTimeoutMinutes: pp.reminder?.['timeout-minutes'],
      reminderRepeat: pp.reminder?.repeat,
      reminderEnabled: pp.reminder?.enabled,
    })),
    followUps: followUps.map(fu => ({
      id: fu.id || generateId(),
      originalText: fu['prompt-text'] || '',
      template: fu.template || '',
      repeatCount: fu['repeat-count'],
      answerWaitMinutes: fu['answer-wait-minutes'],
      reminderEnabled: fu.reminder?.enabled || false,
      reminderTemplateId: fu.reminder?.['template-id'] || '',
      reminderTimeoutMinutes: fu.reminder?.['timeout-minutes'] || 60,
      reminderRepeat: fu.reminder?.repeat || false,
      createdAt: new Date().toISOString(),
    })),
    followUpIndex: 0,
  };
}

/** Rebuild a QueueFileYaml from webview state for saving. */
function templateItemToDoc(item: any, existingDoc?: QueueFileYaml): QueueFileYaml {
  const prompts: QueuePromptYaml[] = [];

  // Main prompt
  const main: QueuePromptYaml = {
    id: 'P1',
    type: 'main',
    'prompt-text': item.originalText || '',
    template: item.template && item.template !== '(None)' ? item.template : undefined,
    'answer-wrapper': item.answerWrapper || undefined,
    'repeat-count': item.repeatCount || 0,
    'repeat-index': Math.max(0, Math.round(Number(item.repeatIndex || 0))),
    'repeat-prefix': item.repeatPrefix || undefined,
    'repeat-suffix': item.repeatSuffix || undefined,
    'answer-wait-minutes': Math.max(0, Math.round(Number(item.answerWaitMinutes || 0))) || undefined,
    'template-repeat-count': item.templateRepeatCount || undefined,
    'template-repeat-index': item.templateRepeatIndex || undefined,
    reminder: item.reminderEnabled ? {
      enabled: true,
      'template-id': item.reminderTemplateId || undefined,
      'timeout-minutes': item.reminderTimeoutMinutes || 60,
      repeat: item.reminderRepeat || false,
    } : undefined,
    'pre-prompt-refs': [] as string[],
    'follow-up-refs': [] as string[],
  };

  // Pre-prompts
  const prePrompts = Array.isArray(item.prePrompts) ? item.prePrompts : [];
  prePrompts.forEach((pp: any, idx: number) => {
    const ppId = `pre-${idx + 1}`;
    const ppYaml: QueuePromptYaml = {
      id: ppId,
      type: 'preprompt',
      'prompt-text': pp.text || '',
      template: pp.template || undefined,
      'repeat-count': pp.repeatCount || undefined,
      'answer-wait-minutes': pp.answerWaitMinutes || undefined,
    };
    if (pp.reminderEnabled) {
      ppYaml.reminder = {
        enabled: true,
        'template-id': pp.reminderTemplateId || undefined,
        'timeout-minutes': pp.reminderTimeoutMinutes || 60,
        repeat: pp.reminderRepeat || false,
      };
    }
    prompts.push(ppYaml);
    main['pre-prompt-refs']!.push(ppId);
  });

  // Follow-ups
  const followUps = Array.isArray(item.followUps) ? item.followUps : [];
  followUps.forEach((fu: any, idx: number) => {
    const fuId = fu.id || `fu-${idx + 1}`;
    const fuYaml: QueuePromptYaml = {
      id: fuId,
      type: 'followup',
      'prompt-text': fu.originalText || '',
      template: fu.template || undefined,
      'repeat-count': fu.repeatCount || undefined,
      'answer-wait-minutes': fu.answerWaitMinutes || undefined,
    };
    if (fu.reminderEnabled) {
      fuYaml.reminder = {
        enabled: true,
        'template-id': fu.reminderTemplateId || undefined,
        'timeout-minutes': fu.reminderTimeoutMinutes || 60,
        repeat: fu.reminderRepeat || false,
      };
    }
    prompts.push(fuYaml);
    main['follow-up-refs']!.push(fuId);
  });

  // Clean empty ref arrays
  if (main['pre-prompt-refs']!.length === 0) { delete main['pre-prompt-refs']; }
  if (main['follow-up-refs']!.length === 0) { delete main['follow-up-refs']; }

  prompts.unshift(main);

  const meta: QueueMetaYaml = existingDoc?.meta
    ? { ...existingDoc.meta }
    : { id: generateId(), status: 'staged' as const };
  meta.updated = new Date().toISOString();

  return { meta, 'prompt-queue': prompts };
}

function saveCurrentTemplate(msg: any): void {
  const templateId = msg.templateId?.trim();
  if (!templateId) { return; }
  const item = msg.item;
  if (!item) { return; }

  // Read existing to preserve meta
  const templates = readAllTemplates();
  const existing = templates.find(t => t.templateId === templateId);
  const doc = templateItemToDoc(item, existing?.data);
  writeTemplate(templateId, doc);
  sendState(templateId);
}

async function copyCurrentTemplate(msg: any): Promise<void> {
  const templateId = msg.templateId?.trim();
  if (!templateId) { return; }

  const template = readTemplate(templateId);
  if (!template?.data) {
    vscode.window.showErrorMessage(`Template not found: ${templateId}`);
    return;
  }

  const currentName = String(template.data.meta?.name || templateId);
  const newName = await vscode.window.showInputBox({
    prompt: 'Enter a name for the copied queue template',
    value: `${currentName}-copy`,
    validateInput: (value) => {
      if (!value || !value.trim()) { return 'Template name is required'; }
      return null;
    },
  });
  if (!newName?.trim()) { return; }

  const clone: QueueFileYaml = JSON.parse(JSON.stringify(template.data));
  clone.meta = clone.meta || ({ id: generateId(), status: 'staged' as const } as QueueMetaYaml);
  clone.meta.id = generateId();
  clone.meta.name = newName.trim();
  clone.meta.status = 'staged';
  clone.meta.created = new Date().toISOString();
  clone.meta.updated = clone.meta.created;

  const newTemplateId = generateId();
  writeTemplate(newTemplateId, clone);
  sendState(newTemplateId);
}

async function renameCurrentTemplate(msg: any): Promise<void> {
  const templateId = msg.templateId?.trim();
  if (!templateId) { return; }

  const template = readTemplate(templateId);
  if (!template?.data) {
    vscode.window.showErrorMessage(`Template not found: ${templateId}`);
    return;
  }

  const currentName = String(template.data.meta?.name || templateId);
  const renamed = await vscode.window.showInputBox({
    prompt: 'Enter a new name for the queue template',
    value: currentName,
    validateInput: (value) => {
      if (!value || !value.trim()) { return 'Template name is required'; }
      return null;
    },
  });
  if (!renamed?.trim()) { return; }

  const nextName = renamed.trim();
  if (nextName === currentName) {
    return;
  }

  const doc: QueueFileYaml = JSON.parse(JSON.stringify(template.data));
  doc.meta = doc.meta || ({ id: generateId(), status: 'staged' as const } as QueueMetaYaml);
  doc.meta.name = nextName;
  doc.meta.updated = new Date().toISOString();
  writeTemplate(templateId, doc);
  sendState(templateId);
}

async function queueFromTemplate(msg: any): Promise<void> {
  const promptText = typeof msg.promptText === 'string' ? msg.promptText.trim() : '';
  const templateId = msg.templateId?.trim() || '';
  if (!templateId) { return; }

  try {
    const template = readTemplate(templateId);
    if (!template?.data) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Clone full template doc so custom/manual fields are preserved.
    const doc: QueueFileYaml = JSON.parse(JSON.stringify(template.data));
    const prompts = doc['prompt-queue'] || [];
    const mainId = doc.meta?.['main-prompt'] || 'P1';
    const main = prompts.find(p => p.id === mainId) || prompts.find(p => p.type === 'main') || prompts[0];

    if (!main) {
      throw new Error('Template has no main prompt');
    }

    // Optional prompt override: only replace template main prompt when non-empty input is provided.
    if (promptText) {
      main['prompt-text'] = promptText;
    }
    delete main['expanded-text'];
    if (main.execution) {
      delete main.execution;
    }

    // Stamp the queue-level transport + message template onto every
    // prompt in the batch at dispatch time — main prompts AND their
    // pre- and follow-up stages. The queue template editor no longer
    // stores per-item templates; they all inherit from the prompt
    // queue's current picker selection the moment the template is
    // queued. Gate / decision flow-control nodes are skipped (they
    // don't render as prompts). Reminders stay on the item (Copilot-
    // only; still edited in the queue-template editor).
    try {
      const queueModule = await import('../managers/promptQueueManager.js');
      const qm = queueModule.PromptQueueManager.instance;
      const queueTransport: 'copilot' | 'anthropic' = qm?.defaultTransport === 'anthropic' ? 'anthropic' : 'copilot';
      const queueTemplate = qm?.defaultMessageTemplateId || '';
      const queueProfile = qm?.defaultAnthropicProfileId || '';
      const STAMPED_TYPES = new Set(['main', 'preprompt', 'followup']);
      for (const p of prompts) {
        if (!p || !STAMPED_TYPES.has(p.type)) { continue; }
        p['template'] = queueTemplate;
        p['transport'] = queueTransport;
        if (queueTransport === 'anthropic') {
          p['anthropic-profile-id'] = queueProfile || undefined;
        } else {
          delete p['anthropic-profile-id'];
        }
      }
    } catch { /* queue manager not ready — leave template as stored */ }

    // Fresh queue entry identity/status while preserving additional metadata.
    doc.meta = doc.meta || ({ id: generateId() } as QueueMetaYaml);
    doc.meta.id = generateId();
    doc.meta.status = 'pending';
    doc.meta.created = new Date().toISOString();
    doc.meta.updated = doc.meta.created;
    doc.meta['main-prompt'] = main.id || mainId;

    const fileName = generateEntryFileName(undefined, 'prompt', new Date());
    writeEntry(entryIdFromFileName(fileName), doc, fileName);

    // Explicitly nudge Prompt Queue to refresh now (watcher also updates shortly after).
    try {
      const queueModule = await import('../managers/promptQueueManager.js');
      const qm = queueModule.PromptQueueManager.instance as any;
      if (typeof qm._reloadFromDisk === 'function') {
        qm._reloadFromDisk();
      }
      const queueItems = Array.isArray(qm.items) ? qm.items : [];
      if (
        qm.autoSendEnabled
        && typeof qm.sendNext === 'function'
        && !queueItems.some((i: any) => i.status === 'sending')
        && queueItems.some((i: any) => i.status === 'pending')
      ) {
        void qm.sendNext();
      }
    } catch {
      // Queue manager may not be initialized yet; file watcher will still pick up the new entry.
    }

    _panel?.webview.postMessage({ type: 'queueSuccess' });
  } catch (e: any) {
    _panel?.webview.postMessage({ type: 'queueError', error: e?.message || 'Failed to queue' });
  }
}
