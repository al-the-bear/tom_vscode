/**
 * Test helpers on a quest's Q&A journal (src/utils/qaJournal.ts): this host's file text, and the process
 * decisions of every host's file as `## <time> — <title>` entries with their details — the shape the process
 * code formats a decision in — so a test can match a decision as it was written.
 */

import * as fs from 'fs';
import * as path from 'path';

import { qaJournalFileName, readQaBlocks } from '../../utils/qaJournal.js';
import { hostSlugOf } from '../../utils/hostSlug.js';

/** This host's journal file of the quest. */
export function qaJournalFile(questFolder: string, quest: string): string {
    return path.join(questFolder, qaJournalFileName(quest, hostSlugOf()));
}

/** This host's journal text ('' without a file). */
export function qaJournalText(questFolder: string, quest: string): string {
    const f = qaJournalFile(questFolder, quest);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

/** The process decisions of the quest's journals as `## <time> — <title>\n\n<details>\n` entries ('' without any). */
export function decisionEntriesText(questFolder: string, quest: string): string {
    return readQaBlocks(questFolder, quest)
        .filter((b) => b.kind === 'decision')
        .map((b) => `## ${b.time} — ${b.title ?? ''}\n\n${b.details ?? ''}\n`)
        .join('\n');
}
