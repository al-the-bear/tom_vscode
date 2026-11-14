import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { TacError } from '../src/protocol/errors';
import { FORMAT_VERSION } from '../src/protocol/types';
import { Store } from '../src/store/store';
import { newService, removeDir, runtimeBody, scratchDir, sk } from './helpers';

const settings = { autoUpdate: false };

test('ST-1 the state survives a restart (journal replay), and again after a snapshot', () => {
    const dir = scratchDir('st1');
    try {
        const { svc, store } = newService(dir);
        svc.hello({ groupId: 'g1', settings });
        const r = svc.register('g1', runtimeBody(['q']));
        const { lease } = svc.acquire('g1', { sessionKey: sk('q'), resources: ['github/o/r'], requestId: 'req1' });
        // no close(): as after a crash, only the journal holds it
        assert.ok(fs.existsSync(path.join(dir, 'groups', 'g1', 'journal.jsonl')));
        const again = newService(dir);
        assert.equal(again.svc.listLeases('g1')[0].leaseId, lease.leaseId);
        assert.equal(again.svc.listRuntimes('g1').items[0].runtimeId, r.runtimeId);
        void store;
        again.store.close();
        assert.ok(fs.existsSync(path.join(dir, 'groups', 'g1', 'snapshot.json')));
        assert.equal(fs.statSync(path.join(dir, 'groups', 'g1', 'journal.jsonl')).size, 0, 'journal truncated after the snapshot');
        const third = newService(dir);
        assert.equal(third.svc.listLeases('g1')[0].resources[0].token, 1);
        assert.equal(third.store.get('g1')!.tokens.get('github/o/r'), 2);
        third.store.close();
    } finally {
        removeDir(dir);
    }
});

test('ST-2 a torn last journal line is dropped (never acknowledged), earlier changes kept', () => {
    const dir = scratchDir('st2');
    try {
        const { svc } = newService(dir);
        svc.hello({ groupId: 'g1', settings });
        svc.register('g1', runtimeBody(['q']));
        const journal = path.join(dir, 'groups', 'g1', 'journal.jsonl');
        fs.appendFileSync(journal, '{"seq":99,"changes":[{"c":"runtimes","id":"X"'); // a crash mid-write
        const again = newService(dir);
        assert.equal(again.svc.listRuntimes('g1').items.length, 1);
        assert.ok(fs.readFileSync(journal, 'utf8').endsWith('\n'), 'the torn tail is cut off');
        again.svc.register('g1', runtimeBody(['q']));
        const third = newService(dir);
        assert.equal(third.svc.listRuntimes('g1').items.length, 2, 'appending after the cut works');
    } finally {
        removeDir(dir);
    }
});

test('ST-3 a store with a newer formatVersion refuses the start', () => {
    const dir = scratchDir('st3');
    try {
        fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ formatVersion: FORMAT_VERSION + 1 }));
        assert.throws(() => Store.open(dir), (e: unknown) => e instanceof TacError && e.code === 'unavailable' && /formatVersion/.test(e.message));
    } finally {
        removeDir(dir);
    }
});

test('ST-4 a removed store folder answers unavailable and reports it as fatal; reads still work', () => {
    const dir = scratchDir('st4');
    try {
        const { svc, store } = newService(dir);
        let fatal = '';
        store.onFatal = (r) => { fatal = r; };
        svc.hello({ groupId: 'g1', settings });
        svc.register('g1', runtimeBody(['q']));
        removeDir(dir);
        assert.throws(() => svc.register('g1', runtimeBody(['q'])), (e: unknown) => e instanceof TacError && e.code === 'unavailable');
        assert.match(fatal, /removed/);
        assert.equal(svc.listRuntimes('g1').items.length, 1);
    } finally {
        removeDir(dir);
    }
});

test('ST-5 a write that fails changes nothing in memory and answers unavailable', () => {
    const dir = scratchDir('st5');
    try {
        const { svc } = newService(dir);
        svc.hello({ groupId: 'g1', settings });
        const gdir = path.join(dir, 'groups', 'g1');
        // Replace the journal by a folder: the open journal fd still works, so make a fresh store hit it.
        const again = newService(dir);
        fs.rmSync(path.join(gdir, 'journal.jsonl'));
        fs.mkdirSync(path.join(gdir, 'journal.jsonl'));
        assert.throws(() => again.svc.register('g1', runtimeBody(['q'])), (e: unknown) => e instanceof TacError && e.code === 'unavailable');
        assert.equal(again.svc.listRuntimes('g1').items.length, 0);
        void svc;
    } finally {
        removeDir(dir);
    }
});
