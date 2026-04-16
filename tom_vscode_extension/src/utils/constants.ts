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
export const GLOB_FLOW = '*.flow.yaml';
export const GLOB_STATE = '*.state.yaml';
export const GLOB_ER = '*.er.yaml';

/**
 * Canonical list of tool names that can be exposed to LLM configurations.
 * Derived from ALL_SHARED_TOOLS in tool-executors.ts — update both together
 * when adding new tools.
 * Used in the status page tool picker and the Anthropic profile editor.
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
    'tomAi_readLocalGuideline',
    'tomAi_readGuideline',
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
    'tomAi_git',
    // Todo / task management
    'tomAi_manageTodo',
    // Chat variables
    'tomAi_chatvar_read',
    'tomAi_chatvar_write',
    // Memory
    'tomAi_memory_read',
    'tomAi_memory_list',
    'tomAi_memory_save',
    'tomAi_memory_update',
    'tomAi_memory_forget',
    // Wave A — workspace awareness (llm_tools.md §6.3)
    'tomAi_getWorkspaceInfoFull',
    'tomAi_getActiveEditor',
    'tomAi_getOpenEditors',
    'tomAi_getProblems',
    'tomAi_getOutputChannel',
    'tomAi_getTerminalOutput',
    'tomAi_findSymbol',
    'tomAi_gotoDefinition',
    'tomAi_findReferences',
    'tomAi_getCodeActions',
    'tomAi_listGuidelines',
    'tomAi_searchGuidelines',
    // Wave B — IDE navigation (llm_tools.md §6.3)
    'tomAi_openFile',
    'tomAi_listCommands',
    'tomAi_askUser',
    'tomAi_askUserPicker',
] as const;
