/**
 * Timer Engine (§3.3)
 *
 * Singleton that fires timed/repeat requests into the PromptQueue.
 * Checks every 30 seconds for due entries: interval-based or
 * scheduled-time entries.  Never sends directly to Copilot —
 * always enqueues into PromptQueueManager.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { PromptQueueManager } from './promptQueueManager';
import { readPanelYamlSync, writePanelYaml } from '../utils/panelYamlStore';
import { logTimed, logTimedError } from '../utils/queueLogger';
import { liveRepeatedTodoPort, releaseDueRepeatedTodos } from '../services/repeatedTodoController';
import { isTimedItemOf } from '../utils/timedQueueItems';
import { timerTickIntervalMs } from '../utils/vscodeSettings';

// ============================================================================
// Types
// ============================================================================

export interface ScheduledTime {
    time: string;      // "HH:MM"
    date?: string;     // "YYYY-MM-DD" — one-shot if present
    /** Day-of-week filter: 0=Sun,1=Mon,...,6=Sat. Absent or empty means every day. */
    weekdays?: number[];
}

export type TimedRequestStatus = 'active' | 'paused' | 'completed';

/** What an entry does when it is due: queue its prompt, or run the repeated-todo check. */
export type TimedRequestKind = 'prompt' | 'repeated-todos';

/** The repeated-todo controller's default check interval. */
export const REPEATED_TODOS_DEFAULT_MINUTES = 15;

export interface TimedRequest {
    id: string;
    /**
     * `prompt` (the default, absent): the entry queues its prompt.
     * `repeated-todos`: the repeated-todo controller — due, it releases the
     * `waiting-for-repeat` todos whose moment has come (services/repeatedTodoController.ts);
     * it queues nothing, takes no prompt, and ignores the timer's time slots.
     */
    kind?: TimedRequestKind;
    enabled: boolean;
    template: string;
    answerWrapper?: boolean;
    originalText: string;
    scheduleMode: 'interval' | 'scheduled';
    intervalMinutes?: number;
    scheduledTimes?: ScheduledTime[];
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    repeatCount?: number;
    repeatPrefix?: string;
    repeatSuffix?: string;
    sendMaximum?: number;
    sentCount?: number;
    answerWaitMinutes?: number;
    /** Day-of-week filter for interval mode: 0=Sun, 1=Mon … 6=Sat. Absent or empty = fire on any day. */
    intervalWeekdays?: number[];
    lastSentAt?: string;
    status: TimedRequestStatus;
}

export interface TimerScheduleSlot {
    id: string;
    dayType: 'weekday' | 'first-weekday' | 'last-weekday' | 'day-of-month';
    /** Weekday indexes: 0=Sun,1=Mon,...,6=Sat */
    weekdays?: number[];
    /** Single weekday for first/last-weekday-of-month: 0=Sun..6=Sat */
    monthWeekday?: number;
    /** Months (1-12) for first/last-weekday or day-of-month */
    months?: number[];
    /** Day number 1-31 for day-of-month */
    dayOfMonth?: number;
    /** Start time HH:MM (empty = from midnight) */
    timeFrom?: string;
    /** End time HH:MM (empty = until midnight) */
    timeTo?: string;
}

// ============================================================================
// Singleton
// ============================================================================


export class TimerEngine {
    private static _inst: TimerEngine | undefined;

    private _entries: TimedRequest[] = [];
    private _schedule: TimerScheduleSlot[] = [];
    private _timerActivated = true;
    private _timer?: ReturnType<typeof setInterval>;
    private _tickCount = 0;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    // ----- lifecycle ---------------------------------------------------------

    static init(ctx: vscode.ExtensionContext): void {
        if (TimerEngine._inst) { return; }
        const e = new TimerEngine();
        e.loadEntries();
        e.start();
        TimerEngine._inst = e;
        TimerEngine._readyResolve?.(e);
        logTimed(`Timer engine started — ${e._entries.length} entries, activated=${e._timerActivated}`);
        // The repeated-todo controller checks once at window start while it is on.
        setTimeout(() => { e.runRepeatedTodoControllers(new Date(), true); }, 5_000);
    }

