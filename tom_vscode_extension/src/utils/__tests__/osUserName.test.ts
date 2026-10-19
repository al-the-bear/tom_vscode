/**
 * The name of the logged-in OS user, as the author of review comments
 * (src/utils/osUserName.ts).
 *
 *   OU-1  macOS: the account's full name (`id -F`); Linux: the GECOS full name; else the login
 *   OU-2  the forms: first name, full name, login
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { osUserFullName, commentAuthorName } from '../osUserName.js';

describe('OS user name', () => {
    test('OU-1: the full name per platform', () => {
        assert.equal(osUserFullName({ platform: 'darwin', login: 'alexiskyaw', run: () => 'Alexis Kyaw\n' }), 'Alexis Kyaw');
        assert.equal(osUserFullName({ platform: 'darwin', login: 'alexiskyaw', run: () => { throw new Error('no id'); } }), '');
        const passwd = 'root:x:0:0:root:/root:/bin/bash\nalexis:x:1000:1000:Alexis Kyaw,,,:/home/alexis:/bin/bash\n';
        assert.equal(osUserFullName({ platform: 'linux', login: 'alexis', readPasswd: () => passwd }), 'Alexis Kyaw');
        assert.equal(osUserFullName({ platform: 'linux', login: 'nobody', readPasswd: () => passwd }), '');
        assert.equal(osUserFullName({ platform: 'win32', login: 'alexi' }), '');
    });

    test('OU-2: the author forms', () => {
        assert.equal(commentAuthorName('first', 'Alexis Kyaw', 'alexiskyaw'), 'Alexis');
        assert.equal(commentAuthorName('full', 'Alexis Kyaw', 'alexiskyaw'), 'Alexis Kyaw');
        assert.equal(commentAuthorName('login', 'Alexis Kyaw', 'alexiskyaw'), 'alexiskyaw');
        assert.equal(commentAuthorName('first', '', 'alexiskyaw'), 'alexiskyaw', 'no full name: the login');
        assert.equal(commentAuthorName('full', 'Kyaw (admin)', 'x'), 'Kyaw admin', 'no parentheses: they would end the author');
    });
});
