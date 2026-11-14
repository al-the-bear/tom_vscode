/**
 * Roles and role types (vscimpb87).
 *
 * A **role type** (`_ai/role-types/<type>/role-type.yaml`) configures a kind of
 * role, starting with its tools: `profileDefault` keeps the profile's own tool
 * selection, `selected` gives exactly the tools it lists. Those replace the
 * profile's selection; the extension's always-on tools are added.
 *
 * A **role** (`_ai/roles/<role>/`) has its `role.md` and a `role-config.yaml`
 * naming its type (`roleType`). A role without one, or a run without a role,
 * runs with the profile's tools.
 *
 * The files are validated against the JSON schemas `src/config/role-type.schema.json`
 * and `role-config.schema.json` (copied into the workspace's
 * `.tom/json-schema/roles/`).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { parse, stringify } from 'yaml';

/** The file of a role type in its folder. */
export const ROLE_TYPE_FILE = 'role-type.yaml';
/** The configuration file of a role in its folder, beside role.md. */
export const ROLE_CONFIG_FILE = 'role-config.yaml';
/** The folder of the role types under `_ai`. */
export const ROLE_TYPES_FOLDER = 'role-types';

/**
 * Tools every prompt keeps whatever its role type says: asking the user,
 * moving the process, reporting and tracking todos, waiting. A role type
 * cannot switch them off; the editors show them greyed and on. A profile with
 * a tool selection of its own gets them too.
 */
export const ALWAYS_ON_TOOLS: readonly string[] = [
    'tomAi_askUser',
    'tomAi_askUserPicker',
    'tomAi_askInMdBrowser',
    'tomAi_notifyUser',
    'tomAi_getProcessState',
    'tomAi_setProcessState',
    'tomAi_listQuestTodos',
    'tomAi_getQuestTodo',
    'tomAi_createQuestTodo',
    'tomAi_updateQuestTodo',
    'tomAi_generateIdPrefix',
    'tomAi_waitFor',
];

export type RoleToolsMode = 'profileDefault' | 'selected';

export interface RoleType {
    name?: string;
    description?: string;
    tools: { mode: RoleToolsMode; enabled?: string[] };
}

export interface RoleConfig {
    roleType?: string;
}

/** A folder name a role or role type may have. */
export const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type Validator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
const validators = new Map<string, Validator>();

/** The schema's path in the extension (`out/config/` beside `out/utils/`). */
export function roleSchemaPath(kind: 'roleType' | 'roleConfig'): string {
    return path.join(__dirname, '..', 'config', kind === 'roleType' ? 'role-type.schema.json' : 'role-config.schema.json');
}

function validator(kind: 'roleType' | 'roleConfig'): Validator {
    let v = validators.get(kind);
    if (!v) {
        const schema = JSON.parse(fs.readFileSync(roleSchemaPath(kind), 'utf8')) as object;
        v = new Ajv2020({ allErrors: true, strict: false }).compile(schema) as Validator;
        validators.set(kind, v);
    }
    return v;
}

