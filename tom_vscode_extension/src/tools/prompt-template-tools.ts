/**
 * Prompt-template tools — `tomAi_createPromptTemplate`,
 * `tomAi_deletePromptTemplate`, `tomAi_listPromptTemplates`,
 * `tomAi_updatePromptTemplate`.
 *
 * Carved out of `chat-enhancement-tools.ts` for coverage entry #20.
 *
 * ## Two transport-keyed stores with different identity models
 *
 *   - **`copilot`** (default): `config.copilot.templates` is a **map
 *     keyed by display name** — `{ "Default": { template, showInMenu },
 *     "Code Review": { template, showInMenu }, ... }`. **The name IS
 *     the id.** Renaming = deleting one entry + creating a new one;
 *     references that used the old name break.
 *
 *   - **`anthropic`**: `config.anthropic.userMessageTemplates` is an
 *     **array of `{ id, name, description?, template, isDefault? }`**.
 *     `id` and `name` are SEPARATE — the id is the stable identifier;
 *     the name is a human-readable label that can change freely.
 *     Renaming the id (via `newId`) is supported but moves the
 *     identity; renaming just the name is purely cosmetic.
 *
 * Both stores live in the workspace `tom_vscode_extension.json` config
 * file. Writes go through `saveSendToChatConfig` which round-trips the
 * full config, preserving fields unrelated to templates.
 *
 * ## NO category enum
 *
 * The coverage doc's a-row asks about a "category enum" — there isn't
 * one. Templates have name/id, body, and (copilot only) a `showInMenu`
 * boolean. The descriptions now explicitly deny the category concept
 * so the model doesn't try to filter by it.
 *
 * ## Placeholder syntax
 *
 *   - **Copilot templates** typically use `${originalPrompt}` to inject
 *     the queued prompt body, plus any chat-variable placeholders
 *     (`${quest}`, `${role}`, etc.).
 *   - **Anthropic templates** typically use `${userMessage}` for the
 *     user's message body. Same chat-variable placeholders apply.
 *
 * Other recognised placeholders are documented on the placeholder-
 * engine guideline — `${memory}`, `${toolHistory}`, `${file:path}`, etc.
 *
 * ## Safer-by-default
 *
 *   - `createPromptTemplate` now requires explicit `overwrite: true`
 *     to replace an existing copilot template (matches `tomAi_createFile`
 *     post entry #2; Anthropic already errored, copilot used to silently
 *     overwrite).
 *   - `updatePromptTemplate` rename now requires `overwrite: true` if
 *     the new name/id already exists. Previously Copilot deleted the
 *     original AND clobbered the rename target — silent data loss.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Shared shapes
// ===========================================================================

export type TemplateTransport = 'copilot' | 'anthropic';

export interface CopilotTemplateEntry {
    template: string;
    showInMenu?: boolean;
}

export interface AnthropicTemplateEntry {
    id: string;
    name: string;
    description?: string;
    template: string;
    isDefault?: boolean;
}

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface CopilotTemplateStoreAccess {
    list(): Record<string, CopilotTemplateEntry>;
    has(name: string): boolean;
    set(name: string, entry: CopilotTemplateEntry): void;
    delete(name: string): boolean;
}

export interface AnthropicTemplateStoreAccess {
    list(): AnthropicTemplateEntry[];
    find(id: string): AnthropicTemplateEntry | undefined;
    add(entry: AnthropicTemplateEntry): void;
    update(id: string, patch: Partial<AnthropicTemplateEntry> & { newId?: string }): AnthropicTemplateEntry | undefined;
    delete(id: string): boolean;
    /** Unset `isDefault` on every entry except `id`. */
    setDefault(id: string): void;
}

export interface PromptTemplateStore {
    copilot: CopilotTemplateStoreAccess;
    anthropic: AnthropicTemplateStoreAccess;
}

// ===========================================================================
// Helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

function resolveTransport(input: { transport?: TemplateTransport } | undefined): TemplateTransport {
    return input?.transport === 'anthropic' ? 'anthropic' : 'copilot';
}

