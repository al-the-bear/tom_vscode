/**
 * A minimal WebSocket server connection (RFC 6455) over a Node HTTP upgrade:
 * text frames, fragmentation, ping / pong, close. Enough for the TAC stream
 * (§ 9.3), with no dependency, so a runtime can start the service from its
 * own installation.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** The largest message the service accepts from a runtime. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export function acceptKey(key: string): string {
    return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Complete the handshake; answers false (and ends the socket) for a request
 * that is not a WebSocket upgrade. `protocol`, when the client offered
 * subprotocols, is the one selected and echoed.
 */
export function completeHandshake(req: IncomingMessage, socket: Duplex, protocol?: string): boolean {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return false;
    }
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
        '', '',
    ].join('\r\n'));
    return true;
}

/** Events: `message` (string), `close` (code, reason), `pong`. */
export class WsConnection extends EventEmitter {
    private buffer: Buffer = Buffer.alloc(0);
    private fragments: Buffer[] = [];
    private fragmentBytes = 0;
    private closed = false;
    lastSeen = Date.now();

    constructor(private readonly socket: Duplex, head?: Buffer) {
        super();
        socket.on('data', (d: Buffer) => this.onData(d));
        socket.on('close', () => this.finish(1006, 'connection lost'));
        socket.on('error', () => this.finish(1006, 'connection error'));
        if (head && head.length > 0) { this.onData(head); }
    }

    get isOpen(): boolean {
        return !this.closed;
    }

    send(text: string): void {
        if (this.closed) { return; }
        this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
    }

    ping(): void {
        if (this.closed) { return; }
        this.socket.write(frame(0x9, Buffer.alloc(0)));
    }

    close(code = 1000, reason = ''): void {
        if (this.closed) { return; }
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        try { this.socket.write(frame(0x8, body)); } catch { /* gone */ }
        this.socket.end();
        this.finish(code, reason);
    }

    /** Drop the connection without a close frame. */
    terminate(): void {
        this.socket.destroy();
        this.finish(1006, 'terminated');
    }

    private finish(code: number, reason: string): void {
        if (this.closed) { return; }
        this.closed = true;
        this.emit('close', code, reason);
    }

    private onData(d: Buffer): void {
        this.lastSeen = Date.now();
        this.buffer = this.buffer.length === 0 ? d : Buffer.concat([this.buffer, d]);
        while (!this.closed) {
            const f = parseFrame(this.buffer);
            if (f === 'incomplete') { return; }
            if (f === 'tooLarge') { this.close(1009, 'message too large'); return; }
            if (f === 'unmasked') { this.close(1002, 'client frames must be masked'); return; }
            this.buffer = this.buffer.subarray(f.length);
            this.onFrame(f.fin, f.opcode, f.payload);
        }
    }

    private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
        switch (opcode) {
            case 0x0: // continuation
            case 0x1: // text
            case 0x2: { // binary (treated as UTF-8 text)
                if (opcode !== 0x0) { this.fragments = []; this.fragmentBytes = 0; }
                this.fragments.push(payload);
                this.fragmentBytes += payload.length;
                if (this.fragmentBytes > MAX_MESSAGE_BYTES) { this.close(1009, 'message too large'); return; }
                if (fin) {
                    const text = Buffer.concat(this.fragments).toString('utf8');
                    this.fragments = [];
                    this.fragmentBytes = 0;
                    this.emit('message', text);
                }
                return;
            }
            case 0x8: { // close
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                this.close(code === 1005 ? 1000 : code, '');
                return;
            }
            case 0x9: // ping
                this.socket.write(frame(0xA, payload));
                return;
            case 0xA: // pong
                this.emit('pong');
                return;
            default:
                this.close(1002, `unknown opcode ${opcode}`);
        }
    }
}

function frame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

type Parsed = { fin: boolean; opcode: number; payload: Buffer; length: number };

function parseFrame(buf: Buffer): Parsed | 'incomplete' | 'tooLarge' | 'unmasked' {
    if (buf.length < 2) { return 'incomplete'; }
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
        if (buf.length < 4) { return 'incomplete'; }
        len = buf.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buf.length < 10) { return 'incomplete'; }
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) { return 'tooLarge'; }
        len = Number(big);
        offset = 10;
    }
    if (len > MAX_MESSAGE_BYTES) { return 'tooLarge'; }
    if (!masked) { return 'unmasked'; }
    if (buf.length < offset + 4 + len) { return 'incomplete'; }
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) { payload[i] = buf[offset + 4 + i] ^ mask[i & 3]; }
    return { fin, opcode, payload, length: offset + 4 + len };
}
