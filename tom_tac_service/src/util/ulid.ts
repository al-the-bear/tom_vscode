/** ULIDs (26 characters, Crockford base32, sortable by time), monotonic within one process. */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(t: number): string {
    let out = '';
    for (let i = 0; i < 10; i++) {
        out = ALPHABET[t % 32] + out;
        t = Math.floor(t / 32);
    }
    return out;
}

function freshRandom(): number[] {
    const bytes = randomBytes(16);
    return Array.from({ length: 16 }, (_, i) => bytes[i] % 32);
}

export function ulid(now: number = Date.now()): string {
    if (now <= lastTime) {
        // Same (or earlier) millisecond: increment the random part, so ids stay sortable.
        now = lastTime;
        for (let i = lastRandom.length - 1; i >= 0; i--) {
            if (lastRandom[i] < 31) { lastRandom[i]++; break; }
            lastRandom[i] = 0;
        }
    } else {
        lastTime = now;
        lastRandom = freshRandom();
    }
    return encodeTime(now) + lastRandom.map((d) => ALPHABET[d]).join('');
}

export function isUlid(s: unknown): s is string {
    return typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}
