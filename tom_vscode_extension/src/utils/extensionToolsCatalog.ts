/**
 * Every editor, page and viewer of the extension, in groups, each with a
 * one-line purpose and how to open it (vscimpb73). One list, rendered by the
 * Status Page's overview at its top and by the chat panels' Extension Tools
 * overlay (vscimpb76), so the two never drift. A test
 * (extensionToolsCatalog.test.ts) holds it to package.json: every
 * `tomAi.editor.*` / `tomAi.panel.*` command and every page command is here or
 * in {@link CATALOG_EXCLUDED_COMMANDS} with the reason.
 *
 * vscode-free.
 */

export type ToolGroupId = 'prompts' | 'queue' | 'quest' | 'trails';

export interface ToolGroup {
    id: ToolGroupId;
    label: string;
    icon: string;
}

/** The four groups, in the order shown. */
export const TOOL_GROUPS: readonly ToolGroup[] = [
    { id: 'prompts', label: 'Prompts & templates', icon: '📋' },
    { id: 'queue', label: 'Queue & automation', icon: '📤' },
    { id: 'quest', label: 'Quest & process', icon: '🧭' },
    { id: 'trails', label: 'Trails, logs & setup', icon: '📜' },
];

export interface ToolEntry {
    id: string;
    label: string;
    group: ToolGroupId;
    /** One line: what it is for. */
    purpose: string;
    /** The command its Open button runs (without arguments). */
    command?: string;
    /** Instead of a command: a section of the Status Page (`tomAi.statusPage` with this section). */
    statusSection?: string;
    /** A codicon name. */
    icon: string;
    /** When it can be used, if not always (shown beside it). */
    whenAvailable?: string;
}

