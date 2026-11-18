/**
 * A writer process for tomAiConfigurationConcurrent.test.ts: another window
 * saving the shared configuration through the real TomAiConfiguration.
 *
 * argv[2] is a JSON job: `{ws, home, start, period, count, offset, section}`.
 * From `start + offset` it saves every `period` ms, `count` times: section
 * `<section><i>` = i when `section` ends with `*`, else section `section` =
 * `{writer, i}`. It prints `done <failures>`.
 */

import * as path from 'path';

interface Job { ws: string; home: string; start: number; period: number; count: number; offset: number; section: string; writer: string }
const job = JSON.parse(process.argv[2]) as Job;
process.env.HOME = job.home;
process.env.USERPROFILE = job.home;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installVscodeStub } = require(path.join(__dirname, '..', '..', 'tools', '__tests__', '_vscode-stub.js')) as typeof import('../../tools/__tests__/_vscode-stub.js');
installVscodeStub({ workspaceFolders: [job.ws] });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TomAiConfiguration } = require('../tomAiConfiguration.js') as typeof import('../tomAiConfiguration.js');

function sleepUntil(t: number): void {
    const ms = t - Date.now();
    if (ms > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
}

async function main(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TomAiConfiguration.init({} as any);
    const tc = TomAiConfiguration.instance;
    // Never a save into a real configuration: the target must lie in the job's workspace.
    if (!tc.configPath.startsWith(job.ws + path.sep)) {
        process.stderr.write(`refused: the target ${tc.configPath} is not in ${job.ws}\n`);
        process.exit(2);
    }
    let failures = 0;
    for (let i = 0; i < job.count; i++) {
        sleepUntil(job.start + job.offset + i * job.period);
        try {
            if (job.section.endsWith('*')) {
                await tc.updateSection(`${job.section.slice(0, -1)}${i}`, i);
            } else {
                await tc.updateSection(job.section, { writer: job.writer, i });
            }
        } catch (err) {
            failures += 1;
            process.stderr.write(`${(err as Error).message}\n`);
        }
    }
    process.stdout.write(`done ${failures}\n`);
}

void main();
