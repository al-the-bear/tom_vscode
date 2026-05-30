/**
 * Reminder-template tools — `tomAi_listReminderTemplates`,
 * `tomAi_createReminderTemplate`, `tomAi_updateReminderTemplate`,
 * `tomAi_deleteReminderTemplate`.
 *
 * Carved out of `chat-enhancement-tools.ts` for coverage entry #21.
 *
 * ## When reminders fire, who they target
 *
 * The `ReminderSystem` watcher polls every 30 s. For every queue item
 * or timed-request stage that is **waiting for an answer** longer than
 * `defaultTimeoutMinutes` (default 5), a reminder is fired into the
 * **same chat panel the original prompt was dispatched to**:
 *
 *   - Copilot transport → Copilot Chat panel
 *   - Anthropic transport → Anthropic Chat panel
 *
 * The reminder body is the matched template's `prompt`, rendered with
 * the **mustache** `{{tokenName}}` syntax (see Placeholder Syntax
 * below). Reminders auto-cancel when the original prompt receives its
 * answer. The model can opt out per stage via `reminderEnabled: false`
 * on `tomAi_addQueueItem` / `tomAi_addTimedRequest` / their per-pre /
 * per-follow-up siblings.
 *
 * ## Placeholder syntax — `{{token}}` NOT `${token}`
 *
 * Reminder templates use **mustache `{{tokenName}}`** syntax, NOT the
 * canonical `${tokenName}` syntax the rest of the placeholder engine
 * uses. The reminder runtime intentionally bypasses the global resolver
 * — only the tokens listed below are replaced. **Chat-variable
 * placeholders (`${quest}`, `${role}`, etc.) DO NOT work in reminders.**
 *
 * Supported tokens (chain-replaced in `ReminderSystem.checkAndGenerateReminder`):
 *
 *   - `{{timeoutMinutes}}`       — minutes since the prompt was sent
 *   - `{{waitingMinutes}}`       — elapsed wait
 *   - `{{originalPrompt}}`       — original prompt body (truncated to 200)
 *   - `{{followUpIndex}}`        — 1-based current follow-up
 *   - `{{followUpTotal}}`        — total configured follow-ups
 *   - `{{sentAt}}`               — sent timestamp (ISO)
 *   - `{{followUpText}}`         — active follow-up body
 *   - `{{promptId}}` / `{{promptType}}` / `{{status}}`
 *   - `{{template}}`             — active template label
 *   - `{{requestId}}` / `{{expectedRequestId}}`
 *   - `{{createdAt}}`
 *   - `{{reminderSentCount}}`    — number of reminders already sent
 *   - `{{queueLength}}`          — total queue length
 *
 * ## ID model + default-template semantics
 *
 *   - Each template has a **server-generated UUID `id`** — the model
 *     cannot collide on id at create time. Two templates with the
 *     same display `name` are tolerated by the store but disambiguated
 *     by their uuids; the tool now rejects name collisions by default
 *     so the model gets a single addressable template per name.
 *
 *   - **At most ONE default at a time.** Setting `isDefault: true` on
 *     create or update unsets the flag on every other template. When
 *     you delete the current default, the FIRST remaining template
 *     auto-promotes (or none if the list is empty after the delete).
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Shared shapes
// ===========================================================================

export interface ReminderTemplateEntry {
    id: string;
    name: string;
    prompt: string;
    isDefault: boolean;
}

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface ReminderTemplateStore {
    list(): ReminderTemplateEntry[];
    findById(id: string): ReminderTemplateEntry | undefined;
    findByName(name: string): ReminderTemplateEntry | undefined;
    add(entry: Omit<ReminderTemplateEntry, 'id'>): ReminderTemplateEntry;
    update(id: string, patch: Partial<Omit<ReminderTemplateEntry, 'id'>>): ReminderTemplateEntry | undefined;
    delete(id: string): { existed: boolean; promotedDefault?: ReminderTemplateEntry };
}

// ===========================================================================
// Helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// tomAi_listReminderTemplates
// ===========================================================================

export type ListReminderTemplatesInput = Record<string, never>;

export async function listReminderTemplatesImpl(store: ReminderTemplateStore): Promise<string> {
    try {
        const templates = store.list();
        const defaultTemplate = templates.find((t) => t.isDefault);
        return JSON.stringify({
            ok: true,
            count: templates.length,
            defaultId: defaultTemplate?.id ?? null,
            defaultName: defaultTemplate?.name ?? null,
            templates,
        }, null, 2);
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_REMINDER_TEMPLATES_DESCRIPTION =
    'List reminder templates used by queue items and timed requests. ' +
    'Response includes the **active default** (`defaultId`/`defaultName`) ' +
    'as top-level fields so you don\'t have to scan the array for ' +
    '`isDefault: true`. Each template has `{id, name, prompt, isDefault}`. ' +
    'Reminder template bodies use **mustache `{{token}}` syntax** (NOT the ' +
    'canonical `${token}`) — chat-variable placeholders DO NOT work; see ' +
    '`tomAi_createReminderTemplate` for the supported token list.';

export const LIST_REMINDER_TEMPLATES_TOOL: SharedToolDefinition<ListReminderTemplatesInput> = {
    name: 'tomAi_listReminderTemplates',
    displayName: 'List Reminder Templates',
    description: LIST_REMINDER_TEMPLATES_DESCRIPTION,
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_createReminderTemplate
// ===========================================================================

export interface CreateReminderTemplateInput {
    name: string;
    prompt: string;
    isDefault?: boolean;
    /** Replace an existing template with the same `name`. Default false. */
    overwrite?: boolean;
}

