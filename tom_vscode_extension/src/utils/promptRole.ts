/**
 * The role a prompt runs as (gsel3; design `role_and_guideline_selector.vscode_extension.md`, R-1, R-2).
 *
 * - **The order**, the first that names a role wins: the todo's `role` (the
 *   todo a walk or TODO item runs) > the queue item's `role` > the process
 *   step's role (a Proceed prompt, and what that prompt queued: its
 *   `processRun`) > the run's queue default role > the chat variable `role`.
 *   A Proceed prompt names no role of its own, so it keeps its step's; a step
 *   that names none passes to the run default.
 * - **The chat variable follows** ({@link RoleOverrides}): while a queue item
 *   whose role comes from its todo, itself or its run's default runs, the
 *   window's `role` holds that role, and it is put back when the item stops
 *   sending, however it stops. Items of several runs may overlap: the role of
 *   the newest is shown, and the value before the first comes back after the
 *   last. A role the user changes by hand meanwhile is kept.
 *
 * Pure: tested in `__tests__/promptRole.test.ts`.
 */

/** What the queue knows about the stage it sends: the roles of its todo, the item and the run's default. */
export interface QueueRoleSource {
    todoRole?: string;
    itemRole?: string;
    runDefaultRole?: string;
}

/** Where the effective role comes from. */
export type PromptRoleOrigin = 'todo' | 'item' | 'step' | 'runDefault' | 'chat' | 'none';

/** The role a prompt runs as and where it comes from (`''` with `none`). */
export interface PromptRole {
    role: string;
    from: PromptRoleOrigin;
}

const named = (role: string | undefined): role is string => typeof role === 'string' && role.trim() !== '' && role !== 'default';

/**
 * The role of a send: `queued` (the queue's stage, absent outside the queue),
 * `stepRole` (the role the process position of the send names; undefined
 * outside a Proceed run, `''` when the step names none), `chatRole` (the chat
 * variable). `''` and `default` name no role.
 */
export function effectivePromptRole(input: { queued?: QueueRoleSource; stepRole?: string; chatRole?: string }): PromptRole {
    const q = input.queued ?? {};
    if (named(q.todoRole)) { return { role: q.todoRole, from: 'todo' }; }
    if (named(q.itemRole)) { return { role: q.itemRole, from: 'item' }; }
    if (named(input.stepRole)) { return { role: input.stepRole, from: 'step' }; }
    if (named(q.runDefaultRole)) { return { role: q.runDefaultRole, from: 'runDefault' }; }
    if (named(input.chatRole)) { return { role: input.chatRole, from: 'chat' }; }
    return { role: '', from: 'none' };
}

/** Whether the chat variable shows a role of this origin while its item runs (the queue's own roles, not the step's). */
export function rolesShownInChatVariable(from: PromptRoleOrigin): boolean {
    return from === 'todo' || from === 'item' || from === 'runDefault';
}

/**
 * The chat variable `role` while queue items with roles run. `hold(key,
 * role)` shows `role` (the first hold remembers the value before it);
 * `release(key)` drops the key — the newest remaining hold is shown, and
 * after the last the remembered value comes back. When the value is found
 * changed by someone else, the holder stops writing until every hold is
 * released (the user's choice stays).
 */
export class RoleOverrides {
    private readonly holds = new Map<string, string>();
    private base: string | undefined;
    private lastSet: string | undefined;
    private userChanged = false;

    constructor(private readonly get: () => string, private readonly set: (role: string) => void) {}

    /** Whether `key` holds a role now. */
    has(key: string): boolean { return this.holds.has(key); }

    /** The keys holding a role now. */
    keys(): string[] { return [...this.holds.keys()]; }

    hold(key: string, role: string): void {
        if (this.holds.size === 0) {
            this.base = this.get();
            this.lastSet = undefined;
            this.userChanged = false;
        }
        this.holds.delete(key);
        this.holds.set(key, role);
        this.apply();
    }

    release(key: string): void {
        if (!this.holds.delete(key)) { return; }
        if (this.holds.size > 0) { this.apply(); return; }
        if (!this.userChanged && this.lastSet !== undefined && this.get() === this.lastSet && this.get() !== (this.base ?? '')) { this.set(this.base ?? ''); }
        this.base = undefined;
        this.lastSet = undefined;
        this.userChanged = false;
    }

    private apply(): void {
        if (this.lastSet !== undefined && this.get() !== this.lastSet) { this.userChanged = true; }
        if (this.userChanged) { return; }
        const role = [...this.holds.values()].at(-1) ?? '';
        if (this.get() !== role) { this.set(role); }
        this.lastSet = role;
    }
}
