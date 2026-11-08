/**
 * Reading a zip archive: the workspace template (`resources/workspace_template.zip`,
 * written by scripts/build-workspace-template.cjs) that "Setup New Workspace
 * Folder" unpacks. Classic zips only (no zip64), stored or deflated entries —
 * what the template build writes, and what every common zip tool writes for an
 * archive this size.
 */

import * as zlib from 'zlib';

export interface ZipEntry {
    /** The entry's path inside the archive, `/`-separated. Folder entries end in `/`. */
    path: string;
    data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
/** The end record sits within its own size plus the longest comment (65535 bytes) of the end. */
const EOCD_SEARCH = EOCD_SIZE + 0xffff;

/** Every entry of the zip in `buf`, in archive order. Throws on anything that is not a readable classic zip. */
export function readZip(buf: Buffer): ZipEntry[] {
    let eocd = -1;
    for (let i = buf.length - EOCD_SIZE; i >= Math.max(0, buf.length - EOCD_SEARCH); i--) {
        if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd < 0) { throw new Error('not a zip: no end-of-central-directory record'); }
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out: ZipEntry[] = [];
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) { throw new Error(`bad central directory entry #${n}`); }
        const method = buf.readUInt16LE(p + 10);
        const compressed = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) { throw new Error(`${name}: bad local header`); }
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        const body = buf.subarray(start, start + compressed);
        let data: Buffer;
        if (method === 0) {
            data = Buffer.from(body);
        } else if (method === 8) {
            data = zlib.inflateRawSync(body);
        } else {
            throw new Error(`${name}: unsupported compression method ${method}`);
        }
        out.push({ path: name, data });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}
