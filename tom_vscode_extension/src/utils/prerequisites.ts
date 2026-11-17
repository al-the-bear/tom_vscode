/**
 * `prerequisites.yaml`: what a project needs before it builds or runs — the
 * secrets it reads and how each can be provided, and the software it expects
 * on the PATH. The file never holds a secret value; nothing here reads one
 * into anything shown.
 *
 * vscode-free: the format (types, parsing, the structural check the JSON
 * schema `src/config/prerequisites.schema.json` also makes), the presence
 * checks per way of providing a secret (every effect through
 * {@link PrerequisiteCheckDeps}, so tests use fakes), and the roll-up the
 * SECRETS view shows. The guideline is `_copilot_guidelines/prerequisites_yaml.md`.
 */

/* eslint-disable @typescript-eslint/naming-convention -- the format's own names (via values, tool names, env names, paths) */
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export const PREREQUISITES_FILE = 'prerequisites.yaml';
export const PREREQUISITES_FORMAT_VERSION = 1;

export const SECRET_TYPES = [
    'api_key', 'access_token', 'oauth_client', 'password', 'ssh_key', 'tls_certificate', 'signing_key',
    'encryption_key', 'service_account', 'connection_string', 'webhook_secret', 'bot_token', 'other',
] as const;
export type SecretType = typeof SECRET_TYPES[number];

export const PROVIDE_VIAS = [
    'env', 'dotenv', 'file', 'keychain', 'vscode_secret', 'kdbx', 'cli_login', 'ssh_agent', 'cloud_secret_manager', 'other',
] as const;
export type ProvideVia = typeof PROVIDE_VIAS[number];

/** The fields each way of providing requires (beyond `via`). */
export const VIA_REQUIRED_FIELDS: Record<ProvideVia, string[]> = {
    env: ['name'],
    dotenv: ['file', 'name'],
    file: ['path'],
    keychain: ['service'],
    vscode_secret: ['key'],
    kdbx: ['database', 'entry'],
    cli_login: ['tool'],
    ssh_agent: [],
    cloud_secret_manager: ['provider', 'name'],
    other: ['viaNote'],
};

/** One way to provide a secret. */
export interface ProvideOption {
    via: ProvideVia;
    description?: string;
    /** A command whose exit code 0 means available (run in the file's folder through the shell). */
    check?: string;
    name?: string;
    file?: string;
    path?: string;
    service?: string;
    account?: string;
    /** Windows Credential Manager target (default: `service`). */
    target?: string;
    key?: string;
    database?: string;
    entry?: string;
    tool?: string;
    fingerprint?: string;
    provider?: string;
    viaNote?: string;
}

export interface SecretEntry {
    id: string;
    title: string;
    type: SecretType;
    typeNote?: string;
    required: boolean;
    description?: string;
    obtain?: string;
    options: ProvideOption[];
}

/** Software the project expects: a command on the PATH. */
export interface ToolEntry {
    id: string;
    title: string;
    /** The command looked up on the PATH, e.g. `dart`, `node`, `gh`. */
    command: string;
    required: boolean;
    description?: string;
    obtain?: string;
    /** A command whose exit code 0 means present (instead of the PATH lookup). */
    check?: string;
}

export interface PrerequisiteSection {
    id: string;
    title: string;
    description?: string;
    secrets: SecretEntry[];
    tools: ToolEntry[];
}

export interface PrerequisitesFile {
    formatVersion: number;
    sections: PrerequisiteSection[];
}

/** A finding of the structural check, with the path into the document. */
export interface PrerequisitesProblem {
    path: string;
    message: string;
}

