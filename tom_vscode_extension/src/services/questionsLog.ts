/**
 * Appender for the **Questions** journal — `_ai/quests/<quest>/questions.md`,
 * the file behind the @WS panel's Logs → Questions tab.
 *
 * Every resolved ask-the-user call lands here: the questions, the verbatim
 * answer, which channel produced it and how long the prompt sat blocked. The
 * exchange used to survive only inside a tool call and its result, buried in
 * the per-call trail; the journal makes it a document.
 *
 * The file name is resolved through `questLogFiles.ts` — the same table the
 * viewer reads through — so the writer and the reader cannot disagree about it.
 * A mismatch would not fail anywhere; the tab would just stay empty forever.
 *
 * Writing is best-effort. An ask blocks a running prompt, and a journal that
 * could fail the prompt it was recording would be worse than no journal.
 */

import * as fs from 'fs';
import * as path from 'path';

import { WsPaths } from '../utils/workspacePaths';
import { FsUtils } from '../utils/fsUtils';
import { questLogLocation } from '../utils/questLogFiles';
import {
    formatQuestionLogEntry,
    questionsLogHeader,
    type QuestionLogEntry,
} from '../utils/questionsLogFormat';

/** Absolute path of a quest's Questions journal, or `undefined` with no workspace. */
export function questionsLogPath(questId?: string): string | undefined {
    const quest = questId || WsPaths.getWorkspaceQuestId();
    const { fileName } = questLogLocation('questions', quest);
    return WsPaths.ai('quests', quest, fileName);
}

/**
 * Append one resolved ask to the quest's Questions journal, creating the file
 * (with its header) the first time.
 */
export function appendQuestionLogEntry(entry: QuestionLogEntry, questId?: string): void {
    try {
        const quest = questId || WsPaths.getWorkspaceQuestId();
        const file = questionsLogPath(quest);
        if (!file) { return; }
        FsUtils.ensureDir(path.dirname(file));
        const preamble = fs.existsSync(file) ? '' : questionsLogHeader(quest);
        fs.appendFileSync(file, preamble + formatQuestionLogEntry(entry) + '\n', 'utf-8');
    } catch {
        // Best-effort diagnostics — never fail the prompt over its own log file.
    }
}
