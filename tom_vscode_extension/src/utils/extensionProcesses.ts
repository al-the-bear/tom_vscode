/**
 * The processes below this window's extension host, attributed to the
 * extensions that started them (vscimpb30, the @TOM VSC view) — pure: the
 * service (src/services/extensionProcessService.ts) runs `ps` / PowerShell
 * and acts; this file parses, builds the tree, attributes and sums.
 *
 * Why processes and not extensions: VS Code has no API or command to disable
 * one extension (only all of them, and only with an extension-host restart).
 * What eats memory and CPU are the helper processes extensions start —
 * language servers, analysers, watchers — and those can be paused (SIGSTOP:
 * no CPU, macOS compresses or swaps their idle memory, the extension does not
 * notice, so nothing restarts it) and resumed where they stopped (SIGCONT).
 */

/** One process as `ps` (or Windows' process list) reports it. */
export interface ProcInfo {
    pid: number;
    ppid: number;
    /** `ps` STAT (`S`, `R`, `T` = stopped, …); '' on Windows. */
    state: string;
    /** Resident memory in KiB (Windows: the working set). */
    rssKb: number;
    /** CPU percent as `ps` reports it; null where unknown (Windows). */
    cpu: number | null;
    /** How long it runs, as `ps` etime (`[[dd-]hh:]mm:ss`) or computed. */
    elapsed: string;
    command: string;
}

/** A process of the tree with its depth below the root (1 = a direct child). */
export interface TreeProc extends ProcInfo {
    depth: number;
}

/** Who started a process: the extension id when it can be told, else a description. */
export interface ProcOwner {
    /** `publisher.name` (a built-in: `vscode.<name>`), or '' when unknown. */
    extensionId: string;
    /** What the row shows: the extension id, or the kind of process. */
    label: string;
    /** What the process is, e.g. `Dart analysis server`, `TypeScript server`, `git`. */
    kind: string;
}

/** The `ps` call whose output parsePsOutput reads (macOS and Linux). */
export const PS_ARGS = ['-A', '-o', 'pid=,ppid=,stat=,rss=,%cpu=,etime=,command='];

/** Parse `ps -A -o pid=,ppid=,stat=,rss=,%cpu=,etime=,command=`. */
export function parsePsOutput(text: string): ProcInfo[] {
    const out: ProcInfo[] = [];
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m) { continue; }
        out.push({ pid: Number(m[1]), ppid: Number(m[2]), state: m[3], rssKb: Number(m[4]), cpu: Number(m[5]), elapsed: m[6], command: m[7].trim() });
    }
    return out;
}

/**
 * The PowerShell command whose JSON parseWindowsProcesses reads: every process
 * with its parent, working set, command line and start time.
 */
export const WINDOWS_PS_COMMAND = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine,Name,CreationDate | ConvertTo-Json -Compress';

/** Parse the JSON of WINDOWS_PS_COMMAND (one object or an array); `now` for the elapsed time. */
export function parseWindowsProcesses(json: string, now: Date = new Date()): ProcInfo[] {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { return []; }
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: ProcInfo[] = [];
    for (const r of list as Array<Record<string, unknown>>) {
        const pid = Number(r.ProcessId);
        if (!Number.isInteger(pid)) { continue; }
        const started = windowsDate(r.CreationDate);
        out.push({
            pid,
            ppid: Number(r.ParentProcessId) || 0,
            state: '',
            rssKb: Math.round((Number(r.WorkingSetSize) || 0) / 1024),
            cpu: null,
            elapsed: started ? formatElapsed(now.getTime() - started.getTime()) : '',
            command: String(r.CommandLine || r.Name || ''),
        });
    }
    return out;
}

