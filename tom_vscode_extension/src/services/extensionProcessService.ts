/**
 * The helper processes of this window's extension host (vscimpb30, the
 * @TOM VSC view): list them, and pause, resume or kill one or all of an
 * extension's (src/utils/extensionProcesses.ts parses and attributes).
 *
 * The extension host is this process (`process.pid`): every extension of the
 * window runs in it, and the language servers and other helpers they start are
 * its descendants. Only those are listed, and only a pid listed now can be
 * acted on — never the extension host itself, nothing of another window.
 *
 * Pause is SIGSTOP and resume SIGCONT (macOS, Linux). Windows has no stop
 * signal: there only Kill is offered.
 */

import { execFile } from 'child_process';

import {
    PS_ARGS,
    WINDOWS_PS_COMMAND,
    descendants,
    groupByExtension,
    parsePsOutput,
    parseWindowsProcesses,
    type ExtensionGroup,
    type ProcInfo,
    type TreeProc,
} from '../utils/extensionProcesses';

/** What the service needs from the system; faked in tests. */
export interface ProcessSystem {
    platform: NodeJS.Platform;
    /** The extension host's pid (the root of the listed tree). */
    rootPid: number;
    /** The system's process list. */
    listAll(): Promise<ProcInfo[]>;
    /** Send a signal (`SIGSTOP`, `SIGCONT`, `SIGTERM`). */
    signal(pid: number, signal: NodeJS.Signals): void;
}

/** A snapshot of the window's helper processes. */
export interface ProcessSnapshot {
    platform: NodeJS.Platform;
    /** Pause / resume work here (not on Windows). */
    canPause: boolean;
    /** The extension host itself. */
    host: ProcInfo | null;
    processes: TreeProc[];
    groups: ExtensionGroup[];
    totalKb: number;
    /** Why the list is empty, when listing failed. */
    error?: string;
}

export type ProcessAction = 'pause' | 'resume' | 'kill';

const SIGNAL: Record<ProcessAction, NodeJS.Signals> = { pause: 'SIGSTOP', resume: 'SIGCONT', kill: 'SIGTERM' };

export class ExtensionProcessService {
    private last: ProcessSnapshot | null = null;

    constructor(private readonly sys: ProcessSystem) {}

    get canPause(): boolean {
        return this.sys.platform !== 'win32';
    }

    /** List the helper processes now. */
    async snapshot(): Promise<ProcessSnapshot> {
        let all: ProcInfo[] = [];
        let error: string | undefined;
        try { all = await this.sys.listAll(); } catch (e) { error = (e as Error).message; }
        const processes = descendants(all, this.sys.rootPid);
        const snap: ProcessSnapshot = {
            platform: this.sys.platform,
            canPause: this.canPause,
            host: all.find((p) => p.pid === this.sys.rootPid) ?? null,
            processes,
            groups: groupByExtension(processes),
            totalKb: processes.reduce((s, p) => s + p.rssKb, 0),
            ...(error ? { error } : {}),
        };
        this.last = snap;
        return snap;
    }

    /**
     * Pause, resume or kill processes: `pids` given, or every process of
     * `extensionId` (its group). Only processes of the window's tree as listed
     * now; the extension host itself never. Answers what was done and refused.
     */
    async act(action: ProcessAction, target: { pids?: number[]; extensionId?: string }): Promise<{ done: number[]; refused: Array<{ pid: number; why: string }> }> {
        if (action !== 'kill' && !this.canPause) {
            return { done: [], refused: (target.pids ?? []).map((pid) => ({ pid, why: 'pausing is not available on Windows; only Kill is' })) };
        }
        const snap = await this.snapshot();
        const listed = new Map(snap.processes.map((p) => [p.pid, p]));
        const wanted = target.extensionId !== undefined
            ? snap.groups.filter((g) => g.extensionId === target.extensionId).flatMap((g) => g.processes.map((p) => p.pid))
            : target.pids ?? [];
        const done: number[] = [];
        const refused: Array<{ pid: number; why: string }> = [];
        // Children before parents when killing (a parent may restart them); parents first when pausing does not matter.
        const order = action === 'kill' ? [...wanted].sort((a, b) => (listed.get(b)?.depth ?? 0) - (listed.get(a)?.depth ?? 0)) : wanted;
        for (const pid of order) {
            if (pid === this.sys.rootPid) { refused.push({ pid, why: 'the extension host itself' }); continue; }
            if (!listed.has(pid)) { refused.push({ pid, why: 'not a process of this window\'s extension host' }); continue; }
            try {
                this.sys.signal(pid, SIGNAL[action]);
                done.push(pid);
            } catch (e) {
                refused.push({ pid, why: (e as Error).message });
            }
        }
        return { done, refused };
    }

    /** The last snapshot (the status bar between refreshes). */
    get lastSnapshot(): ProcessSnapshot | null {
        return this.last;
    }
}

/** The live system: `ps` on macOS / Linux, PowerShell's process list on Windows, `process.kill`. */
export function liveProcessSystem(): ProcessSystem {
    const platform = process.platform;
    return {
        platform,
        rootPid: process.pid,
        listAll: () => new Promise((resolve, reject) => {
            const done = (err: Error | null, stdout: string): void => {
                if (err) { reject(err); return; }
                resolve(platform === 'win32' ? parseWindowsProcesses(stdout) : parsePsOutput(stdout));
            };
            if (platform === 'win32') {
                execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS_COMMAND], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (e, out) => done(e, String(out)));
            } else {
                execFile('ps', PS_ARGS, { maxBuffer: 64 * 1024 * 1024 }, (e, out) => done(e, String(out)));
            }
        }),
        signal: (pid, signal) => { process.kill(pid, signal); },
    };
}
