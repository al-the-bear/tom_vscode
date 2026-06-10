/**
 * WS Panel Handler – Accordion panel containing TASKS, LOGS, SETTINGS, ISSUES,
 * TESTS and QUEST TODO.
 *
 * A single VS Code webview panel ("@WS") using the reusable accordion component.
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
    registerQuestTodoPopoutSerializer,
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
import {
    getDocumentPickerHtml,
    getDocumentPickerCss,
    getDocumentPickerScript,
} from './documentPicker.js';
import { readMediaText } from '../utils/webviewLoader.js';
import { wireCompletionMessages } from '../utils/completionWiring.js';

const VIEW_ID = 'tomAi.wsPanel';

export class WsPanelHandler implements vscode.WebviewViewProvider {
    public static readonly viewType = VIEW_ID;
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _extensionContext: vscode.ExtensionContext;

    /** Whether the WS webview view has been resolved and is available. */
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

        // /skill + @file completion for the Guidelines / Documentation
        // textareas: the shared media/shared/completion.js client posts
        // `requestCompletion`; this wiring shows the picker and posts the chosen
        // `insertCompletion` back. Registered as its own listener so it coexists
        // with _handleMessage below.
        wireCompletionMessages(webviewView.webview);

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
            case 'docsGetFiles': // documentPicker message type
                this._sendDocsFiles(message.group);
                return;
            case 'loadDocsFile':
            case 'docsLoadFile': // documentPicker message type
                this._loadDocsFile(message.file, message.group);
                return;
            case 'docsBrowseFile': // documentPicker "Other file" browse
                await this._browseDocsFile();
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
            // WS simple-section actions (tasks / logs)
            switch (message.action) {
                case 'refreshLogs':
                    vscode.window.showInformationMessage('WS: Refresh Logs clicked');
                    break;
                case 'exportLogs':
                    vscode.window.showInformationMessage('WS: Export Logs clicked');
                    break;
                case 'openWorkspaceTodoExplorer':
                    await vscode.commands.executeCommand('tomAi.workspaceTodos.focus');
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
    <label id="guidelines-quest-label" for="guidelines-quest" style="display:none;">Quest:</label>
    <select id="guidelines-quest" title="Quest" style="display:none;"></select>
    <label for="guidelines-file">File:</label>
    <select id="guidelines-file" title="File"></select>
    <button class="icon-btn" onclick="reloadGuidelines()" title="Reload"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" onclick="addGuidelinesFile()" title="Add"><span class="codicon codicon-add"></span></button>
    <button class="icon-btn" onclick="deleteGuidelinesFile()" title="Delete"><span class="codicon codicon-trash"></span></button>
    <button class="icon-btn" onclick="openGuidelinesInEditor()" title="Open in editor"><span class="codicon codicon-go-to-file"></span></button>
    <button class="icon-btn" onclick="previewGuidelines()" title="Preview in overlay"><span class="codicon codicon-open-preview"></span></button>
    <button class="icon-btn" onclick="openGuidelinesExternal()" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>
</div>
<textarea id="guidelines-text" placeholder="Guidelines..." spellcheck="false" data-completion="on"></textarea>
<div class="status-bar">Workspace/project guidelines editor</div>`,
            },
            {
                id: 'documentation',
                title: 'Documentation',
                icon: 'note',
                content: `
<div class="toolbar">
    ${getDocumentPickerHtml({ idPrefix: 'docs', allowOtherFile: true, showGroupSelector: true, groupLabel: 'Group:', fileLabel: 'File:' })}
    <button class="icon-btn" onclick="reloadDocs()" title="Reload"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" onclick="addDocsFile()" title="Add"><span class="codicon codicon-add"></span></button>
    <button class="icon-btn" onclick="deleteDocsFile()" title="Delete"><span class="codicon codicon-trash"></span></button>
    <button class="icon-btn" onclick="openDocsInEditor()" title="Open in editor"><span class="codicon codicon-go-to-file"></span></button>
    <button class="icon-btn" onclick="previewDocs()" title="Preview in overlay"><span class="codicon codicon-open-preview"></span></button>
    <button class="icon-btn" onclick="openDocsExternal()" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>
</div>
<textarea id="docs-text" placeholder="Documentation..." spellcheck="false" data-completion="on"></textarea>
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

        // Issues panels and Quest TODO need their own CSS and client-side scripts.
        // wsPanel-specific CSS/JS now live in media/wsPanel/{style.css,main.js} and
        // are read verbatim and composed into the accordion's inline <style>/<script>.
        // Fragment scripts (issues / tests / questTodo / documentPicker / status
        // listeners) are grouped AHEAD of the wsPanel main script so their declared
        // functions and window-exposed APIs (docs_*, attachStatusPanelListeners) are
        // available before main.js runs; the shared completion component is appended
        // LAST because it reads window.__tomVscodeApi published at the top of main.js.
        const additionalCss = [
            getIssuesCss(),
            getQuestTodoCss(),
            getDocumentPickerCss(),
            readMediaText('wsPanel', 'style.css'),
            getEmbeddedStatusStyles(),
        ].join('\n');

        const additionalScript = [
            getIssuesScript('issues', 'issues'),
            getIssuesScript('tests', 'tests'),
            getQuestTodoScript(),
            getDocumentPickerScript({ idPrefix: 'docs', allowOtherFile: true, showGroupSelector: true }),
            getStatusPanelListenersScript(),
            readMediaText('wsPanel', 'main.js'),
            readMediaText('shared', 'completion.js'),
        ].join('\n');

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
        if (group.startsWith('quest:')) {
            const questId = group.substring('quest:'.length);
            if (!questId) {
                return null;
            }
            return WsPaths.ai(`quests/${questId}`) || path.join(wsRoot, '_ai', 'quests', questId);
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

    private _collectGuidelinesQuests(): { id: string; label: string }[] {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
        if (!fs.existsSync(questsDir)) {
            return [];
        }
        const result: { id: string; label: string }[] = [];
        const entries = fs.readdirSync(questsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                result.push({ id: `quest:${entry.name}`, label: entry.name });
            }
        }
        return result.sort((a, b) => a.label.localeCompare(b.label));
    }

    private _sendGuidelinesGroups(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this._view?.webview.postMessage({ type: 'guidelinesGroups', groups: [], projects: [], quests: [] });
            return;
        }
        const wsRoot = workspaceFolder.uri.fsPath;
        const groups: { id: string; label: string }[] = [];
        const projectsWithGuidelines: { id: string; label: string }[] = this._collectGuidelinesProjects();
        const questFolders: { id: string; label: string }[] = this._collectGuidelinesQuests();

        const globalDir = WsPaths.guidelines() || path.join(wsRoot, '_copilot_guidelines');
        if (fs.existsSync(globalDir)) {
            groups.push({ id: 'global', label: 'Workspace' });
        }

        if (projectsWithGuidelines.length > 0) {
            groups.push({ id: 'project', label: 'Project' });
        }

        if (questFolders.length > 0) {
            groups.push({ id: 'quest', label: 'Quest' });
        }

        const rolesDir = WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles');
        if (fs.existsSync(rolesDir)) {
            groups.push({ id: 'roles', label: 'Roles' });
        }

        const githubDir = WsPaths.github() || path.join(wsRoot, '.github');
        if (fs.existsSync(githubDir) && fs.existsSync(path.join(githubDir, 'copilot-instructions.md'))) {
            groups.push({ id: 'copilot-instructions', label: 'Copilot Instructions' });
        }

        this._view?.webview.postMessage({ type: 'guidelinesGroups', groups, projects: projectsWithGuidelines, quests: questFolders });
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

    private async _browseDocsFile(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Markdown': ['md'] },
            defaultUri: workspaceFolder.uri,
        });
        if (!result || result.length === 0) {
            return;
        }
        const filePath = result[0].fsPath;
        const wsRoot = workspaceFolder.uri.fsPath;
        const relativePath = path.relative(wsRoot, filePath);
        this._view?.webview.postMessage({ type: 'docsBrowsedFile', file: relativePath });
        // Also load the content
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            this._view?.webview.postMessage({ type: 'docsContent', content });
        }
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

let _provider: WsPanelHandler | undefined;

/** Get the WS panel provider for cross-module access. */
export function getWsPanelProvider(): WsPanelHandler | undefined {
    return _provider;
}

export function registerWsPanel(context: vscode.ExtensionContext): void {
    initIssueProviders();
    _provider = new WsPanelHandler(context.extensionUri, context);

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

    // Restore the Quest TODO popout window after a Reload Window / host restart.
    // Registered here because the WsPanelHandler constructor above guarantees
    // setQuestTodoContext(context) has run, so the popout module's context is set.
    registerQuestTodoPopoutSerializer(context);
}
