/**
 * The files behind the Role Editor and the Role Type Editor (vscimpb87):
 * `_ai/roles/<role>/role.md` with `role-config.yaml`, and
 * `_ai/role-types/<type>/role-type.yaml`. Every write is checked against the
 * file's JSON schema (utils/roleTypes.ts) and refused when it does not match;
 * each YAML file starts with its `# yaml-language-server: $schema=` line,
 * pointing at the workspace's copy of the schema (`.tom/json-schema/roles/`).
 *
 * vscode-free: the folders come in as arguments.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    parseRoleConfig, parseRoleType, ROLE_CONFIG_FILE, ROLE_ID_PATTERN, ROLE_TYPE_FILE, ROLE_TYPES_FOLDER, schemaLine,
    serializeRoleConfig, serializeRoleType, type RoleType,
} from '../utils/roleTypes';

export interface RoleRecord {
    id: string;
    /** role.md as written ('' when the folder has none). */
    roleMd: string;
    /** The role type its role-config.yaml names. */
    roleType?: string;
    /** Why role-config.yaml could not be read. */
    configError?: string;
}

export interface RoleTypeRecord {
    id: string;
    value?: RoleType;
    /** Why role-type.yaml could not be read. */
    error?: string;
    /** The roles naming this type. */
    usedBy: string[];
}

export class RoleStore {
    constructor(private readonly workspaceRoot: string, private readonly aiRoot: string) {}

    private rolesDir(): string { return path.join(this.aiRoot, 'roles'); }
    private typesDir(): string { return path.join(this.aiRoot, ROLE_TYPES_FOLDER); }

    private folders(dir: string): string[] {
        if (!fs.existsSync(dir)) { return []; }
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && ROLE_ID_PATTERN.test(e.name))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b));
    }

    /** Every role (a folder of `_ai/roles/` holding role.md). */
    roles(): RoleRecord[] {
        return this.folders(this.rolesDir())
            .filter((id) => fs.existsSync(path.join(this.rolesDir(), id, 'role.md')))
            .map((id) => this.role(id)!);
    }

    role(id: string): RoleRecord | undefined {
        const dir = path.join(this.rolesDir(), id);
        if (!ROLE_ID_PATTERN.test(id) || !fs.existsSync(dir)) { return undefined; }
        const md = path.join(dir, 'role.md');
        const record: RoleRecord = { id, roleMd: fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '' };
        const configFile = path.join(dir, ROLE_CONFIG_FILE);
        if (fs.existsSync(configFile)) {
            const parsed = parseRoleConfig(fs.readFileSync(configFile, 'utf8'));
            if (parsed.ok) {
                if (parsed.value.roleType) { record.roleType = parsed.value.roleType; }
            } else {
                record.configError = parsed.errors.join('; ');
            }
        }
        return record;
    }

    /** Every role type, with the roles that name it. */
    roleTypes(): RoleTypeRecord[] {
        const roles = this.roles();
        return this.folders(this.typesDir())
            .filter((id) => fs.existsSync(path.join(this.typesDir(), id, ROLE_TYPE_FILE)))
            .map((id) => {
                const parsed = parseRoleType(fs.readFileSync(path.join(this.typesDir(), id, ROLE_TYPE_FILE), 'utf8'));
                const usedBy = roles.filter((r) => r.roleType === id).map((r) => r.id);
                return parsed.ok ? { id, value: parsed.value, usedBy } : { id, error: parsed.errors.join('; '), usedBy };
            });
    }

    /**
     * Save a role: role.md, and role-config.yaml naming its type. No type:
     * an existing role-config.yaml keeps no type; none is created.
     */
    saveRole(id: string, roleMd: string, roleType: string | undefined): void {
        if (!ROLE_ID_PATTERN.test(id)) { throw new Error(`"${id}" is not a role name (letters, digits, _ and -)`); }
        const type = roleType?.trim() || undefined;
        if (type && !fs.existsSync(path.join(this.typesDir(), type, ROLE_TYPE_FILE))) { throw new Error(`role type "${type}" does not exist`); }
        const dir = path.join(this.rolesDir(), id);
        fs.mkdirSync(dir, { recursive: true });
        const configFile = path.join(dir, ROLE_CONFIG_FILE);
        if (type || fs.existsSync(configFile)) {
            const text = serializeRoleConfig(type ? { roleType: type } : {}, schemaLine(configFile, this.workspaceRoot, 'roleConfig'));
            fs.writeFileSync(configFile, text);
        }
        fs.writeFileSync(path.join(dir, 'role.md'), roleMd.endsWith('\n') ? roleMd : `${roleMd}\n`);
    }

    /** A new role with a role.md to fill in. */
    createRole(id: string): void {
        if (!ROLE_ID_PATTERN.test(id)) { throw new Error(`"${id}" is not a role name (letters, digits, _ and -)`); }
        if (fs.existsSync(path.join(this.rolesDir(), id))) { throw new Error(`role "${id}" exists`); }
        const title = id.split(/[_-]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
        this.saveRole(id, `# ${title}\n\nWhat this role does.\n\n## Responsibilities\n\n- \n`, undefined);
    }

    /** Save a role type (role-type.yaml). */
    saveRoleType(id: string, value: RoleType): void {
        if (!ROLE_ID_PATTERN.test(id)) { throw new Error(`"${id}" is not a role type name (letters, digits, _ and -)`); }
        const file = path.join(this.typesDir(), id, ROLE_TYPE_FILE);
        const text = serializeRoleType(value, schemaLine(file, this.workspaceRoot, 'roleType'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }

    /** A new role type, keeping the profile's tools until its tools are selected. */
    createRoleType(id: string): void {
        if (fs.existsSync(path.join(this.typesDir(), id))) { throw new Error(`role type "${id}" exists`); }
        this.saveRoleType(id, { tools: { mode: 'profileDefault' } });
    }

    /** Delete a role type no role names. */
    deleteRoleType(id: string): void {
        const record = this.roleTypes().find((t) => t.id === id);
        if (!record) { throw new Error(`role type "${id}" does not exist`); }
        if (record.usedBy.length) { throw new Error(`role type "${id}" is named by ${record.usedBy.join(', ')}; give those roles another type first`); }
        fs.rmSync(path.join(this.typesDir(), id), { recursive: true, force: true });
    }
}
