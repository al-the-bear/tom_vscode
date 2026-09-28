/**
 * Current-Prompt Dump — the three texts of the prompt that is running right
 * now, one file each, replaced on every send.
 *
 * This backs the @WS panel's **Logs → Current Prompt** tab. The per-call trail
 * files under `_ai/trail/anthropic/<quest>/` accumulate and have to be hunted
 * through by timestamp; the live trail interleaves prompts with answers. What
 * was missing was the flat question "what exactly is in flight right now, and
 * how does it differ from what I typed" — answered by three always-current
 * files:
 *
 *   _ai/trail/anthropic/<quest>/current_prompt.<chat|queue>.<literal|user|system>.md
 *
 * `literal` is the user's own text; `user` is the message that actually went to
 * the model after placeholder expansion; `system` is the assembled system
 * prompt. Seeing the first two side by side is the point — that gap is where
 * placeholder and template bugs hide.
 *
 * Chat and queue get separate sets because both can be in flight at once: a
 * queue item runs while the user sends a chat message, and one overwriting the
 * other would make the tab lie about whichever it clobbered.
 *
 * Each send writes twice — {@link beginCurrentPrompt} when it starts, then
 * {@link writeCurrentPrompt} when its texts are resolved. The gap between those
 * two moments is not small (see `beginCurrentPrompt`), and leaving the previous
 * send's files in place across it is what makes the tab look frozen.
 *
 * The files live in the trail area, which is gitignored. They must not go in
 * the quest folder — that is tracked in the fleet-shared `_ai` repo, and a file
 * rewritten on every prompt would produce a merge conflict per send across four
 * machines.
 *
 * File names come from `questLogFiles.ts`, the same module the viewer resolves
 * through, so the writer and the reader cannot disagree about them.
 */

import * as path from 'path';

import { WsPaths } from '../utils/workspacePaths';
import { FsUtils } from '../utils/fsUtils';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
import { resolveTrailPath } from './trailPathResolver';
import {
    currentPromptFiles,
    pendingCurrentPromptFiles,
    type CurrentPromptFile,
    type CurrentPromptTexts,
    type QuestLogPromptSource,
} from '../utils/questLogFiles';

/**
 * Directory holding the current-prompt files for a quest — the Anthropic trail
 * bucket, shared with the raw per-call trail and `last_request.json`.
 *
 * Exported because the Logs viewer resolves the same directory when it reads
 * them back; two independent derivations of one path is exactly the drift this
 * module exists to avoid.
 */
export function currentPromptDir(questId?: string): string {
    const trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
    const raw = (trail.raw ?? trail) as Record<string, unknown>;
    const paths = (raw.paths ?? {}) as Record<string, string>;
    const base = paths.anthropic ?? '${ai}/trail/anthropic/${quest}';
    const quest = questId || WsPaths.getWorkspaceQuestId();
    return resolveTrailPath(base, { subsystem: 'anthropic', quest });
}

/** The prompt about to be dispatched, as the viewer will show it. */
export interface CurrentPromptCapture extends CurrentPromptTexts {
    /** Which of the two prompts that can run in parallel this is. */
    source: QuestLogPromptSource;
    /** Quest to file it under; defaults to the workspace's active quest. */
    questId?: string;
}

/**
 * What a send knows about itself the moment it starts: its origin, its quest,
 * and the text the user typed.
 */
export interface CurrentPromptClaim {
    source: QuestLogPromptSource;
    literal: string;
    questId?: string;
}

/**
 * Phase one — claim this origin's files as soon as the send begins.
 *
 * A send does not know its user message or system prompt when it starts: both
 * wait on the previous turn's history compaction and memory extraction, which
 * are API calls and routinely take a minute. Writing only once, when all three
 * texts exist, means the tab describes the *previous* send for that entire
 * window — the send is already marked running, and the panel still shows what
 * ran before it. Cancelling a turn makes the window longest of all, because the
 * cancelled turn leaves exactly that background work pending.
 *
 * So the literal lands immediately and the other two are marked unresolved;
 * {@link writeCurrentPrompt} replaces all three the moment they exist.
 */
export function beginCurrentPrompt(claim: CurrentPromptClaim): void {
    writeFiles(pendingCurrentPromptFiles(claim.source, claim.literal), claim.questId);
}

/**
 * Phase two — replace this origin's three files with the prompt about to be
 * sent.
 *
 * All three are written every time, including an empty system prompt: leaving
 * the previous send's text in place would present it as current, which is worse
 * than showing nothing.
 */
export function writeCurrentPrompt(capture: CurrentPromptCapture): void {
    writeFiles(currentPromptFiles(capture.source, capture), capture.questId);
}

function writeFiles(files: CurrentPromptFile[], questId?: string): void {
    try {
        const dir = currentPromptDir(questId);
        for (const file of files) {
            FsUtils.safeWriteText(path.join(dir, file.fileName), file.text);
        }
    } catch {
        // Best-effort diagnostics — never break the send path over a log file.
    }
}