export const EXTENSION_TOOLS: readonly ToolEntry[] = [
    // (1) Prompts & templates
    { id: 'promptTemplates', label: 'Prompt Template Editor', group: 'prompts', icon: 'symbol-snippet', command: 'tomAi.editor.promptTemplates',
        purpose: 'Every template in one editor: Copilot and Anthropic message templates, profiles, configurations, reminder templates, user-message templates, assist prompts.' },
    { id: 'queueTemplates', label: 'Queue-Template Editor', group: 'prompts', icon: 'list-ordered', command: 'tomAi.editor.queueTemplates',
        purpose: 'Queue templates (`*.template.queue.yaml`): an item with its pre-prompts and follow-ups, kept to queue again.' },
    { id: 'reusablePrompts', label: 'Reusable Prompt Editor', group: 'prompts', icon: 'note', command: 'tomAi.editor.reusablePrompts',
        purpose: 'Reusable `.prompt.md` files in four scopes: global, project, quest, and the folders above the open file.' },
    { id: 'groupPrompts', label: 'Group Prompt Editor', group: 'prompts', icon: 'group-by-ref-type', command: 'tomAi.editor.groupPrompts',
        purpose: 'The prompts a todo group walk (`<prefix>*`) sends for each todo: the global ones and the quest\'s own.' },
    { id: 'processTemplates', label: 'Process Template Editor', group: 'prompts', icon: 'file-code', command: 'tomAi.editor.processTemplates',
        purpose: 'The Proceed template: how a process position becomes the prompt it queues.' },
    { id: 'assistPrompts', label: 'Assist prompts', group: 'prompts', icon: 'lightbulb', statusSection: 'assistPrompts',
        purpose: 'Grill me, Explain in detail, Finish review round and the other assist prompts (a Status Page section).' },

    // (2) Queue & automation
    { id: 'promptQueue', label: 'Prompt Queue Editor', group: 'queue', icon: 'list-flat', command: 'tomAi.editor.promptQueue',
        purpose: 'The queue of every process run: items, their stages and answers, the run tabs and their settings.' },
    { id: 'timedRequests', label: 'Timed Requests Editor', group: 'queue', icon: 'watch', command: 'tomAi.editor.timedRequests',
        purpose: 'Prompts sent on a schedule (interval or set times) and the repeated-todo controller.' },
    { id: 'providerSdks', label: 'Provider SDKs', group: 'queue', icon: 'package', command: 'tomAi.providerSdks',
        purpose: 'Install, update and remove the Anthropic SDK and the Agent SDK with its Claude CLI.' },
    { id: 'telegram', label: 'Telegram', group: 'queue', icon: 'comment-discussion', statusSection: 'telegram',
        purpose: 'Remote control and notifications through the quest\'s Telegram bot (a Status Page section).' },
    { id: 'mcpServer', label: 'MCP server', group: 'queue', icon: 'server', statusSection: 'mcpConfig',
        purpose: 'The standalone MCP server: start / stop, its port, key and tool selection (a Status Page section).' },

    // (3) Quest & process
    { id: 'process', label: 'Process Editor', group: 'quest', icon: 'type-hierarchy', command: 'tomAi.editor.process',
        purpose: 'Processes: phases, steps, gates, sessions, subprocesses and branches.' },
    { id: 'processBranching', label: 'Process branching editor', group: 'quest', icon: 'git-merge', command: 'tomAi.process.startNested',
        purpose: 'Start (or see suggested) subprocesses and branches of the running step.',
        whenAvailable: 'when the running step lists subprocesses or branches' },
    { id: 'chatVariables', label: 'Chat Variables Editor', group: 'quest', icon: 'symbol-variable', command: 'tomAi.editor.chatVariables',
        purpose: 'The chat variables of the window and of each process run (quest, role, custom keys).' },
    { id: 'contextSettings', label: 'Context & Settings Editor', group: 'quest', icon: 'settings', command: 'tomAi.editor.contextSettings',
        purpose: 'The window\'s quest, role, active projects and todo file, and the reminder settings.' },
    { id: 'memory', label: 'Memory Panel', group: 'quest', icon: 'database', command: 'tomAi.panel.memory',
        purpose: 'The quest\'s per-session memory and the shared memory files.' },
    { id: 'createQuest', label: 'Create New Quest', group: 'quest', icon: 'new-folder', command: 'tomAi.createQuest',
        purpose: 'A new quest\'s files and the todo that defines it with you.' },
    { id: 'setupWorkspaceFolder', label: 'Setup New Workspace Folder', group: 'quest', icon: 'root-folder', command: 'tomAi.setupWorkspaceFolder',
        purpose: 'Unpack the workspace template (configuration, guidelines, _ai roles / processes and the starting quest) into a folder.' },

    // (4) Trails, logs & setup
    { id: 'rawTrailViewer', label: 'Raw Trail Files Viewer', group: 'trails', icon: 'history', command: 'tomAi.editor.rawTrailViewer',
        purpose: 'Every prompt, answer and tool call of a session, file by file.' },
    { id: 'summaryTrailViewer', label: 'Trail Summary Viewer', group: 'trails', icon: 'book', command: 'tomAi.editor.summaryTrailViewer',
        purpose: 'The summary trail (`.prompts.md` / `.answers.md`) as a list of exchanges.' },
    { id: 'mdBrowser', label: 'MD Browser', group: 'trails', icon: 'markdown', command: 'tomAi.openInMdBrowser',
        purpose: 'Markdown documents rendered, with review questions, answers and links that open files.' },
    { id: 'usage', label: 'Usage and cost', group: 'trails', icon: 'graph', statusSection: 'usage',
        purpose: 'Tokens and cost per profile and model (a Status Page section).' },
    { id: 'openConfig', label: 'Open Config', group: 'trails', icon: 'json', command: 'tomAi.openConfig',
        purpose: 'The workspace configuration file `.tom/tom_vscode_extension.json`.' },
    { id: 'openSettings', label: 'Extension Settings', group: 'trails', icon: 'gear', command: 'tomAi.openSettings',
        purpose: 'The extension\'s VS Code settings.' },
    { id: 'quickReference', label: 'Quick Reference', group: 'trails', icon: 'references', command: 'tomAi.showQuickReference',
        purpose: 'The extension\'s quick reference (doc/quick_reference.md).' },
    { id: 'help', label: 'Extension Help', group: 'trails', icon: 'question', command: 'tomAi.showHelp',
        purpose: 'The user guide.' },
    { id: 'dartBinariesHelp', label: 'Missing Dart Binaries', group: 'trails', icon: 'warning', command: 'tomAi.showDartBinariesHelp',
        purpose: 'Why DartScript or CodeSpecs validation is unavailable on this platform, and how to get the binaries.' },
    { id: 'agentSdkHelp', label: 'Missing Agent SDK', group: 'trails', icon: 'warning', command: 'tomAi.showAgentSdkCliHelp',
        purpose: 'What to do when the provider SDK or the Claude CLI is not installed.' },
    { id: 'statusPage', label: 'Status Page', group: 'trails', icon: 'dashboard', command: 'tomAi.statusPage',
        purpose: 'This page: the extension\'s state and settings, section by section.' },
];

