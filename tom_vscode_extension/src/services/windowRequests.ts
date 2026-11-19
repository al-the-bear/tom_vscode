/**
 * Requests from one window on this machine to another, and the asks each
 * window has open — what USER NOTIFICATIONS needs to answer an ask of another
 * window, or continue another window's queue, from wherever the user is.
 *
 * Both live under one folder of the extension's global storage, shared by
 * every window:
 *
 * - `interactions/<windowId>.json` — the asks the window has open, as the
 *   user-input panel renders them (InteractionView: id, kind, run, title, data),
 *   written by the window whenever they change. Another window reads it to show
 *   one of them in its own user-input panel (a stand-in, `proxyOf`).
 * - `requests/<windowId>/<time>-<n>.json` — a request to the window: `answerAsk`
 *   (the response the stand-in's panel produced, for the ask `id`) or
 *   `resumeRun` (switch the run's auto-send on). The window takes each file,
 *   deletes it and carries it out.
 *
 * vscode-free (fs).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { InteractionView } from './userInteractions';

/** A request to a window. */
export type WindowRequest =
    | { type: 'answerAsk'; id: string; response: Record<string, unknown>; from?: string }
    | { type: 'resumeRun'; run: string; from?: string };

/** What a window does with the requests it is sent. */
export interface WindowRequestHandlers {
    answerAsk(id: string, response: Record<string, unknown>): boolean;
    resumeRun(run: string): boolean;
}

let rootDir: string | undefined;
let ownWindow: string | undefined;
let counter = 0;

/** Register the folder (global storage) and this window's id (activation). */
export function configureWindowRequests(dir: string | undefined, windowId: string | undefined): void {
    rootDir = dir;
    ownWindow = windowId;
}

function interactionsFile(windowId: string): string | undefined {
    return rootDir ? path.join(rootDir, 'interactions', `${windowId}.json`) : undefined;
}

function requestsDir(windowId: string): string | undefined {
    return rootDir ? path.join(rootDir, 'requests', windowId) : undefined;
}

function writeAtomic(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${counter++}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
}

/** Write this window's open asks (its own; stand-ins are left out). */
export function publishInteractions(views: readonly InteractionView[]): void {
    const file = ownWindow ? interactionsFile(ownWindow) : undefined;
    if (!file) { return; }
    try {
        const own = views.filter((v) => !v.proxyOf);
        writeAtomic(file, `${JSON.stringify({ windowId: ownWindow, at: new Date().toISOString(), interactions: own })}\n`);
    } catch { /* best effort: another window then says the ask is not found */ }
}

/** The asks window `windowId` has open, as it last wrote them (none when unknown). */
export function readWindowInteractions(windowId: string): InteractionView[] {
    const file = interactionsFile(windowId);
    if (!file) { return []; }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { interactions?: unknown };
        return Array.isArray(raw.interactions) ? raw.interactions as InteractionView[] : [];
    } catch { return []; }
}

/** Send `request` to window `windowId`; answers whether it was written. */
export function sendWindowRequest(windowId: string, request: WindowRequest): boolean {
    const dir = requestsDir(windowId);
    if (!dir) { return false; }
    try {
        writeAtomic(path.join(dir, `${Date.now().toString(36)}-${process.pid}-${counter++}.json`), `${JSON.stringify({ ...request, ...(ownWindow ? { from: ownWindow } : {}) })}\n`);
        return true;
    } catch { return false; }
}

/** Take and carry out the requests waiting for this window, oldest first; answers how many were carried out. */
export function takeWindowRequests(handlers: WindowRequestHandlers): number {
    const dir = ownWindow ? requestsDir(ownWindow) : undefined;
    if (!dir) { return 0; }
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return 0; }
    let done = 0;
    for (const name of names) {
        const file = path.join(dir, name);
        let request: WindowRequest | undefined;
        try { request = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowRequest; } catch { request = undefined; }
        try { fs.unlinkSync(file); } catch { continue; } // another taker (a second listener) has it
        if (!request) { continue; }
        try {
            const ok = request.type === 'answerAsk'
                ? handlers.answerAsk(String(request.id), request.response ?? {})
                : request.type === 'resumeRun' ? handlers.resumeRun(String(request.run)) : false;
            if (ok) { done++; }
        } catch { /* a failing handler must not stop the others */ }
    }
    return done;
}

/**
 * Watch this window's requests and every window's open asks: requests are
 * carried out as they arrive (and once now); `onInteractions` runs when any
 * window's asks change (stand-ins whose ask was settled leave). Answers the
 * stop function.
 */
export function startWindowRequests(handlers: WindowRequestHandlers, onInteractions?: () => void): () => void {
    if (!rootDir || !ownWindow) { return () => undefined; }
    const watchers: fs.FSWatcher[] = [];
    const reqDir = requestsDir(ownWindow)!;
    const askDir = path.join(rootDir, 'interactions');
    try {
        fs.mkdirSync(reqDir, { recursive: true });
        fs.mkdirSync(askDir, { recursive: true });
        takeWindowRequests(handlers);
        const w1 = fs.watch(reqDir, () => { takeWindowRequests(handlers); });
        w1.on('error', () => w1.close());
        watchers.push(w1);
        if (onInteractions) {
            const w2 = fs.watch(askDir, () => { try { onInteractions(); } catch { /* display only */ } });
            w2.on('error', () => w2.close());
            watchers.push(w2);
        }
    } catch { /* no watching: requests wait for the next start */ }
    return () => { for (const w of watchers) { try { w.close(); } catch { /* closed */ } } };
}

/** This window's id, as configured. */
export function windowRequestsOwnWindow(): string | undefined {
    return ownWindow;
}
