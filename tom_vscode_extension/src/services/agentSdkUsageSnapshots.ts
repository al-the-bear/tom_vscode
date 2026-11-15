/**
 * The last result's cumulative accounting of each Agent SDK session (qrfix3;
 * utils/agentSdkUsage.ts): the baseline its next prompt's cost, API time and
 * per-model rows are told from.
 *
 * Kept in memory and, once activation names a folder ({@link setAgentSdkUsageStoreDir},
 * the extension's global storage), in `agent-sdk-usage.json` there, so the first
 * prompt after a reload still has its baseline. Machine-local on purpose: the
 * Claude CLI keeps a session's totals with its conversation on this machine. At
 * most {@link MAX_SESSIONS} sessions are kept, the oldest dropped first.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentSdkUsageSnapshot } from '../utils/agentSdkUsage';

export const AGENT_SDK_USAGE_FILE = 'agent-sdk-usage.json';
const MAX_SESSIONS = 500;

interface Entry { snapshot: AgentSdkUsageSnapshot; at: number }

let storeDir: string | undefined;
let loaded = false;
const entries = new Map<string, Entry>();

/** Where the snapshots are persisted (the extension's global storage); undefined: memory only. */
export function setAgentSdkUsageStoreDir(dir: string | undefined): void {
    storeDir = dir;
    loaded = false;
    entries.clear();
}

function file(): string | undefined {
    return storeDir ? path.join(storeDir, AGENT_SDK_USAGE_FILE) : undefined;
}

function load(): void {
    if (loaded) { return; }
    loaded = true;
    const f = file();
    if (!f) { return; }
    try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, Entry>;
        for (const [id, e] of Object.entries(raw)) {
            if (e && typeof e === 'object' && e.snapshot && typeof e.snapshot === 'object') { entries.set(id, e); }
        }
    } catch { /* none yet, or unreadable: start empty */ }
}

function save(): void {
    const f = file();
    if (!f) { return; }
    try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* a lost baseline only makes the next prompt show the session's totals so far */ }
}

/** The previous result's snapshot of session `sessionId`, if one was recorded. */
export function agentSdkUsageSnapshot(sessionId: string): AgentSdkUsageSnapshot | undefined {
    load();
    return entries.get(sessionId)?.snapshot;
}

/** Record session `sessionId`'s latest result (the baseline for its next prompt). */
export function recordAgentSdkUsageSnapshot(sessionId: string, snapshot: AgentSdkUsageSnapshot, now = Date.now()): void {
    load();
    entries.delete(sessionId);
    entries.set(sessionId, { snapshot, at: now });
    while (entries.size > MAX_SESSIONS) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) { break; }
        entries.delete(oldest);
    }
    save();
}
