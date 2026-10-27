/**
 * The heartbeat of a window's state file (`_ai/local/<window>.window-state.json`):
 * every window rewrites `heartbeat` every {@link HEARTBEAT_INTERVAL_MS}, with
 * its process id and its CLI and MCP servers. A window whose heartbeat is
 * older than {@link HEARTBEAT_STALE_MS} — or that has none (a build from
 * before the heartbeat, or a window that died) — is gone: the WINDOW STATUS
 * view shows it so, and tomAi_sendItemToQuest answers `targetRunning: false`.
 *
 * vscode-free.
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 90_000;

export interface ServerState {
    running: boolean;
    host?: string;
    port?: number;
}

/** The heartbeat fields of a window state file. */
export interface WindowHeartbeat {
    heartbeat?: string;
    pid?: number;
    cliServer?: ServerState;
    mcpServer?: ServerState;
}

/** The fields of a window state file the rules below read. */
export interface HeartbeatState extends WindowHeartbeat {
    windowId?: string;
    workspace?: string;
    activeQuest?: string;
}

/** Whether the window wrote its heartbeat within the last {@link HEARTBEAT_STALE_MS}. */
export function isWindowAlive(state: WindowHeartbeat, nowMs: number, staleMs = HEARTBEAT_STALE_MS): boolean {
    if (!state.heartbeat) { return false; }
    const at = Date.parse(state.heartbeat);
    return Number.isFinite(at) && nowMs - at <= staleMs;
}

/** The live windows working on `quest`: its quest is active there, or its workspace is named after it. */
export function liveWindowsOf<T extends HeartbeatState>(states: ReadonlyArray<T>, quest: string, nowMs: number): T[] {
    return states.filter((s) => (s.activeQuest === quest || s.workspace === quest) && isWindowAlive(s, nowMs));
}

/** The servers a window runs, for its line in the WINDOW STATUS view: `CLI :19901 · MCP :19921`, or ''. */
export function serverSummary(state: WindowHeartbeat): string {
    const parts: string[] = [];
    if (state.cliServer?.running) { parts.push(`CLI${state.cliServer.port ? ` :${state.cliServer.port}` : ''}`); }
    if (state.mcpServer?.running) { parts.push(`MCP${state.mcpServer.port ? ` :${state.mcpServer.port}` : ''}`); }
    return parts.join(' · ');
}

/** Merge a fresh heartbeat into a state file's content (other fields kept). */
export function withHeartbeat<T extends object>(state: T, beat: Required<Pick<WindowHeartbeat, 'pid'>> & Omit<WindowHeartbeat, 'heartbeat'>, now: Date): T & WindowHeartbeat {
    return {
        ...state,
        heartbeat: now.toISOString(),
        pid: beat.pid,
        cliServer: beat.cliServer ?? { running: false },
        mcpServer: beat.mcpServer ?? { running: false },
    };
}