/**
 * package.json commands that look like an editor or page but are left out,
 * with why (the test reads this list).
 */
export const CATALOG_EXCLUDED_COMMANDS: Readonly<Record<string, string>> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- command ids
    'tomAi.openInMdViewer': 'opens the current file in the external MarkText viewer: an action on a file, not a page',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- command ids
    'tomAi.process.abortNested': 'an action on the running subprocess, not a page',
};

/** The entries of a group, in catalogue order. */
export function toolsOfGroup(group: ToolGroupId): ToolEntry[] {
    return EXTENSION_TOOLS.filter((t) => t.group === group);
}

/** The entry with `id`, or undefined. */
export function toolById(id: string): ToolEntry | undefined {
    return EXTENSION_TOOLS.find((t) => t.id === id);
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The Status Page's overview section: the groups, each entry with its purpose
 * and an Open button. A command entry runs through the page's action
 * `openExtensionTool` (by id: the host looks the command up, the webview never
 * names one); a section entry jumps to that section of the page.
 */
export function extensionToolsOverviewHtml(): string {
    const groups = TOOL_GROUPS.map((g) => {
        const rows = toolsOfGroup(g.id).map((t) => {
            const button = t.statusSection
                ? `<button class="sp-btn small" data-sp-jump="${escapeHtml(t.statusSection)}" title="Go to the ${escapeHtml(t.label)} section">Go to</button>`
                : `<button class="sp-btn small" data-status-action="openExtensionTool" data-tool-id="${escapeHtml(t.id)}" title="${escapeHtml(t.command ?? '')}">Open</button>`;
            return `<div class="sp-tools-row" data-tool="${escapeHtml(t.id)}">`
                + `<span class="codicon codicon-${escapeHtml(t.icon)}"></span>`
                + `<span class="sp-tools-label">${escapeHtml(t.label)}</span>`
                + `<span class="sp-tools-purpose">${escapeHtml(t.purpose)}${t.whenAvailable ? ` <em>(${escapeHtml(t.whenAvailable)})</em>` : ''}</span>`
                + button
                + '</div>';
        }).join('');
        return `<div class="sp-tools-group" data-group="${g.id}"><div class="sp-tools-group-title">${g.icon} ${escapeHtml(g.label)}</div>${rows}</div>`;
    }).join('');
    return `<div class="sp-section" data-section="toolsOverview">
        <div class="sp-section-header sp-collapsible" data-collapse="toolsOverview">
            <span class="sp-section-title"><span class="sp-collapse-icon">▼</span> 🗺️ Editors and pages</span>
        </div>
        <div class="sp-collapse-content" id="sp-toolsOverview-content">${groups}</div>
    </div>`;
}
