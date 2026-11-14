/**
 * The local service as a process: its configuration, key file, `service.json`,
 * the idle stop and the start sequence (agent_collaboration
 * part-coordination-service § Two runtimes starting it at once, § Lifetime).
 *
 * The port is the lock: the service binds it before it opens the store, and of
 * two services started at once exactly one binds it; the other answers
 * `alreadyRunning` and exits.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TacHttpServer } from './http/server';
import { TacError } from './protocol/errors';
import { PROTOCOL_VERSION } from './protocol/types';
import { TacService } from './service/service';
import { Store, writeFileAtomic } from './store/store';

export const DEFAULT_PORT = 19890;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_IDLE_MINUTES = 15;
export const SERVICE_NAME = 'tom-tac-service';
export const SERVICE_VERSION = readOwnVersion();

export interface LocalConfig {
    host: string;
    port: number;
    storeDir: string;
    idleMinutes: number;
    keepRunning: boolean;
    maxPayloadBytes: number;
}

function readOwnVersion(): string {
    for (const p of [path.join(__dirname, '..', '..', 'package.json'), path.join(__dirname, '..', 'package.json')]) {
        try {
            const v = (JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string });
            if (v.name === 'tom-tac-service' && v.version) { return v.version; }
        } catch { /* next */ }
    }
    return '0.0.0';
}

/** `~/.tom/coordination/` (on Windows `%USERPROFILE%\.tom\coordination\`): one store per machine and OS user. */
export function defaultStoreDir(): string {
    return path.join(os.homedir(), '.tom', 'coordination');
}

export function defaultConfig(): LocalConfig {
    return {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        storeDir: defaultStoreDir(),
        idleMinutes: DEFAULT_IDLE_MINUTES,
        keepRunning: false,
        maxPayloadBytes: 1024 * 1024,
    };
}

/**
 * Read a configuration file: JSON, or YAML limited to top-level `key: value`
 * lines (comments with `#`), which is all the machine's service config needs.
 */
