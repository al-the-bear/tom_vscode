/**
 * Prompt-template tools — `tomAi_createPromptTemplate`,
 * `tomAi_deletePromptTemplate`, `tomAi_listPromptTemplates`,
 * `tomAi_updatePromptTemplate`.
 *
 * ## One store
 *
 * The templates are the user-message templates,
 * `config.anthropic.userMessageTemplates`: an **array of `{ id, name,
 * description?, template, isDefault? }`**. Both transports read them — an
 * Anthropic send and a Copilot send (src/utils/copilotTemplates.ts). `id` is
 * the stable key; `name` is a label that can change freely. Renaming the id
 * (`newId`) moves the identity. The Copilot Queue Wrapper is not a template:
 * it is the `copilot.queueWrapper` setting.
 *
 * The store lives in the workspace `tom_vscode_extension.json`. Writes go
 * through `saveSendToChatConfig`, which round-trips the full config.
 *
 * ## NO category enum
 *
 * Templates have id, name, description, body and `isDefault`; the
 * descriptions deny a category concept so the model doesn't filter by it.
 *
 * ## Placeholder syntax
 *
 * `${userMessage}` is the prompt body (`${originalPrompt}` is filled the
 * same), plus the chat-variable placeholders (`${quest}`, `${role}`,
 * `${memory}`, `${file:path}`, …; see the placeholder-engine guideline).
 *
 * ## Safer-by-default
 *
 * Creating over an existing id, and renaming onto one, need `overwrite: true`.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Shared shapes
// ===========================================================================

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
    anthropic: AnthropicTemplateStoreAccess;
}

// ===========================================================================
// Helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

const DEFAULT_BODY = '${userMessage}';

// ===========================================================================
// tomAi_listPromptTemplates
// ===========================================================================

/** The list takes no input. */
export type ListPromptTemplatesInput = Record<string, never>;

export async function listPromptTemplatesImpl(store: PromptTemplateStore, _input: ListPromptTemplatesInput): Promise<string> {
    try {
        const list = store.anthropic.list();
        return JSON.stringify({
            ok: true,
            count: list.length,
            templates: list.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                template: t.template,
                isDefault: t.isDefault === true,
            })),
        }, null, 2);
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_PROMPT_TEMPLATES_DESCRIPTION =
    'List the prompt templates: the one store both transports (Anthropic and ' +
    'Copilot) read, `anthropic.userMessageTemplates` — `{id, name, ' +
    'description, template, isDefault}`; `id` is the stable key, `name` the ' +
    'label. **NO category field.** The Copilot Queue Wrapper is a setting ' +
    '(`copilot.queueWrapper`), not a template.';