    /** The repeated-todo controller entry, or undefined when there is none. */
    get repeatedTodoController(): TimedRequest | undefined {
        return this._entries.find((x) => x.kind === 'repeated-todos');
    }

    /** Add the repeated-todo controller (one per list; an existing one is answered). */
    addRepeatedTodoController(intervalMinutes = REPEATED_TODOS_DEFAULT_MINUTES): TimedRequest {
        const existing = this.repeatedTodoController;
        if (existing) { return existing; }
        return this.addEntry({
            kind: 'repeated-todos',
            enabled: true,
            template: '(None)',
            originalText: 'Repeated todos: release the waiting-for-repeat todos whose next repetition has come',
            scheduleMode: 'interval',
            intervalMinutes,
        });
    }

    /**
     * Run the repeated-todo check of every controller entry that is on and due
     * (`force`: due or not, e.g. at window start or Check now). Answers how
     * many todos it released.
     */
    runRepeatedTodoControllers(now: Date, force = false): number {
        if (!this._timerActivated) { return 0; }
        let total = 0;
        for (const entry of this._entries) {
            if (entry.kind !== 'repeated-todos' || !entry.enabled || entry.status !== 'active') { continue; }
            if (!force && !this.checkInterval(entry, now)) { continue; }
            total += this.runRepeatedTodoCheck(entry, now);
        }
        return total;
    }

    /** One check of `entry`: release the due todos, stamp the run. */
    runRepeatedTodoCheck(entry: TimedRequest, now: Date): number {
        let released = 0;
        try {
            const result = releaseDueRepeatedTodos(liveRepeatedTodoPort(), now);
            released = result.released.length;
            for (const r of result.released) { logTimed(`Repeated todo released: ${r.questId}/${r.todoId} (due ${r.next_repeat})`); }
            for (const f of result.failed) { logTimed(`Repeated todo due but not released (write failed): ${f}`); }
        } catch (err) {
            logTimedError('repeated-todo check', err);
        }
        entry.lastSentAt = now.toISOString();
        entry.sentCount = (entry.sentCount ?? 0) + released;
        this.saveEntries();
        this._onDidChange.fire();
        return released;
    }

    static get instance(): TimerEngine {
        if (!TimerEngine._inst) { throw new Error('TimerEngine not initialised'); }
        return TimerEngine._inst;
    }

    private static _readyResolve: ((e: TimerEngine) => void) | undefined;
    private static readonly _ready: Promise<TimerEngine> = new Promise((resolve) => { TimerEngine._readyResolve = resolve; });

    /** The engine once it runs; a view restored before `init` subscribes through this. */
    static whenReady(): Promise<TimerEngine> {
        return TimerEngine._inst ? Promise.resolve(TimerEngine._inst) : TimerEngine._ready;
    }

    dispose(): void {
        logTimed('Timer engine stopped');
        this.stop();
        this._onDidChange.dispose();
    }

    // ----- accessors ---------------------------------------------------------

    get entries(): readonly TimedRequest[] { return this._entries; }

    get timerActivated(): boolean { return this._timerActivated; }
    set timerActivated(v: boolean) {
        if (this._timerActivated === v) { return; }
        this._timerActivated = v;
        logTimed(`Timer engine ${v ? 'activated' : 'deactivated'}`);
        this.saveEntries();
        this._onDidChange.fire();
    }

    get schedule(): readonly TimerScheduleSlot[] { return this._schedule; }
    setSchedule(slots: TimerScheduleSlot[]): void {
        this._schedule = slots;
        this.saveEntries();
        this._onDidChange.fire();
    }

    getEntry(id: string): TimedRequest | undefined {
        return this._entries.find(e => e.id === id);
    }

    // ----- CRUD --------------------------------------------------------------

    addEntry(entry: Omit<TimedRequest, 'id' | 'status'>): TimedRequest {
        const full: TimedRequest = {
            ...entry,
            id: randomUUID(),
            status: entry.enabled ? 'active' : 'paused',
        };
        this._entries.push(full);
        logTimed(`Entry added: '${full.originalText.substring(0, 60)}' (id=${full.id.substring(0, 8)}, mode=${full.scheduleMode})`);
        this.saveEntries();
        this._onDidChange.fire();
        return full;
    }

