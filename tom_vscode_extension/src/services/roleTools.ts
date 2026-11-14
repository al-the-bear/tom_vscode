/**
 * A send's tools by the role it runs as (vscimpb87): the process step's role
 * while a Proceed prompt runs (`ProcessStateStore.runRole()`), else the chat
 * variable `role`. When that role's type selects tools (`_ai/role-types/<type>/role-type.yaml`,
 * mode `selected`), they replace the profile's selection — with the
 * extension's always-on tools — on every transport; `profileDefault`, a role
 * without `role-config.yaml` and a run without a role keep the profile's tools.
 * Applied once per send in `AnthropicHandler.sendMessageOwned`, before the
 * external MCP tools and the tool plan; an isolated send (a sub-agent) keeps
 * its own list.
 */

import * as path from 'path';
import { resolveRoleTools, type RoleToolsResolution } from '../utils/roleTypes';
import { WsPaths } from '../utils/workspacePaths';

export interface RoleToolsDeps {
    /** The role the send runs as ('' or 'default': none). */
    role(): string | undefined;
    /** The `_ai` folder. */
    aiRoot(): string | undefined;
}

/** The live role: the running Proceed's step role, else the chat variable `role`. */
export const liveRoleToolsDeps: RoleToolsDeps = {
    role: () => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const pss = (require('../managers/processStateStore') as typeof import('../managers/processStateStore')).ProcessStateStore.instance;
            const fromRun = pss?.runRole();
            if (fromRun) { return fromRun; }
        } catch { /* no process store */ }
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            return (require('../managers/chatVariablesStore') as typeof import('../managers/chatVariablesStore')).ChatVariablesStore.instance?.role;
        } catch { return undefined; }
    },
    aiRoot: () => {
        const roles = WsPaths.ai('roles');
        return roles ? path.dirname(roles) : undefined;
    },
};

let deps: RoleToolsDeps = liveRoleToolsDeps;

/** Tests: the role and `_ai` folder a send reads (undefined: the live ones). */
export function __setRoleToolsDepsForTests(next: RoleToolsDeps | undefined): void {
    deps = next ?? liveRoleToolsDeps;
}

/** Where the current send's tools come from. */
export function currentRoleTools(): RoleToolsResolution {
    const aiRoot = deps.aiRoot();
    const role = deps.role();
    return aiRoot ? resolveRoleTools(aiRoot, role) : { role: role ?? '', note: 'no workspace: the profile\'s tools' };
}

/**
 * The send's tools for its role: `tools` unchanged when the role keeps the
 * profile's selection, else the registry's tools the role type names.
 */
export function roleScopedTools<T extends { name: string }>(tools: T[], registry: readonly T[], isolated: boolean): { tools: T[]; resolution?: RoleToolsResolution } {
    if (isolated) { return { tools }; }
    const resolution = currentRoleTools();
    if (!resolution.tools) { return { tools, resolution }; }
    const wanted = new Set(resolution.tools);
    return { tools: registry.filter((t) => wanted.has(t.name)), resolution };
}
