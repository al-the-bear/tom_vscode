/**
 * The roles of the workspace: the folders (or `.md` / `.yaml` files) under
 * `_ai/roles/`. A role named in a chat variable or a process step is one of
 * these names.
 */

import * as fs from 'fs';

/** Role names under `rolesDir`, sorted; `[]` when it does not exist. */
export function listRoleNames(rolesDir: string | undefined): string[] {
    if (!rolesDir || !fs.existsSync(rolesDir)) { return []; }
    try {
        return fs.readdirSync(rolesDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() || e.name.endsWith('.md') || e.name.endsWith('.yaml'))
            .map((e) => (e.isDirectory() ? e.name : e.name.replace(/\.(md|yaml)$/, '')))
            .sort();
    } catch {
        return [];
    }
}

/** A role name as a folder of `_ai/roles/` may be named (the Role Editor's rule). */
export const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Why `role` cannot be stored as a todo's, a queue item's or a run's role
 * (gsel3), or undefined when it can: `''` / undefined clear it; anything else
 * must be a role name and, when `rolesDir` has roles, one of them.
 */
export function roleRefusal(role: unknown, rolesDir: string | undefined): string | undefined {
    if (role === undefined || role === null || role === '') { return undefined; }
    if (typeof role !== 'string' || !ROLE_NAME_PATTERN.test(role)) {
        return `role must be a role folder name ([A-Za-z0-9][A-Za-z0-9_-]*), not ${JSON.stringify(role)}`;
    }
    const roles = listRoleNames(rolesDir);
    if (roles.length > 0 && !roles.includes(role)) {
        return `role "${role}" is not a role of _ai/roles/ (the roles: ${roles.join(', ')})`;
    }
    return undefined;
}
