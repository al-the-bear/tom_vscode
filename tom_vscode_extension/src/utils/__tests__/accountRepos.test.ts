/**
 * "My Repos (<account>)" in the Issues panel: which repositories are the account's (src/utils/accountRepos.ts).
 *
 *   MR-1 owned by the login (any case) and not a fork: kept in order; another owner's clone and a fork the
 *        account owns are left out; a duplicate id counts once
 *   MR-2 a fork flag that cannot be read keeps the repository; no login gives none
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { ownAccountRepoIds } from '../accountRepos.js';

describe('the account\'s own repos', () => {
    test('MR-1: owned and not forked', async () => {
        const forks = new Set(['al-the-bear/tom_flutter_inappwebview']);
        const asked: string[] = [];
        const ids = await ownAccountRepoIds(
            ['al-the-bear/tom_vscode', 'dart-lang/sdk', 'Al-The-Bear/tom_d4rt', 'al-the-bear/tom_flutter_inappwebview', 'al-the-bear/tom_vscode', 'al-the-bear-other/x', 'invalid'],
            'al-the-bear',
            async (id) => { asked.push(id); return forks.has(id); },
        );
        assert.deepEqual(ids, ['al-the-bear/tom_vscode', 'Al-The-Bear/tom_d4rt']);
        assert.deepEqual(asked, ['al-the-bear/tom_vscode', 'Al-The-Bear/tom_d4rt', 'al-the-bear/tom_flutter_inappwebview'], 'only the account\'s repos are looked up');
    });

    test('MR-2: unknown fork flag, no login', async () => {
        assert.deepEqual(await ownAccountRepoIds(['me/a', 'me/b'], 'me', async (id) => { if (id === 'me/a') { throw new Error('403'); } return false; }), ['me/a', 'me/b']);
        assert.deepEqual(await ownAccountRepoIds(['me/a'], '  ', async () => false), []);
    });
});