export function readConfigFile(file: string): Partial<LocalConfig> {
    const text = fs.readFileSync(file, 'utf8');
    let raw: Record<string, unknown>;
    if (text.trimStart().startsWith('{')) {
        raw = JSON.parse(text) as Record<string, unknown>;
    } else {
        raw = {};
        text.split(/\r?\n/).forEach((line, i) => {
            const t = line.replace(/\s+#.*$/, '').trim();
            if (!t || t.startsWith('#')) { return; }
            const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(t);
            if (!m || /^\s/.test(line)) {
                throw new Error(`${file}:${i + 1}: expected a top-level "key: value" line`);
            }
            let v: unknown = m[2].replace(/^(['"])(.*)\1$/, '$2');
            if (v === 'true' || v === 'false') { v = v === 'true'; } else if (/^-?\d+$/.test(String(v))) { v = Number(v); }
            raw[m[1]] = v;
        });
    }
    const out: Partial<LocalConfig> = {};
    const known: (keyof LocalConfig)[] = ['host', 'port', 'storeDir', 'idleMinutes', 'keepRunning', 'maxPayloadBytes'];
    for (const k of Object.keys(raw)) {
        if (!(known as string[]).includes(k)) {
            throw new Error(`${file}: unknown setting ${k} (known: ${known.join(', ')})`);
        }
    }
    if (raw.host !== undefined) { out.host = String(raw.host); }
    if (raw.port !== undefined) { out.port = Number(raw.port); }
    if (raw.storeDir !== undefined) { out.storeDir = expandHome(String(raw.storeDir)); }
    if (raw.idleMinutes !== undefined) { out.idleMinutes = Number(raw.idleMinutes); }
    if (raw.keepRunning !== undefined) { out.keepRunning = raw.keepRunning === true; }
    if (raw.maxPayloadBytes !== undefined) { out.maxPayloadBytes = Number(raw.maxPayloadBytes); }
    return out;
}

function expandHome(p: string): string {
    return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * The configuration of a start: defaults, then the machine's service config
 * (`<storeDir>/config.yaml`, or the file `--config` names), then `overrides`.
 */
export function resolveConfig(overrides: Partial<LocalConfig> = {}, configFile?: string): LocalConfig {
    const base = defaultConfig();
    const storeDir = overrides.storeDir ?? base.storeDir;
    const file = configFile ?? path.join(storeDir, 'config.yaml');
    const fromFile = fs.existsSync(file) ? readConfigFile(file) : {};
    if (configFile && !fs.existsSync(configFile)) {
        throw new Error(`config file ${configFile} does not exist`);
    }
    const merged = { ...base, ...fromFile, ...stripUndefined(overrides) };
    // Absolute, because a detached service and service.json outlive the caller's working directory.
    return { ...merged, storeDir: path.resolve(merged.storeDir) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * The key of the local service: `<storeDir>/local.key`, created at the first
 * start with a random token, readable only by its user (mode 0600).
 */
export function ensureKeyFile(storeDir: string): string {
    fs.mkdirSync(storeDir, { recursive: true });
    const file = keyFilePath(storeDir);
    try {
        const key = randomBytes(32).toString('hex');
        fs.writeFileSync(file, key + '\n', { mode: 0o600, flag: 'wx' });
        return key;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { throw e; }
    }
    return readKeyFile(storeDir)!;
}

export function keyFilePath(storeDir: string): string {
    return path.join(storeDir, 'local.key');
}

export function readKeyFile(storeDir: string): string | undefined {
    try {
        const key = fs.readFileSync(keyFilePath(storeDir), 'utf8').trim();
        return key || undefined;
    } catch {
        return undefined;
    }
}

export interface ServiceJson {
    pid: number;
    port: number;
    host: string;
    version: string;
    protocolVersion: string;
    startedAt: string;
}

export function readServiceJson(storeDir: string): ServiceJson | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(storeDir, 'service.json'), 'utf8')) as ServiceJson;
    } catch {
        return undefined;
    }
}

export type StartResult =
    | { status: 'running'; handle: RunningService }
    | { status: 'alreadyRunning'; port: number };

export interface RunningService {
    readonly port: number;
    readonly config: LocalConfig;
    readonly service: TacService;
    readonly store: Store;
    /** Resolves when the service has stopped (idle stop, handover, stop, a fatal store error). */
    readonly stopped: Promise<string>;
    stop(reason?: string): Promise<void>;
}

export interface StartOptions {
    /** How often the idle stop is checked; default half the idle time, at most 30 s. */
    idleCheckMs?: number;
    /** How often the housekeeping sweep runs; default 15 s. */
    sweepMs?: number;
    pingMs?: number;
    silentMs?: number;
    now?: () => number;
    log?: (line: string) => void;
}

/**
 * Start the local service: bind the port, open the store, serve. Answers
 * `alreadyRunning` when another process holds the port.
 */
export async function startLocalService(config: LocalConfig, opts: StartOptions = {}): Promise<StartResult> {
    const log = opts.log ?? (() => undefined);
    fs.mkdirSync(config.storeDir, { recursive: true });
    const key = ensureKeyFile(config.storeDir);
    const startedAt = new Date().toISOString();
    let service: TacService | undefined;
    let store: Store | undefined;
    let lastAccess = Date.now();
    let stopping: Promise<void> | undefined;
    let resolveStopped!: (reason: string) => void;
    const stopped = new Promise<string>((r) => { resolveStopped = r; });
    let idleTimer: NodeJS.Timeout | undefined;
    let sweepTimer: NodeJS.Timeout | undefined;

    const stop = (reason = 'stop'): Promise<void> => {
        if (stopping) { return stopping; }
        stopping = (async () => {
            log(`stopping: ${reason}`);
            if (idleTimer) { clearInterval(idleTimer); }
            if (sweepTimer) { clearInterval(sweepTimer); }
            await server.close();
            try { store?.close(); } catch (e) { log(`final snapshot failed: ${(e as Error).message}`); }
            const sj = readServiceJson(config.storeDir);
            if (sj && sj.pid === process.pid) {
                try { fs.rmSync(path.join(config.storeDir, 'service.json')); } catch { /* gone */ }
            }
            resolveStopped(reason);
        })();
        return stopping;
    };

    const server: TacHttpServer = new TacHttpServer({
        service: () => service,
        key,
        host: config.host,
        port: config.port,
        pingMs: opts.pingMs,
        silentMs: opts.silentMs,
        onAccess: () => { lastAccess = Date.now(); },
        admin: {
            status: (): Record<string, unknown> => ({
                name: SERVICE_NAME,
                version: SERVICE_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                pid: process.pid,
                host: config.host,
                port: server.port,
                startedAt,
                storeDir: config.storeDir,
                storeBytes: store?.sizeOnDisk() ?? 0,
                groups: store?.groupIds() ?? [],
                openStreams: service?.openStreamCount() ?? 0,
                keepRunning: config.keepRunning,
                idleMinutes: config.idleMinutes,
                idleSince: service && service.openStreamCount() === 0 ? new Date(lastAccess).toISOString() : null,
            }),
            stop: (reason) => { void stop(reason); },
        },
    });

    try {
        await server.listen();
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            return { status: 'alreadyRunning', port: config.port };
        }
        throw e;
    }
    const port = server.port;
    try {
        store = Store.open(config.storeDir);
    } catch (e) {
        await server.close();
        throw e;
    }
    store.onFatal = (reason) => { log(`fatal: ${reason}`); void stop(`fatal: ${reason}`); };
    service = new TacService({
        store,
        now: opts.now,
        maxPayloadBytes: config.maxPayloadBytes,
        serviceInfo: { name: SERVICE_NAME, version: SERVICE_VERSION, pid: process.pid, startedAt },
    });
    const sj: ServiceJson = { pid: process.pid, port, host: config.host, version: SERVICE_VERSION, protocolVersion: PROTOCOL_VERSION, startedAt };
    writeFileAtomic(path.join(config.storeDir, 'service.json'), JSON.stringify(sj, null, 2) + '\n');
    log(`listening on ${config.host}:${port}, store ${config.storeDir}`);

    sweepTimer = setInterval(() => { try { service!.sweep(); } catch { /* next time */ } }, opts.sweepMs ?? 15_000);
    sweepTimer.unref();
    if (!config.keepRunning) {
        idleTimer = setInterval(() => {
            if (service!.openStreamCount() > 0) { return; }
            if (Date.now() - lastAccess >= config.idleMinutes * 60_000) { void stop('idle'); }
        }, opts.idleCheckMs ?? Math.min(30_000, Math.max(50, (config.idleMinutes * 60_000) / 2)));
    }
    return {
        status: 'running',
        handle: { port, config, service, store, stopped, stop },
    };
}

/** Throw the TAC error for a store whose format is newer, with a sentence for the command line. */
export function describeStartError(e: unknown): string {
    if (e instanceof TacError) { return `${e.code}: ${e.message}`; }
    return (e as Error)?.message ?? String(e);
}
