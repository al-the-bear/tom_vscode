/**
 * The host slug: the `<host>` of the per-machine files
 * (`extension_config.<host>.<quest>.yaml`, `session-todo.<host>.<quest>.todo.yaml`).
 * The machine's short host name, lower case, anything but letters, digits,
 * `_` and `-` replaced by `_`.
 *
 * vscode-free (the migration script uses it without a window).
 */

import * as os from 'os';

export function hostSlugOf(hostname: string = os.hostname()): string {
    const short = hostname.split('.')[0].trim().toLowerCase();
    const safe = short.replace(/[^a-z0-9_-]/g, '_');
    return safe || 'unknown-host';
}
