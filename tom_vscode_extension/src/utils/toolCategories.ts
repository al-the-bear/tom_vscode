/**
 * Tool categorisation for the profile-editor UI. Maps every entry of
 * AVAILABLE_LLM_TOOLS to a human-readable category so the editor can render
 * grouped checkboxes with per-group bulk-select buttons.
 *
 * Categories are intentionally narrower than `AnthropicProfile.toolsEnabled`
 * (read-only vs. all) so users can quickly toggle, say, "all Issues tools"
 * without ticking eight boxes. Tools missing from the map go into "Other".
 *
 * Update both this file and `utils/constants.ts::AVAILABLE_LLM_TOOLS` (and
 * `tools/tool-executors.ts::ALL_SHARED_TOOLS`) whenever a tool is added.
 */

/**
 * Category name → tool names (in display order; the editor re-sorts
 * alphabetically). Adding a new category here is the only step needed to
 * surface it in the profile editor.
 */
export const CATEGORY_MAP: Record<string, string[]> = {
    'AI Conversation': [
        'tomAi_readConversationResult',
        'tomAi_writeConversationResult',
    ],
    'Ask AI': [
        'tomAi_askBigBrother',
        'tomAi_askCopilot',
    ],
    'Chat Variables': [
        'tomAi_readChatVariable',
        'tomAi_writeChatVariable',
    ],
    'Diagnostics': [
        'tomAi_getErrors',
        'tomAi_getProblems',
    ],
    'Editor Context': [
        'tomAi_getActiveEditor',
        'tomAi_getOpenEditors',
        'tomAi_getWorkspaceInfo',
    ],
    'Files (read)': [
        'tomAi_findFiles',
        'tomAi_findTextInFiles',
        'tomAi_listDirectory',
        'tomAi_readFile',
    ],
    'Files (write)': [
        'tomAi_createFile',
        'tomAi_deleteFile',
        'tomAi_editFile',
        'tomAi_moveFile',
        'tomAi_multiEditFile',
    ],
    'Git': [
        'tomAi_gitRead',
        'tomAi_gitShow',
        'tomAi_gitWrite',
    ],
    'Guidelines (global)': [
        'tomAi_listGlobalGuidelines',
        'tomAi_readGlobalGuideline',
        'tomAi_searchGlobalGuidelines',
    ],
    'Guidelines (project)': [
        'tomAi_listProjectGuidelines',
        'tomAi_readProjectGuideline',
        'tomAi_searchProjectGuidelines',
    ],
    'Issues': [
        'tomAi_addIssueComment',
        'tomAi_createIssue',
        'tomAi_getIssue',
        'tomAi_listIssueComments',
        'tomAi_listIssueRepos',
        'tomAi_listIssues',
        'tomAi_setIssueStatus',
        'tomAi_toggleIssueLabel',
    ],
    'Language Service': [
        'tomAi_applyCodeAction',
        'tomAi_findReferences',
        'tomAi_findSymbol',
        'tomAi_getCodeActions',
        'tomAi_getCodeActionsCached',
        'tomAi_gotoDefinition',
        'tomAi_rename',
    ],
    'Memory': [
        'tomAi_forgetMemory',
        'tomAi_listMemory',
        'tomAi_readMemory',
        'tomAi_saveMemory',
        'tomAi_updateMemory',
    ],
    'Notebook': [
        'tomAi_notebookEdit',
        'tomAi_notebookRun',
    ],
    'Pattern Prompts': [
        'tomAi_listPatternPrompts',
        'tomAi_readPatternPrompt',
    ],
    'Planning': [
        'tomAi_enterPlanMode',
        'tomAi_exitPlanMode',
        'tomAi_spawnSubagent',
    ],
    'Process': [
        'tomAi_killCommand',
        'tomAi_readCommandOutput',
        'tomAi_runCommand',
        'tomAi_runCommandStream',
    ],
    'Prompt Templates': [
        'tomAi_createPromptTemplate',
        'tomAi_deletePromptTemplate',
        'tomAi_listPromptTemplates',
        'tomAi_updatePromptTemplate',
    ],
    'Quests': [
        'tomAi_archiveQuestTodos',
        'tomAi_createQuestTodo',
        'tomAi_deleteQuestTodo',
        'tomAi_deleteQuestTodos',
        'tomAi_getCombinedTodos',
        'tomAi_getQuestTodo',
        'tomAi_listQuests',
        'tomAi_listQuestTodos',
        'tomAi_listWorkspaceQuestTodos',
        'tomAi_moveQuestTodo',
        'tomAi_updateQuestTodo',
    ],
    'Reminders': [
        'tomAi_createReminderTemplate',
        'tomAi_deleteReminderTemplate',
        'tomAi_listReminderTemplates',
        'tomAi_updateReminderTemplate',
    ],
    'Session Todos': [
        'tomAi_addSessionTodo',
        'tomAi_deleteSessionTodo',
        'tomAi_getAllSessionTodos',
        'tomAi_listSessionTodos',
        'tomAi_updateSessionTodo',
    ],
    'Tasks & Debug': [
        'tomAi_runDebugConfig',
        'tomAi_runTask',
    ],
    'Tests': [
        'tomAi_addTestComment',
        'tomAi_createTest',
        'tomAi_getTest',
        'tomAi_listTestComments',
        'tomAi_listTestRepos',
        'tomAi_listTests',
        'tomAi_setTestStatus',
        'tomAi_toggleTestLabel',
    ],
    'Todos (chat)': [
        'tomAi_manageTodo',
    ],
    'User Interaction': [
        'tomAi_askUser',
        'tomAi_askUserPicker',
        'tomAi_notifyUser',
    ],
    'VS Code Commands': [
        'tomAi_listCommands',
        'tomAi_openFile',
        'tomAi_runVscodeCommand',
        'tomAi_runVscodeCommandTyped',
    ],
    'Web': [
        'tomAi_fetchWebpage',
        'tomAi_webSearch',
    ],
    'Workspace Edit': [
        'tomAi_applyEdit',
    ],
};