export type ParseResult =
    | { ok: true; file: PrerequisitesFile; problems: PrerequisitesProblem[] }
    | { ok: false; error: string; problems: PrerequisitesProblem[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/**
 * Parse a `prerequisites.yaml`. Structural problems (what the schema reports
 * too, plus unique ids) are listed; entries that are unusable are left out,
 * the rest is kept so the view can still show it.
 */
export function parsePrerequisites(text: string): ParseResult {
    let doc: unknown;
    try {
        doc = parseYaml(text);
    } catch (e) {
        return { ok: false, error: `not YAML: ${(e as Error).message.split('\n')[0]}`, problems: [] };
    }
    const problems: PrerequisitesProblem[] = [];
    if (!isObj(doc)) { return { ok: false, error: 'the file is not a mapping', problems }; }
    const formatVersion = doc.formatVersion;
    if (formatVersion !== PREREQUISITES_FORMAT_VERSION) {
        problems.push({ path: 'formatVersion', message: `formatVersion must be ${PREREQUISITES_FORMAT_VERSION}` });
    }
    if (!Array.isArray(doc.sections)) { return { ok: false, error: 'no sections list', problems }; }
    const sections: PrerequisiteSection[] = [];
    const sectionIds = new Set<string>();
    doc.sections.forEach((raw, si) => {
        const at = `sections[${si}]`;
        if (!isObj(raw) || !str(raw.id) || !str(raw.title)) { problems.push({ path: at, message: 'a section needs id and title' }); return; }
        const id = raw.id as string;
        if (sectionIds.has(id)) { problems.push({ path: `${at}.id`, message: `section id ${id} is used twice` }); return; }
        sectionIds.add(id);
        const secrets: SecretEntry[] = [];
        const tools: ToolEntry[] = [];
        const itemIds = new Set<string>();
        const takeId = (itemAt: string, itemId: string): boolean => {
            if (itemIds.has(itemId)) { problems.push({ path: `${itemAt}.id`, message: `id ${itemId} is used twice in section ${id}` }); return false; }
            itemIds.add(itemId);
            return true;
        };
        (Array.isArray(raw.secrets) ? raw.secrets : []).forEach((s, i) => {
            const sAt = `${at}.secrets[${i}]`;
            const secret = parseSecret(s, sAt, problems);
            if (secret && takeId(sAt, secret.id)) { secrets.push(secret); }
        });
        (Array.isArray(raw.tools) ? raw.tools : []).forEach((t, i) => {
            const tAt = `${at}.tools[${i}]`;
            if (!isObj(t) || !str(t.id) || !str(t.title) || !str(t.command)) { problems.push({ path: tAt, message: 'a tool needs id, title and command' }); return; }
            if (!takeId(tAt, t.id as string)) { return; }
            tools.push({
                id: t.id as string, title: t.title as string, command: t.command as string,
                required: t.required !== false,
                description: str(t.description), obtain: str(t.obtain), check: str(t.check),
            });
        });
        if (raw.secrets !== undefined && !Array.isArray(raw.secrets)) { problems.push({ path: `${at}.secrets`, message: 'secrets must be a list' }); }
        if (raw.tools !== undefined && !Array.isArray(raw.tools)) { problems.push({ path: `${at}.tools`, message: 'tools must be a list' }); }
        sections.push({ id, title: raw.title as string, description: str(raw.description), secrets, tools });
    });
    return { ok: true, file: { formatVersion: typeof formatVersion === 'number' ? formatVersion : 0, sections }, problems };
}

function parseSecret(s: unknown, at: string, problems: PrerequisitesProblem[]): SecretEntry | null {
    if (!isObj(s) || !str(s.id) || !str(s.title)) { problems.push({ path: at, message: 'a secret needs id and title' }); return null; }
    const type = s.type as SecretType;
    if (!SECRET_TYPES.includes(type)) { problems.push({ path: `${at}.type`, message: `type must be one of ${SECRET_TYPES.join(', ')}` }); return null; }
    if (type === 'other' && !str(s.typeNote)) { problems.push({ path: `${at}.typeNote`, message: 'type other needs a typeNote' }); }
    if (!Array.isArray(s.options) || s.options.length === 0) { problems.push({ path: `${at}.options`, message: 'a secret needs at least one option' }); return null; }
    const options: ProvideOption[] = [];
    s.options.forEach((o, i) => {
        const oAt = `${at}.options[${i}]`;
        if (!isObj(o) || !PROVIDE_VIAS.includes(o.via as ProvideVia)) { problems.push({ path: `${oAt}.via`, message: `via must be one of ${PROVIDE_VIAS.join(', ')}` }); return; }
        const via = o.via as ProvideVia;
        const missing = VIA_REQUIRED_FIELDS[via].filter((f) => !str(o[f]));
        if (missing.length) { problems.push({ path: oAt, message: `via ${via} needs ${missing.join(', ')}` }); return; }
        const option: ProvideOption = { via };
        for (const k of ['description', 'check', 'name', 'file', 'path', 'service', 'account', 'target', 'key', 'database', 'entry', 'tool', 'fingerprint', 'provider', 'viaNote'] as const) {
            const v = str(o[k]);
            if (v !== undefined) { option[k] = v; }
        }
        options.push(option);
    });
    if (options.length === 0) { return null; }
    return {
        id: s.id as string, title: s.title as string, type, typeNote: str(s.typeNote),
        required: s.required !== false, description: str(s.description), obtain: str(s.obtain), options,
    };
}

/** A starting file for a project without one (the view's Create button). */
export function prerequisitesSkeleton(projectName: string): string {
    return [
        '# What this project needs before it builds or runs: secrets (never their values) and software.',
        '# Format: _copilot_guidelines/prerequisites_yaml.md; schema: the Tom AI extension\'s prerequisites.schema.json.',
        `formatVersion: ${PREREQUISITES_FORMAT_VERSION}`,
        'sections:',
        '  - id: main',
        `    title: ${JSON.stringify(projectName)}`,
        '    description: >-',
        '      What this component needs, and what for.',
        '    secrets: []',
        '    tools: []',
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** `set` ✓, `missing` ✗, `unknown` ?. */
export type CheckStatus = 'set' | 'missing' | 'unknown';

export interface CheckResult {
    status: CheckStatus;
    /** env / a tool: what the extension host (VS Code) sees. */
    host?: CheckStatus;
    /** env / a tool: what the login shell (a terminal) sees. */
    shell?: CheckStatus;
    /** One line: what was looked at (never a value). */
    detail: string;
    /** E.g. a key file readable by others. */
    warning?: string;
    /** ISO time of the check. */
    checkedAt: string;
}

export interface RunResult {
    /** null: it did not run or was killed (timeout). */
    exitCode: number | null;
    timedOut?: boolean;
    /** Only when asked for (`captureStdout`); never a secret (status output, fingerprints). */
    stdout?: string;
}

/** Every effect a check has; the service gives the real ones, tests fakes. */
export interface PrerequisiteCheckDeps {
    platform: NodeJS.Platform;
    homedir: string;
    /** The extension host's environment. */
    env: NodeJS.ProcessEnv;
    /** Whether the user's login shell has the variable set and non-empty (presence only). */
    shellHasEnv(name: string): Promise<CheckStatus>;
    /** Whether the login shell finds the command. */
    shellHasCommand(command: string): Promise<CheckStatus>;
    /** File facts, or null when it does not exist / cannot be read. */
    stat(file: string): { size: number; mode: number; isFile: boolean } | null;
    readText(file: string): string | null;
    /** Run a program (no shell); stdout only with captureStdout. */
    run(command: string, args: string[], opts?: { captureStdout?: boolean; cwd?: string }): Promise<RunResult>;
    /** Run a `check` command line through the shell in `cwd`. */
    runShell(commandLine: string, cwd: string): Promise<RunResult>;
    /** VS Code SecretStorage of this extension: whether the key holds something. */
    vscodeSecretHas(key: string): Promise<boolean>;
    now(): Date;
}

/** `~/x` and paths relative to the file's folder. */
export function resolveOptionPath(p: string, baseDir: string, homedir: string): string {
    if (p === '~') { return homedir; }
    if (p.startsWith('~/')) { return path.join(homedir, p.slice(2)); }
    return path.isAbsolute(p) ? p : path.join(baseDir, p);
}

/** The value of `name` in a dotenv text is set and non-empty (the value itself is not kept). */
export function dotenvHasKey(text: string, name: string): boolean {
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim().replace(/^export\s+/, '');
        if (!line || line.startsWith('#')) { continue; }
        const eq = line.indexOf('=');
        if (eq <= 0 || line.slice(0, eq).trim() !== name) { continue; }
        const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        return value !== '';
    }
    return false;
}

/**
 * The built-in login checks of `cli_login`: the program, its arguments, and
 * whether exit 0 is enough or stdout must be non-empty. `file` checks look for
 * the tool's credentials file instead (no program run).
 */
export const CLI_LOGIN_CHECKS: Record<string, { command: string; args: string[]; needsStdout?: boolean } | { credentialsFiles: (home: string, platform: NodeJS.Platform) => string[] }> = {
    gh: { command: 'gh', args: ['auth', 'status'] },
    gcloud: { command: 'gcloud', args: ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], needsStdout: true },
    aws: { command: 'aws', args: ['sts', 'get-caller-identity'] },
    az: { command: 'az', args: ['account', 'show'] },
    npm: { command: 'npm', args: ['whoami'] },
    firebase: { command: 'firebase', args: ['login:list'], needsStdout: true },
    'dart pub': {
        credentialsFiles: (home, platform) => platform === 'darwin'
            ? [path.join(home, 'Library', 'Application Support', 'dart', 'pub-credentials.json')]
            : platform === 'win32'
                ? [path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'dart', 'pub-credentials.json')]
                : [path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'dart', 'pub-credentials.json')],
    },
};

