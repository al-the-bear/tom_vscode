/**
 * User interactions per process run, not per window (vscimpb81), under the vscode stub.
 *
 *   UR-1 the run of a turn: its queue item's run (runAsQueueItem), else the process position it runs as, else
 *        `default`; the waits record it
 *   UR-2 tool approval: approvals of two runs are open at the same time, each in the registry of open interactions
 *        with its run and item; a Stop of run A's item (abortPendingApprovals with its match) denies only A's; B's
 *        is answered from the user-input panel (respond) and reaches its turn
 *   UR-3 plan mode is per run: run A entering it does not refuse run B's writes; the user leaving it in A leaves B
 *        alone
 *   UR-4 pickers: while run A's QuickPick is on screen, run B's picker is answered in the user-input panel (its
 *        item, typed text, dismissal); a second picker of the same run waits for the first
 *   UR-5 Telegram replies: one question open — the reply is its answer; several — `<run>: answer` names the run,
 *        otherwise the runs are listed
 *   UR-6 the registry of open interactions: runs (`default` first) with counts, the item's interactions, views
 *        without callbacks
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-per-run-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { AnthropicHandler } from '../anthropic-handler.js';
import { currentInteractionRun, queueItemWaits, runAsQueueItem } from '../../services/userWaits.js';
import { runInProcessPosition } from '../../services/processRunContext.js';
import { userInteractions, UserInteractions } from '../../services/userInteractions.js';
import { enterPlanModeImpl, isPlanModeActive, leavePlanModeByUser, planModeRefusalFor, resetPlanModeForTests } from '../../tools/planning-tools.js';
import { createLiveUserPrompter, type PickerItem } from '../../tools/user-interaction-tools.js';
import { routeReply } from '../../utils/askReplyRouting.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('user interactions per process run', () => {
    test('UR-1: the run of a turn', async () => {
        assert.equal(currentInteractionRun(), 'default');
        assert.equal(await runAsQueueItem('i1', async () => currentInteractionRun(), 'collab'), 'collab');
        const position = { quest: 'q', state: {} as never, run: 'design' };
        assert.equal(await runInProcessPosition(position as never, async () => currentInteractionRun()), 'design');
        let release: () => void = () => undefined;
        const waiting = runAsQueueItem('i2', () => new Promise<void>((r) => { release = r; }), 'r2');
        void waiting;
        assert.equal(currentInteractionRun(), 'default', 'outside: default');
        release();
        await waiting;
        assert.equal(queueItemWaits().size, 0);
    });

    test('UR-2: approvals of two runs', async () => {
        const handler = AnthropicHandler.instance as Json;
        const ask = (run: string, item: string, id: string): Promise<boolean> =>
            runAsQueueItem(item, () => handler.awaitApproval({ toolUseId: id, toolName: 'tomAi_editFile', inputSummary: `edit for ${run}` }), run);
        const a = ask('A', 'item-A', 'tu-a');
        const b = ask('B', 'item-B', 'tu-b');
        await tick();
        assert.deepEqual(userInteractions.list().filter((i) => i.kind === 'approval').map((i) => [i.id, i.run, i.queueItemId]),
            [['tu-a', 'A', 'item-A'], ['tu-b', 'B', 'item-B']], 'both open, each with its run');
        assert.deepEqual(queueItemWaits().get('item-A'), [{ kind: 'approval', run: 'A' }]);
        // Stop of run A's item: only A's approval is denied.
        assert.equal(handler.abortPendingApprovals((x: { queueItemId?: string }) => x.queueItemId === 'item-A'), 1);
        assert.equal(await a, false);
        assert.ok(userInteractions.get('tu-b'), 'B\'s approval stays open');
        // Answered from the user-input panel.
        userInteractions.get('tu-b')!.respond!({ type: 'approval', id: 'tu-b', approved: true, approveAll: false });
        assert.equal(await b, true);
        assert.equal(userInteractions.list().filter((i) => i.kind === 'approval').length, 0);
    });

    test('UR-3: plan mode per run', async () => {
        resetPlanModeForTests();
        await runAsQueueItem('pa', () => enterPlanModeImpl({ reason: 'plan A' }), 'A');
        assert.equal(isPlanModeActive('A'), true);
        assert.equal(isPlanModeActive('B'), false);
        assert.ok(await runAsQueueItem('pa', async () => planModeRefusalFor('tomAi_editFile', { readOnly: false }), 'A'), 'A\'s writes refused');
        assert.equal(await runAsQueueItem('pb', async () => planModeRefusalFor('tomAi_editFile', { readOnly: false }), 'B'), undefined, 'B writes');
        await runAsQueueItem('pb', () => enterPlanModeImpl({ reason: 'plan B' }), 'B');
        assert.equal(leavePlanModeByUser('A'), true);
        assert.deepEqual([isPlanModeActive('A'), isPlanModeActive('B')], [false, true], 'leaving A leaves B alone');
        resetPlanModeForTests();
    });

    test('UR-4: pickers of two runs', async () => {
        let acceptA: (() => void) | undefined;
        const fakeWindow: Json = {
            createQuickPick: () => {
                const qp: Json = {
                    items: [], selectedItems: [], value: '',
                    onDidAccept: (cb: () => void) => { acceptA = () => { qp.selectedItems = [qp.items[0]]; cb(); }; },
                    onDidHide: () => undefined, show: () => undefined, dispose: () => undefined,
                };
                return qp;
            },
            showInputBox: async () => 'typed',
        };
        const prompter = createLiveUserPrompter(fakeWindow);
        const items: PickerItem[] = [{ label: 'one', value: '1' }, { label: 'two', value: '2' }];
        const a = runAsQueueItem('pk-a', () => prompter.showQuickPick(items, { title: 'A?' }), 'A');
        await tick();
        const b = runAsQueueItem('pk-b', () => prompter.showQuickPick(items, { title: 'B?' }), 'B');
        await tick();
        const panelPick = userInteractions.list().find((i) => i.kind === 'picker');
        assert.ok(panelPick, 'B\'s picker is in the user-input panel');
        assert.equal(panelPick.run, 'B');
        assert.deepEqual((panelPick.data.items as Json[]).map((x) => x.label), ['one', 'two']);
        panelPick.respond!({ type: 'picker', id: panelPick.id, selected: [1], other: '' });
        assert.deepEqual(await b, { label: 'two', value: '2' }, 'answered in any order');
        acceptA!();
        assert.deepEqual(await a, { label: 'one', value: '1' });
        // A's next picker is a QuickPick again (none is on screen); B typed its own words in the panel.
        const b2 = runAsQueueItem('pk-b', () => prompter.showQuickPick(items, { title: 'B2?' }), 'B');
        await tick();
        const a2 = runAsQueueItem('pk-a', () => prompter.showQuickPick(items, { title: 'A2?' }), 'A');
        await tick();
        const pick2 = userInteractions.list().find((i) => i.kind === 'picker')!;
        assert.equal(pick2.run, 'A', 'B\'s QuickPick is on screen now: A answers in the panel');
        pick2.respond!({ type: 'picker', id: pick2.id, selected: [], other: 'my own' });
        assert.deepEqual(await a2, { label: 'my own', value: 'my own' });
        acceptA!();
        assert.deepEqual(await b2, { label: 'one', value: '1' });
        // Dismissed in the panel.
        const b3 = runAsQueueItem('pk-b', () => prompter.showQuickPick(items, { title: 'B3?' }), 'B');
        await tick();
        const a3 = runAsQueueItem('pk-a', () => prompter.showQuickPick(items, { title: 'A3?' }), 'A');
        await tick();
        const pick3 = userInteractions.list().find((i) => i.kind === 'picker')!;
        pick3.respond!({ type: 'picker', id: pick3.id, dismissed: true });
        assert.equal(await a3, undefined);
        acceptA!();
        await b3;
    });

    test('UR-5: Telegram replies', () => {
        const one = [{ requestId: 'q1', run: 'default' }];
        assert.deepEqual(routeReply('Postgres', one), { kind: 'answer', requestId: 'q1', run: 'default', text: 'Postgres' });
        assert.deepEqual(routeReply('note: keep it', one), { kind: 'answer', requestId: 'q1', run: 'default', text: 'note: keep it' }, 'a colon in an answer of one question is text');
        const two = [{ requestId: 'q1', run: 'default' }, { requestId: 'q2', run: 'collab' }];
        assert.deepEqual(routeReply('Collab: yes please', two), { kind: 'answer', requestId: 'q2', run: 'collab', text: 'yes please' });
        assert.deepEqual(routeReply('yes', two), { kind: 'ambiguous', runs: ['default', 'collab'] });
        assert.deepEqual(routeReply('x', []), { kind: 'none' });
    });

    test('UR-6: the registry of open interactions', () => {
        const reg = new UserInteractions();
        const seen: string[] = [];
        reg.onChange((added) => seen.push(added ? `+${added.id}` : '-'));
        const remove = reg.add({ id: 'b1', kind: 'question', run: 'beta', createdAt: 2, title: 't', data: {}, respond: () => undefined });
        reg.add({ id: 'd1', kind: 'approval', run: 'default', queueItemId: 'it', createdAt: 1, title: 't', data: {} });
        reg.add({ id: 'b2', kind: 'plan', run: 'beta', createdAt: 3, title: 't', data: {} });
        assert.deepEqual(reg.runs(), [{ run: 'default', count: 1 }, { run: 'beta', count: 2 }]);
        assert.deepEqual(reg.forQueueItem('it').map((i) => i.id), ['d1']);
        assert.equal('respond' in reg.views()[1], false, 'no callback in a view');
        assert.deepEqual(reg.list().map((i) => i.id), ['d1', 'b1', 'b2'], 'oldest first');
        remove();
        remove();
        assert.deepEqual(seen, ['+b1', '+d1', '+b2', '-'], 'removed once');
    });
});
