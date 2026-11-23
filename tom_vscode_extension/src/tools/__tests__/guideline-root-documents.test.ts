/**
 * tomAi_readGlobalGuideline reads a root document in a folder of the Tom root (gsel23): a rule heading such as
 * `## [sysadm/machines.md] …` names one.
 *
 *   RD-1 `sysadm/machines.md` (and without `.md`, with `./`) returns the file; `§` sections work; a guideline of
 *        the same relative path wins over it
 *   RD-2 refused: a path leaving the root, a hidden segment, a folder, a file that is not there (the message names
 *        the root's own documents)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { readGlobalGuidelineImpl, rootDocumentAt } from '../guideline-tools.js';
import { guidelineLevels } from '../../utils/guidelineFolders.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'root-documents-')));
after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(root, '..', 'outside-root-documents.md'), { force: true });
});
const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
};
put('_agent_guidelines/index_root.md', '# Index\n');
put('_agent_guidelines/dart/rules.md', 'GUIDELINE dart rules\n');
put('sysadm/machines.md', '# Machines\n\nAt the start of a session run `hostname`.\n\n## 2. Firewalls\n\nNever change firewall rules without an explicit instruction.\n');
put('dart/rules.md', 'ROOT DOCUMENT dart rules\n');
put('_agent_guidelines/other/machines.md', 'GUIDELINE of the same name\n');
put('.hidden/x.md', 'hidden\n');
put('../outside-root-documents.md', 'outside\n');
const scope = { wsRoot: root, levels: guidelineLevels([path.join(root, '_agent_guidelines')]), root };

describe('root documents in a folder of the root (gsel23)', () => {
    test('RD-1: sysadm/machines.md', async () => {
        const text = await readGlobalGuidelineImpl(scope, { fileName: 'sysadm/machines.md' });
        assert.match(text, /^# Machines\n\nAt the start of a session run `hostname`\./);
        assert.equal(await readGlobalGuidelineImpl(scope, { fileName: 'sysadm/machines' }), text, '.md added');
        assert.equal(await readGlobalGuidelineImpl(scope, { fileName: './sysadm/machines.md' }), text);
        assert.match(await readGlobalGuidelineImpl(scope, { fileName: 'sysadm/machines.md § 2' }), /§ 2[\s\S]*Never change firewall rules/);
        assert.equal(await readGlobalGuidelineImpl(scope, { fileName: 'dart/rules.md' }), 'GUIDELINE dart rules\n', 'a guideline of the same path wins');
        assert.doesNotMatch(text, /GUIDELINE of the same name/, 'the exact root path wins over a guideline found only by name');
        assert.deepEqual(rootDocumentAt(root, 'sysadm/machines.md')?.level, 'rootDocument');
    });

    test('RD-2: refused', async () => {
        for (const bad of ['../outside-root-documents.md', '.hidden/x.md', 'sysadm', 'sysadm/', '/etc/hosts', 'machines.md']) {
            assert.equal(rootDocumentAt(root, bad), undefined, bad);
        }
        assert.equal(rootDocumentAt(undefined, 'sysadm/machines.md'), undefined, 'no root');
        assert.match(await readGlobalGuidelineImpl(scope, { fileName: 'sysadm/nope.md' }), /not found[\s\S]*the root's own documents \(sysadm\/nope\.md\)/);
    });
});