/** The program a check runs, for running at most one check per program at a time. */
export function checkProgram(option: ProvideOption, platform: NodeJS.Platform): string | null {
    if (option.check) { return 'shell'; }
    switch (option.via) {
        case 'keychain': return platform === 'darwin' ? 'security' : platform === 'win32' ? 'cmdkey' : 'secret-tool';
        case 'cli_login': {
            const entry = CLI_LOGIN_CHECKS[option.tool ?? ''];
            return entry && 'command' in entry ? entry.command : null;
        }
        case 'ssh_agent': return 'ssh-add';
        default: return null;
    }
}

const fromRun = (r: RunResult, what: string): { status: CheckStatus; detail: string } => r.timedOut
    ? { status: 'unknown', detail: `${what}: timed out` }
    : r.exitCode === null
        ? { status: 'unknown', detail: `${what}: did not run` }
        : { status: r.exitCode === 0 ? 'set' : 'missing', detail: `${what}: exit ${r.exitCode}` };

/** Check one way of providing a secret: presence only, never the value. */
export async function checkOption(option: ProvideOption, baseDir: string, deps: PrerequisiteCheckDeps): Promise<CheckResult> {
    const at = deps.now().toISOString();
    const done = (r: { status: CheckStatus; detail: string; host?: CheckStatus; shell?: CheckStatus; warning?: string }): CheckResult => ({ ...r, checkedAt: at });
    if (option.check) {
        const r = await deps.runShell(option.check, baseDir);
        return done(fromRun(r, `check \`${option.check}\``));
    }
    switch (option.via) {
        case 'env': {
            const name = option.name!;
            const host: CheckStatus = (deps.env[name] ?? '') !== '' ? 'set' : 'missing';
            const shell = await deps.shellHasEnv(name);
            const status: CheckStatus = host === 'set' || shell === 'set' ? 'set' : shell === 'missing' ? 'missing' : 'unknown';
            const warning = host === 'set' && shell === 'missing'
                ? 'set in VS Code, not in a login shell: a terminal will not have it'
                : host === 'missing' && shell === 'set'
                    ? 'set in a login shell, not in VS Code: restart VS Code from a shell that has it, or set it where VS Code reads it'
                    : undefined;
            return done({ status, host, shell, detail: `$${name}: VS Code ${host === 'set' ? 'set' : 'not set'}, login shell ${shell === 'set' ? 'set' : shell === 'missing' ? 'not set' : 'unknown'}`, ...(warning ? { warning } : {}) });
        }
        case 'dotenv': {
            const file = resolveOptionPath(option.file!, baseDir, deps.homedir);
            const text = deps.readText(file);
            if (text === null) { return done({ status: 'missing', detail: `${file}: no such file` }); }
            const has = dotenvHasKey(text, option.name!);
            return done({ status: has ? 'set' : 'missing', detail: `${file}: ${option.name} ${has ? 'set' : 'not set'}` });
        }
        case 'file': {
            const file = resolveOptionPath(option.path!, baseDir, deps.homedir);
            const st = deps.stat(file);
            if (!st || !st.isFile) { return done({ status: 'missing', detail: `${file}: no such file` }); }
            if (st.size === 0) { return done({ status: 'missing', detail: `${file}: empty` }); }
            const warning = deps.platform !== 'win32' && (st.mode & 0o077) !== 0
                ? `readable by ${st.mode & 0o007 ? 'others' : 'the group'} (mode ${(st.mode & 0o777).toString(8)}): chmod 600`
                : undefined;
            return done({ status: 'set', detail: `${file}: present, ${st.size} bytes`, ...(warning ? { warning } : {}) });
        }
        case 'keychain': {
            if (deps.platform === 'darwin') {
                const args = ['find-generic-password', '-s', option.service!, ...(option.account ? ['-a', option.account] : [])];
                return done(fromRun(await deps.run('security', args), `Keychain ${option.service}${option.account ? ` / ${option.account}` : ''}`));
            }
            if (deps.platform === 'win32') {
                const target = option.target ?? option.service!;
                const r = await deps.run('cmdkey', [`/list:${target}`], { captureStdout: true });
                if (r.timedOut || r.exitCode === null) { return done(fromRun(r, `Credential Manager ${target}`)); }
                const found = /Target:/i.test(r.stdout ?? '');
                return done({ status: found ? 'set' : 'missing', detail: `Credential Manager ${target}: ${found ? 'found' : 'not found'}` });
            }
            // libsecret: `lookup` prints the secret to stdout, which is never captured.
            const attrs = ['service', option.service!, ...(option.account ? ['account', option.account] : [])];
            return done(fromRun(await deps.run('secret-tool', ['lookup', ...attrs]), `libsecret ${attrs.join(' ')}`));
        }
        case 'vscode_secret': {
            const has = await deps.vscodeSecretHas(option.key!);
            return done({ status: has ? 'set' : 'missing', detail: `VS Code secret ${option.key}: ${has ? 'stored' : 'not stored'}` });
        }
        case 'cli_login': {
            const tool = option.tool!;
            const entry = CLI_LOGIN_CHECKS[tool];
            if (!entry) { return done({ status: 'unknown', detail: `no built-in login check for ${tool}: give the option a check` }); }
            if ('credentialsFiles' in entry) {
                const files = entry.credentialsFiles(deps.homedir, deps.platform);
                const found = files.find((f) => { const st = deps.stat(f); return !!st && st.isFile && st.size > 0; });
                return done({ status: found ? 'set' : 'missing', detail: found ? `${tool}: ${found}` : `${tool}: no ${files.join(' / ')}` });
            }
            const r = await deps.run(entry.command, entry.args, { captureStdout: entry.needsStdout });
            const base = fromRun(r, `${entry.command} ${entry.args.join(' ')}`);
            if (base.status === 'set' && entry.needsStdout && !(r.stdout ?? '').trim()) {
                return done({ status: 'missing', detail: `${entry.command} ${entry.args.join(' ')}: no account` });
            }
            return done(base);
        }
        case 'ssh_agent': {
            const r = await deps.run('ssh-add', ['-l'], { captureStdout: true });
            if (r.timedOut || r.exitCode === null) { return done(fromRun(r, 'ssh-add -l')); }
            const keys = (r.stdout ?? '').split('\n').filter((l) => l.trim() && !/no identities/i.test(l));
            if (r.exitCode !== 0 || keys.length === 0) { return done({ status: 'missing', detail: 'ssh-agent: no key loaded' }); }
            if (option.fingerprint) {
                const has = keys.some((l) => l.includes(option.fingerprint!));
                return done({ status: has ? 'set' : 'missing', detail: `ssh-agent: ${has ? 'has' : 'lacks'} ${option.fingerprint}` });
            }
            return done({ status: 'set', detail: `ssh-agent: ${keys.length} key${keys.length === 1 ? '' : 's'} loaded` });
        }
        case 'kdbx':
        case 'cloud_secret_manager':
        case 'other':
            return done({ status: 'unknown', detail: `via ${option.via} is not checked from VS Code: give the option a check` });
    }
}

