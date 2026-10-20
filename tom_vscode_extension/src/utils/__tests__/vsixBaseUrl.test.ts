/**
 * The base URLs the VSIX's README links are rewritten against (vscimpa2).
 * vsce derives `https://github.com/<owner>/<repo>/blob/HEAD` from
 * package.json's `repository.url` but ignores `repository.directory`, so a
 * README in a sub-folder of its repository would link to the repository root.
 * scripts/vsix-base-url.cjs derives the URLs itself, folder included, and
 * every installer passes them.
 *
 *   VB-1 the URLs from a repository with a directory: blob (content) and raw (images), on main
 *   VB-2 this package's own repository: the tom_vscode repo, folder tom_vscode_extension
 *   VB-3 every installer takes them from the script; none hard-codes a base URL or packages
 *        without the repository
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const base = require(path.join(ROOT, 'scripts', 'vsix-base-url.cjs')) as {
    vsixBaseUrls(manifest: unknown, branch?: string): { content: string; images: string };
};

describe('VSIX base URLs', () => {
    test('VB-1: from a repository with a directory', () => {
        const urls = base.vsixBaseUrls({ repository: { type: 'git', url: 'git@github.com:owner/repo.git', directory: 'pkg/ext' } });
        assert.deepEqual(urls, {
            content: 'https://github.com/owner/repo/blob/main/pkg/ext',
            images: 'https://github.com/owner/repo/raw/main/pkg/ext',
        });
        assert.equal(base.vsixBaseUrls({ repository: 'https://github.com/owner/repo' }, 'dev').content, 'https://github.com/owner/repo/blob/dev', 'no directory: the root');
        assert.throws(() => base.vsixBaseUrls({}), /repository/);
    });

    test('VB-2: this package', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        assert.equal(base.vsixBaseUrls(manifest).content, 'https://github.com/al-the-bear/tom_vscode/blob/main/tom_vscode_extension');
    });

    test('VB-3: every installer uses it', () => {
        for (const script of ['install_extension.sh', 'install_extension.ps1', 'reinstall_for_testing.sh']) {
            const text = fs.readFileSync(path.join(ROOT, script), 'utf8');
            assert.match(text, /vsix-base-url\.cjs/, `${script}: the URLs come from the script`);
            assert.doesNotMatch(text, /--baseContentUrl\s+https?:/, `${script}: no hard-coded URL`);
            assert.doesNotMatch(text, /--allow-missing-repository/, `${script}: the repository is in package.json`);
        }
    });
});