    updateEntry(id: string, patch: Partial<Omit<TimedRequest, 'id'>>): void {
        const e = this._entries.find(x => x.id === id);
        if (!e) { return; }

        // Editing rules (revised — active is no longer locked):
        // - COMPLETED entries stay locked (fully immutable; use the
        //   enable toggle to re-open the entry, which flips it back to
        //   active / paused).
        // - ACTIVE and PAUSED entries are fully editable. The tick
        //   loop rereads fresh state on every iteration, so edits are
        //   safe mid-run. The previous "active is locked" rule forced
        //   users to pause before adding a scheduled time, which made
        //   new scheduled entries (initial scheduledTimes=[]) impossible
        //   to configure without a pause/resume round-trip, and
        //   silently dropped any patch that wasn't `enabled=false` —
        //   including any scheduled-time edits that did sneak through.
        if (e.status === 'completed') {
            return;
        }

        const changedKeys = Object.keys(patch).join(', ');
        Object.assign(e, patch);
        // Recalculate status from enabled flag
        if (patch.enabled !== undefined) {
            e.status = patch.enabled ? 'active' : 'paused';
            if (!patch.enabled) {
                const removed = this.removeQueuedTimedItems(e.id);
                if (removed > 0) {
                    logTimed(`Removed ${removed} pending/staged timed queue item(s) for paused entry ${e.id.substring(0, 8)}`);
                }
            }
        }
        logTimed(`Entry updated: '${e.originalText.substring(0, 40)}' [${changedKeys}]`);
        this.saveEntries();
        this._onDidChange.fire();
    }

    removeEntry(id: string): void {
        const removed = this._entries.find(e => e.id === id);
        this._entries = this._entries.filter(e => e.id !== id);
        if (removed) { logTimed(`Entry removed: '${removed.originalText.substring(0, 40)}'`); }
        this.saveEntries();
        this._onDidChange.fire();
    }

    enableAll(): void {
        for (const e of this._entries) {
            if (e.status === 'paused') { e.enabled = true; e.status = 'active'; }
        }
        this.saveEntries();
        this._onDidChange.fire();
    }

    disableAll(): void {
        for (const e of this._entries) {
            if (e.status === 'active') {
                e.enabled = false;
                e.status = 'paused';
                const removed = this.removeQueuedTimedItems(e.id);
                if (removed > 0) {
                    logTimed(`Removed ${removed} pending/staged timed queue item(s) for paused entry ${e.id.substring(0, 8)}`);
                }
            }
        }
        this.saveEntries();
        this._onDidChange.fire();
    }

    // ----- timer loop --------------------------------------------------------

    private start(): void {
        if (this._timer) { return; }
        // `tomAi.timedRequests.tickInterval`, read when the engine starts.
        this._timer = setInterval(() => this.tick(), timerTickIntervalMs((key) => vscode.workspace.getConfiguration('tomAi').get(key)));
    }

    private stop(): void {
        if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
    }

    private async tick(): Promise<void> {
        if (!this._timerActivated) { return; }
        this._tickCount++;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const activeCount = this._entries.filter(e => e.enabled && e.status === 'active').length;
        // The repeated-todo controller sends no prompt: it runs outside the time slots.
        this.runRepeatedTodoControllers(now);

        // Check global timer schedule (allowed time slots)
        const inSchedule = this._isWithinSchedule(now);
        logTimed(`Tick #${this._tickCount} at ${hh}:${mm}:${ss} — ${this._entries.length} entries (${activeCount} active), timer active, schedule ${inSchedule ? 'in-slot' : 'out-of-slot'}`);
        if (!inSchedule) { return; }

        for (const entry of this._entries) {
            if (entry.kind === 'repeated-todos') { continue; }
            if (!entry.enabled || entry.status !== 'active') {
                if (!entry.enabled) {
                    logTimed(`Entry '${entry.originalText.substring(0, 40)}' skipped: disabled`);
                } else if (entry.status === 'completed') {
                    logTimed(`Entry '${entry.originalText.substring(0, 40)}' skipped: completed`);
                }
                continue;
            }

            let shouldFire = false;

            if (entry.scheduleMode === 'interval') {
                shouldFire = this.checkInterval(entry, now);
                if (!shouldFire && entry.lastSentAt) {
                    const remaining = Math.max(0, Math.round(((entry.intervalMinutes || 0) * 60_000 - (now.getTime() - new Date(entry.lastSentAt).getTime())) / 60_000));
                    logTimed(`Checking entry '${entry.originalText.substring(0, 40)}' (id=${entry.id.substring(0, 8)}): mode=interval, last sent=${entry.lastSentAt}, interval=${entry.intervalMinutes}min — not due: ${remaining}min remaining`);
                }
            } else if (entry.scheduleMode === 'scheduled') {
                shouldFire = this.checkScheduledTimes(entry, now);
            }

            if (shouldFire) {
                logTimed(`Checking entry '${entry.originalText.substring(0, 40)}' (id=${entry.id.substring(0, 8)}): mode=${entry.scheduleMode} — due, firing`);
                await this.fire(entry, now);
            }
        }
    }