const DEFAULT_COPILOT_BODY = '${originalPrompt}';
const DEFAULT_ANTHROPIC_BODY = '${userMessage}';

// ===========================================================================
// tomAi_listPromptTemplates
// ===========================================================================

export interface ListPromptTemplatesInput {
    transport?: TemplateTransport;
}

export async function listPromptTemplatesImpl(store: PromptTemplateStore, input: ListPromptTemplatesInput): Promise<string> {
    try {
        const transport = resolveTransport(input);
        if (transport === 'anthropic') {
            const list = store.anthropic.list();
            return JSON.stringify({
                ok: true, transport,
                count: list.length,
                templates: list.map((t) => ({
                    transport,
                    id: t.id,
                    name: t.name,
                    description: t.description,
                    template: t.template,
                    isDefault: t.isDefault === true,
                })),
            }, null, 2);
        }
        const map = store.copilot.list();
        const templates = Object.entries(map).map(([name, value]) => ({
            transport,
            name,
            template: value.template,
            showInMenu: value.showInMenu !== false,
        }));
        return JSON.stringify({ ok: true, transport, count: templates.length, templates }, null, 2);
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_PROMPT_TEMPLATES_DESCRIPTION =
    'List prompt templates. **Two stores keyed by `transport`**: ' +
    '`copilot` (default — map keyed by display name; entries have ' +
    '`{template, showInMenu}`) and `anthropic` (array of `{id, name, ' +
    'description, template, isDefault}`; id is the stable key, name is ' +
    'the human label). **NO category field** in either store — templates ' +
    'have name/id and body only. Pass `transport: "anthropic"` to list ' +
    'the Anthropic user-message templates instead.';

export const LIST_PROMPT_TEMPLATES_TOOL: SharedToolDefinition<ListPromptTemplatesInput> = {
    name: 'tomAi_listPromptTemplates',
    displayName: 'List Prompt Templates',
    description: LIST_PROMPT_TEMPLATES_DESCRIPTION,
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Default `copilot`.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_createPromptTemplate
// ===========================================================================

export interface CreatePromptTemplateInput {
    transport?: TemplateTransport;
    name: string;
    template?: string;
    /** Copilot only. Default true. */
    showInMenu?: boolean;
    /** Anthropic only. */
    description?: string;
    /** Anthropic only — defaults to `name` when omitted. */
    id?: string;
    /** Anthropic only — when true, unsets `isDefault` on every other template. */
    isDefault?: boolean;
    /** Replace an existing template with the same name/id. Default false. */
    overwrite?: boolean;
}

export async function createPromptTemplateImpl(store: PromptTemplateStore, input: CreatePromptTemplateInput): Promise<string> {
    try {
        if (!input.name || !input.name.trim()) {
            return err('`name` is required.');
        }
        const transport = resolveTransport(input);

        if (transport === 'anthropic') {
            const id = input.id?.trim() || input.name.trim();
            if (store.anthropic.find(id)) {
                if (!input.overwrite) {
                    return err(`Anthropic template with id "${id}" already exists. Pass \`overwrite: true\` to replace it, or use \`tomAi_updatePromptTemplate\`.`);
                }
                store.anthropic.delete(id);
            }
            store.anthropic.add({
                id,
                name: input.name,
                description: input.description,
                template: input.template || DEFAULT_ANTHROPIC_BODY,
                isDefault: input.isDefault === true,
            });
            if (input.isDefault === true) { store.anthropic.setDefault(id); }
            return ok({ transport, id, name: input.name });
        }

        // copilot
        const name = input.name.trim();
        if (store.copilot.has(name)) {
            if (!input.overwrite) {
                return err(`Copilot template "${name}" already exists. Pass \`overwrite: true\` to replace it, or use \`tomAi_updatePromptTemplate\`.`);
            }
        }
        store.copilot.set(name, {
            template: input.template || DEFAULT_COPILOT_BODY,
            showInMenu: input.showInMenu !== false,
        });
        return ok({ transport, name });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const CREATE_PROMPT_TEMPLATE_DESCRIPTION =
    'Create a prompt template in the `copilot` or `anthropic` store. ' +
    '**Both transports now reject silent overwrite** — pass ' +
    '`overwrite: true` to replace an existing template (or use ' +
    '`tomAi_updatePromptTemplate` instead). Default template body: ' +
    '`${originalPrompt}` for copilot, `${userMessage}` for anthropic. ' +
    'Anthropic `id` defaults to `name` when omitted; setting `isDefault: ' +
    'true` unsets the default flag on every other anthropic template in ' +
    'the same call. **Placeholder syntax** matches the placeholder ' +
    'engine: `${originalPrompt}` / `${userMessage}` for the prompt body, ' +
    'plus chat-variable expansions (`${quest}`, `${role}`, `${memory}`, ' +
    '`${file:path}`, …).';

export const CREATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<CreatePromptTemplateInput> = {
    name: 'tomAi_createPromptTemplate',
    displayName: 'Create Prompt Template',
    description: CREATE_PROMPT_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Default `copilot`.' },
            name: { type: 'string', description: 'Copilot: also the key. Anthropic: display label.' },
            template: { type: 'string', description: 'Default `${originalPrompt}` (copilot) or `${userMessage}` (anthropic).' },
            showInMenu: { type: 'boolean', description: 'Copilot only. Default true.' },
            description: { type: 'string', description: 'Anthropic only.' },
            id: { type: 'string', description: 'Anthropic only. Defaults to `name`.' },
            isDefault: { type: 'boolean', description: 'Anthropic only. Sets this as the default + unsets others.' },
            overwrite: { type: 'boolean', description: 'Replace an existing template with the same name/id. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_updatePromptTemplate
// ===========================================================================

export interface UpdatePromptTemplateInput {
    transport?: TemplateTransport;
    /** Copilot: existing template name. Anthropic: optional new display name. */
    name?: string;
    /** Copilot only — rename target. */
    newName?: string;
    template?: string;
    showInMenu?: boolean;
    description?: string;
    /** Anthropic only — existing template id. */
    id?: string;
    /** Anthropic only — rename target id. */
    newId?: string;
    isDefault?: boolean;
    /** Permit the rename to clobber an existing target. Default false. */
    overwrite?: boolean;
}

export async function updatePromptTemplateImpl(store: PromptTemplateStore, input: UpdatePromptTemplateInput): Promise<string> {
    try {
        const transport = resolveTransport(input);
        if (transport === 'anthropic') {
            const lookupId = input.id || input.name;
            if (!lookupId) { return err('`id` or `name` is required to look up an anthropic template.'); }
            const existing = store.anthropic.find(lookupId);
            if (!existing) {
                return err(`Anthropic template with id "${lookupId}" not found. Use \`tomAi_listPromptTemplates\` to see available ids.`);
            }
            const targetId = input.newId?.trim() || existing.id;
            if (targetId !== existing.id && store.anthropic.find(targetId)) {
                if (!input.overwrite) {
                    return err(`Anthropic template with id "${targetId}" already exists. Pass \`overwrite: true\` to clobber it.`);
                }
                store.anthropic.delete(targetId);
            }
            const updated = store.anthropic.update(existing.id, {
                newId: targetId,
                name: input.name,
                description: input.description,
                template: input.template,
                isDefault: input.isDefault,
            });
            if (input.isDefault === true && updated) { store.anthropic.setDefault(targetId); }
            return ok({ transport, id: targetId, name: updated?.name ?? input.name });
        }

        // copilot
        if (!input.name) {
            return err('`name` (existing template) is required for copilot.');
        }
        if (!store.copilot.has(input.name)) {
            return err(`Copilot template "${input.name}" not found. Use \`tomAi_listPromptTemplates\` to see available names.`);
        }
        const old = store.copilot.list()[input.name];
        const targetName = input.newName?.trim() || input.name;
        if (targetName !== input.name && store.copilot.has(targetName)) {
            if (!input.overwrite) {
                return err(`Cannot rename to "${targetName}" — that name is already in use. Pass \`overwrite: true\` to clobber the existing template.`);
            }
        }
        if (targetName !== input.name) { store.copilot.delete(input.name); }
        store.copilot.set(targetName, {
            template: input.template !== undefined ? input.template : old.template,
            showInMenu: input.showInMenu !== undefined ? input.showInMenu : (old.showInMenu !== false),
        });
        return ok({ transport, name: targetName, renamedFrom: targetName !== input.name ? input.name : undefined });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const UPDATE_PROMPT_TEMPLATE_DESCRIPTION =
    'Patch an existing prompt template. **Copilot**: keyed by `name`; ' +
    'pass `newName` to rename. **Anthropic**: keyed by `id`; pass ' +
    '`newId` to rename the id (separate from `name` which is a cosmetic ' +
    'display label). **Rename collisions** are rejected unless ' +
    '`overwrite: true` (previously Copilot silently clobbered the rename ' +
    'target — data-loss trap). Setting `isDefault: true` on anthropic ' +
    'unsets `isDefault` on every other anthropic template. Missing ids/ ' +
    'names surface a pointer at `tomAi_listPromptTemplates`.';

export const UPDATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<UpdatePromptTemplateInput> = {
    name: 'tomAi_updatePromptTemplate',
    displayName: 'Update Prompt Template',
    description: UPDATE_PROMPT_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Default `copilot`.' },
            name: { type: 'string', description: 'Copilot: existing template name. Anthropic: new display name (optional).' },
            newName: { type: 'string', description: 'Copilot only — rename target.' },
            template: { type: 'string' },
            showInMenu: { type: 'boolean', description: 'Copilot only.' },
            description: { type: 'string', description: 'Anthropic only.' },
            id: { type: 'string', description: 'Anthropic only — existing template id.' },
            newId: { type: 'string', description: 'Anthropic only — rename target id.' },
            isDefault: { type: 'boolean', description: 'Anthropic only.' },
            overwrite: { type: 'boolean', description: 'Permit rename target to clobber an existing template. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_deletePromptTemplate
// ===========================================================================

export interface DeletePromptTemplateInput {
    transport?: TemplateTransport;
    name?: string;
    id?: string;
}

export async function deletePromptTemplateImpl(store: PromptTemplateStore, input: DeletePromptTemplateInput): Promise<string> {
    try {
        const transport = resolveTransport(input);
        if (transport === 'anthropic') {
            if (!input.id) { return err('`id` is required for anthropic templates.'); }
            const existed = store.anthropic.delete(input.id);
            if (!existed) {
                return err(`Anthropic template with id "${input.id}" not found. Use \`tomAi_listPromptTemplates\` to see available ids.`);
            }
            return ok({ transport, id: input.id });
        }
        if (!input.name) { return err('`name` is required for copilot templates.'); }
        const existed = store.copilot.delete(input.name);
        if (!existed) {
            return err(`Copilot template "${input.name}" not found. Use \`tomAi_listPromptTemplates\` to see available names.`);
        }
        return ok({ transport, name: input.name });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const DELETE_PROMPT_TEMPLATE_DESCRIPTION =
    'Delete a prompt template. Copilot needs `name`; anthropic needs ' +
    '`id`. **NOT idempotent** — deleting an unknown template returns a ' +
    'structured "not found" error with a pointer at ' +
    '`tomAi_listPromptTemplates`. To remove a template that may or may ' +
    'not exist without that error, call list first to check.';

export const DELETE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<DeletePromptTemplateInput> = {
    name: 'tomAi_deletePromptTemplate',
    displayName: 'Delete Prompt Template',
    description: DELETE_PROMPT_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            transport: { type: 'string', enum: ['copilot', 'anthropic'], description: 'Default `copilot`.' },
            name: { type: 'string', description: 'Copilot template name.' },
            id: { type: 'string', description: 'Anthropic template id.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROMPT_TEMPLATE_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PROMPT_TEMPLATES_TOOL,
    CREATE_PROMPT_TEMPLATE_TOOL,
    UPDATE_PROMPT_TEMPLATE_TOOL,
    DELETE_PROMPT_TEMPLATE_TOOL,
];
