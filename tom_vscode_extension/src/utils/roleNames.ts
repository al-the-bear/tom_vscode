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
