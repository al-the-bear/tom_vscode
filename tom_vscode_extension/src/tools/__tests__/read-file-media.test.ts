/**
 * tomAi_readFile's rich answer (ccparity_c_transports-10): an image or a PDF
 * comes back as a content block the direct API shows the model, as Claude
 * Code's Read does (`readFileMediaImpl`, the tool's `executeRich`).
 *
 *   RM-1 png, jpg, gif, webp: an image block (base64, the media type the bytes say) after a text block naming
 *        the file, its type and size; the stand-in text names the same
 *   RM-2 a PDF: a document block (application/pdf, titled with the file name)
 *   RM-3 no rich answer (the text answer stands): a text file; a file named .png whose bytes are not an image;
 *        a missing file, a directory, a path outside the workspace (execute's error message says it)
 *   RM-4 a file over the API's limit: a text answer saying so, no media block
 *   RM-5 the tool: executeRich installed beside execute; the description says what the direct API gets
 */

/* eslint-disable @typescript-eslint/naming-convention -- media block wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { IMAGE_MAX_BYTES, PDF_MAX_BYTES, readFileMediaImpl, READ_FILE_DESCRIPTION } from '../file-primitives';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-file-media-'));
const write = (name: string, bytes: Buffer | string): string => { fs.writeFileSync(path.join(root, name), bytes); return name; };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16, 4)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(40, 0x20)]);

type Block = { type: string; text?: string; title?: string; source?: { type: string; media_type: string; data: string } };

describe('tomAi_readFile: images and PDFs as content blocks', () => {
    test('RM-1: images', async () => {
        for (const [name, bytes, mediaType] of [
            ['shot.png', PNG, 'image/png'], ['photo.jpg', JPEG, 'image/jpeg'], ['photo.jpeg', JPEG, 'image/jpeg'],
            ['anim.gif', GIF, 'image/gif'], ['pic.webp', WEBP, 'image/webp'],
        ] as const) {
            write(name, bytes);
            const rich = await readFileMediaImpl(root, { filePath: name });
            assert.ok(rich, name);
            const blocks = rich!.blocks as Block[];
            assert.equal(blocks.length, 2, name);
            assert.equal(blocks[0].type, 'text');
            assert.match(blocks[0].text!, new RegExp(`${name.replace('.', '\\.')}.*${mediaType}.*${bytes.length} bytes`));
            assert.equal(blocks[1].type, 'image');
            assert.deepEqual(blocks[1].source, { type: 'base64', media_type: mediaType, data: bytes.toString('base64') });
            assert.equal(rich!.text, blocks[0].text, 'the stand-in for trails and logs');
        }
        write('misnamed.png', JPEG);
        const misnamed = await readFileMediaImpl(root, { filePath: 'misnamed.png' });
        assert.equal((misnamed!.blocks[1] as Block).source!.media_type, 'image/jpeg', 'the bytes decide the type');
    });

    test('RM-2: a PDF', async () => {
        write('spec.pdf', PDF);
        const rich = await readFileMediaImpl(root, { filePath: path.join(root, 'spec.pdf') });
        const doc = rich!.blocks[1] as Block;
        assert.equal(doc.type, 'document');
        assert.equal(doc.title, 'spec.pdf');
        assert.deepEqual(doc.source, { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') });
        assert.match(rich!.text, /spec\.pdf.*application\/pdf/);
    });

    test('RM-3: no rich answer', async () => {
        write('notes.ts', 'export const x = 1;\n');
        write('fake.png', 'not an image at all');
        fs.mkdirSync(path.join(root, 'folder.png'), { recursive: true });
        for (const filePath of ['notes.ts', 'fake.png', 'missing.png', 'folder.png', path.join(os.tmpdir(), 'elsewhere.png')]) {
            assert.equal(await readFileMediaImpl(root, { filePath }), undefined, filePath);
        }
    });

    test('RM-4: over the limit', async () => {
        write('huge.png', Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES, 0)]));
        const rich = await readFileMediaImpl(root, { filePath: 'huge.png' });
        assert.equal(rich!.blocks.length, 1);
        assert.equal(rich!.blocks[0].type, 'text');
        assert.match(rich!.text, /huge\.png.*image\/png.*larger than the .* limit/);
        assert.ok(PDF_MAX_BYTES > IMAGE_MAX_BYTES);
    });

    test('RM-5: the tool', () => {
        const executors = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'tools', 'tool-executors.ts'), 'utf8');
        assert.match(executors, /executeRich: \(input\) => readFileMediaImpl\(getWorkspaceRoot\(\), input\),/);
        assert.match(READ_FILE_DESCRIPTION, /direct API.*image \(png, jpg, gif, webp\).*PDF/s);
        assert.ok(READ_FILE_DESCRIPTION.length <= 1250, 'the description limit (TD-3)');
    });
});
