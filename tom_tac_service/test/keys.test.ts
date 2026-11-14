import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TacError } from '../src/protocol/errors';
import { keysConflict, parseResourceKey, parseSessionKeyText, sessionKeyText } from '../src/protocol/keys';
import { isUlid, ulid } from '../src/util/ulid';

test('KY-1 session key text form round-trips, separators inside parts encoded', () => {
    const k = { quest: 'vscode_extension', session: 'idea', run: 'collab', host: 'mbp', workspace: 'tom_agent_container' };
    assert.equal(sessionKeyText(k), 'vscode_extension#idea@collab/mbp/tom_agent_container');
    assert.deepEqual(parseSessionKeyText(sessionKeyText(k)), k);
    const odd = { quest: 'q#1', session: 'a@b', run: 'r/x', host: 'h', workspace: 'w s' };
    assert.deepEqual(parseSessionKeyText(sessionKeyText(odd)), odd);
    assert.throws(() => parseSessionKeyText('nope'), TacError);
});

test('KY-2 resource keys parse; malformed ones are invalid', () => {
    assert.deepEqual(parseResourceKey('github/al-the-bear/tom_vscode'), { kind: 'repo', repository: 'github/al-the-bear/tom_vscode' });
    assert.deepEqual(parseResourceKey('github/al-the-bear/tom_vscode:a/b'), { kind: 'repo', repository: 'github/al-the-bear/tom_vscode', unit: 'a/b' });
    assert.deepEqual(parseResourceKey('infra:vsix-release'), { kind: 'infra', name: 'vsix-release' });
    assert.deepEqual(parseResourceKey('ai:quests/vscode_extension'), { kind: 'ai', path: 'quests/vscode_extension' });
    for (const bad of ['', 'tom_vscode', 'github/x', 'github/a/b:/x', 'github/a/b:x/', 'infra:', 'ai:/x']) {
        assert.throws(() => parseResourceKey(bad), (e: unknown) => e instanceof TacError && e.code === 'invalid', bad);
    }
});

test('KY-3 conflicts: whole repository, units by path prefix at / boundaries, shared paths, infra and ai', () => {
    const repo = 'github/al-the-bear/tom_vscode';
    assert.ok(keysConflict(repo, repo));
    assert.ok(keysConflict(repo, `${repo}:ext/src`));
    assert.ok(keysConflict(`${repo}:ext`, `${repo}:ext/src`));
    assert.ok(keysConflict(`${repo}:ext/src`, `${repo}:ext`));
    assert.ok(!keysConflict(`${repo}:ext`, `${repo}:extension`), 'prefix only at a / boundary');
    assert.ok(!keysConflict(`${repo}:ext/a`, `${repo}:ext/b`));
    assert.ok(!keysConflict(repo, 'github/al-the-bear/tom_forge'));
    const units = [{ repository: repo, path: 'ext', shared: ['ext/CHANGELOG.md'] }];
    assert.ok(!keysConflict(`${repo}:ext/CHANGELOG.md`, `${repo}:ext`, units), 'a shared path conflicts with nothing');
    assert.ok(!keysConflict(repo, `${repo}:ext/CHANGELOG.md`, units));
    assert.ok(keysConflict('infra:vsix', 'infra:vsix'));
    assert.ok(!keysConflict('infra:vsix', 'infra:pub'));
    assert.ok(keysConflict('ai:quests/a', 'ai:quests/a'));
    assert.ok(!keysConflict('ai:quests/a', 'ai:quests/a/b'), 'ai keys conflict only with themselves');
    assert.ok(!keysConflict('infra:x', repo));
});

test('KY-4 ULIDs are well-formed and sortable', () => {
    const a = ulid(1000);
    const b = ulid(1000);
    const c = ulid(2000);
    assert.ok(isUlid(a) && isUlid(b) && isUlid(c));
    assert.ok(a < b && b < c);
});
