/**
 * Session keys and resource keys (doc/tac_specification.md § 3.4, § 3.5).
 */
import { TacError } from './errors';
import type { SessionKey, Unit } from './types';

const SESSION_PARTS: (keyof SessionKey)[] = ['quest', 'session', 'run', 'host', 'workspace'];

/** `<quest>#<session>@<run>/<host>/<workspace>`, each part percent-encoded. */
export function sessionKeyText(k: SessionKey): string {
    const e = (s: string) => encodeURIComponent(s);
    return `${e(k.quest)}#${e(k.session)}@${e(k.run)}/${e(k.host)}/${e(k.workspace)}`;
}

export function parseSessionKeyText(text: string): SessionKey {
    const m = /^([^#@/]+)#([^#@/]+)@([^#@/]+)\/([^#@/]+)\/([^#@/]+)$/.exec(text);
    if (!m) {
        throw new TacError('invalid', `not a session key: ${text}`, { expected: '<quest>#<session>@<run>/<host>/<workspace>' });
    }
    const d = (s: string) => decodeURIComponent(s);
    return { quest: d(m[1]), session: d(m[2]), run: d(m[3]), host: d(m[4]), workspace: d(m[5]) };
}

export function validateSessionKey(k: unknown): SessionKey {
    if (!k || typeof k !== 'object') {
        throw new TacError('invalid', 'sessionKey must be an object {quest, session, run, host, workspace}');
    }
    const o = k as Record<string, unknown>;
    for (const p of SESSION_PARTS) {
        if (typeof o[p] !== 'string' || (o[p] as string).length === 0) {
            throw new TacError('invalid', `sessionKey.${p} must be a non-empty string`);
        }
    }
    return { quest: o.quest as string, session: o.session as string, run: o.run as string, host: o.host as string, workspace: o.workspace as string };
}

export function sameSession(a: SessionKey, b: SessionKey): boolean {
    return SESSION_PARTS.every((p) => a[p] === b[p]);
}

export type ParsedKey =
    | { kind: 'repo'; repository: string; unit?: string }
    | { kind: 'infra'; name: string }
    | { kind: 'ai'; path: string };

const REPO_RE = /^[a-z][a-z0-9.-]*\/[^/:\s]+\/[^/:\s]+$/;

export function parseResourceKey(key: string): ParsedKey {
    if (typeof key !== 'string' || key.length === 0) {
        throw new TacError('invalid', 'a resource key must be a non-empty string');
    }
    if (key.startsWith('infra:')) {
        const name = key.slice(6);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
            throw new TacError('invalid', `malformed infra key: ${key}`);
        }
        return { kind: 'infra', name };
    }
    if (key.startsWith('ai:')) {
        const path = key.slice(3);
        if (!path || path.startsWith('/') || path.endsWith('/') || path.includes('//')) {
            throw new TacError('invalid', `malformed ai key: ${key}`);
        }
        return { kind: 'ai', path };
    }
    const colon = key.indexOf(':');
    const repository = colon < 0 ? key : key.slice(0, colon);
    if (!REPO_RE.test(repository)) {
        throw new TacError('invalid', `malformed resource key: ${key}`, { expected: '<provider>/<owner>/<repo>[:<unit path>], infra:<name> or ai:<path>' });
    }
    if (colon < 0) {
        return { kind: 'repo', repository };
    }
    const unit = key.slice(colon + 1);
    if (!unit || unit.startsWith('/') || unit.endsWith('/') || unit.includes('//')) {
        throw new TacError('invalid', `malformed unit path in ${key}`);
    }
    return { kind: 'repo', repository, unit };
}

/** `a` equals `b` or is a path prefix of it at a `/` boundary. */
function isPathPrefix(a: string, b: string): boolean {
    return a === b || b.startsWith(a + '/');
}

/** Whether a unit key's path lies in a `shared` path of the unit containing it (it then conflicts with nothing). */
function inSharedPath(repository: string, path: string, units: Unit[]): boolean {
    for (const u of units) {
        if (u.repository !== repository || !u.shared) { continue; }
        for (const s of u.shared) {
            if (isPathPrefix(s, path)) { return true; }
        }
    }
    return false;
}

/** Whether two resource keys conflict (§ 3.5). */
export function keysConflict(a: string, b: string, units: Unit[] = []): boolean {
    const pa = parseResourceKey(a);
    const pb = parseResourceKey(b);
    if (pa.kind !== pb.kind) { return false; }
    if (pa.kind === 'infra' && pb.kind === 'infra') { return pa.name === pb.name; }
    if (pa.kind === 'ai' && pb.kind === 'ai') { return pa.path === pb.path; }
    if (pa.kind === 'repo' && pb.kind === 'repo') {
        if (pa.repository !== pb.repository) { return false; }
        if (pa.unit && inSharedPath(pa.repository, pa.unit, units)) { return false; }
        if (pb.unit && inSharedPath(pb.repository, pb.unit, units)) { return false; }
        if (!pa.unit || !pb.unit) { return true; }
        return isPathPrefix(pa.unit, pb.unit) || isPathPrefix(pb.unit, pa.unit);
    }
    return false;
}
