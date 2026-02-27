/**
 * T3 Panel Handler – Accordion panel containing TASKS, LOGS, SETTINGS, ISSUES,
 * TESTS and QUEST TODO.
 *
 * A single VS Code webview panel ("TOM") using the reusable accordion component.
 * The ISSUES and TESTS sections embed the issues panel fragments from
 * issuesPanel-handler; the QUEST TODO section embeds from questTodoPanel-handler.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AccordionSection, getAccordionHtml } from './accordionPanel.js';
import {
    getIssuesHtmlFragment,
    getIssuesCss,
    getIssuesScript,
    handleIssuesPanelMessage,
    initIssueProviders,
} from './issuesPanel-handler.js';
import {
    getQuestTodoHtmlFragment,
    getQuestTodoCss,
    getQuestTodoScript,
    handleQuestTodoMessage,
    setupQuestTodoWatcher,
    sendQuestTodoRefresh,
    setQuestTodoContext,
} from './questTodoPanel-handler.js';
import {
    gatherStatusData,
    getEmbeddedStatusHtml,
    getEmbeddedStatusStyles,
    getStatusPanelListenersScript,
    handleStatusAction,
} from './statusPage-handler.js';
import { WsPaths } from '../utils/workspacePaths.js';
import { scanWorkspaceProjectsByDetectors } from '../utils/projectDetector.js';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview.js';
import { openInExternalApplication } from './handler_shared.js';

const VIEW_ID = 'tomAi.wsPanel';

export class T3PanelHandler implements vscode.WebviewViewProvider {
    public static readonly viewType = VIEW_ID;
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _extensionContext: vscode.ExtensionContext;

    /** Whether the T3 webview view has been resolved and is available. */
    get isViewAvailable(): boolean {
        return !!this._view;
    }

    /**
     * Select a todo by ID in the embedded Quest TODO accordion section.
     * Expands the Quest TODO accordion, posts qtPendingSelect.
     * The webview handles its own refresh to consume the pending selection.
     */
    selectTodo(todoId: string, file?: string, questId?: string): void {
        if (!this._view) return;
        const wb = this._view.webview;
        // Expand the questTodo accordion section
        wb.postMessage({ type: 'expandSection', sectionId: 'questTodo' });
        // Send the pending selection after a brief delay
        // so the accordion has time to expand and render the content
        setTimeout(() => {
            wb.postMessage({
                type: 'qtPendingSelect',
                state: { todoId, file: file || '', questId: questId || '' },
            });
        }, 150);
    }

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._extensionContext = context;
        setQuestTodoContext(context);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                await this._handleMessage(message, webviewView.webview);
            },
            undefined,
            this._extensionContext.subscriptions,
        );
    }

    // ------------------------------------------------------------------
    // Message routing
    // ------------------------------------------------------------------

    private async _handleMessage(message: any, webview: vscode.Webview): Promise<void> {
        // Quest TODO messages (prefixed with 'qt')
        if (typeof message.type === 'string' && message.type.startsWith('qt')) {
            await handleQuestTodoMessage(message, webview);
            return;
        }

        switch (message.type) {
            case 'statusAction':
                await handleStatusAction(message.action, message);
                setTimeout(() => this._sendStatusData(), 500);
                return;
            case 'getStatusData':
                await this._sendStatusData();
                return;
            case 'getGuidelinesGroups':
                this._sendGuidelinesGroups();
                return;
            case 'getGuidelinesFiles':
                this._sendGuidelinesFiles(message.group);
                return;
            case 'loadGuidelinesFile':
                this._loadGuidelinesFile(message.file, message.group);
                return;
            case 'saveGuidelinesFile':
                this._saveGuidelinesFile(message.file, message.content, message.group);
                return;
            case 'addGuidelinesFile':
                await this._addGuidelinesFile(message.group);
                return;
            case 'deleteGuidelinesFile':
                await this._deleteGuidelinesFile(message.file, message.group);
                return;
            case 'openGuidelinesInEditor':
                await this._openGuidelinesInEditor(message.file, message.group);
                return;
            case 'previewGuidelinesFile':
                await this._previewFile(message.file, message.group, 'guidelines');
                return;
            case 'openGuidelinesExternal':
                await this._openFileExternal(message.file, message.group, 'guidelines');
                return;
            case 'getDocsGroups':
                this._sendDocsGroups();
                return;
            case 'getDocsFiles':
                this._sendDocsFiles(message.group);
                return;
            case 'loadDocsFile':
                this._loadDocsFile(message.file, message.group);
                return;
            case 'saveDocsFile':
                this._saveDocsFile(message.file, message.content, message.group);
                return;
            case 'addDocsFile':
                await this._addDocsFile(message.group);
                return;
            case 'deleteDocsFile':
                await this._deleteDocsFile(message.file, message.group);
                return;
            case 'openDocsInEditor':
                await this._openDocsInEditor(message.file, message.group);
                return;
            case 'previewDocsFile':
                await this._previewFile(message.file, message.group, 'docs');
                return;
            case 'openDocsExternal':
                await this._openFileExternal(message.file, message.group, 'docs');
                return;
            case 'showWarning':
                vscode.window.showWarningMessage(message.text || 'Warning');
                return;
        }

        if (message.type === 'action') {
            // T3 simple-section actions (tasks / logs)
            switch (message.action) {
                case 'refreshLogs':
                    vscode.window.showInformationMessage('T3: Refresh Logs clicked');
                    break;
                case 'exportLogs':
                    vscode.window.showInformationMessage('T3: Export Logs clicked');
                    break;
                case 'openWorkspaceTodoExplorer':
                    await vscode.commands.executeCommand('tomAi.workspaceTodosView.focus');
                    break;
                case 'openGuidelinesFolder': {
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (!wsRoot) {
                        break;
                    }
                    const guidelinesDir = WsPaths.guidelines() || path.join(wsRoot, '_copilot_guidelines');
                    if (fs.existsSync(guidelinesDir)) {
                        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(guidelinesDir), { forceNewWindow: false });
                    } else {
                        vscode.window.showWarningMessage('Guidelines folder not found.');
                    }
                    break;
                }
                case 'openNotesFolder': {
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (!wsRoot) {
                        break;
                    }
                    const notesDir = WsPaths.ai('notes') || path.join(wsRoot, '_ai', 'notes');
                    if (!fs.existsSync(notesDir)) {
                        fs.mkdirSync(notesDir, { recursive: true });
                    }
                    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(notesDir));
                    break;
                }
            }
        } else if (message.panelMode) {
            // Delegate to the issues panel handler
            await handleIssuesPanelMessage(message, webview);
        }
    }

    // ------------------------------------------------------------------
    // HTML via accordion component
    // ------------------------------------------------------------------

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
        );

        const sections: AccordionSection[] = [
            {
                id: 'guidelines',
                title: 'Guidelines',
                icon: 'book',
                content: `
<div class="toolbar">
    <label for="guidelines-group">Type:</label>
    <select id="guidelines-group" title="Group"></select>
    <label id="guidelines-project-label" for="guidelines-project" style="display:none;">Project:</label>
    <select id="guidelines-project" title="Project" style="display:none;"></select>
    <label for="guidelines-file">File:</label>
    <select id="guidelines-file" title="File"></select>
    <button class="icon-btn" onclick="reloadGuidelines()" title="Reload"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" onclick="addGuidelinesFile()" title="Add"><span class="codicon codicon-add"></span></button>
    <button class="icon-btn" onclick="deleteGuidelinesFile()" title="Delete"><span class="codicon codicon-trash"></span></button>
    <button class="icon-btn" onclick="openGuidelinesInEditor()" title="Open in editor"><span class="codicon codicon-go-to-file"></span></button>
    <button class="icon-btn" onclick="previewGuidelines()" title="Preview in overlay"><span class="codicon codicon-open-preview"></span></button>
    <button class="icon-btn" onclick="openGuidelinesExternal()" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>
</div>
<textarea id="guidelines-text" placeholder="Guidelines..." spellcheck="false"></textarea>
<div class="status-bar">Workspace/project guidelines editor</div>`,
            },
            {
                id: 'documentation',
                title: 'Documentation',
                icon: 'note',
                content: `
<div class="toolbar">
    <label for="docs-group">Group:</label>
    <select id="docs-group" title="Group"></select>
    <label id="docs-project-label" for="docs-project" style="display:none;">Project:</label>
    <select id="docs-project" title="Project" style="display:none;"></select>
    <label for="docs-file">File:</label>
    <select id="docs-file" title="File"></select>
    <button class="icon-btn" onclick="reloadDocs()" title="Reload"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" onclick="addDocsFile()" title="Add"><span class="codicon codicon-add"></span></button>
    <button class="icon-btn" onclick="deleteDocsFile()" title="Delete"><span class="codicon codicon-trash"></span></button>
    <button class="icon-btn" onclick="openDocsInEditor()" title="Open in editor"><span class="codicon codicon-go-to-file"></span></button>
    <button class="icon-btn" onclick="previewDocs()" title="Preview in overlay"><span class="codicon codicon-open-preview"></span></button>
    <button class="icon-btn" onclick="openDocsExternal()" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>
</div>
<textarea id="docs-text" placeholder="Documentation..." spellcheck="false"></textarea>
<div class="status-bar">Documentation viewer</div>`,
            },
            {
                id: 'logs',
                title: 'Logs',
                icon: 'output',
                content: `
<div class="toolbar">
    <button class="icon-btn" data-action="refreshLogs" title="Refresh"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" data-action="exportLogs" title="Export Logs"><span class="codicon codicon-go-to-file"></span></button>
</div>
<textarea readonly placeholder="Log output will appear here..."></textarea>
<div class="status-bar">Logs panel ready</div>`,
            },
            {
                id: 'settings',
                title: 'Settings',
                icon: 'settings-gear',
                content: '<div id="settings-status-panel" class="settings-panel"><div class="sp-loading">Loading status...</div></div>',
            },
            {
                id: 'issues',
                title: 'Issues',
                icon: 'issues',
                content: getIssuesHtmlFragment('issues'),
            },
            {
                id: 'tests',
                title: 'Tests',
                icon: 'beaker',
                content: getIssuesHtmlFragment('tests'),
            },
            {
                id: 'questTodo',
                title: 'Quest TODO',
                icon: 'tasklist',
                content: getQuestTodoHtmlFragment(),
            },
        ];

        // Issues panels and Quest TODO need their own CSS and client-side scripts
        const additionalCss = `${getIssuesCss()}\n${getQuestTodoCss()}\n
#guidelines textarea, #documentation textarea { min-height: 220px; width: 100%; resize: vertical; }
#guidelines .toolbar, #documentation .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
#guidelines select, #documentation select { max-width: 220px; min-width: 120px; }
.settings-panel { display: flex; flex-direction: column; height: 100%; min-height: 200px; }
.sp-loading { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); }
${getEmbeddedStatusStyles()}
`;
        const additionalScript = `
${getIssuesScript('issues', 'issues')}
${getIssuesScript('tests', 'tests')}
${getQuestTodoScript()}

var guidelinesFiles = [];
var guidelinesSelectedFile = '';
var guidelinesSelectedGroup = 'global';
var guidelinesGroups = [];
var guidelinesProjects = [];
var guidelinesSelectedProject = '';
var guidelinesContent = '';
var guidelinesSaveTimer = null;

function effectiveGuidelinesGroup() {
    return guidelinesSelectedGroup === 'project' ? guidelinesSelectedProject : guidelinesSelectedGroup;
}

function selectGuidelinesGroup(group) {
    guidelinesSelectedGroup = (group === 'projects' ? 'project' : (group || 'global'));
    guidelinesSelectedProject = '';
    guidelinesSelectedFile = '';
    guidelinesContent = '';
    updateGuidelinesUI();
    if (guidelinesSelectedGroup !== 'project') {
        vscode.postMessage({ type: 'getGuidelinesFiles', group: guidelinesSelectedGroup });
    }
}

function selectGuidelinesProject(projectGroup) {
    guidelinesSelectedProject = projectGroup || '';
    guidelinesSelectedFile = '';
    guidelinesContent = '';
    updateGuidelinesUI();
    if (guidelinesSelectedProject) {
        vscode.postMessage({ type: 'getGuidelinesFiles', group: guidelinesSelectedProject });
    }
}

function selectGuidelinesFile(file) {
    guidelinesSelectedFile = file || '';
    if (guidelinesSelectedFile) {
        vscode.postMessage({ type: 'loadGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
    } else {
        guidelinesContent = '';
        updateGuidelinesUI();
    }
}

function reloadGuidelines() {
    vscode.postMessage({ type: 'getGuidelinesGroups' });
    if (effectiveGuidelinesGroup()) {
        vscode.postMessage({ type: 'getGuidelinesFiles', group: effectiveGuidelinesGroup() });
    }
}

function addGuidelinesFile() {
    vscode.postMessage({ type: 'addGuidelinesFile', group: effectiveGuidelinesGroup() });
}

function deleteGuidelinesFile() {
    if (!guidelinesSelectedFile) return;
    vscode.postMessage({ type: 'deleteGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function openGuidelinesInEditor() {
    if (!guidelinesSelectedFile) return;
    vscode.postMessage({ type: 'openGuidelinesInEditor', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function previewGuidelines() {
    if (!guidelinesSelectedFile) return;
    vscode.postMessage({ type: 'previewGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function openGuidelinesExternal() {
    if (!guidelinesSelectedFile) { vscode.postMessage({ type: 'showWarning', text: 'No file selected' }); return; }
    vscode.postMessage({ type: 'openGuidelinesExternal', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
}

function updateGuidelinesUI() {
    var groupSel = document.getElementById('guidelines-group');
    if (groupSel) {
        groupSel.innerHTML = (guidelinesGroups || []).map(function(g) {
            return '<option value="' + g.id + '"' + (g.id === guidelinesSelectedGroup ? ' selected' : '') + '>' + g.label + '</option>';
        }).join('');
    }

    var projectSel = document.getElementById('guidelines-project');
    var projectLabel = document.getElementById('guidelines-project-label');
    if (projectSel) {
        if (guidelinesSelectedGroup === 'project' && (guidelinesProjects || []).length > 0) {
            if (projectLabel) projectLabel.style.display = '';
            projectSel.style.display = '';
            projectSel.innerHTML = '<option value="">(Select project)</option>' + (guidelinesProjects || []).map(function(p) {
                return '<option value="' + p.id + '"' + (p.id === guidelinesSelectedProject ? ' selected' : '') + '>' + p.label + '</option>';
            }).join('');
        } else {
            if (projectLabel) projectLabel.style.display = 'none';
            projectSel.style.display = 'none';
            projectSel.innerHTML = '';
        }
    }

    var fileSel = document.getElementById('guidelines-file');
    if (fileSel) {
        fileSel.innerHTML = '<option value="">(Select file)</option>' + (guidelinesFiles || []).map(function(f) {
            return '<option value="' + f + '"' + (f === guidelinesSelectedFile ? ' selected' : '') + '>' + f + '</option>';
        }).join('');
    }

    var ta = document.getElementById('guidelines-text');
    if (ta) {
        ta.value = guidelinesContent || '';
    }
}

function onGuidelinesInput() {
    var ta = document.getElementById('guidelines-text');
    if (!ta || !guidelinesSelectedFile) return;
    guidelinesContent = ta.value;
    if (guidelinesSaveTimer) clearTimeout(guidelinesSaveTimer);
    guidelinesSaveTimer = setTimeout(function() {
        vscode.postMessage({ type: 'saveGuidelinesFile', file: guidelinesSelectedFile, content: guidelinesContent, group: effectiveGuidelinesGroup() });
    }, 500);
}

// ---- Documentation panel state ----
var docsFiles = [];
var docsSelectedFile = '';
var docsSelectedGroup = 'notes';
var docsGroups = [];
var docsProjects = [];
var docsSelectedProject = '';
var docsContent = '';
var docsSaveTimer = null;

function effectiveDocsGroup() {
    return docsSelectedGroup === 'project' ? docsSelectedProject : docsSelectedGroup;
}

function selectDocsGroup(group) {
    docsSelectedGroup = (group === 'projects' ? 'project' : (group || 'notes'));
    docsSelectedProject = '';
    docsSelectedFile = '';
    docsContent = '';
    updateDocsUI();
    if (docsSelectedGroup !== 'project') {
        vscode.postMessage({ type: 'getDocsFiles', group: docsSelectedGroup });
    }
}

function selectDocsProject(projectGroup) {
    docsSelectedProject = projectGroup || '';
    docsSelectedFile = '';
    docsContent = '';
    updateDocsUI();
    if (docsSelectedProject) {
        vscode.postMessage({ type: 'getDocsFiles', group: docsSelectedProject });
    }
}

function selectDocsFile(file) {
    docsSelectedFile = file || '';
    if (docsSelectedFile) {
        vscode.postMessage({ type: 'loadDocsFile', file: docsSelectedFile, group: effectiveDocsGroup() });
    } else {
        docsContent = '';
        updateDocsUI();
    }
}

function reloadDocs() {
    vscode.postMessage({ type: 'getDocsGroups' });
    if (effectiveDocsGroup()) {
        vscode.postMessage({ type: 'getDocsFiles', group: effectiveDocsGroup() });
    }
}

function addDocsFile() {
    vscode.postMessage({ type: 'addDocsFile', group: effectiveDocsGroup() });
}

function deleteDocsFile() {
    if (!docsSelectedFile) return;
    vscode.postMessage({ type: 'deleteDocsFile', file: docsSelectedFile, group: effectiveDocsGroup() });
}

function openDocsInEditor() {
    if (!docsSelectedFile) return;
    vscode.postMessage({ type: 'openDocsInEditor', file: docsSelectedFile, group: effectiveDocsGroup() });
}

function previewDocs() {
    if (!docsSelectedFile) return;
    vscode.postMessage({ type: 'previewDocsFile', file: docsSelectedFile, group: effectiveDocsGroup() });
}

function openDocsExternal() {
    if (!docsSelectedFile) { vscode.postMessage({ type: 'showWarning', text: 'No file selected' }); return; }
    vscode.postMessage({ type: 'openDocsExternal', file: docsSelectedFile, group: effectiveDocsGroup() });
}

function updateDocsUI() {
    var groupSel = document.getElementById('docs-group');
    if (groupSel) {
        groupSel.innerHTML = (docsGroups || []).map(function(g) {
            return '<option value="' + g.id + '"' + (g.id === docsSelectedGroup ? ' selected' : '') + '>' + g.label + '</option>';
        }).join('');
    }

    var projectSel = document.getElementById('docs-project');
    var projectLabel = document.getElementById('docs-project-label');
    if (projectSel) {
        if (docsSelectedGroup === 'project' && (docsProjects || []).length > 0) {
            if (projectLabel) projectLabel.style.display = '';
            projectSel.style.display = '';
            projectSel.innerHTML = '<option value="">(Select project)</option>' + (docsProjects || []).map(function(p) {
                return '<option value="' + p.id + '"' + (p.id === docsSelectedProject ? ' selected' : '') + '>' + p.label + '</option>';
            }).join('');
        } else {
            if (projectLabel) projectLabel.style.display = 'none';
            projectSel.style.display = 'none';
            projectSel.innerHTML = '';
        }
    }

    var fileSel = document.getElementById('docs-file');
    if (fileSel) {
        fileSel.innerHTML = '<option value="">(Select file)</option>' + (docsFiles || []).map(function(f) {
            return '<option value="' + f + '"' + (f === docsSelectedFile ? ' selected' : '') + '>' + f + '</option>';
        }).join('');
    }

    var ta = document.getElementById('docs-text');
    if (ta) {
        ta.value = docsContent || '';
    }
}

function onDocsInput() {
    var ta = document.getElementById('docs-text');
    if (!ta || !docsSelectedFile) return;
    docsContent = ta.value;
    if (docsSaveTimer) clearTimeout(docsSaveTimer);
    docsSaveTimer = setTimeout(function() {
        vscode.postMessage({ type: 'saveDocsFile', file: docsSelectedFile, content: docsContent, group: effectiveDocsGroup() });
    }, 500);
}

window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'guidelinesGroups') {
        guidelinesGroups = msg.groups || [];
        guidelinesProjects = msg.projects || [];
        updateGuidelinesUI();
    } else if (msg.type === 'guidelinesFiles') {
        guidelinesFiles = msg.files || [];
        if (msg.selectedFile) guidelinesSelectedFile = msg.selectedFile;
        else if (guidelinesFiles.length > 0 && !guidelinesSelectedFile) guidelinesSelectedFile = guidelinesFiles[0];
        updateGuidelinesUI();
        if (guidelinesSelectedFile) {
            vscode.postMessage({ type: 'loadGuidelinesFile', file: guidelinesSelectedFile, group: effectiveGuidelinesGroup() });
        }
    } else if (msg.type === 'guidelinesContent') {
        guidelinesContent = msg.content || '';
        updateGuidelinesUI();
    } else if (msg.type === 'docsGroups') {
        docsGroups = msg.groups || [];
        docsProjects = msg.projects || [];
        updateDocsUI();
    } else if (msg.type === 'docsFiles') {
        docsFiles = msg.files || [];
        if (msg.selectedFile) docsSelectedFile = msg.selectedFile;
        else if (docsFiles.length > 0 && !docsSelectedFile) docsSelectedFile = docsFiles[0];
        updateDocsUI();
        if (docsSelectedFile) {
            vscode.postMessage({ type: 'loadDocsFile', file: docsSelectedFile, group: effectiveDocsGroup() });
        }
    } else if (msg.type === 'docsContent') {
        docsContent = msg.content || '';
        updateDocsUI();
    }
});

// Called by accordion after each render (initial and toggle).
// Re-applies UI state so freshly-expanded sections show current data.
// Guards needed: during initial render() var assignments haven't executed yet
// (function declarations are hoisted but var assignments are not).
function onRenderComplete() {
    if (guidelinesGroups) updateGuidelinesUI();
    if (docsGroups) updateDocsUI();
}

setTimeout(function() {
    var groupSel = document.getElementById('guidelines-group');
    if (groupSel) groupSel.addEventListener('change', function() { selectGuidelinesGroup(groupSel.value); });
    var projectSel = document.getElementById('guidelines-project');
    if (projectSel) projectSel.addEventListener('change', function() { selectGuidelinesProject(projectSel.value); });
    var guidelinesFileSel = document.getElementById('guidelines-file');
    if (guidelinesFileSel) guidelinesFileSel.addEventListener('change', function() { selectGuidelinesFile(guidelinesFileSel.value); });
    var guidelinesText = document.getElementById('guidelines-text');
    if (guidelinesText) guidelinesText.addEventListener('input', onGuidelinesInput);

    var docsGroupSel = document.getElementById('docs-group');
    if (docsGroupSel) docsGroupSel.addEventListener('change', function() { selectDocsGroup(docsGroupSel.value); });
    var docsProjectSel = document.getElementById('docs-project');
    if (docsProjectSel) docsProjectSel.addEventListener('change', function() { selectDocsProject(docsProjectSel.value); });
    var docsFileSel = document.getElementById('docs-file');
    if (docsFileSel) docsFileSel.addEventListener('change', function() { selectDocsFile(docsFileSel.value); });
    var docsText = document.getElementById('docs-text');
    if (docsText) docsText.addEventListener('input', onDocsInput);

    vscode.postMessage({ type: 'getGuidelinesGroups' });
    vscode.postMessage({ type: 'getGuidelinesFiles', group: 'global' });
    vscode.postMessage({ type: 'getDocsGroups' });
    vscode.postMessage({ type: 'getDocsFiles', group: 'notes' });
    vscode.postMessage({ type: 'getStatusData' });
}, 0);

// Status panel listeners
${getStatusPanelListenersScript()}

// Route Quest TODO messages from extension to qtHandleMessage
// Route statusData messages to populate the settings panel
window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'expandSection') {
        // Programmatically expand an accordion section by ID
        var sid = msg.sectionId || '';
        if (sid && typeof isExpanded === 'function' && !isExpanded(sid)) {
            toggleSection(sid);
        }
        return;
    }
    if (typeof msg.type === 'string' && msg.type.startsWith('qt')) {
        qtHandleMessage(msg);
    } else if (msg.type === 'statusData') {
        var panel = document.getElementById('settings-status-panel');
        if (panel) {
            // Preserve collapse/expand states before replacing HTML
            var __savedCollapseStates = {};
            panel.querySelectorAll('.sp-collapse-content').forEach(function(el) {
                if (el.id) __savedCollapseStates[el.id] = el.classList.contains('sp-collapsed');
            });
            panel.innerHTML = msg.html || '<div class="sp-loading">No data</div>';
            // Restore collapse/expand states after replacing HTML
            Object.keys(__savedCollapseStates).forEach(function(elId) {
                var el = document.getElementById(elId);
                if (!el) return;
                var icon = el.previousElementSibling ? el.previousElementSibling.querySelector('.sp-collapse-icon') : null;
                if (__savedCollapseStates[elId]) {
                    el.classList.add('sp-collapsed');
                    if (icon) icon.textContent = '▶';
                } else {
                    el.classList.remove('sp-collapsed');
                    if (icon) icon.textContent = '▼';
                }
            });
        }
        attachStatusPanelListeners();
    }
});
`;

        return getAccordionHtml({
            codiconsUri: codiconsUri.toString(),
            sections,
            initialExpanded: 'guidelines',
            additionalCss,
            additionalScript,
        });
    }

    // ------------------------------------------------------------------
    // Status panel
    // ------------------------------------------------------------------

    private async _sendStatusData(): Promise<void> {
        const status = await gatherStatusData();
        const html = getEmbeddedStatusHtml(status);
        this._view?.webview.postMessage({ type: 'statusData', html });
    }

    private _getGuidelinesDir(group?: string): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        if (!group || group === 'global') {
            return WsPaths.guidelines() || path.join(wsRoot, '_copilot_guidelines');
        }
        if (group === 'copilot-instructions') {
            return WsPaths.github() || path.join(wsRoot, '.github');
        }
        if (group === 'roles') {
            return WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles');
        }
        if (group.startsWith('project:')) {
            const projectRelPath = group.substring('project:'.length);
            if (!projectRelPath) {
                return null;
            }
            return path.join(wsRoot, projectRelPath, WsPaths.guidelinesFolder);
        }
        return null;
    }

    private _collectGuidelinesProjects(): { id: string; label: string }[] {
        const projects = scanWorkspaceProjectsByDetectors({ traverseWholeWorkspace: true });
        const result: { id: string; label: string }[] = [];

        for (const proj of projects) {
            const guidelinesDir = path.join(proj.absolutePath, WsPaths.guidelinesFolder);
            if (fs.existsSync(guidelinesDir)) {
                result.push({ id: `project:${proj.relativePath}`, label: proj.name });
            }
        }

        return result.sort((a, b) => a.label.localeCompare(b.label));
    }

    private _sendGuidelinesGroups(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this._view?.webview.postMessage({ type: 'guidelinesGroups', groups: [], projects: [] });
            return;
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const groups: { id: string; label: string }[] = [];
        const projectsWithGuidelines: { id: string; label: string }[] = this._collectGuidelinesProjects();

        const globalDir = WsPaths.guidelines() || path.join(wsRoot, '_copilot_guidelines');
        if (fs.existsSync(globalDir)) {
            groups.push({ id: 'global', label: 'Workspace' });
        }

        if (projectsWithGuidelines.length > 0) {
            groups.push({ id: 'project', label: 'Project' });
        }

        const rolesDir = WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles');
        if (fs.existsSync(rolesDir)) {
            groups.push({ id: 'roles', label: 'Roles' });
        }

        const githubDir = WsPaths.github() || path.join(wsRoot, '.github');
        if (fs.existsSync(githubDir) && fs.existsSync(path.join(githubDir, 'copilot-instructions.md'))) {
            groups.push({ id: 'copilot-instructions', label: 'Copilot Instructions' });
        }

        this._view?.webview.postMessage({ type: 'guidelinesGroups', groups, projects: projectsWithGuidelines });
    }

    private _sendGuidelinesFiles(group?: string): void {
        const dir = this._getGuidelinesDir(group);
        if (!dir || !fs.existsSync(dir)) {
            this._view?.webview.postMessage({ type: 'guidelinesFiles', files: [] });
            return;
        }
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
        this._view?.webview.postMessage({ type: 'guidelinesFiles', files });
    }

    private _loadGuidelinesFile(file: string, group?: string): void {
        const dir = this._getGuidelinesDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (!fs.existsSync(filePath)) {
            this._view?.webview.postMessage({ type: 'guidelinesContent', content: '' });
            return;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        this._view?.webview.postMessage({ type: 'guidelinesContent', content });
    }

    private _saveGuidelinesFile(file: string, content: string, group?: string): void {
        const dir = this._getGuidelinesDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf-8');
    }

    private async _addGuidelinesFile(group?: string): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter filename (without .md extension)',
            placeHolder: 'my_guidelines',
        });
        if (!name) {
            return;
        }
        const dir = this._getGuidelinesDir(group);
        if (!dir) {
            return;
        }
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filename = name.endsWith('.md') ? name : `${name}.md`;
        const filePath = path.join(dir, filename);
        if (fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`File "${filename}" already exists`);
            return;
        }
        fs.writeFileSync(filePath, `# ${name}\n\n`, 'utf-8');
        this._view?.webview.postMessage({ type: 'guidelinesFiles', files: fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(), selectedFile: filename });
        this._loadGuidelinesFile(filename, group);
    }

    private async _deleteGuidelinesFile(file: string, group?: string): Promise<void> {
        const dir = this._getGuidelinesDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            vscode.window.showInformationMessage(`Deleted "${file}"`);
            this._sendGuidelinesFiles(group);
        }
    }

    private async _openGuidelinesInEditor(file: string, group?: string): Promise<void> {
        const dir = this._getGuidelinesDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (fs.existsSync(filePath)) {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        }
    }

    // ------------------------------------------------------------------
    // Shared: Preview in overlay & Open in external application
    // ------------------------------------------------------------------

    private async _previewFile(file: string, group: string | undefined, panel: 'guidelines' | 'docs'): Promise<void> {
        const dir = panel === 'guidelines' ? this._getGuidelinesDir(group) : this._getDocsDir(group);
        if (!dir || !file) {
            return;
        }
        const filePath = path.join(dir, file);
        if (!fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`File not found: ${file}`);
            return;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        await showMarkdownHtmlPreview(this._extensionContext, {
            title: file,
            markdown: content,
            meta: filePath,
        });
    }

    private async _openFileExternal(file: string, group: string | undefined, panel: 'guidelines' | 'docs'): Promise<void> {
        const dir = panel === 'guidelines' ? this._getGuidelinesDir(group) : this._getDocsDir(group);
        if (!dir || !file) {
            return;
        }
        const filePath = path.join(dir, file);
        if (!fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`File not found: ${file}`);
            return;
        }
        const opened = await openInExternalApplication(filePath);
        if (!opened) {
            vscode.window.showWarningMessage('No external application configured for this file type.');
        }
    }

    // ------------------------------------------------------------------
    // Documentation panel (group-based: Workspace, Projects, Notes)
    // ------------------------------------------------------------------

    private _getDocsDir(group?: string): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        if (!group || group === 'notes') {
            return WsPaths.ai('notes') || path.join(wsRoot, '_ai', 'notes');
        }
        if (group === 'workspace') {
            const docDir = path.join(wsRoot, 'doc');
            return fs.existsSync(docDir) ? docDir : path.join(wsRoot, '_doc');
        }
        if (group.startsWith('docproject:')) {
            const projectRelPath = group.substring('docproject:'.length);
            if (!projectRelPath) {
                return null;
            }
            return path.join(wsRoot, projectRelPath, 'doc');
        }
        return null;
    }

    private _collectDocsProjects(): { id: string; label: string }[] {
        const projects = scanWorkspaceProjectsByDetectors({ traverseWholeWorkspace: true });
        const result: { id: string; label: string }[] = [];

        for (const proj of projects) {
            const docDir = path.join(proj.absolutePath, 'doc');
            if (fs.existsSync(docDir)) {
                result.push({ id: `docproject:${proj.relativePath}`, label: proj.name });
            }
        }

        return result.sort((a, b) => a.label.localeCompare(b.label));
    }

    private _sendDocsGroups(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this._view?.webview.postMessage({ type: 'docsGroups', groups: [], projects: [] });
            return;
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const groups: { id: string; label: string }[] = [];
        const projectsWithDocs: { id: string; label: string }[] = this._collectDocsProjects();

        const wsDocDir = path.join(wsRoot, 'doc');
        const wsDocAltDir = path.join(wsRoot, '_doc');
        if (fs.existsSync(wsDocDir) || fs.existsSync(wsDocAltDir)) {
            groups.push({ id: 'workspace', label: 'Workspace' });
        }

        if (projectsWithDocs.length > 0) {
            groups.push({ id: 'project', label: 'Projects' });
        }

        const notesDir = WsPaths.ai('notes') || path.join(wsRoot, '_ai', 'notes');
        if (fs.existsSync(notesDir)) {
            groups.push({ id: 'notes', label: 'Notes' });
        }

        this._view?.webview.postMessage({ type: 'docsGroups', groups, projects: projectsWithDocs });
    }

    private _sendDocsFiles(group?: string): void {
        const dir = this._getDocsDir(group);
        if (!dir || !fs.existsSync(dir)) {
            this._view?.webview.postMessage({ type: 'docsFiles', files: [] });
            return;
        }
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
        this._view?.webview.postMessage({ type: 'docsFiles', files });
    }

    private _loadDocsFile(file: string, group?: string): void {
        const dir = this._getDocsDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (!fs.existsSync(filePath)) {
            this._view?.webview.postMessage({ type: 'docsContent', content: '' });
            return;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        this._view?.webview.postMessage({ type: 'docsContent', content });
    }

    private _saveDocsFile(file: string, content: string, group?: string): void {
        const dir = this._getDocsDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf-8');
    }

    private async _addDocsFile(group?: string): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter filename (without .md extension)',
            placeHolder: 'my_document',
        });
        if (!name) {
            return;
        }
        const dir = this._getDocsDir(group);
        if (!dir) {
            return;
        }
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filename = name.endsWith('.md') ? name : `${name}.md`;
        const filePath = path.join(dir, filename);
        if (fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`File "${filename}" already exists`);
            return;
        }
        fs.writeFileSync(filePath, `# ${name}\n\n`, 'utf-8');
        this._view?.webview.postMessage({ type: 'docsFiles', files: fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(), selectedFile: filename });
        this._loadDocsFile(filename, group);
    }

    private async _deleteDocsFile(file: string, group?: string): Promise<void> {
        const dir = this._getDocsDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            vscode.window.showInformationMessage(`Deleted "${file}"`);
            this._sendDocsFiles(group);
        }
    }

    private async _openDocsInEditor(file: string, group?: string): Promise<void> {
        const dir = this._getDocsDir(group);
        if (!dir) {
            return;
        }
        const filePath = path.join(dir, file);
        if (fs.existsSync(filePath)) {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        }
    }
}

let _provider: T3PanelHandler | undefined;

/** Get the T3 panel provider for cross-module access. */
export function getT3PanelProvider(): T3PanelHandler | undefined {
    return _provider;
}

export function registerT3Panel(context: vscode.ExtensionContext): void {
    initIssueProviders();
    _provider = new T3PanelHandler(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_ID, _provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    // Quest TODO file watcher — refreshes the embedded section on YAML changes
    const watcher = setupQuestTodoWatcher(() => {
        if (_provider?.['_view']?.webview) {
            sendQuestTodoRefresh(_provider['_view'].webview);
        }
    });
    if (watcher) {
        context.subscriptions.push(watcher);
    }
}
