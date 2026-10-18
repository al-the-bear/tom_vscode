/**
 * The Markdown Browser's in-place edit of the file it shows: replace lines
 * `startLine..endLine` (exclusive) with `replacement`, but only when those
 * lines still hold `expected` — the text the browser rendered. A file changed
 * since (an editor, another session) is refused rather than overwritten.
 *
 * Line ranges are the browser's: it renders the file with every line in place
 * (markdownHeadings' transform without the CR/LF conversion), so its line
 * numbers are file line numbers. A CRLF file keeps its line endings; the
 * comparison ignores them. vscode-free.
 */

export interface MdLineEdit {
    startLine: number;
    endLine: number;
    expected: string;
    replacement: string;
}

export type MdLineEditResult = { ok: true; text: string } | { ok: false; reason: string };

export function applyMdLineEdit(fileText: string, edit: MdLineEdit): MdLineEditResult {
    const eol = fileText.includes('\r\n') ? '\r\n' : '\n';
    const lines = fileText.split(/\r?\n/);
    const { startLine, endLine } = edit;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 0 || endLine < startLine || endLine > lines.length) {
        return { ok: false, reason: `Lines ${startLine + 1}–${endLine} are not in the file (${lines.length} lines). Reload the document.` };
    }
    const current = lines.slice(startLine, endLine).join('\n');
    if (current !== edit.expected.replace(/\r\n/g, '\n')) {
        return { ok: false, reason: 'The file changed since it was shown here. Reload the document and try again.' };
    }
    const replacement = edit.replacement.replace(/\r\n|\r/g, '\n').split('\n');
    const next = [...lines.slice(0, startLine), ...replacement, ...lines.slice(endLine)];
    return { ok: true, text: next.join(eol) };
}