/** A categorised, sorted view of the tool list for grouped multi-checkbox rendering. */
export interface ToolCategoryGroup {
    /** Display name; the editor sorts groups alphabetically by this. */
    category: string;
    /** Tools belonging to this group; pre-sorted alphabetically by `value`. */
    tools: Array<{ value: string; label: string; readOnly: boolean }>;
}

/**
 * Returns the categorised view of the given tool names. Categories are sorted
 * alphabetically, with "Other" pushed to the end (tools without a mapping land
 * there). Within each category, tools are sorted alphabetically by name.
 *
 * @param toolNames All tool names the picker should expose (typically
 *                  `AVAILABLE_LLM_TOOLS`).
 * @param readOnlyTools Optional set of tool names that are read-only. When
 *                  provided, each option carries a `readOnly` flag the
 *                  webview uses to drive the "Select Read-Only" button.
 */
export function categorizeTools(
    toolNames: readonly string[],
    readOnlyTools?: ReadonlySet<string>,
): ToolCategoryGroup[] {
    // Invert CATEGORY_MAP so we can look up by tool name.
    const nameToCategory = new Map<string, string>();
    for (const [cat, tools] of Object.entries(CATEGORY_MAP)) {
        for (const t of tools) { nameToCategory.set(t, cat); }
    }

    // Bucket tool names by category.
    const buckets = new Map<string, string[]>();
    for (const name of toolNames) {
        const cat = nameToCategory.get(name) ?? 'Other';
        const arr = buckets.get(cat) ?? [];
        arr.push(name);
        buckets.set(cat, arr);
    }

    // Sort categories alphabetically; pin "Other" to the bottom for sanity.
    const orderedCategories = [...buckets.keys()]
        .sort((a, b) => {
            if (a === 'Other' && b !== 'Other') { return 1; }
            if (b === 'Other' && a !== 'Other') { return -1; }
            return a.localeCompare(b);
        });

    return orderedCategories.map((category) => {
        const names = (buckets.get(category) ?? []).slice().sort((a, b) => a.localeCompare(b));
        return {
            category,
            tools: names.map((value) => ({
                value,
                label: value,
                readOnly: readOnlyTools ? readOnlyTools.has(value) : false,
            })),
        };
    });
}
