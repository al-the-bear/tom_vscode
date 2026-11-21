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
    /** The guideline choices of the stage's todo, the item and the item's run (gsel4; services/aspectChoiceLevels.ts). */
    todoGuidelines?: Record<string, string>;
    itemGuidelines?: Record<string, string>;
    runGuidelines?: Record<string, string>;
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

/** How the trail header and the queue item name where a role comes from (gsel11). */
export const PROMPT_ROLE_ORIGIN_LABEL: Record<Exclude<PromptRoleOrigin, 'none'>, string> = {
    todo: 'todo',
    item: 'item',
    step: 'process step',
    runDefault: 'run default',
    chat: 'chat variable',
};

/** The order the role of a prompt is taken in, as the queue item's hover names it. */
export const PROMPT_ROLE_ORDER_TEXT = 'the todo\'s role > the item\'s role > the process step\'s > the run\'s default > the chat variable role';

/**
 * What the live trail's prompt header adds for the role a prompt runs as
 * (gsel11): ` · role idea_author (todo)`; no role: `''`.
 */
export function promptRoleHeaderSuffix(role: PromptRole | undefined): string {
    if (!role || role.from === 'none' || !role.role) { return ''; }
    return ` · role ${role.role} (${PROMPT_ROLE_ORIGIN_LABEL[role.from]})`;
}

/** What the queue item's role chip shows (gsel11; media/shared/queueEntryRenderFunctions.js). */
export interface QueueItemRoleView {
    /** The role the item runs as, as far as the queue knows it; `''`: none known. */
    role: string;
    /** Where it comes from; `none` with no role. */
    from: PromptRoleOrigin;
    /** A walk over several todos that has none in hand: each todo's own role wins over what is shown. */
    perTodo?: boolean;
    /** The chip's text after the role: `· from its todo`, `· run default`, `· process step`; `''` for the item's own. */
    note: string;
    /** The chip's hover. */
    title: string;
}

/**
 * The role chip of a queue item (gsel11): the role it runs as by the queue's
 * order without the chat variable (that is the window's at send time), where
 * it comes from, and the hover naming the order. `todoRole` is the role of the
 * todo the item runs (a TODO item's, the claimed one of a walk); `perTodo`: a
 * walk with no todo in hand.
 */
export function queueItemRoleView(input: { todoRole?: string; itemRole?: string; stepRole?: string; runDefaultRole?: string; perTodo?: boolean }): QueueItemRoleView {
    const r = effectivePromptRole({ queued: { todoRole: input.todoRole, itemRole: input.itemRole, runDefaultRole: input.runDefaultRole }, stepRole: input.stepRole });
    const order = `The order: ${PROMPT_ROLE_ORDER_TEXT}.`;
    const own = named(input.itemRole) ? input.itemRole : undefined;
    const perTodo = input.perTodo ? ' A walk: the todo it runs names its own role, which wins over this.' : '';
    if (r.from === 'none') {
        return {
            role: '', from: 'none', note: '', ...(input.perTodo ? { perTodo: true } : {}),
            title: `No role of its own: it runs as the chat variable role, if any.${perTodo} ${order}`,
        };
    }
    const note = r.from === 'todo' ? '· from its todo' : r.from === 'item' ? '' : `· ${PROMPT_ROLE_ORIGIN_LABEL[r.from]}`;
    const whence = r.from === 'todo' ? 'from the todo it runs' : r.from === 'item' ? 'its own role' : r.from === 'step' ? 'from the process step it was queued for' : 'the default role of its run';
    const passed = own && r.from === 'todo' && own !== r.role ? ` Its own role ${own} is passed over.` : '';
    return {
        role: r.role, from: r.from, note, ...(input.perTodo ? { perTodo: true } : {}),
        title: `Runs as role ${r.role} — ${whence}.${passed}${perTodo} The chat variable role shows it while it sends. ${order}`,
    };
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
