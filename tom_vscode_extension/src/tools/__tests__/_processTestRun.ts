/**
 * Process tests work in a run of their own: the `default` run runs no process
 * (vscimpb122), so a test that starts one selects (or creates) a run first.
 */
import assert from 'node:assert/strict';
import * as path from 'path';

import type { ProcessStateStore } from '../../managers/processStateStore.js';
import { EMPTY_PROCESS_STATE } from '../../utils/processDefinition.js';
import { ProcessRepository } from '../../utils/processRepository.js';

/** The run the process tests work in unless they name another. */
export const TEST_RUN = 't';

/** Make `run` the window's run (created with no process when the quest has none of that name). */
export function useRun(store: ProcessStateStore, run: string = TEST_RUN): void {
    if (store.currentRun === run) { return; }
    const r = store.runs().some((x) => x.run === run) ? store.selectRun(run) : store.createRun(run, undefined, 'user');
    assert.equal(r.ok, true, JSON.stringify(r));
}

/**
 * A `default` run that still holds a process from before the migration
 * (vscimpb122): written into its state file as such a quest has it, then read
 * by the store. For tests that compare the window's `default` with a run.
 */
export function seedLegacyDefault(store: ProcessStateStore, workspace: string, quest: string, position: { process: string; phase?: string; step?: string }): void {
    const repo = new ProcessRepository(path.join(workspace, '_ai', 'processes'), path.join(workspace, '_ai', 'quests'));
    const def = repo.definitions().get(position.process);
    const phase = position.phase ?? def?.phases[0]?.id ?? '';
    const step = position.step ?? def?.phases.find((p) => p.id === phase)?.steps[0]?.id ?? '';
    repo.writeStateStack(quest, [{ ...EMPTY_PROCESS_STATE, process: position.process, phase, step }], 'default');
    store.reload();
}