export async function createReminderTemplateImpl(store: ReminderTemplateStore, input: CreateReminderTemplateInput): Promise<string> {
    try {
        if (!input.name || !input.name.trim()) { return err('`name` is required.'); }
        if (!input.prompt || !input.prompt.trim()) { return err('`prompt` is required.'); }
        const trimmedName = input.name.trim();
        const existing = store.findByName(trimmedName);
        if (existing) {
            if (!input.overwrite) {
                return err(`Reminder template named "${trimmedName}" already exists (id ${existing.id}). Pass \`overwrite: true\` to replace it, or use \`tomAi_updateReminderTemplate\` with the existing id.`);
            }
            store.delete(existing.id);
        }
        const created = store.add({
            name: trimmedName,
            prompt: input.prompt,
            isDefault: input.isDefault === true,
        });
        return ok({
            id: created.id,
            name: created.name,
            isDefault: created.isDefault,
            replacedId: existing?.id,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const CREATE_REMINDER_TEMPLATE_DESCRIPTION =
    'Create a reminder template. **Name collisions rejected** without ' +
    'explicit `overwrite: true` (two templates with the same name were ' +
    'previously tolerated silently — confusing because users address ' +
    'reminders by name in the UI). Id is **server-generated UUID** — you ' +
    'cannot pick it. Setting `isDefault: true` unsets the flag on every ' +
    'other template. **Body uses mustache `{{token}}`** — supported tokens: ' +
    '`{{timeoutMinutes}}`, `{{waitingMinutes}}`, `{{originalPrompt}}`, ' +
    '`{{followUpIndex}}`, `{{followUpTotal}}`, `{{sentAt}}`, ' +
    '`{{followUpText}}`, `{{promptId}}`, `{{promptType}}`, `{{status}}`, ' +
    '`{{template}}`, `{{requestId}}`, `{{expectedRequestId}}`, ' +
    '`{{createdAt}}`, `{{reminderSentCount}}`, `{{queueLength}}`. The ' +
    'canonical `${...}` placeholders are NOT resolved in reminder bodies.';

export const CREATE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<CreateReminderTemplateInput> = {
    name: 'tomAi_createReminderTemplate',
    displayName: 'Create Reminder Template',
    description: CREATE_REMINDER_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['name', 'prompt'],
        properties: {
            name: { type: 'string', description: 'Display name — must be unique unless `overwrite: true`.' },
            prompt: { type: 'string', description: 'Mustache `{{token}}` body. See description for supported tokens.' },
            isDefault: { type: 'boolean', description: 'Mark as the default template (unsets others). Default false.' },
            overwrite: { type: 'boolean', description: 'Replace an existing template with the same name. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_updateReminderTemplate
// ===========================================================================

export interface UpdateReminderTemplateInput {
    id: string;
    name?: string;
    prompt?: string;
    isDefault?: boolean;
}

export async function updateReminderTemplateImpl(store: ReminderTemplateStore, input: UpdateReminderTemplateInput): Promise<string> {
    try {
        if (!input.id) { return err('`id` is required.'); }
        const existing = store.findById(input.id);
        if (!existing) {
            return err(`Reminder template "${input.id}" not found. Use \`tomAi_listReminderTemplates\` to see available ids.`);
        }
        if (input.name && input.name.trim() !== existing.name) {
            const collide = store.findByName(input.name.trim());
            if (collide && collide.id !== input.id) {
                return err(`Cannot rename to "${input.name.trim()}" — another reminder template already uses that name (id ${collide.id}).`);
            }
        }
        const updated = store.update(input.id, {
            name: input.name?.trim(),
            prompt: input.prompt,
            isDefault: input.isDefault,
        });
        if (!updated) {
            // Defensive — shouldn't happen given the findById check above
            return err(`Update returned no entry for "${input.id}".`);
        }
        return ok({
            id: updated.id,
            name: updated.name,
            isDefault: updated.isDefault,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const UPDATE_REMINDER_TEMPLATE_DESCRIPTION =
    'Patch an existing reminder template by id. **Unknown id surfaces ' +
    'a structured "not found" error** pointing at `tomAi_listReminderTemplates` ' +
    '— the legacy impl silently no-op\'d and returned `template: null`. ' +
    'Rename collisions (two templates ending up with the same name) ' +
    'are rejected explicitly. Setting `isDefault: true` unsets the flag ' +
    'on every other template. Mustache `{{token}}` syntax applies to ' +
    '`prompt`; see `tomAi_createReminderTemplate` for supported tokens.';

export const UPDATE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<UpdateReminderTemplateInput> = {
    name: 'tomAi_updateReminderTemplate',
    displayName: 'Update Reminder Template',
    description: UPDATE_REMINDER_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            isDefault: { type: 'boolean' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_deleteReminderTemplate
// ===========================================================================

export interface DeleteReminderTemplateInput {
    id: string;
}

export async function deleteReminderTemplateImpl(store: ReminderTemplateStore, input: DeleteReminderTemplateInput): Promise<string> {
    try {
        if (!input.id) { return err('`id` is required.'); }
        const result = store.delete(input.id);
        if (!result.existed) {
            return err(`Reminder template "${input.id}" not found. Use \`tomAi_listReminderTemplates\` to see available ids.`);
        }
        return ok({
            id: input.id,
            promotedDefaultId: result.promotedDefault?.id ?? null,
            promotedDefaultName: result.promotedDefault?.name ?? null,
            note: result.promotedDefault
                ? `"${result.promotedDefault.name}" auto-promoted to default after removing the prior default.`
                : 'No auto-promotion needed.',
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const DELETE_REMINDER_TEMPLATE_DESCRIPTION =
    'Delete a reminder template by id. Unknown id surfaces a structured ' +
    '"not found" error (was a silent no-op before). **When you delete the ' +
    'current default**, the FIRST remaining template auto-promotes to the ' +
    'new default; the response includes `promotedDefaultId` / ' +
    '`promotedDefaultName` so you can see the transfer happen. Deleting ' +
    'the only template leaves the system with no default.';

export const DELETE_REMINDER_TEMPLATE_TOOL: SharedToolDefinition<DeleteReminderTemplateInput> = {
    name: 'tomAi_deleteReminderTemplate',
    displayName: 'Delete Reminder Template',
    description: DELETE_REMINDER_TEMPLATE_DESCRIPTION,
    tags: ['templates', 'reminder', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REMINDER_TEMPLATE_TOOLS: SharedToolDefinition<any>[] = [
    LIST_REMINDER_TEMPLATES_TOOL,
    CREATE_REMINDER_TEMPLATE_TOOL,
    UPDATE_REMINDER_TEMPLATE_TOOL,
    DELETE_REMINDER_TEMPLATE_TOOL,
];
