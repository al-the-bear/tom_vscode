#!/usr/bin/env node
/**
 * vsix-base-url.cjs — the base URLs `vsce package` rewrites the README's
 * relative links against, from package.json's `repository`.
 *
 * vsce guesses `https://github.com/<owner>/<repo>/blob/HEAD` from
 * `repository.url` but ignores `repository.directory`, so for an extension in
 * a sub-folder of its repository every README link would point at the
 * repository root. This derives both URLs with the folder, on `main`, and is
 * the one place every installer takes them from.
 *
 * Usage: node scripts/vsix-base-url.cjs content|images
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** `{content, images}`: the blob and raw URLs of the package's folder on `branch`. */
function vsixBaseUrls(manifest, branch = 'main') {
    const repo = manifest && manifest.repository;
    const url = typeof repo === 'string' ? repo : repo && repo.url;
    if (typeof url !== 'string') { throw new Error('package.json has no repository: add {"type": "git", "url": …, "directory": …}'); }
    const m = /github(?:\.com\/|\.com:|:)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (!m) { throw new Error(`repository ${url} is not a GitHub repository`); }
    const dir = typeof repo === 'object' && typeof repo.directory === 'string' && repo.directory
        ? `/${repo.directory.replace(/^\/+|\/+$/g, '')}` : '';
    return {
        content: `https://github.com/${m[1]}/blob/${branch}${dir}`,
        images: `https://github.com/${m[1]}/raw/${branch}${dir}`,
    };
}

if (require.main === module) {
    const which = process.argv[2] === 'images' ? 'images' : 'content';
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    process.stdout.write(vsixBaseUrls(manifest)[which]);
}

module.exports = { vsixBaseUrls };
