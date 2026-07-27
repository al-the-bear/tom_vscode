export const BRIDGE_REQUEST_TIMEOUT = 30_000;
export const BRIDGE_RESTART_DELAY = 5_000;
export const BRIDGE_MAX_RESTARTS = 10;
export const TIMER_TICK_INTERVAL = 30_000;
export const REMINDER_CHECK_INTERVAL = 30_000;
export const REMINDER_DEFAULT_TIMEOUT = 600_000;
export const TELEGRAM_POLL_INTERVAL = 300_000;
export const BRIDGE_AUTO_START_DELAY = 2_000;
export const CLI_SERVER_AUTO_START_DELAY = 1_000;
export const TELEGRAM_AUTO_START_DELAY = 2_000;

export const TRAIL_MAX_FILES_PER_FOLDER = 50;
export const TRAIL_MAX_VIEWER_EXCHANGES = 100;
export const TRAIL_DEFAULT_CLEANUP_DAYS = 2;
export const TRAIL_DEFAULT_MAX_ENTRIES = 1000;

export const FILE_EXT_TODO = '.todo.yaml';
export const FILE_EXT_CHAT = '.chat.md';
export const FILE_EXT_PROMPT = '.prompt.md';
export const FILE_EXT_TRAIL_PROMPT = '.userprompt.md';
export const FILE_EXT_TRAIL_ANSWER = '.answer.json';
export const FILE_EXT_PROMPTS_MD = '.prompts.md';
export const FILE_EXT_ANSWERS_MD = '.answers.md';

export const GLOB_TODO = '**/*.todo.yaml';
export const GLOB_PROMPT = '**/*.prompt.md';
export const GLOB_CHAT = '**/*.chat.md';

/**
 * The option set every tool picker renders — status page, Anthropic profile
 * editor, the global template editors, and the MCP server card. A profile with
 * `toolsEnabled: false` gets exactly the tools its `enabledTools` allow-list
 * names, and that allow-list is built by ticking these boxes, so a tool absent
 * here is unreachable under such a profile no matter what `ALL_SHARED_TOOLS`
 * holds.
 *
 * It therefore mirrors ALL_SHARED_TOOLS in tool-executors.ts, minus the
 * deliberate exclusions listed in DELIBERATELY_UNSELECTABLE_TOOLS below. That
 * relationship is enforced — see tools/__tests__/tool-registry-parity.test.ts —
 * so a new tool must be added here (with a CATEGORY_MAP entry in
 * utils/toolCategories.ts) or excluded on purpose; it cannot be forgotten.
 */