    private checkInterval(entry: TimedRequest, now: Date): boolean {
        if (!entry.intervalMinutes || entry.intervalMinutes < 1) { return false; }
        // Day-of-week filter: absent or empty array means fire every day
        if (entry.intervalWeekdays && entry.intervalWeekdays.length > 0) {
            if (!entry.intervalWeekdays.includes(now.getDay())) { return false; }
        }
        if (!entry.lastSentAt) { return true; } // Never fired → fire now
        const last = new Date(entry.lastSentAt).getTime();
        return (now.getTime() - last) >= entry.intervalMinutes * 60_000;
    }

    private checkScheduledTimes(entry: TimedRequest, now: Date): boolean {
        if (!entry.scheduledTimes?.length) { return false; }

        const nowHH = String(now.getHours()).padStart(2, '0');
        const nowMM = String(now.getMinutes()).padStart(2, '0');
        const nowTime = `${nowHH}:${nowMM}`;
        const nowDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const nowDay = now.getDay(); // 0=Sun..6=Sat

        for (const st of entry.scheduledTimes) {
            // Check if this time matches (within 1-minute window via exact HH:MM)
            if (st.time !== nowTime) { continue; }

            // If weekdays are specified, only fire on matching days of the week
            if (st.weekdays && st.weekdays.length > 0) {
                if (!st.weekdays.includes(nowDay)) { continue; }
            }

            // If date-specific, check date match
            if (st.date && st.date !== nowDate) { continue; }

            // Don't fire if already sent within this minute
            if (entry.lastSentAt) {
                const lastDate = new Date(entry.lastSentAt);
                if (lastDate.getHours() === now.getHours() &&
                    lastDate.getMinutes() === now.getMinutes() &&
                    lastDate.getFullYear() === now.getFullYear() &&
                    lastDate.getMonth() === now.getMonth() &&
                    lastDate.getDate() === now.getDate()) {
                    continue;
                }
            }

            return true;
        }
        return false;
    }

    // ----- global schedule checking ------------------------------------------

    private _isWithinSchedule(now: Date): boolean {
        if (!this._schedule.length) { return true; }
        return this._schedule.some(slot => this._matchesSlot(slot, now));
    }

    private _matchesSlot(slot: TimerScheduleSlot, now: Date): boolean {
        if (!this._matchesDay(slot, now)) { return false; }
        return this._matchesTime(slot, now);
    }

    private _matchesDay(slot: TimerScheduleSlot, now: Date): boolean {
        const dayOfWeek = now.getDay(); // 0=Sun..6=Sat
        const dayOfMonth = now.getDate();
        const month = now.getMonth() + 1; // 1-12

        switch (slot.dayType) {
            case 'weekday':
                return (slot.weekdays || []).includes(dayOfWeek);
            case 'first-weekday':
            case 'last-weekday': {
                if (slot.monthWeekday === undefined) { return false; }
                if (slot.months?.length && !slot.months.includes(month)) { return false; }
                if (dayOfWeek !== slot.monthWeekday) { return false; }
                if (slot.dayType === 'first-weekday') {
                    return dayOfMonth <= 7;
                } else {
                    const daysInMonth = new Date(now.getFullYear(), month, 0).getDate();
                    return (dayOfMonth + 7) > daysInMonth;
                }
            }
            case 'day-of-month': {
                if (slot.dayOfMonth === undefined) { return false; }
                if (slot.months?.length && !slot.months.includes(month)) { return false; }
                return dayOfMonth === slot.dayOfMonth;
            }
            default:
                return false;
        }
    }

