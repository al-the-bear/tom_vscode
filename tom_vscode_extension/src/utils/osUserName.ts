/**
 * The logged-in OS user's name — the author written into review comments
 * (`> ⬆️ **C-12** (Alexis): …`).
 *
 * The full name comes from the account: `id -F` on macOS, the GECOS field of
 * `/etc/passwd` on Linux. Windows has no cheap equivalent, so there (and
 * whenever the full name is empty) the login name is used.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export interface OsUserProbe {
    platform: string;
    login: string;
    /** Runs `id -F` (macOS). */
    run?: () => string;
    /** Reads `/etc/passwd` (Linux). */
    readPasswd?: () => string;
}

/** The account's full name; `''` when the platform does not give one. */
export function osUserFullName(probe: OsUserProbe): string {
    try {
        if (probe.platform === 'darwin' && probe.run) {
            return probe.run().trim();
        }
        if (probe.platform === 'linux' && probe.readPasswd) {
            const line = probe.readPasswd().split('\n').find((l) => l.split(':')[0] === probe.login);
            return line ? (line.split(':')[4] || '').split(',')[0].trim() : '';
        }
    } catch {
        // No full name to be had: the caller falls back to the login.
    }
    return '';
}

export type CommentAuthorForm = 'first' | 'full' | 'login';

/** The author as written in a comment; parentheses are dropped, as they would end it. */
export function commentAuthorName(form: CommentAuthorForm, fullName: string, login: string): string {
    const full = fullName.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    const name = form === 'login' || !full ? login : form === 'first' ? full.split(' ')[0] : full;
    return name.replace(/[()]/g, '').trim();
}

let cached: string | undefined;

/** The comment author for this machine's logged-in user (computed once). */
export function currentCommentAuthor(form: CommentAuthorForm): string {
    if (cached === undefined) {
        const login = os.userInfo().username;
        const fullName = osUserFullName({
            platform: process.platform,
            login,
            run: () => execFileSync('id', ['-F'], { encoding: 'utf-8', timeout: 2000 }),
            readPasswd: () => fs.readFileSync('/etc/passwd', 'utf-8'),
        });
        cached = commentAuthorName(form, fullName, login);
    }
    return cached;
}