/** Check a tool: on the extension host's PATH and in a login shell (or its own check). */
export async function checkTool(tool: ToolEntry, baseDir: string, deps: PrerequisiteCheckDeps, onHostPath: (command: string) => boolean): Promise<CheckResult> {
    const at = deps.now().toISOString();
    if (tool.check) { return { ...fromRun(await deps.runShell(tool.check, baseDir), `check \`${tool.check}\``), checkedAt: at }; }
    const host: CheckStatus = onHostPath(tool.command) ? 'set' : 'missing';
    const shell = await deps.shellHasCommand(tool.command);
    const status: CheckStatus = host === 'set' || shell === 'set' ? 'set' : shell === 'missing' ? 'missing' : 'unknown';
    const warning = host === 'set' && shell === 'missing' ? 'on VS Code\'s PATH, not in a login shell'
        : host === 'missing' && shell === 'set' ? 'in a login shell, not on VS Code\'s PATH' : undefined;
    return {
        status, host, shell, checkedAt: at,
        detail: `${tool.command}: VS Code PATH ${host === 'set' ? 'found' : 'not found'}, login shell ${shell === 'set' ? 'found' : shell === 'missing' ? 'not found' : 'unknown'}`,
        ...(warning ? { warning } : {}),
    };
}

/** Whether `command` is an executable file in one of `PATH`'s folders. */
export function onPath(command: string, envPath: string | undefined, platform: NodeJS.Platform, stat: PrerequisiteCheckDeps['stat']): boolean {
    if (!envPath) { return false; }
    const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    for (const dir of envPath.split(platform === 'win32' ? ';' : ':')) {
        if (!dir) { continue; }
        for (const ext of exts) {
            const st = stat(path.join(dir, command + ext));
            if (st && st.isFile && (platform === 'win32' || (st.mode & 0o111) !== 0)) { return true; }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Keys and roll-up
// ---------------------------------------------------------------------------

/** The cache key of an option's result: the file, the section, the secret, the option's index and via. */
export function optionKey(file: string, sectionId: string, secretId: string, index: number, via: string): string {
    return `${file}#${sectionId}/${secretId}/${index}-${via}`;
}

/** The cache key of a tool's result. */
export function toolKey(file: string, sectionId: string, toolId: string): string {
    return `${file}#${sectionId}/tool:${toolId}`;
}

export interface RollUp {
    status: CheckStatus;
    /** Required items available / missing / not known (unchecked or unknown). */
    set: number;
    missing: number;
    unknown: number;
    /** Every item, required or not. */
    total: number;
}

/** A secret is available when any of its options is set; missing when every option is missing. */
export function secretStatus(results: ReadonlyArray<CheckResult | undefined>): CheckStatus {
    if (results.some((r) => r?.status === 'set')) { return 'set'; }
    if (results.length > 0 && results.every((r) => r?.status === 'missing')) { return 'missing'; }
    return 'unknown';
}

/** Roll items up: ✓ every required item set, ✗ a required item missing, else ?. Optional items are counted in total only. */
export function rollUp(items: ReadonlyArray<{ required: boolean; status: CheckStatus }>): RollUp {
    const req = items.filter((i) => i.required);
    const set = req.filter((i) => i.status === 'set').length;
    const missing = req.filter((i) => i.status === 'missing').length;
    const unknown = req.length - set - missing;
    return { status: missing > 0 ? 'missing' : unknown > 0 ? 'unknown' : 'set', set, missing, unknown, total: items.length };
}

/** Roll up roll-ups (section → project → repository). */
export function combineRollUps(parts: readonly RollUp[]): RollUp {
    const sum = (k: 'set' | 'missing' | 'unknown' | 'total'): number => parts.reduce((n, p) => n + p[k], 0);
    const missing = sum('missing');
    const unknown = sum('unknown');
    return { status: missing > 0 ? 'missing' : unknown > 0 ? 'unknown' : 'set', set: sum('set'), missing, unknown, total: sum('total') };
}

/**
 * The line (0-based) of a node in the file's text, for opening the file at an
 * entry: the section's `id:` line, then the item's (`<section>/<secret>` or
 * `<section>/tool:<tool>`) after it. -1 when not found.
 */
export function prerequisitesLineOf(text: string, nodeId: string): number {
    const lines = text.split(/\r?\n/);
    const idLine = (id: string, from: number): number => {
        const re = new RegExp(`^\\s*(?:-\\s*)?id:\\s*['"]?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*(?:#.*)?$`);
        for (let i = from; i < lines.length; i++) { if (re.test(lines[i])) { return i; } }
        return -1;
    };
    const [sectionId, rest] = nodeId.split('/', 2) as [string, string | undefined];
    const s = idLine(sectionId, 0);
    if (s < 0 || rest === undefined) { return s; }
    const item = idLine(rest.replace(/^tool:/, ''), s + 1);
    return item < 0 ? s : item;
}