/** A CIM date as ConvertTo-Json writes it: `/Date(1731230000000)/`, or an ISO string. */
function windowsDate(v: unknown): Date | null {
    if (typeof v !== 'string') { return null; }
    const ms = /\/Date\((\d+)\)\//.exec(v);
    const d = ms ? new Date(Number(ms[1])) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

/** An elapsed time as `ps` writes it: `[[dd-]hh:]mm:ss`. */
export function formatElapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const two = (n: number): string => String(n).padStart(2, '0');
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const clock = `${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
    if (days) { return `${days}-${two(hours)}:${clock}`; }
    return hours ? `${two(hours)}:${clock}` : clock;
}

/** Every descendant of `rootPid`, depth first (a parent before its children); the root itself not included. */
export function descendants(procs: readonly ProcInfo[], rootPid: number): TreeProc[] {
    const children = new Map<number, ProcInfo[]>();
    for (const p of procs) {
        if (p.pid === p.ppid) { continue; }
        const list = children.get(p.ppid) ?? [];
        list.push(p);
        children.set(p.ppid, list);
    }
    const out: TreeProc[] = [];
    const seen = new Set<number>([rootPid]);
    const walk = (pid: number, depth: number): void => {
        for (const c of (children.get(pid) ?? []).sort((a, b) => a.pid - b.pid)) {
            if (seen.has(c.pid)) { continue; }
            seen.add(c.pid);
            out.push({ ...c, depth });
            walk(c.pid, depth + 1);
        }
    };
    walk(rootPid, 1);
    return out;
}

/** Known kinds of helper process by their command line, first match wins. */
const KINDS: Array<{ test: RegExp; kind: string; extensionId?: string }> = [
    { test: /\bdart(?:\.exe)?\b.*\b(language-server|analysis_server)\b|analysis_server\.dart\.snapshot/i, kind: 'Dart analysis server', extensionId: 'dart-code.dart-code' },
    { test: /\bdart(?:\.exe)?\b.*\b(tooling-daemon|devtools)\b/i, kind: 'Dart tooling', extensionId: 'dart-code.dart-code' },
    { test: /\btsserver(\.js)?\b/i, kind: 'TypeScript server', extensionId: 'vscode.typescript-language-features' },
    { test: /\beslintServer\b|eslint[\\/]server/i, kind: 'ESLint server', extensionId: 'dbaeumer.vscode-eslint' },
    { test: /copilot/i, kind: 'Copilot', extensionId: 'github.copilot' },
    { test: /(^|[\\/\s])git(\.exe)?(\s|$)|[\\/]git-core[\\/]/i, kind: 'git', extensionId: 'vscode.git' },
    { test: /\btom_bs(\.exe)?\b/i, kind: 'DartScript bridge (tom_bs)', extensionId: 'peter-nicolai-alexis-kyaw.tom-ai-extension' },
    { test: /claude-agent-sdk|@anthropic-ai[\\/]claude/i, kind: 'Claude Agent SDK', extensionId: 'peter-nicolai-alexis-kyaw.tom-ai-extension' },
    { test: /\bpylance\b|\bpyright\b/i, kind: 'Python language server', extensionId: 'ms-python.vscode-pylance' },
    { test: /\bgopls\b/i, kind: 'Go language server', extensionId: 'golang.go' },
    { test: /\brust-analyzer\b/i, kind: 'Rust analyzer', extensionId: 'rust-lang.rust-analyzer' },
];

/**
 * The extension that started a process, read from its command line, the
 * surest first: a path below an installed extension
 * (`.vscode/extensions/<publisher.name>-<version>/`), a known kind of process
 * (KINDS: the Dart analysis server, tsserver, git, …), a path below a built-in
 * extension (`…/app/extensions/<name>/` → `vscode.<name>`) or an extension's
 * global storage (`globalStorage/<publisher.name>/`); else unknown, labelled by
 * its program name.
 */
export function attributeProcess(command: string): ProcOwner {
    const cmd = String(command || '');
    const known = KINDS.find((k) => k.test.test(cmd));
    const installed = /[\\/]\.vscode(?:-insiders|-oss)?[\\/]extensions[\\/]([a-z0-9][\w-]*\.[\w.-]+?)-\d+\.\d+\.\d+[^\\/]*[\\/]/i.exec(cmd);
    // A built-in extension's folder; `node_modules` there is shared (tsserver lives in it), not an extension.
    const builtin = /[\\/](?:app|resources[\\/]app)[\\/]extensions[\\/](?!node_modules[\\/])([\w.-]+)[\\/]/i.exec(cmd);
    const storage = /[\\/]globalStorage[\\/]([a-z0-9][\w-]*\.[\w.-]+)[\\/]/i.exec(cmd);
    const extensionId = (installed?.[1] ?? known?.extensionId ?? (builtin ? `vscode.${builtin[1]}` : storage?.[1] ?? '')).toLowerCase();
    const kind = known?.kind ?? programName(cmd);
    return { extensionId, label: extensionId || kind, kind };
}

/** The program a command line runs (its first word's file name). */
function programName(command: string): string {
    const first = /^\s*("([^"]+)"|(\S+(?:\s(?=\S*\.app[\\/]))?\S*))/.exec(command);
    const exe = first ? (first[2] ?? first[3] ?? '') : '';
    const base = exe.split(/[\\/]/).pop() ?? exe;
    return base || 'process';
}

/** A stopped process (SIGSTOP): its `ps` state starts with `T`. */
export function isPaused(state: string): boolean {
    return /^T/.test(state || '');
}

/** One extension's processes and their sums (what the view lists). */
export interface ExtensionGroup {
    extensionId: string;
    label: string;
    rssKb: number;
    /** Summed CPU percent; null when unknown (Windows). */
    cpu: number | null;
    processes: Array<TreeProc & { owner: ProcOwner; paused: boolean }>;
    /** Every process of the group is paused. */
    paused: boolean;
}

/** Group the processes by their extension, the largest memory first. */
export function groupByExtension(procs: readonly TreeProc[]): ExtensionGroup[] {
    const groups = new Map<string, ExtensionGroup>();
    for (const p of procs) {
        const owner = attributeProcess(p.command);
        const key = owner.extensionId || `?${owner.kind}`;
        const g = groups.get(key) ?? { extensionId: owner.extensionId, label: owner.label, rssKb: 0, cpu: null, processes: [], paused: false };
        g.rssKb += p.rssKb;
        if (p.cpu !== null) { g.cpu = (g.cpu ?? 0) + p.cpu; }
        g.processes.push({ ...p, owner, paused: isPaused(p.state) });
        groups.set(key, g);
    }
    for (const g of groups.values()) { g.paused = g.processes.length > 0 && g.processes.every((p) => p.paused); }
    return [...groups.values()].sort((a, b) => b.rssKb - a.rssKb || a.label.localeCompare(b.label));
}

/** Memory for a person: `612 MB`, `9.2 GB`. */
export function formatMemory(kb: number): string {
    const mb = kb / 1024;
    if (mb < 1024) { return `${Math.round(mb)} MB`; }
    return `${(mb / 1024).toFixed(1)} GB`;
}

/** The status bar's text for the window's helper processes: `9.2 GB in 7 processes`. */
export function totalsText(procs: readonly ProcInfo[]): string {
    const kb = procs.reduce((s, p) => s + p.rssKb, 0);
    return `${formatMemory(kb)} in ${procs.length} process${procs.length === 1 ? '' : 'es'}`;
}
