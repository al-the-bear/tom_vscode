import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { Store } from '../src/store/store';
import { TacService } from '../src/service/service';
import type { SessionKey } from '../src/protocol/types';
import { ulid } from '../src/util/ulid';

/** A scratch folder under the package's gitignored `dist/` (never /tmp). */
export function scratchDir(name: string): string {
    const dir = path.join(__dirname, '..', 'scratch', `${name}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function removeDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

export class FakeClock {
    t = Date.parse('2026-11-14T12:00:00.000Z');
    now = (): number => this.t;
    advance(minutes: number): void { this.t += minutes * 60_000; }
}

export function newService(dir: string, clock = new FakeClock()): { svc: TacService; store: Store; clock: FakeClock } {
    const store = Store.open(dir);
    const svc = new TacService({ store, now: clock.now });
    return { svc, store, clock };
}

export function sk(quest: string, session = 'default', run = 'default', host = 'mbp', workspace = 'ws'): SessionKey {
    return { quest, session, run, host, workspace };
}

export function runtimeBody(quests: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        runtimeId: ulid(),
        kind: 'vscode',
        host: 'mbp',
        workspace: 'ws',
        workspaceRoot: '/work/ws',
        quests,
        clones: [],
        ...extra,
    };
}

export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > until) { throw new Error(`timed out waiting for ${what}`); }
        await sleep(20);
    }
}