    private _matchesTime(slot: TimerScheduleSlot, now: Date): boolean {
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const nowTime = `${hh}:${mm}`;
        const from = slot.timeFrom || '00:00';
        const to = slot.timeTo || '23:59';
        return nowTime >= from && nowTime <= to;
    }

    private async fire(entry: TimedRequest, now: Date): Promise<void> {
        let queue: PromptQueueManager;
        try { queue = PromptQueueManager.instance; } catch { return; }

        // Safety guard: entry state may have changed after due-check but before enqueue.
        if (!entry.enabled || entry.status !== 'active') {
            logTimed(`Entry '${entry.originalText.substring(0, 40)}' skipped: state changed to ${entry.status}`);
            return;
        }

        // Skip if this timed entry already has an in-flight item in the queue.
        // Checking pending + sending + staged prevents the same entry from being
        // double-enqueued while its previous item is still processing.  Different
        // entries each do their own independent check, so they never block each other.
        const hasPending = queue.items.some(
            i => i.type === 'timed' &&
            (i.status === 'pending' || i.status === 'sending' || i.status === 'staged') &&
            isTimedItemOf(i, entry.id)
        );
        if (hasPending) {
            logTimed(`Entry '${entry.originalText.substring(0, 40)}' skipped: already pending in queue`);
            return;
        }

        // Re-check state just before enqueue in case UI changed during processing.
        if (!entry.enabled || entry.status !== 'active') {
            logTimed(`Entry '${entry.originalText.substring(0, 40)}' skipped: state changed to ${entry.status} before enqueue`);
            return;
        }

        const reminderDesc = entry.reminderTemplateId
            ? `reminder: ${entry.reminderTemplateId}, timeout=${entry.reminderTimeoutMinutes ?? 0}min`
            : 'no reminder';
        if (entry.reminderTemplateId) {
            logTimed(`Entry '${entry.originalText.substring(0, 40)}' has reminder template '${entry.reminderTemplateId}', timeout=${entry.reminderTimeoutMinutes ?? 0}min, repeat=${!!entry.reminderRepeat}`);
        }
        logTimed(`Firing entry '${entry.originalText.substring(0, 40)}' → enqueueing to prompt queue (${reminderDesc}, repeat=${!!entry.reminderRepeat})`);

        // Enqueue
        await queue.enqueue({
            originalText: entry.originalText,
            // The entry's template is applied like any item's; the item names its entry in a field of its own.
            template: entry.template || '(None)',
            answerWrapper: entry.answerWrapper || false,
            type: 'timed',
            timedEntryId: entry.id,
            initialStatus: 'pending',
            reminderEnabled: !!entry.reminderEnabled,
            reminderTemplateId: entry.reminderTemplateId,
            reminderTimeoutMinutes: entry.reminderTimeoutMinutes,
            reminderRepeat: !!entry.reminderRepeat,
            repeatCount: Math.max(0, Math.round(Number(entry.repeatCount || 0))),
            repeatPrefix: entry.repeatPrefix,
            repeatSuffix: entry.repeatSuffix,
            answerWaitMinutes: entry.answerWaitMinutes && entry.answerWaitMinutes > 0 ? entry.answerWaitMinutes : undefined,
        });

        // Update lastSentAt and sentCount
        entry.lastSentAt = now.toISOString();
        entry.sentCount = (entry.sentCount || 0) + 1;

        // Auto-pause interval entries when sendMaximum is reached
        if (entry.scheduleMode === 'interval' && entry.sendMaximum && entry.sendMaximum > 0) {
            if (entry.sentCount >= entry.sendMaximum) {
                entry.status = 'paused';
                entry.enabled = false;
                logTimed(`Entry '${entry.originalText.substring(0, 40)}' auto-paused: sent ${entry.sentCount}/${entry.sendMaximum} times`);
            }
        }

        // Mark date-specific scheduled entries as completed if all dates have passed
        if (entry.scheduleMode === 'scheduled' && entry.scheduledTimes) {
            const allDated = entry.scheduledTimes.every(st => !!st.date);
            if (allDated) {
                const allPast = entry.scheduledTimes.every(st => {
                    if (!st.date) { return false; }
                    return new Date(st.date + 'T' + st.time) <= now;
                });
                if (allPast) {
                    entry.status = 'completed';
                    entry.enabled = false;
                    logTimed(`Entry '${entry.originalText.substring(0, 40)}' completed: all scheduled dates have passed`);
                }
            }
        }

        this.saveEntries();
        this._onDidChange.fire();
    }