export const AVAILABLE_LLM_TOOLS = [
    // Read-only file / workspace tools
    'tomAi_readFile',
    'tomAi_listDirectory',
    'tomAi_findFiles',
    'tomAi_findTextInFiles',
    'tomAi_fetchWebpage',
    'tomAi_webSearch',
    'tomAi_getErrors',
    // Guidelines — global + project
    // Ask-AI tools
    'tomAi_askBigBrother',
    'tomAi_askCopilot',
    // Write / mutating file tools
    'tomAi_createFile',
    'tomAi_editFile',
    'tomAi_multiEditFile',
    'tomAi_deleteFile',
    'tomAi_moveFile',
    // Shell / VS Code
    'tomAi_runCommand',
    'tomAi_runVscodeCommand',
    // Git (read-only, structured)
    'tomAi_gitRead',
    // Todo / task management
    'tomAi_manageTodo',
    // Chat variables
    'tomAi_readChatVariable',
    'tomAi_writeChatVariable',
    // Memory
    'tomAi_readMemory',
    'tomAi_listMemory',
    'tomAi_saveMemory',
    'tomAi_updateMemory',
    'tomAi_forgetMemory',
    // Editor / workspace context
    'tomAi_getWorkspaceInfo',
    'tomAi_getActiveEditor',
    'tomAi_getOpenEditors',
    // Diagnostics
    'tomAi_getProblems',
    // Language service
    'tomAi_findSymbol',
    'tomAi_gotoDefinition',
    'tomAi_findReferences',
    'tomAi_getCodeActions',
    // Guidelines — global + project (scope applies at each tool)
    'tomAi_readGlobalGuideline',
    'tomAi_listGlobalGuidelines',
    'tomAi_searchGlobalGuidelines',
    'tomAi_readProjectGuideline',
    'tomAi_listProjectGuidelines',
    'tomAi_searchProjectGuidelines',
    // VS Code commands and navigation
    'tomAi_openFile',
    'tomAi_listCommands',
    'tomAi_runVscodeCommandTyped',
    // User interaction
    'tomAi_askUser',
    'tomAi_askUserPicker',
    // Workspace-wide edit
    'tomAi_applyEdit',
    // Language service (cached code-action + rename)
    'tomAi_getCodeActionsCached',
    'tomAi_applyCodeAction',
    'tomAi_rename',
    // Tasks / debug
    'tomAi_runTask',
    'tomAi_runDebugConfig',
    // Streaming processes
    'tomAi_runCommandStream',
    'tomAi_readCommandOutput',
    'tomAi_killCommand',
    // Git (write + show)
    'tomAi_gitWrite',
    'tomAi_gitShow',
    // Planning + delegation
    'tomAi_enterPlanMode',
    'tomAi_exitPlanMode',
    'tomAi_spawnSubagent',
    // Notebook
    'tomAi_notebookEdit',
    'tomAi_notebookRun',
    // Pattern prompts
    'tomAi_listPatternPrompts',
    'tomAi_readPatternPrompt',
    // Quest todos
    'tomAi_listQuestTodos',
    'tomAi_getQuestTodo',
    'tomAi_createQuestTodo',
    'tomAi_updateQuestTodo',
    'tomAi_moveQuestTodo',
    'tomAi_deleteQuestTodo',
    'tomAi_archiveQuestTodos',
    'tomAi_deleteQuestTodos',
    'tomAi_listWorkspaceQuestTodos',
    'tomAi_getCombinedTodos',
    'tomAi_listQuests',
    // Quest / workspace introspection
    'tomAi_getActiveQuest',
    'tomAi_listProjects',
    'tomAi_listDocuments',
    // Session todos
    'tomAi_addSessionTodo',
    'tomAi_listSessionTodos',
    'tomAi_getAllSessionTodos',
    'tomAi_updateSessionTodo',
    'tomAi_deleteSessionTodo',
    // Notification
    'tomAi_notifyUser',
    // Issues (bottom-panel WS tab — issue tracker)
    'tomAi_listIssueRepos',
    'tomAi_listIssues',
    'tomAi_getIssue',
    'tomAi_listIssueComments',
    'tomAi_createIssue',
    'tomAi_addIssueComment',
    'tomAi_setIssueStatus',
    'tomAi_toggleIssueLabel',
    // Tests (bottom-panel WS tab — testkit)
    'tomAi_listTestRepos',
    'tomAi_listTests',
    'tomAi_getTest',
    'tomAi_listTestComments',
    'tomAi_createTest',
    'tomAi_addTestComment',
    'tomAi_setTestStatus',
    'tomAi_toggleTestLabel',
    // AI Conversation — result document (the only mutation exposed there)
    'tomAi_readConversationResult',
    'tomAi_writeConversationResult',
    // Prompt + reminder templates (split from manage-style)
    'tomAi_listPromptTemplates',
    'tomAi_createPromptTemplate',
    'tomAi_updatePromptTemplate',
    'tomAi_deletePromptTemplate',
    'tomAi_listReminderTemplates',
    'tomAi_createReminderTemplate',
    'tomAi_updateReminderTemplate',
    'tomAi_deleteReminderTemplate',
    // Id generation
    'tomAi_generateIdPrefix',
    // Queue + timed requests — observation only; the mutators and the dispatch
    // entry points are in DELIBERATELY_UNSELECTABLE_TOOLS below.
    'tomAi_listQueue',
    'tomAi_listTimedRequests',
    // Past tool calls + prompt history (read-only trail access)
    'tomAi_listPastToolCalls',
    'tomAi_searchPastToolResults',
    'tomAi_readPastToolResult',
    'tomAi_listPromptPairs',
    'tomAi_getPromptPair',
] as const;

/**
 * Registered in ALL_SHARED_TOOLS but deliberately kept out of the pickers, so
 * they are reachable only under `toolsEnabled: true`.
 *
 * These are the queue and timer *control plane*: they let a caller enqueue,
 * edit, dispatch and re-send prompts, and switch the timer engine on and off.
 * A model that can tick them in its own profile can drive its own prompt loop —
 * which is a legitimate thing to want for an autonomous agent, but not
 * something an allow-list profile should be able to acquire by accident. The
 * read-only counterparts (`tomAi_listQueue`, `tomAi_listTimedRequests`) are
 * selectable: observing the queue carries no such risk.
 *
 * This is an exclusion, not a backlog. To make one of these selectable, move
 * the name into AVAILABLE_LLM_TOOLS and give it a CATEGORY_MAP entry.
 */
export const DELIBERATELY_UNSELECTABLE_TOOLS = [
    // Queue — mutation and dispatch
    'tomAi_addQueueItem',
    'tomAi_updateQueueItem',
    'tomAi_removeQueueItem',
    'tomAi_setQueueItemStatus',
    'tomAi_addQueueFollowUp',
    'tomAi_updateQueueFollowUp',
    'tomAi_removeQueueFollowUp',
    'tomAi_addQueuePrePrompt',
    'tomAi_updateQueuePrePrompt',
    'tomAi_removeQueuePrePrompt',
    'tomAi_sendQueuedPrompt',
    'tomAi_resendQueueItem',
    // Timed requests — mutation and the engine kill switch
    'tomAi_addTimedRequest',
    'tomAi_updateTimedRequest',
    'tomAi_removeTimedRequest',
    'tomAi_setTimerEngineState',
] as const;
