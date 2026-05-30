/**
 * Language-service tools — aggregator only.
 *
 * After the entry #10 + #11 coverage refactors, every tool in this
 * family lives in its own vscode-free file with `*Impl(deps, input)`
 * overloads and dedicated tests:
 *
 *   - Navigation (find/goto/refs) → `language-navigation.ts`
 *   - Code actions (3 tools + 5-min registry) → `code-action-tools.ts`
 *   - Rename → `rename-tool.ts`
 *
 * This file is now just a re-export + master-list aggregator so the
 * existing `import { LANGUAGE_SERVICE_TOOLS } from './language-service-tools'`
 * call site in `tool-executors.ts` keeps working without churn.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import {
    FIND_SYMBOL_TOOL,
    GOTO_DEFINITION_TOOL,
    FIND_REFERENCES_TOOL,
} from './language-navigation';
import {
    GET_CODE_ACTIONS_TOOL,
    GET_CODE_ACTIONS_CACHED_TOOL,
    APPLY_CODE_ACTION_TOOL,
} from './code-action-tools';
import { RENAME_TOOL } from './rename-tool';

export {
    FIND_SYMBOL_TOOL,
    GOTO_DEFINITION_TOOL,
    FIND_REFERENCES_TOOL,
    GET_CODE_ACTIONS_TOOL,
    GET_CODE_ACTIONS_CACHED_TOOL,
    APPLY_CODE_ACTION_TOOL,
    RENAME_TOOL,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LANGUAGE_SERVICE_TOOLS: SharedToolDefinition<any>[] = [
    FIND_SYMBOL_TOOL,
    GOTO_DEFINITION_TOOL,
    FIND_REFERENCES_TOOL,
    GET_CODE_ACTIONS_TOOL,
    GET_CODE_ACTIONS_CACHED_TOOL,
    APPLY_CODE_ACTION_TOOL,
    RENAME_TOOL,
];