    private removeQueuedTimedItems(entryId: string): number {
        let queue: PromptQueueManager;
        try {
            queue = PromptQueueManager.instance;
        } catch {
            return 0;
        }

        const ids = queue.items
            .filter(i => (i.status === 'pending' || i.status === 'staged') && isTimedItemOf(i, entryId))
            .map(i => i.id);

        for (const id of ids) {
            queue.remove(id);
        }
        return ids.length;
    }

    // ----- persistence (config file + YAML) ------------------------------------

    private loadEntries(): void {
        // Load from YAML file only (no JSON config fallback)
        try {
            const data = readPanelYamlSync<{ timerActivated?: boolean; schedule?: TimerScheduleSlot[]; entries?: TimedRequest[] }>('timed');
            if (data?.timerActivated !== undefined) {
                this._timerActivated = data.timerActivated;
            }
            if (data?.schedule && Array.isArray(data.schedule)) {
                this._schedule = data.schedule;
            }
            if (data?.entries && Array.isArray(data.entries)) {
                this._entries = data.entries;
                for (const entry of this._entries) {
                    if (!entry.id) {
                        entry.id = randomUUID();
                    }
                    if (!entry.scheduleMode || (entry.scheduleMode !== 'interval' && entry.scheduleMode !== 'scheduled')) {
                        entry.scheduleMode = 'interval';
                    }
                    if (!entry.template) {
                        entry.template = '(None)';
                    }
                    if (typeof entry.originalText !== 'string') {
                        entry.originalText = '';
                    }
                    if (typeof entry.enabled !== 'boolean') {
                        entry.enabled = true;
                    }
                    if (!entry.status || (entry.status !== 'active' && entry.status !== 'paused' && entry.status !== 'completed')) {
                        entry.status = entry.enabled ? 'active' : 'paused';
                    }
                    if (entry.scheduleMode === 'interval' && (!entry.intervalMinutes || entry.intervalMinutes < 1)) {
                        entry.intervalMinutes = 30;
                    }
                    if (entry.scheduleMode === 'scheduled' && !Array.isArray(entry.scheduledTimes)) {
                        entry.scheduledTimes = [];
                    }
                    entry.repeatCount = Math.max(0, Math.round(Number(entry.repeatCount || 0)));
                    if (typeof entry.repeatPrefix !== 'string') {
                        entry.repeatPrefix = '';
                    }
                    if (typeof entry.repeatSuffix !== 'string') {
                        entry.repeatSuffix = '';
                    }
                    if (!Array.isArray(entry.intervalWeekdays)) {
                        entry.intervalWeekdays = [];
                    }
                }
                console.log('[TimerEngine] loadEntries: loaded', this._entries.length, 'entries from YAML');
                logTimed(`Loaded ${this._entries.length} entries from YAML`);
            } else {
                console.log('[TimerEngine] loadEntries: no entries in YAML, data =', data);
                logTimed('No entries found in YAML store');
            }
        } catch (e) {
            console.error('[TimerEngine] loadEntries: error loading YAML:', e);
            logTimedError('loadEntries', e);
            this._entries = [];
        }
    }

    private saveEntries(): void {
        // Persist to YAML file only (no JSON config fallback)
        this._persistYaml().catch(() => { /* best effort */ });
    }

    private async _persistYaml(): Promise<void> {
        try {
            await writePanelYaml('timed', {
                timerActivated: this._timerActivated,
                schedule: this._schedule,
                entries: this._entries,
            }, '../../_ai/schemas/yaml/timed.schema.json');
        } catch { /* best effort */ }
    }
}
