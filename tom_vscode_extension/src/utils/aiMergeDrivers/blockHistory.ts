/**
 * `ai-block-history`: the block merge of `compacted_history.md` (the port of
 * ai_merge_block_history.py, vscimpb142c). Blocks
 * `<!-- tom:block created="…" modified="…" -->` … `<!-- /tom:block -->` are
 * grouped by `created`; a collision keeps the larger `modified`; sorted by
 * `created`. An unterminated block fails (git's conflict markers).
 *
 * vscode-free and pure.
 */

import { pyCompare, stripNewlines, type MergeOutcome, type MergeSides } from './common';

const BLOCK_OPEN = /<!--\s*tom:block\s+created="([^"]+)"\s+modified="([^"]+)"\s*-->/gu;
const BLOCK_CLOSE = /<!--\s*\/tom:block\s*-->/gu;

interface Block { created: string; modified: string; body: string }

function parseBlocks(text: string): Block[] {
    const out: Block[] = [];
    let pos = 0;
    while (pos < text.length) {
        BLOCK_OPEN.lastIndex = pos;
        const open = BLOCK_OPEN.exec(text);
        if (!open) { return out; }
        BLOCK_CLOSE.lastIndex = open.index + open[0].length;
        const close = BLOCK_CLOSE.exec(text);
        if (!close) { throw new Error(`ai-block-history: unterminated block starting at offset ${open.index}; ours/theirs may be malformed.`); }
        out.push({ created: open[1], modified: open[2], body: stripNewlines(text.slice(open.index + open[0].length, close.index)) });
        pos = close.index + close[0].length;
    }
    return out;
}

function serialise(blocks: Block[]): string {
    return blocks.map((b) => `<!-- tom:block created="${b.created}" modified="${b.modified}" -->\n${b.body}\n<!-- /tom:block -->`).join('\n\n') + '\n';
}

export function mergeBlockHistory(sides: MergeSides): MergeOutcome {
    let ours: Block[];
    let theirs: Block[];
    try {
        ours = parseBlocks(sides.ours ?? '');
        theirs = parseBlocks(sides.theirs ?? '');
    } catch (e) {
        return { status: 'fail', message: (e as Error).message };
    }
    const byCreated = new Map<string, Block>();
    for (const b of [...ours, ...theirs]) {
        const existing = byCreated.get(b.created);
        if (!existing) { byCreated.set(b.created, b); } else if (pyCompare(b.modified, existing.modified) > 0) { byCreated.set(b.created, b); }
    }
    const order = [...byCreated.keys()].sort(pyCompare);
    return { status: 'merged', text: serialise(order.map((c) => byCreated.get(c)!)) };
}
