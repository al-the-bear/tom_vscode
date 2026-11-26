/**
 * What the Q&A page (handlers/qaPanel-handler.ts) and its entry points show,
 * read from disk: the entries of both tabs for a filter (utils/qaView.ts), the
 * per-machine read marker and the "new" counters.
 *
 * - Questions: every host's Q&A journal of each quest (services/qaJournal.ts
 *   readQaItems) and this machine's answer
 *   store (utils/userAnswers.ts).
 * - Decisions: the quest's `todos*.todo.yaml` files, the archived ones
 *   included (managers/questTodoManager.ts).
 * - The read marker: `<global storage>/qa-read/<key of the _ai folder>.json`
 *   (services/userAnswersStore.ts qaReadMarkerFile), beside the answer store:
 *   per machine, outside git.
 */

import * as fs from 'fs';
import * as path from 'path';

import { WsPaths } from '../utils/workspacePaths';
import { hostSlugOf } from '../utils/hostSlug';
import { writeFileAtomic } from '../utils/atomicWrite';
import { listQuestIds, listTodoFiles, readTodoFile } from '../managers/questTodoManager';
import { readAnswers, type UserAnswer } from '../utils/userAnswers';
import {
    decisionEntriesOf, markShown, newCount, normaliseQaMarker, questionEntries, questsOfFilter, sortDecisionEntries,
    type QaDecisionEntry, type QaFilter, type QaQuestionEntry, type QaReadMarker, type QaTab,
} from '../utils/qaView';
import type { QaItem } from '../utils/qaJournal';
import { readQaItems } from './qaJournal';
import { answersDir, qaReadMarkerFile } from './userAnswersStore';
import { windowWorkspaceQuests } from './aiWorkspaceLive';

/** The quests a filter shows in this window. */
export function filterQuests(filter: QaFilter): string[] {
    const all = listQuestIds();
    let workspace: string[] = [];
    if (filter.scope === 'workspace') {
        try { workspace = windowWorkspaceQuests()?.quests ?? all; } catch { workspace = all; }
    }
    return questsOfFilter(filter, WsPaths.getWorkspaceQuestId(), workspace, all);
}

/** The journal items of the quests. */
export function readJournalItems(quests: readonly string[]): QaItem[] {
    const out: QaItem[] = [];
    for (const quest of quests) {
        const folder = WsPaths.ai('quests', quest);
        if (folder) { out.push(...readQaItems(folder, quest)); }
    }
    return out;
}

/** This machine's stored answers. */
export function readStoredAnswers(): UserAnswer[] {
    const dir = answersDir();
    return dir ? readAnswers(dir) : [];
}

/** The Questions tab's entries of the quests. */
export function readQuestionEntries(quests: readonly string[]): QaQuestionEntry[] {
    return questionEntries(readJournalItems(quests), readStoredAnswers(), quests, hostSlugOf());
}

/** The Decisions tab's entries of the quests: their `todos*.todo.yaml` files, the archived ones included. */
export function readDecisionEntries(quests: readonly string[]): QaDecisionEntry[] {
    const out: QaDecisionEntry[] = [];
    for (const quest of quests) {
        const folder = WsPaths.ai('quests', quest);
        if (!folder) { continue; }
        for (const file of listTodoFiles(quest, { showNormalFiles: true, showArchiveFiles: true })) {
            if (!file.startsWith('todos')) { continue; }
            try {
                out.push(...decisionEntriesOf(quest, readTodoFile(path.join(folder, file)).map((t) => ({ ...t, _sourceFile: file }))));
            } catch { /* an unreadable file shows nothing */ }
        }
    }
    return sortDecisionEntries(out);
}

/** This machine's read marker. */
export function readQaMarker(): QaReadMarker {
    const file = qaReadMarkerFile();
    if (!file) { return {}; }
    try { return normaliseQaMarker(JSON.parse(fs.readFileSync(file, 'utf-8'))); } catch { return {}; }
}

/** Mark the entries of `tab` shown: the marker moves up to the newest of each quest. */
export function markTabShown(tab: QaTab, entries: ReadonlyArray<QaQuestionEntry | QaDecisionEntry>): void {
    const file = qaReadMarkerFile();
    if (!file || !entries.length) { return; }
    const before = readQaMarker();
    const after = markShown(before, entries, tab);
    if (JSON.stringify(before) === JSON.stringify(after)) { return; }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomic(file, `${JSON.stringify(after, null, 2)}\n`);
    } catch { /* the marker is a convenience */ }
}

/** The "new" counters of both tabs for the quests (the entry points show them for the window's quest). */
export function qaNewCounts(quests: readonly string[], marker: QaReadMarker = readQaMarker()): { questions: number; decisions: number } {
    return {
        questions: newCount(readQuestionEntries(quests), 'questions', marker),
        decisions: newCount(readDecisionEntries(quests), 'decisions', marker),
    };
}