export const LIST_PROMPT_TEMPLATES_TOOL: SharedToolDefinition<ListPromptTemplatesInput> = {
    name: 'tomAi_listPromptTemplates',
    displayName: 'List Prompt Templates',
    description: LIST_PROMPT_TEMPLATES_DESCRIPTION,
    tags: ['templates', 'copilot', 'anthropic'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_createPromptTemplate
// ===========================================================================

export interface CreatePromptTemplateInput {
    name: string;
    template?: string;
    description?: string;
    /** Defaults to `name` when omitted. */
    id?: string;
    /** When true, unsets `isDefault` on every other template. */
    isDefault?: boolean;
    /** Replace an existing template with the same id. Default false. */
    overwrite?: boolean;
}

export async function createPromptTemplateImpl(store: PromptTemplateStore, input: CreatePromptTemplateInput): Promise<string> {
    try {
        if (!input.name || !input.name.trim()) {
            return err('`name` is required.');
        }
        const id = input.id?.trim() || input.name.trim();
        if (store.anthropic.find(id)) {
            if (!input.overwrite) {
                return err(`A template with id "${id}" already exists. Pass \`overwrite: true\` to replace it, or use \`tomAi_updatePromptTemplate\`.`);
            }
            store.anthropic.delete(id);
        }
        store.anthropic.add({
            id,
            name: input.name,
            description: input.description,
            template: input.template || DEFAULT_BODY,
            isDefault: input.isDefault === true,
        });
        if (input.isDefault === true) { store.anthropic.setDefault(id); }
        return ok({ id, name: input.name });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const CREATE_PROMPT_TEMPLATE_DESCRIPTION =
    'Create a prompt template in the one template store (both transports read ' +
    'it). An existing id is not replaced unless `overwrite: true` (or use ' +
    '`tomAi_updatePromptTemplate`). Default body `${userMessage}`; `id` ' +
    'defaults to `name`; `isDefault: true` unsets the default flag on every ' +
    'other template. **Placeholder syntax** matches the placeholder engine: ' +
    '`${userMessage}` (or `${originalPrompt}`) for the prompt body, plus ' +
    'chat-variable expansions (`${quest}`, `${role}`, `${memory}`, ' +
    '`${file:path}`, …).';

export const CREATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<CreatePromptTemplateInput> = {
    name: 'tomAi_createPromptTemplate',
    displayName: 'Create Prompt Template',
    description: CREATE_PROMPT_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'copilot', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', description: 'Display label (and the id when `id` is omitted).' },
            template: { type: 'string', description: 'Default `${userMessage}`.' },
            description: { type: 'string' },
            id: { type: 'string', description: 'Defaults to `name`.' },
            isDefault: { type: 'boolean', description: 'Sets this as the default + unsets others.' },
            overwrite: { type: 'boolean', description: 'Replace an existing template with the same id. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_updatePromptTemplate
// ===========================================================================

export interface UpdatePromptTemplateInput {
    /** Existing template id. */
    id?: string;
    /** New display name; also looks the template up when `id` is omitted. */
    name?: string;
    template?: string;
    description?: string;
    /** Rename target id. */
    newId?: string;
    isDefault?: boolean;
    /** Permit the rename to clobber an existing target. Default false. */
    overwrite?: boolean;
}

export async function updatePromptTemplateImpl(store: PromptTemplateStore, input: UpdatePromptTemplateInput): Promise<string> {
    try {
        const lookupId = input.id || input.name;
        if (!lookupId) { return err('`id` (or `name`) is required to look up the template.'); }
        const existing = store.anthropic.find(lookupId);
        if (!existing) {
            return err(`Template with id "${lookupId}" not found. Use \`tomAi_listPromptTemplates\` to see available ids.`);
        }
        const targetId = input.newId?.trim() || existing.id;
        if (targetId !== existing.id && store.anthropic.find(targetId)) {
            if (!input.overwrite) {
                return err(`A template with id "${targetId}" already exists. Pass \`overwrite: true\` to clobber it.`);
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
        return ok({ id: targetId, name: updated?.name ?? input.name });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const UPDATE_PROMPT_TEMPLATE_DESCRIPTION =
    'Patch an existing prompt template, keyed by `id` (or `name` when `id` is ' +
    'omitted); pass `newId` to rename the id (`name` is a cosmetic label). ' +
    'A rename onto an existing id is rejected unless `overwrite: true`. ' +
    '`isDefault: true` unsets `isDefault` on every other template. A missing ' +
    'id surfaces a pointer at `tomAi_listPromptTemplates`.';

export const UPDATE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<UpdatePromptTemplateInput> = {
    name: 'tomAi_updatePromptTemplate',
    displayName: 'Update Prompt Template',
    description: UPDATE_PROMPT_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'copilot', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Existing template id.' },
            name: { type: 'string', description: 'New display name (looks the template up when `id` is omitted).' },
            template: { type: 'string' },
            description: { type: 'string' },
            newId: { type: 'string', description: 'Rename target id.' },
            isDefault: { type: 'boolean' },
            overwrite: { type: 'boolean', description: 'Permit rename target to clobber an existing template. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_deletePromptTemplate
// ===========================================================================

export interface DeletePromptTemplateInput {
    id?: string;
}

export async function deletePromptTemplateImpl(store: PromptTemplateStore, input: DeletePromptTemplateInput): Promise<string> {
    try {
        if (!input.id) { return err('`id` is required.'); }
        const existed = store.anthropic.delete(input.id);
        if (!existed) {
            return err(`Template with id "${input.id}" not found. Use \`tomAi_listPromptTemplates\` to see available ids.`);
        }
        return ok({ id: input.id });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const DELETE_PROMPT_TEMPLATE_DESCRIPTION =
    'Delete a prompt template by `id`. **NOT idempotent** — deleting an ' +
    'unknown template returns a structured "not found" error with a pointer ' +
    'at `tomAi_listPromptTemplates`. To remove a template that may or may not ' +
    'exist without that error, call list first to check.';

export const DELETE_PROMPT_TEMPLATE_TOOL: SharedToolDefinition<DeletePromptTemplateInput> = {
    name: 'tomAi_deletePromptTemplate',
    displayName: 'Delete Prompt Template',
    description: DELETE_PROMPT_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'copilot', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string', description: 'Template id.' },
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
