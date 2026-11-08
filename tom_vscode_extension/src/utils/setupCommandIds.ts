/**
 * The ids of the setup commands — Create New Quest and Setup New Workspace
 * Folder. A leaf module (no imports): the panels' "no quest is open" banner
 * (handlers/questHint-handler.ts) is loaded through handler_shared's import
 * chain, so it must not take these ids from the command handlers themselves,
 * which would hand it an id still undefined while that chain is loading.
 */

export const CREATE_QUEST_COMMAND = 'tomAi.createQuest';
export const SETUP_WORKSPACE_COMMAND = 'tomAi.setupWorkspaceFolder';
