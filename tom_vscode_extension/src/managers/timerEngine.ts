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

// ============================================================================
// Types
// ============================================================================

export interface ScheduledTime {
    time: string;   // "HH:MM"
    date?: string;  // "YYYY-MM-DD" — one-shot if present
}

export type TimedRequestStatus = 'active' | 'paused' | 'completed';

export interface TimedRequest {
    id: string;
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

const CHECK_INTERVAL_MS = 30_000;

export class TimerEngine {
    private static _inst: TimerEngine | undefined;

    private _entries: TimedRequest[] = [];
    private _schedule: TimerScheduleSlot[] = [];
    private _timerActivated = true;
    private _timer?: ReturnType<typeof setInterval>;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private _ctx!: vscode.ExtensionContext;

    // ----- lifecycle ---------------------------------------------------------

    static init(ctx: vscode.ExtensionContext): void {
        if (TimerEngine._inst) { return; }
        const e = new TimerEngine();
        e._ctx = ctx;
        e.loadEntries();
        e.start();
        TimerEngine._inst = e;
    }

    static get instance(): TimerEngine {
        if (!TimerEngine._inst) { throw new Error('TimerEngine not initialised'); }
        return TimerEngine._inst;
    }

    dispose(): void {
        this.stop();
        this._onDidChange.dispose();
    }

    // ----- accessors ---------------------------------------------------------

    get entries(): readonly TimedRequest[] { return this._entries; }

    get timerActivated(): boolean { return this._timerActivated; }
    set timerActivated(v: boolean) {
        if (this._timerActivated === v) { return; }
        this._timerActivated = v;
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
        this.saveEntries();
        this._onDidChange.fire();
        return full;
    }

    updateEntry(id: string, patch: Partial<Omit<TimedRequest, 'id'>>): void {
        const e = this._entries.find(x => x.id === id);
        if (!e) { return; }

        // Editing rules:
        // - ACTIVE entries are locked; only pausing (enabled=false) is allowed.
        // - COMPLETED entries are locked.
        // - PAUSED entries are fully editable.
        if (e.status === 'active') {
            if (patch.enabled === false) {
                e.enabled = false;
                e.status = 'paused';
                this.saveEntries();
                this._onDidChange.fire();
            }
            return;
        }

        if (e.status === 'completed') {
            return;
        }

        Object.assign(e, patch);
        // Recalculate status from enabled flag
        if (patch.enabled !== undefined) {
            e.status = patch.enabled ? 'active' : 'paused';
        }
        this.saveEntries();
        this._onDidChange.fire();
    }

    removeEntry(id: string): void {
        this._entries = this._entries.filter(e => e.id !== id);
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
            if (e.status === 'active') { e.enabled = false; e.status = 'paused'; }
        }
        this.saveEntries();
        this._onDidChange.fire();
    }

    // ----- timer loop --------------------------------------------------------

    private start(): void {
        if (this._timer) { return; }
        this._timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    }

    private stop(): void {
        if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
    }

    private async tick(): Promise<void> {
        if (!this._timerActivated) { return; }
        const now = new Date();

        // Check global timer schedule (allowed time slots)
        if (!this._isWithinSchedule(now)) { return; }

        for (const entry of this._entries) {
            if (!entry.enabled || entry.status !== 'active') { continue; }

            let shouldFire = false;

            if (entry.scheduleMode === 'interval') {
                shouldFire = this.checkInterval(entry, now);
            } else if (entry.scheduleMode === 'scheduled') {
                shouldFire = this.checkScheduledTimes(entry, now);
            }

            if (shouldFire) {
                await this.fire(entry, now);
            }
        }
    }

    private checkInterval(entry: TimedRequest, now: Date): boolean {
        if (!entry.intervalMinutes || entry.intervalMinutes < 1) { return false; }
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

        for (const st of entry.scheduledTimes) {
            // Check if this time matches (within 1-minute window via exact HH:MM)
            if (st.time !== nowTime) { continue; }

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

        // Skip if this timed entry already has a pending item in the queue
        const hasPending = queue.items.some(
            i => i.type === 'timed' && i.status === 'pending' && i.template === `timed:${entry.id}`
        );
        if (hasPending) { return; }

        // Enqueue
        await queue.enqueue({
            originalText: entry.originalText,
            template: `timed:${entry.id}`,
            answerWrapper: entry.answerWrapper || false,
            type: 'timed',
            initialStatus: 'pending',
            reminderEnabled: !!entry.reminderEnabled,
            reminderTemplateId: entry.reminderTemplateId,
            reminderTimeoutMinutes: entry.reminderTimeoutMinutes,
            reminderRepeat: !!entry.reminderRepeat,
        });

        // Update lastSentAt
        entry.lastSentAt = now.toISOString();

        // Mark date-specific scheduled entries as completed if all dates have passed
        if (entry.scheduleMode === 'scheduled' && entry.scheduledTimes) {
            const allDated = entry.scheduledTimes.every(st => !!st.date);
            if (allDated) {
                const allPast = entry.scheduledTimes.every(st => {
                    if (!st.date) { return false; }
                    return new Date(st.date + 'T' + st.time) <= now;
                });
                if (allPast) { entry.status = 'completed'; entry.enabled = false; }
            }
        }

        this.saveEntries();
        this._onDidChange.fire();
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
                }
                console.log('[TimerEngine] loadEntries: loaded', this._entries.length, 'entries from YAML');
            } else {
                console.log('[TimerEngine] loadEntries: no entries in YAML, data =', data);
            }
        } catch (e) {
            console.error('[TimerEngine] loadEntries: error loading YAML:', e);
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
