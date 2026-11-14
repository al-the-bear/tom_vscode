#!/usr/bin/env node
/**
 * The service's command line:
 *
 *   tom-tac-service serve [--config <file>] [--host <h>] [--port <n>] [--store <dir>]
 *                         [--idle-minutes <n>] [--keep-running]
 *   tom-tac-service admin status|stop [--host <h>] [--port <n>] [--store <dir>]
 *
 * Exit codes: 0 done; 1 error; 2 usage; 3 another service already holds the port.
 */
import { TacClient } from './client';
import { describeStartError, readKeyFile, resolveConfig, SERVICE_VERSION, startLocalService } from './local';
import type { LocalConfig } from './local';
import { PROTOCOL_VERSION } from './protocol/types';

const USAGE = `Usage:
  tom-tac-service serve [--config <file>] [--host <h>] [--port <n>] [--store <dir>]
                        [--idle-minutes <n>] [--keep-running]
  tom-tac-service admin status|stop [--host <h>] [--port <n>] [--store <dir>]
  tom-tac-service --version | --help

serve   runs the TAC coordination service (local mode) until it is idle for
        --idle-minutes (default 15) with no stream open, or until stopped.
        Settings come from <store>/config.yaml (or --config), then the flags.
admin   talks to the running service: its status, or stop it.`;

interface Parsed {
    command?: string;
    sub?: string;
    flags: Map<string, string | true>;
}

function parse(argv: string[]): Parsed {
    const flags = new Map<string, string | true>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const [name, inline] = a.slice(2).split('=', 2);
            if (inline !== undefined) {
                flags.set(name, inline);
            } else if (name === 'keep-running' || name === 'help' || name === 'version') {
                flags.set(name, true);
            } else {
                const v = argv[i + 1];
                if (v === undefined || v.startsWith('--')) { throw new Error(`--${name} needs a value`); }
                flags.set(name, v);
                i++;
            }
        } else {
            positional.push(a);
        }
    }
    return { command: positional[0], sub: positional[1], flags };
}

function num(flags: Parsed['flags'], name: string): number | undefined {
    const v = flags.get(name);
    if (v === undefined) { return undefined; }
    const n = Number(v);
    if (!Number.isFinite(n)) { throw new Error(`--${name} needs a number`); }
    return n;
}

function str(flags: Parsed['flags'], name: string): string | undefined {
    const v = flags.get(name);
    return typeof v === 'string' ? v : undefined;
}

function overrides(p: Parsed): Partial<LocalConfig> {
    return {
        host: str(p.flags, 'host'),
        port: num(p.flags, 'port'),
        storeDir: str(p.flags, 'store'),
        idleMinutes: num(p.flags, 'idle-minutes'),
        keepRunning: p.flags.has('keep-running') ? true : undefined,
    };
}

const log = (line: string) => process.stderr.write(`[tom-tac-service ${new Date().toISOString()}] ${line}\n`);

async function serve(p: Parsed): Promise<number> {
    const config = resolveConfig(overrides(p), str(p.flags, 'config'));
    const r = await startLocalService(config, { log });
    if (r.status === 'alreadyRunning') {
        log(`port ${r.port} is held by another process; a running service is used instead`);
        return 3;
    }
    const stop = (signal: string) => { void r.handle.stop(signal); };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    const reason = await r.handle.stopped;
    log(`stopped (${reason})`);
    return reason.startsWith('fatal') ? 1 : 0;
}

async function admin(p: Parsed): Promise<number> {
    const config = resolveConfig(overrides(p), str(p.flags, 'config'));
    const key = readKeyFile(config.storeDir);
    if (!key) {
        process.stderr.write(`no key file in ${config.storeDir}: the service has never run there\n`);
        return 1;
    }
    const client = new TacClient({ baseUrl: `http://${config.host}:${config.port}`, key });
    if (p.sub === 'status') {
        process.stdout.write(JSON.stringify(await client.adminStatus(), null, 2) + '\n');
        return 0;
    }
    if (p.sub === 'stop') {
        await client.adminStop(false);
        process.stdout.write('stopping\n');
        return 0;
    }
    process.stderr.write(`${USAGE}\n`);
    return 2;
}

async function main(argv: string[]): Promise<number> {
    let p: Parsed;
    try {
        p = parse(argv);
    } catch (e) {
        process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
        return 2;
    }
    if (p.flags.has('version')) {
        process.stdout.write(`tom-tac-service ${SERVICE_VERSION} (${PROTOCOL_VERSION})\n`);
        return 0;
    }
    if (p.flags.has('help') || !p.command) {
        process.stdout.write(`${USAGE}\n`);
        return p.command ? 0 : 2;
    }
    try {
        if (p.command === 'serve') { return await serve(p); }
        if (p.command === 'admin') { return await admin(p); }
    } catch (e) {
        process.stderr.write(`${describeStartError(e)}\n`);
        return 1;
    }
    process.stderr.write(`unknown command ${p.command}\n${USAGE}\n`);
    return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