/** The schema findings of `data` ([] when valid). */
export function validateRoleFile(kind: 'roleType' | 'roleConfig', data: unknown): string[] {
    const v = validator(kind);
    if (v(data)) { return []; }
    return (v.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message ?? 'does not match the schema'}`);
}

/** Read YAML text as a role type; undefined with the findings when it is not one. */
export function parseRoleType(text: string): { ok: true; value: RoleType } | { ok: false; errors: string[] } {
    let data: unknown;
    try { data = parse(text) ?? {}; } catch (e) { return { ok: false, errors: [`YAML: ${(e as Error).message}`] }; }
    const errors = validateRoleFile('roleType', data);
    return errors.length ? { ok: false, errors } : { ok: true, value: data as RoleType };
}

/** Read YAML text as a role configuration. */
export function parseRoleConfig(text: string): { ok: true; value: RoleConfig } | { ok: false; errors: string[] } {
    let data: unknown;
    try { data = parse(text) ?? {}; } catch (e) { return { ok: false, errors: [`YAML: ${(e as Error).message}`] }; }
    const errors = validateRoleFile('roleConfig', data);
    return errors.length ? { ok: false, errors } : { ok: true, value: data as RoleConfig };
}

/** The `# yaml-language-server: $schema=` line of a file at `file`, pointing at the workspace's copy of the schema. */
export function schemaLine(file: string, workspaceRoot: string, kind: 'roleType' | 'roleConfig'): string {
    const schema = path.join(workspaceRoot, '.tom', 'json-schema', 'roles', kind === 'roleType' ? 'role-type.schema.json' : 'role-config.schema.json');
    return `# yaml-language-server: $schema=${path.relative(path.dirname(file), schema).split(path.sep).join('/')}`;
}

/** A role type as its file's text (refused when it does not match the schema). */
export function serializeRoleType(value: RoleType, header: string): string {
    const clean: RoleType = {
        ...(value.name?.trim() ? { name: value.name.trim() } : {}),
        ...(value.description?.trim() ? { description: value.description.trim() } : {}),
        // A mode other than the two is kept as given, so the schema refuses it.
        tools: value?.tools?.mode === 'selected'
            ? { mode: 'selected', enabled: [...new Set((value.tools.enabled ?? []).filter((t) => !ALWAYS_ON_TOOLS.includes(t)))].sort() }
            : value?.tools?.mode === 'profileDefault' ? { mode: 'profileDefault' } : { ...(value?.tools ?? {}) } as RoleType['tools'],
    };
    const errors = validateRoleFile('roleType', clean);
    if (errors.length) { throw new Error(`The role type does not match its schema: ${errors.join('; ')}`); }
    return `${header}\n${stringify(clean)}`;
}

/** A role configuration as its file's text. */
export function serializeRoleConfig(value: RoleConfig, header: string): string {
    const clean: RoleConfig = value.roleType?.trim() ? { roleType: value.roleType.trim() } : {};
    const errors = validateRoleFile('roleConfig', clean);
    if (errors.length) { throw new Error(`The role configuration does not match its schema: ${errors.join('; ')}`); }
    return `${header}\n${Object.keys(clean).length ? stringify(clean) : '{}\n'}`;
}

/**
 * The tool names a role type gives, or undefined when it keeps the profile's
 * selection (`profileDefault`). `selected`: its tools and the always-on ones.
 */
export function roleTypeToolNames(roleType: RoleType | undefined): string[] | undefined {
    if (!roleType || roleType.tools.mode !== 'selected') { return undefined; }
    return [...new Set([...ALWAYS_ON_TOOLS, ...(roleType.tools.enabled ?? [])])];
}

/** Where a role's tools come from, for the role named `role` under the `_ai` folder `aiRoot`. */
export interface RoleToolsResolution {
    role: string;
    roleType?: string;
    /** The tool names; undefined: the profile's selection. */
    tools?: string[];
    /** Why the profile's selection applies, or a file that could not be read. */
    note?: string;
}

/** The tools of the role `role`: its config's type, that type's tools. Missing or invalid files: the profile's. */
export function resolveRoleTools(aiRoot: string, role: string | undefined): RoleToolsResolution {
    const name = role?.trim() ?? '';
    if (!name || name === 'default' || !ROLE_ID_PATTERN.test(name)) { return { role: name, note: 'no role: the profile\'s tools' }; }
    const configFile = path.join(aiRoot, 'roles', name, ROLE_CONFIG_FILE);
    if (!fs.existsSync(configFile)) { return { role: name, note: `role ${name} has no ${ROLE_CONFIG_FILE}: the profile's tools` }; }
    const config = parseRoleConfig(fs.readFileSync(configFile, 'utf8'));
    if (!config.ok) { return { role: name, note: `${configFile} is not valid (${config.errors.join('; ')}): the profile's tools` }; }
    const type = config.value.roleType;
    if (!type) { return { role: name, note: `role ${name} names no role type: the profile's tools` }; }
    const typeFile = path.join(aiRoot, ROLE_TYPES_FOLDER, type, ROLE_TYPE_FILE);
    if (!fs.existsSync(typeFile)) { return { role: name, roleType: type, note: `role type ${type} does not exist: the profile's tools` }; }
    const parsed = parseRoleType(fs.readFileSync(typeFile, 'utf8'));
    if (!parsed.ok) { return { role: name, roleType: type, note: `${typeFile} is not valid (${parsed.errors.join('; ')}): the profile's tools` }; }
    const tools = roleTypeToolNames(parsed.value);
    return tools ? { role: name, roleType: type, tools } : { role: name, roleType: type, note: `role type ${type} keeps the profile's tools` };
}

/**
 * A profile's own tool selection with the always-on tools: a profile that
 * lists tools gets them too; one with no tools at all stays without.
 */
export function withAlwaysOnTools(enabled: readonly string[]): string[] {
    return enabled.length ? [...new Set([...enabled, ...ALWAYS_ON_TOOLS])] : [];
}
