# @Tom Extension User Guide

## 1) What the extension provides

The extension combines VS Code automation, bridge-based scripting, Copilot workflows, Tom AI chat tools, local LLM integration, a prompt queue with timed requests, and dedicated output channels for observability.

## 2) Panels and layout

Current bottom panel layout:

- `@CHAT` (`tomAi.chatPanel`): five subpanels — **Anthropic**, **Tom AI Chat**, **AI Conversation**, **Copilot**, **Local LLM**. Shared features: prompt queue side panel, document picker, live-trail button (Anthropic), session-history button, memory/config buttons, accordion/pin/rotate layout.
- `@WS` (`tomAi.wsPanel`): Guidelines, Documentation, Logs, Settings, Issues, Tests, Quest TODO. The Logs section carries its own strip of thirteen sub-tabs over the active quest's log files and the running prompt — see [Logs Panel](#logs-panel).

AI Conversation is the only subpanel that is **not** queue-compatible — each AI Conversation turn runs as an ad-hoc chat.

### Guidelines Panel

The Guidelines panel in @WS provides a document browser for copilot guidelines. Features:

- **Project dropdown**: Filter guidelines by project (shows projects with `_copilot_guidelines/` folders)
- **Quest dropdown**: Filter guidelines by quest (shows quests when quest project type selected)
- **Link navigation**: Click links to navigate within the panel or open in Markdown Browser

### Logs Panel

The Logs section of @WS shows the active quest's log-style markdown files from
`_ai/quests/{quest}/`, plus the prompt that is running right now. It is
read-only; use the toolbar to edit.

- **Sub-tabs**: **MD Trail** (`live-trail.md`, rendered), **Trail** (the same
  file as highlighted source), **Prompts** / **Answers**
  (`history/{quest}.anthropic.prompts.md` / `.answers.md`), **Progress**, **Overview**,
  **Notes** (`quest-notes.{quest}.md`), **Refresh**
  (`quest_refresh.{quest}.md`), **DocUpdate**
  (`quest_documentation_update.{quest}.md`), **Deferred**
  (`deferred.{quest}.md`), **Questions** (`questions.{quest}.md` — every
  question the model asked you and the answer you gave), **Decisions**
  (`decisions.{quest}.md` — the decisions carried by each todo, copied here when
  the todo is archived as completed), **Current Prompt** (see below)
- **Remembered selection**: the active sub-tab is restored after a window reload
- **Auto-refresh**: re-reads every 2.5 s while the section is expanded; a file
  that has not changed costs no read
- **256 KB window**: a larger file is shown from the end its newest content is
  at — the last 256 KB (marked `(tail)`) of the two trail tabs and of the three
  journals (**Deferred**, **Questions**, **Decisions**), which are appended to,
  and the first 256 KB (marked `(head)`) of the remaining tabs, whose documents
  are prepended to or rewritten wholesale
- **Follow scrolling**: the view opens at that same end, and a reader still
  sitting there stays there as the file grows; scrolling away to study something
  holds that position

#### Current Prompt sub-tab

Shows the prompt currently in flight, replaced on every send. A dropdown in the
toolbar — visible only on this sub-tab — picks which of six views to show:

| Option | Shows |
| --- | --- |
| Chat / Queue **Literal Prompt** | What you typed, before placeholders were expanded and before keyword triggers were stripped |
| Chat / Queue **User Prompt** | The user message that actually went to the model |
| Chat / Queue **System Prompt** | The assembled system prompt — empty when the profile has none |

Comparing the literal against the user prompt is the fastest way to see what a
template or a placeholder did to your text.

A queue item and a chat message can run at the same time, so the two keep
separate sets: the **Chat** options never show a queue item's prompt and vice
versa. The dropdown selection is remembered across a window reload alongside the
sub-tab.

The files behind it live in the quest's Anthropic trail folder
(`_ai/trail/anthropic/{quest}/current_prompt.*.md`), which is gitignored — they
change on every prompt, so they are deliberately kept out of the tracked quest
folder. They are written for every Anthropic transport (direct SDK, Agent SDK,
vscodeLm) and persist after the answer arrives, so the tab still shows the last
prompt sent when nothing is running.
- **Toolbar**: **Refresh** re-reads the selected file from disk; **Open in
  editor** opens it in a normal text editor
- **Missing files**: not every quest has every document; a missing one is
  reported in the viewer rather than treated as an error

### Markdown Browser

The Markdown Browser is a standalone webview panel for reading markdown documents with full navigation:

- **Open via**: `@T: Open in Markdown Browser` command, `@T: Open in Markdown Browser (Live)` for follow-tail mode, or link clicks in Guidelines panel
- **Document picker**: Grouped by Guidelines, Workspace Docs, Notes, Roles, Quests, Copilot Instructions, and Projects
- **Quest dropdown**: Secondary dropdown to filter quest documents when in quest context
- **Link resolver**: Clickable `.md` links navigate within the browser; special link types include `quest:`, `issue:`, `todo:`, and `test:` protocols; non-`.md` files open in the VS Code editor; external URLs open in the system browser
- **Links in plain text**: a path to a Markdown file written as plain text — `iterations/notes.md`, `../other.md`, `clarifications.sbp.md` — is a link like any Markdown link, resolved relative to the document and then to the workspace root (code blocks are left alone).
- **Open here or in a new browser**: hovering a link to a `.md` document shows a small popup with **Open here** and **Open in new MD Browser**; a plain click still opens it here.
- **Section references** (DocSpecs documents): a reference to section ids written `OUTER > INNER` (upper case ids joined by `>`, also inside backticks) is a link to that heading — the outer ids pick among headings that share the inner id. References that name no heading stay plain text.
- **Back and forth within the document**: following a section reference or an in-document anchor remembers where you were. The second pair of arrows, in the bar under the toolbar, goes back to it and forward again; the trail starts fresh for another document.
- **Search**: the search box in the same bar finds text in the document as you type (case-insensitive), shows which match is current and how many there are (*147/356*; *0/0* when nothing matches), and highlights the matches. It starts where you are reading — at the first match from the top of the view, and while you type on it stays on the current match — and counts every match in the document. Enter / Shift+Enter or the up / down arrows step through them, and after the last match comes the first from the top; a match inside a folded section unfolds it; Esc or the × in the box clears it; Cmd/Ctrl+F jumps to the box.
- **Line number support**: Links with `#L10` or `#L10-L20` fragments open source files at the specified line
- **Auto-reload**: File watcher (debounced ~200 ms) monitors the currently viewed file and re-renders on external changes; scroll position is preserved across same-file re-renders in normal mode
- **Reload** (the refresh button): renders the file again in any case — also when its text has not changed, and with a text area open (which is closed; the reading position stays)
- **While a change is saved** — Save, Save and next, a one-click answer, accepting / rejecting / removing a mark or a comment, accept / reject all — the browser shows a *Saving…* indicator with a wait cursor and takes no clicks or typing until the change is done (or refused)
- **While a text area is open** the search box and the review navigation (↑ / ↓ and the kinds) are disabled, so nothing scrolls or re-renders under the text you are writing; they come back when it is saved or discarded
- **Live mode (follow-tail)**: Opened via the "Open Live Trail" button in the Anthropic subpanel or the Live command. Auto-scrolls to the bottom on each re-render as events stream in; pauses when the user scrolls up and resumes when they return to the bottom
- **Anchor navigation**: Heading anchors allow direct scrolling to specific sections
- **Position in the document**: the file bar shows `Line X / N` — the source line at the top of the view and the document's line count. While you drag far into a part not shown yet it reads `≈ Line X / N` until that part is drawn.
- **Navigation history**: Back/forward buttons with up to 100 entries; going back or forward to a document opens it where you left it (the block that was at the top of the view, at the same height)
- **Breadcrumb navigation**: Shows current document path
- **Folding sections**: every heading starts with a small triangle that folds or unfolds its section — its text and the subsections below it, up to the next heading of the same or a higher level. Each heading keeps its own state: folding a section and unfolding it again leaves its subsections folded or open as they were. In the action bar, the **fold all** button folds every section (and then offers to unfold all), and the level dropdown (H1, H2, … — the levels the document has, up to 10) with the button beside it folds or unfolds every heading of that one level. The folded state is kept while the document refreshes and starts fresh for another document; following a link to a heading inside a folded section unfolds it.
- **Indenting by heading level**: the indent button in the action bar shifts every heading right by its level (a level-*n* heading by *n* − 1 steps) and the content of its section one step further, so the outline reads at a glance. The dropdown beside it sets a step to 1, 2 (default), 3, 4, 6 or 8 spaces. It stays on while the document refreshes.
- **Answering review questions**: every `**Answer:**` marker (outside code blocks) carries a small comment button. It opens a 5-line text area, resizable by its corner handle; the button gives way to **Save**, **Discard** and **Save and next** while it is open — Save and next saves (if anything changed) and opens the next unanswered question. It opens with the answer already written there, so an answer can be corrected or cleared; an unanswered question opens with its **recommended option** filled in (`(b)`). Hovering the button lists the question's options — `(a)`, `(b)` …, the recommended one in bold — and a click on one writes it as the answer at once; *Write an answer…* opens the text area. The recommended option is the one written bold (`**(b)**`, the TomSpecs rule), else the one whose text says "recommended", else the letter of a `*Recommendation:*` line. In a TomSpecs document the options and the recommended option are those the TomSpecs runtime reads — the same as the agents' tools see — once the browser has read the document (a moment after it opens); until then, and in any other Markdown file, the browser reads them itself by the same rules. Save writes it right after the marker — `**Answer:** your text` — and the browser stays where it was and shows the updated document. The answer is what the answer import reads: the rest of the marker's line and, in a blockquote, the following `>` lines up to a bare `>` line, a blank line or a line without `>` (outside a quote, the rest of the paragraph). A longer answer is written on further lines of the same quote; blank lines inside it are dropped, since they would end it.
- **Edit mode** (pencil button in the action bar): every paragraph, list, quote, table and code block shows two buttons at its end; switching edit mode on or off is immediate, also on large documents. **Edit** opens the block's markdown source in a text area, starting with the empty line that separates it from the block before — delete that newline to merge the block into the previous one. **Insert** opens an empty one whose text is appended directly to the end of the block — start it with an empty line for a new paragraph. The text is saved exactly as typed, newlines included. Both close with Save / Discard and keep the reading position; a save updates only the part of the page it changed. Large documents (several MB) render in short steps, so the window stays responsive while they open — the file bar shows the progress — and only the part around the view is laid out; the pages above and below it are prepared ahead, so scrolling does not show blank pages.
- **Review comments**: in edit mode every paragraph, list, quote, table and code block also has a **comment** button. It opens a text area after the block, filled in with the upward arrow, the document's next comment id (the highest `C-<n>` in the document + 1 — in a TomSpecs document the id the TomSpecs runtime gives the next comment, when that is higher, so the browser and the agents' tools never hand out the same id twice) and you as the author — `⬆️ **C-13** (Alexis): ` — and you write your comment after it. The author is the logged-in OS user: the first name of the account's full name (macOS account name, Linux GECOS field), else the login. On Save it goes into the document as a comment block of its own after the block, every line under `> `: `> ⬆️ **C-13** your comment`. Id and author are optional in the notation (`> ⬆️ **C-12** (Alexis): …`, `> ⬆️ (Alexis): …`, `> ⬆️ …`); a missing id is added on save, and so is the author when the comment names none (a comment by someone else keeps its author). A comment block carries its own comment button, always visible: it reopens the comment without the `>` prefixes, and Save writes it back. Saving it empty asks once more (*Save again to remove it*) and then removes the block. Comment blocks are drawn with a yellow bar on a tinted background. In a TomSpecs (SOM) Markdown document a comment on a form belongs in the form's preamble, above its first field: from a form's first field to the next heading the blocks offer no comment button.
- **Inline review marks** (CriticMarkup, as in the TomSpecs notation) are drawn as marks with an icon each, so the kind of change is visible at a glance: `{++ added ++}` green with a ➕ diff icon, `{-- removed --}` struck through in red, `{~~ old ~> new ~~}` the old text struck through next to the new one in a dashed blue frame, `{== text ==}{>> comment <<}` highlighted (the comment as its tooltip and as a yellow note after it), and a `{>> comment <<}` alone as a yellow note. Marks inside code are left as text.
- **Reviewing changes**: in edit mode every change mark has an accept (✓) and a reject (✗) button, and every inline comment a remove button; one click decides that one mark, and the file is written by the TomSpecs runtime's rules — an accepted change keeps its new text, a rejected one its old text, a removed comment leaves the text it was on, and no double spaces are left behind. A comment block's trash button removes it with one click. The action bar's **Accept all changes** (✓✓) and **Reject all changes** buttons decide every change mark of the document at once (comments stay for their own decision); the notification that follows offers **Undo** while the file is unchanged.
- **Stepping through a review**: the action bar's ↑ / ↓ buttons step through the kinds ticked in the popup the button between them opens (the count beside them says which target is current and how many the ticked kinds have, *2/14*; *–/14* before the first step, updated as you decide, answer or save) — **Changes**, **Comments** (comment blocks), **Inline comments**, **Questions**, **Unanswered** questions, one or several at once, in document order (**Unanswered** is ticked when a document opens — the usual review; the button names them: *Unanswered*, *Changes + 2*, *All*, *Nothing*) — from the reading position, wrapping at the ends; the current one is outlined. After a save, an accepted or rejected change or a removed comment, the next step goes on from there: the question after the one just answered, the change after the one just decided (changing the ticked kinds goes on from the current target too). Stepping shows the context at the top of the view — a question's text above its answer, the paragraph a comment block is on — keeping the target itself, or the answer's open text area, in view. While **Unanswered** is ticked, stepping to an unanswered question opens its answer with the recommended option filled in.
- **Editing is guarded**: a save is refused, and the text area stays open with the reason, when the file changed since it was shown, or when it has unsaved changes in an editor. With **CR/LF** on everything can be edited as usual, except a paragraph that holds a converted line break (an escaped `\n` or a bare CR in the file): its lines are not the file's lines, so it shows no editing buttons until CR/LF is off. An automatic refresh that arrives while a text area is open is held back until it closes.

### Processes

A **process** is a named way of working through a quest, so you do not have to explain it to the agent again in every prompt. It has **phases**; each phase has **steps**, and a step can group **sub-steps** (the step is then just their group). A step or sub-step can name the **role** doing it. Every phase ends with a **quality gate** step and can have a **post-gate** step whose todos are done after the gate passed and before the next phase starts. Phases, steps and sub-steps can be **repeatable** — run in several iterations, optionally up to a maximum.

Processes live in `_ai/processes/<id>/`: `<id>.process.yaml` is the structure and `<id>.md` the description.

- **Process editor** — the hierarchy icon button at the bottom of every @CHAT subpanel (or `@T: Open Process Editor`). The list on the left shows every process; **+** creates one from a one-phase skeleton, the copy button duplicates the selected one under a new id. The form edits the name, summary, Markdown description and every phase, step, sub-step, gate and post-gate step: id, name, role, repeatable / maximum, description, **prompt** (what is to be done when it runs — Proceed puts it into the prompt it queues), **session** (the session its prompts run in, shown like the queue's session link — `name based on X, per prompt, profile`, or *inherited*; a click opens the session picker: an existing session, or a new one described by its base, lifetime, profile and name — the editor only writes the definition, Proceed creates the session; the ✕ clears it, so it is inherited from the step, then the phase, then the process; `${phase-iteration}`, `${step-iteration}` and `${substep-iteration}` in a name are filled in). The process itself has a **Session of every prompt** field: e.g. a per-prompt session with a profile makes every Proceed prompt start fresh. A profile this window does not have is refused on save, and the post-gate todos with an optional quest-todo id prefix, and on a gate **If the gate fails** — run it again, or back to one of the phase's steps (`onFail`). Problems are listed as you type; **Save** (Ctrl/Cmd+S) refuses an invalid definition. The descriptions are edited only here.
- **PROCESS view** (@TOM sidebar, first, above QUEST NOTES) — where the active quest is: process, phase, step and sub-step as dropdowns, each iteration with **−** / **+**, the role the step names, and the post-gate todos when in that step. **?** shows a description; the pencil opens the editor. Normally the agent keeps this current; you can set any of it by hand. **+** starts the next iteration (a new phase iteration starts again at its first step, a new step iteration at its first sub-step); **−** only corrects the number. A gate always has **+**: a failed gate is run again.
- **Action bar** (top of the PROCESS view) — the moves the process allows from the current position, as icon buttons (the tooltip says where each leads). The position shown is **what runs next**: nothing runs until you press **Proceed**.
  - **Proceed** (▶) — runs the current phase, step or sub-step: its prompt goes into the prompt queue, then the state moves on to the next position, which runs only when you press Proceed again. After a **decision point** — every gate, the end of every phase, every repeatable sub-step and the end of every repeatable step (e.g. step 03 of the tom_specs process, after its verdict review) — it moves to the **decision** after it instead;
  - **Decide…** (a fork icon, framed) — Proceed at a decision. The view shows a *Decision — how does the process go on?* box listing the options; the button opens a dialog with them: **Go on to …** (the next position), **Repeat …** for every repeatable level that ends there (sub-step, step, phase — below its maximum; the iteration counts up and the first step / sub-step inside it is next), and after a gate **Gate passed — go on to …** / **Gate failed — run the gate again** or **— back to …** (the step the gate names in `onFail`, set in the process editor). A step entered again within the same round of its phase continues at its next iteration — the `onFail` step after a failed gate, and the steps after it as they come round again — so session names and todo prefixes that carry the iteration do not repeat an earlier round's; Back returns to the iteration a step was at. At the end of the process the forward option is **Finish the process** — the state file then records `completed: true` and the view says *The process is finished*; **Reopen** takes it back. Nothing is queued: the choice only moves the state. The decisions are not written in the definition: the extension puts one after every decision point;
  - **Skip** — to the next position without running this one; **Back** — to the previous position, a correction (iterations are kept).
  - **Confirm done** (a person icon, framed) — Proceed at a **user action**: a step or sub-step the process marks as yours (`userAction: true`), such as reviewing a document or answering its questions. The view shows it in a highlighted *Your turn — user action* box with what is to be done (its description), and the steps and sub-steps that are user actions carry 👤 in the dropdowns. A user action runs no prompt: the button opens no action page but a confirmation saying that this is a user action, what is to be done, and that you hereby confirm you have done it; **I confirm I have done it** moves the process on (after a decision point, to its decision).

  Every button except Proceed only moves the state, at once. Proceed opens the **action page**: what runs, where the state goes afterwards (or that it stays for your decision), the **session** the prompt is queued in (the one the process names for this position, else the queue default; **Change…** opens the session picker for this prompt only), the `prompt` fields of what runs here (at a phase's first step the phase's too, at a step's first sub-step the step's too), a field for **custom instructions** and a live preview of the prompt. A session the process names that does not exist yet is created from the definition (its base too) when you confirm. **Add to queue** (Ctrl/Cmd+Enter) adds the prompt to the prompt queue, which sends it, and then moves the state; **Cancel** changes nothing. The queued prompt — and every prompt it queues in turn, such as the todo walks of a planning step — runs as the position it belongs to: its role and the *Current process* section of its system prompt are those of that position, however far the process has moved since.
- **Process template editor** (the snippet button at the right of the action bar, the *Edit template* button on the action page, or `@T: Open Process Template Editor`) — the Proceed prompt template, the same for every process, stored in the extension config under `processActionTemplates.proceed`. The list on the right inserts a placeholder at the cursor: the action variables (`${custom-instructions}`, `${action-prompt}` — the `prompt` fields of what runs here, `${action-note}` — a note for a repeated run, `${action-position}`, `${action-after}` — what the view does after queuing, `${action-label}`, `${action-target}`), the process variables of the position being run, and the chat variables. The preview resolves the edited text at the current position. **Default** puts the built-in template back; an empty template queues nothing.
- **State per quest** — the position is stored in `_ai/quests/<quest>/process-state.<quest>.yaml`, so it is the same in every window and on every machine, and switching the quest switches it. Moving to a step that names a role also sets the `role` chat variable; choosing *— none —* as the process clears the process variables and sets `role` back to `default`. The Chat Variables view lists the process variables read-only under *Process*; a long description is shortened, and hovering it opens a scrollable popup with the whole text.
- **In the system prompt** — every Anthropic profile includes a *Current process* section while a process is set: the positions, the steps of the phase, the post-gate todos and the descriptions. The values are also chat variables (`process`, `phase`, `step`, `substep`, `phase-iteration`, `step-iteration`, `substep-iteration`, `process-description`, `phase-description`, `step-description`, `substep-description`, `phase-prompt`, `step-prompt`, `substep-prompt`, `session`) and placeholders (`${process-context}` for the whole block). The agent moves the state with `tomAi_setProcessState`.

### Window Status Panel

The Window Status panel is an Explorer sidebar view showing the state of all open @Tom windows:

- **Multi-window overview**: One card per open window displaying workspace name and active quest
- **Subsystem status**: Per-subsystem indicators (Copilot, Local LLM, AI Conversation, etc.) with color coding:
  - **Orange**: Prompt sent, awaiting answer
  - **Green**: Answer received
- **Relative timestamps**: Shows how long ago each state change occurred
- **Servers**: behind the indicators, the servers the window runs with their ports, e.g. `CLI :19901 · MCP :19921`
- **Heartbeat**: every window rewrites its heartbeat (time, process id, servers) every 30 seconds; a window whose heartbeat is older than 90 seconds is shown dimmed and marked *gone*. A window of an older build writes no heartbeat and is not judged.
- **Auto-refresh**: File watcher on `_ai/local/*.window-state.json` with periodic refresh every 3 seconds
- **Cleanup**: Delete button to remove stale window entries

The @TOM sidebar holds the quest's views (Process, Quest Notes, Quest Todos, Sessions, Session Todos); @TOM WS the workspace's (VS Code Notes, Workspace Notes, Workspace Todos, TODO Log, Window Status).

### Quest TODO Panel

The Quest TODO panel (the `@WS` Quest TODO section, and the editor that opens for any `*.todo.yaml` file) manages quest todos with status tracking.

#### Prefix groups

The list is grouped by **todo-id prefix** — the characters before the id's first digit, so `qr1-…` and `qr3-…` share the group `qr`. Ids that start with a digit, or contain no digit at all, collect in a group called **Unprefixed**, which always sits last. Each group is headed by a thin separator line showing the prefix, the number of todos in brackets, and a triangle that expands or collapses the group.

The list opens **fully collapsed** — after a window reload or a VS Code restart you see only the separator lines. Expand the groups you need; the **Collapse all** toolbar button closes them again. Expanding a group sticks for the rest of the session, including across todo refreshes.

#### Moving todos between files

Four top-bar buttons move todos between files instead of destroying them:

- **Archive completed todo** — moves the selected *completed* todo to the file's `-archived` sibling (e.g. `todos.myquest.todo.yaml` → `todos-archived.myquest.todo.yaml`), stamping it with the archive date. Enabled only for completed todos.
- **Archive all completed** — bulk-archives every completed todo in the current file.
- **Delete todo (to file)** — moves the selected *non-completed* todo to the `-deleted` sibling, stamping the deletion date. Completed todos can only be archived, not deleted.
- **Delete all cancelled** — bulk-moves every cancelled todo to the `-deleted` sibling.

Archived/deleted sibling files are **terminal**: they can be viewed but never archived or deleted *from*, and the buttons hide when browsing them. A todo moved to the `-deleted` file remains recoverable (unlike the per-row hard-delete). There is no separate backup file mechanism anymore.

Archiving a **completed** todo also **copies** any decisions it carried into the quest's `decisions.<quest>.md` journal (@WS → Logs → Decisions), stamped with the todo id and the archive timestamp. It is a copy, not a move — the archived todo keeps its decisions. Two cases are deliberately left out: deleting never journals (a deleted todo's decisions were never acted on), and neither does archiving a todo that has not reached `completed` — the Archive button works on any status, and a todo archived half-done was abandoned rather than concluded.

A further set of top-bar buttons changes a todo **without** moving it to a terminal file:

- **Mark selected todo completed** / **Mark selected todo cancelled** / **Mark selected todo not-started** — set the selected todo's status in place (the completed action also stamps the completion date). With a non-empty todo stack they act on the whole stack after a single confirmation.
- **Move to quest / workspace / another quest** (the ⬆️ button on a todo's row) — asks where to move it: **Quest todos** (the todo's own quest file, offered when it is not already there), **Workspace todos** (`workspace.todo.yaml`), or **Move to quest…**, which opens a second picker listing every quest and moves the todo into that quest's `todos.<quest>.todo.yaml`. With more than one todo stacked it moves the whole stack; the picker then reads *Move N stacked todos to…* instead of *Move this todo to…*. Works in quest, session and workspace mode. A todo that leaves its quest gets `[moved from quest: <id>]` added to its notes; a todo whose id the target already holds is left where it is and reported.
  - **A whole group** — a group separator (the line naming a prefix, e.g. `annot`) has its own ⬆️ button: it moves every open todo of that group with the same pickers, as if they were stacked. Completed and cancelled todos stay; a group with none open has no button.
  - **Ids in the other quest** — when the todos enter a quest they are not in, a third picker asks how they are named there, once for all of them: number them into one of that quest's groups (listed largest first, each with its count and the ids the moved todos would get — the group's prefix and consecutive numbers after its highest, each id keeping the text after its own number, e.g. `vscannot3_ajtf-tools` → `annot10_ajtf-tools`), **Enter a prefix…** to number them under a prefix of your own (a new group starts at 1; the input box previews the new ids and refuses a prefix with a digit, a space or a path character), or **Keep the ids as they are**. A renamed todo's notes say which id it had, and the `blocked_by` / `dependencies` among the moved todos follow the new ids.
- **Move selected to other todo file** — opens a quick pick of the quest's other `*.todo.yaml` files (including the `-archived` and `-deleted` siblings), plus a *New todo file…* option, and moves the selected todo (or the whole stack) into the chosen file. Available only in concrete quest mode. Clicking a todo in any of the quest's todo files loads its details, and the details pane refreshes automatically after a status change.

#### Decisions and the `decision-needed` status

A todo can carry a list of **decisions** — open questions that must be answered before the work can start. Each entry has three fields: a one-line **summary**, the **decision needed** (what exactly has to be decided, and the options), and the **decision** itself once made. In the details pane they render as a collapsible list: collapsed you see just the summary line, expanded all three fields.

A todo with unanswered decisions belongs in status **`decision-needed`** (❓), which sorts directly after `blocked` and ahead of `not-started`. It is a normal dropdown choice and the four quest-todo tools round-trip it, so the model can create a todo already in that state — the workspace rule is that a todo whose scope contains a user decision is created as `decision-needed` with the decisions filled in, rather than as `not-started`. `prefix*` queue iteration refuses to run a series containing one; see [Todo iteration](#todo-iteration-prefix).

**Session todos** (the Session Todos view and the panel's session mode) are stored in one stable, git-tracked file per machine and quest — `_ai/quests/<quest>/session-todo.<host>.<quest>.todo.yaml` — and **persist across window reloads**. Older per-window session files are migrated into it automatically.

#### Todo stack (batch send)

Each list row shows a small clickable circle **under its status icon**. Clicking it adds the todo to the **todo stack**; the circle then shows the todo's 1-based stack position. **Shift-click** (with at least one todo already stacked) adds every todo between the last picked one and the clicked one, in the current list order. Clicking a stacked circle again removes that todo and renumbers the rest. The **Clear todo stack** toolbar button empties the stack.

With a non-empty stack, the send buttons switch to batch mode:

- **Save to Queue** — adds **one prompt per stacked todo** to the prompt queue, in stack order, each embedded via the selected template (e.g. the Execute TODO template).
- **Send** (Copilot or Anthropic, following the queue's transport) — combines **all stacked todos into a single prompt**: the todo YAML fragments concatenate into one todo list, get one numbered `REQUIRED: Add responseValue #TODO_<n>=…` line each, and the combined block is inserted into the selected template. With no template selected, the concatenated YAML fragments (plus the response-value lines) are sent as-is.

## 3) Sending prompts

### Anthropic

The Anthropic subpanel in `@CHAT` is the primary AI chat surface. Every turn picks a **profile** that bundles model + transport + history mode + user-message template.

Curated profiles (9 total): **Sonnet 4.6**, **Opus 4.7**, and **Opus 4.6**, each in three flavors:

- **Direct** — raw Anthropic SDK. History injected via `trim_and_summary` compaction. Memory placeholders (`${memory}`, `${memory-shared}`, `${memory-quest}`) expanded before send.
- **Agent SDK T&S** — routes through `@anthropic-ai/claude-agent-sdk` but still uses in-extension history compaction. Memory pulled via `tomAi_memory_*` tools on demand.
- **Agent SDK SDK-MM** — Agent SDK with SDK-managed continuity. The session id persists in a `<name>.session.json` in `_ai/quests/<quest>/history/` (gitignored; `chat` for the panel, `default` for the queue, or a named session) so the next turn resumes in place. Works with Claude Code's session selector.

Switches + actions on the action bar: profile picker, model picker (filters to profile-compatible models), **Open Live Trail** (MD Browser in follow-tail mode), **Session History** (opens `history.md`), **Memory**, **Clear Session**, **Config**.

#### Named sessions

A conversation lives in a **session**: a `<name>.session.json` file in the quest's `history/` folder (machine-local, gitignored). On the Agent SDK transport with SDK-managed history it holds the SDK conversation the session continues; on the direct API transport the session has a history of its own (below). The panel uses its own session `chat`, the prompt queue `default` — and any number of named sessions can be created and chosen:

- **The session button** (speech-bubble icon, right of the profile) shows the session the panel sends in — its name, what it is based on, its lifetime when it is not one conversation, and its model when it has a profile (e.g. *walk based on prep (per iteration) · claude-opus-5-5*). A click opens VS Code's picker: the quest's sessions with what each one does, **New session…**, and **New session based on…**. The choice is kept per quest; *The panel's own session (chat)* goes back to the default. Picking a session that has a profile selects that profile in the panel; you can still choose another. **Save to Queue** queues the prompt in the panel's session, so it continues the same conversation as Send would.
- **New session…** and **New session based on…** (which first asks for the base) ask for the session's lifetime:
  - **Continue** — one conversation. With a base, its first prompt starts from the base's conversation (an SDK fork); later prompts continue the new session, and the base is never changed.
  - **New for every prompt** — every prompt starts again, from the base's current conversation or fresh without a base, and nothing is saved, so the base can hold preparatory context (read the spec, the guidelines, …) while the prompts in this session never change the context of the ones after them.
  - **New for every queue iteration** — each round of a queued item's repeat count, or each todo of a `<prefix>*` walk, starts again from the base (or fresh); that iteration's pre-prompts, main prompt and follow-ups continue it.
- Then for the **profile** the session runs with: its prompts use it unless the queued item names its own profile; without one they use the queue default. The session list shows each session's model.
- **The SESSIONS view** (@TOM sidebar, above SESSION TODOS) lists the quest's sessions — `default` (the queue's) and `chat` (the panel's) always, then every session file — with what each is based on, its lifetime, profile and model, whether it has a conversation yet and when it was last used. **+** in its title bar creates a session (the picker's new-session steps); per row, **Reset** forgets the conversation and keeps the base, lifetime and profile (a based session starts from its base again), and **Delete** removes the session after asking — not while another session is based on it. Both touch only the session file; a session's history folder (`history/sessions/<name>/`) stays.
- **Clear Session** forgets the selected session's conversation; a session you created keeps its definition (base, lifetime and profile) and starts again from it.
- A queued item can name a session that does not exist yet, as a name or with its base, lifetime and profile: it is created before the item's first prompt is sent. An item whose profile keeps its conversation elsewhere than the session's existing one (an Agent SDK session continued by a direct-API profile, or the reverse) is refused when it is queued.

On the **direct API transport** the extension sends the history itself — the compacted history, the last raw turns and the rounds not yet compacted — so a session's history is files of its own:

- `chat` (the panel) and `default` (the queue) share the quest's history in `history/`, as before;
- any other session keeps its own in `history/sessions/<name>/` (the same files), so a queued prompt or a process step that names a session reads and writes only that history;
- **Continue** with a base: the session's history is copied from the base's once, on its first prompt, and continues on its own; the base is never changed;
- **New for every prompt**: every prompt reads the base's current history, or none without a base, and nothing is saved or compacted;
- **New for every queue iteration**: the session's folder holds the current iteration's history and is started again from the base's (or empty) when the next iteration begins.

The live trail and the prompt/answer trail stay one per quest (a log of every exchange); **Recreate history from trail** rebuilds the quest's own history.

### Copilot

Use command palette or editor context menu:

- `@T: Send to Copilot`
- `@T: Send to Copilot (Default Template)`
- `@T: Send to Copilot (Pick Template)`

In `@CHAT`, Copilot supports templates, prompt slots, answer-file notifications, and response-value extraction.

#### CHAT Action Bar

The Copilot section in `@CHAT` includes an action bar with:

- **R** (Repeat count): Number of times to repeat the prompt (text input, 24px wide). Accepts a plain integer, a chat-variable name (resolved at dispatch), or a `prefix*` pattern (see [Repeat and Affix Support](#repeat-and-affix-support))
- **W** (Answer wait minutes): Minutes to wait before auto-advancing without an answer file. When set to 0, uses classic answer-file detection. When > 0, the queue auto-advances after the specified time (text input, 24px wide)
- **Template picker**: Select a prompt template
- **Queue button**: Add the current prompt to the queue with the configured repeat count and wait time

### Tom AI Chat

Use:

- `@T: Start Tom AI Chat`
- `@T: Send Tom AI Chat Prompt`
- `@T: Interrupt Tom AI Chat`

Tom AI Chat shares the Anthropic handler (profiles, tool trail, approval gate, raw trail) but has its own subpanel UI and tool-surface tuning. The tool trail's past-tool-access tools (`tomAi_listPastToolCalls`, `tomAi_searchPastToolResults`, `tomAi_readPastToolResult`) let the model recall prior tool output by replay key (`t1`, `t2`, …) across turns.

### Local LLM (Ollama)

Use:

- `@T: Send to Local LLM`
- `@T: Send to Local LLM (Default Template)`
- `@T: Send to Local LLM (Pick Template)`

Switch model with `@T: Change Local LLM Model...`.

## 4) Prompt Queue

The prompt queue manages sequenced prompt dispatch to Copilot with answer detection, repeat logic, and automation settings.

### Queue Storage

Queue entries are stored as individual YAML files (one file per entry) in the queue folder (`_ai/queue/`, setting `tomAi.queueFolder`), named `<host>_<workspace>_<yymmdd>_<hhmmss>-<token>_<quest>.<type>.entry.queue.yaml`; `<token>` is the first eight characters of the item's id, which the file holds as `meta.id`. The item's **Open YAML file** button opens it. Queue settings are stored separately in `queue-settings.yaml`. This file-per-entry approach enables cross-window sync via file watchers.

Files are prefixed with the hostname to prevent cross-workspace collisions when multiple machines share a workspace folder.

### Queue Entry Fields

Each queued prompt tracks:

- **Status**: `staged` → `pending` → `sending` → `sent` (or `error`). **Send Now** (the play icon) sends a staged or pending item at once and also works on a `sent` item: the whole item runs again from its first prompt (every repetition or `prefix*` todo, every follow-up). With auto-send off an item sends its first prompt and then holds as `SENDING (PAUSED)` until auto-send is turned on; an item with nothing left becomes `sent`.
- **Type**: `normal`, `timed`, or `reminder`
- **Template**: Prompt template name (or "(None)")
- **Answer wrapper**: Whether to wrap with answer file template
- **Request ID**: Unique ID for matching answer files
- **Pre-prompts**: Sent before the main prompt
- **Follow-ups**: Sent after receiving the main answer
- **Repeat settings**: `repeatCount`, `repeatIndex`, `repeatPrefix`, `repeatSuffix`
- **Reminder settings**: Template, timeout, repeat, enabled flag
- **Answer wait minutes**: Time-based auto-advance timeout

### Repeat and Affix Support

Prompts can repeat multiple times with customizable prefix and suffix text:

- **repeatCount**: Total number of times to send the prompt. Accepts three forms:
  - A **plain integer** (e.g. `3`).
  - A **chat-variable name** — resolved to its numeric value at dispatch time (not at enqueue), so the count reflects the variable's value when the item is actually processed.
  - A **`prefix*` pattern** (e.g. `tod*`) — switches the main prompt into **todo iteration**, described below. The displayed count is the highest number among the active quest's todo ids that start with `prefix` and hold a number. The number is the first run of digits after the prefix, wherever it starts, and anything after it is ignored: `tod3`, `tod3b`, `tod3-review` and `tod-groupa3` all count as `3`. The prefix itself may hold digits — `p2s2ss3-*` walks `p2s2ss3-1`, `p2s2ss3-2`, … — but must not end in one: `p2s2ss3*` is refused with an error instead of being queued, because after it `p2s2ss31` could be todo 1 or another group. Only the quest's **live** todo files are scanned — todos in the `-archived` / `-deleted` siblings do not contribute.
- **repeatIndex**: Current iteration (0-based internally, displayed 1-based)
- **repeatPrefix / repeatSuffix**: Template text inserted before/after each repetition, supporting placeholders `${repeatNumber}` (1-based), `${repeatIndex}` (0-based), `${repeatCount}` (total)

#### Todo iteration (`prefix*`)

A `prefix*` repeat count does not repeat a fixed number of times — it **walks the active quest's numbered todos**, one per dispatch. This applies to the **main prompt only**; a `prefix*` entered on a pre-prompt or follow-up keeps the plain counter behaviour.

- **Which todo goes next**: the lowest-numbered todo whose status is `not-started`. Todos sharing a number (`dsa2-a`, `dsa2-b`) are walked in alphabetical order. The walk starts at the first number that actually exists — a series of `dsa7`, `dsa9` starts at 7.
- **Todo groups**: the prefix is matched literally, dashes included, and the number may come after more text. So `xyz*` walks `xyz-groupa1`, `xyz-groupa2`, `xyz-groupb1` … together, by number (`xyz-groupa1`, `xyz-groupb1`, `xyz-groupa2`, …), while `xyz-groupa*` walks one group only. Every id that starts with the prefix and holds a digit joins the walk, so pick prefixes that no unrelated todo family starts with (`vsc*` would also take `vsctsa…` and `vscimpa…`).
- **Blocked todos**: before each pick, every `blocked` todo of the series is checked against its `blocked_by` list. When each todo named there is completed, cancelled, or no longer exists (deleted, or archived out of the live files), the todo is set back to `not-started` and runs in its turn — so a todo that waits on an earlier todo of the same list runs once that one is done. A todo with an open blocker stays blocked and is skipped. So does a blocked todo with no `blocked_by` list (a block written only in its notes) or with a `blocked_until` release condition, which the queue does not evaluate. A blocker in another quest is written `<quest>/<todo id>`.
- **Claiming**: before the prompt is sent, the picked todo is set to `in-progress`. That is what makes the walk terminate — a claimed todo no longer qualifies, so every dispatch shrinks the candidate set. Todos that are already `in-progress`, `blocked`, `completed`, or `cancelled` are skipped.
- **An open decision holds the whole series**: if *any* matched todo is `decision-needed`, nothing is dispatched. The queue item goes to `DECISION-NEEDED`, auto-send switches off, and the ids that are waiting are logged.
- **The held item does not hold the rest of the queue**: restart the queue and the other prompts run — the blocked one is skipped for as long as its decisions are open. Answer them (set the todo back to `not-started`) and it returns to `PENDING` by itself the next time the queue picks an item; there is nothing to click. It is never overridden — an item is released only once its series has no unanswered todo left.
- **If the send fails**: the todo is handed back to `not-started`, so the retry picks up the same todo rather than skipping it.
- **When nothing is left**: the main stage ends and the item proceeds to its follow-ups. A `prefix*` that matches no todo at all sends nothing and logs why — it does not fall back to a single run.
- **Placeholders**: `${repeatTodoId}` is the picked todo's full id, `${repeatTodoTitle}` its title (its description when it has none), and `${repeatNumber}` its number. All three work in the prompt text and in the repeat prefix/suffix.
- **In the queue entry header**: the current todo's full id appears as a badge next to the `[MP …]` progress, e.g. `SENDING [MP 7/9] [dsa7-review]`. The rep-number is read-only in this mode, since the walk is driven by todo status rather than by the counter.
- **Caveat**: if a prompt resets its todo back to `not-started`, that todo will be picked up again.

### Answer Detection

The queue uses RequestId-based answer file matching:

- A unique request ID is embedded in each prompt via the answer wrapper template
- The file watcher monitors the answer directory for `*_answer.json` files
- A fallback polling mechanism (every 30 seconds) catches missed file events
- When `answerWaitMinutes` > 0, the queue auto-advances after the specified time without requiring an answer file

### Automation Settings

| Setting | Default | Description |
| --- | --- | --- |
| Auto-send | On | Automatically send pending items |
| Auto-start | Off | Enable auto-send on extension activation |
| Auto-pause | On | Pause auto-send when queue empties |
| Auto-continue | Off | Auto-continue processing after receiving an answer |

Turning **Auto-send** off never interrupts the item that is already running —
it finishes its stages and then the queue stops instead of starting the next
one. This holds for every transport and however the running item finishes
(answer file, answer-wait timeout, manual **Continue**, or a resend).

A few explicit actions deliberately start an item even while auto-send is off,
because that is what they are for: **Send now** on an item, the per-item
**Retry now** on a waiting or retrying item, and **Retry All Errors** (which
turns auto-send back on for the cascade). The background health check also
resumes an item whose rate-limit or retry window has just elapsed.

### Pause after this

Every queue item carries a **pause icon** in its header. Clicking it arms
"pause after this" and the icon switches to an inverted (white-on-black)
state so the armed item is unmistakable at a glance. Click again to disarm.

The armed item still runs to completion — all pre-prompts, every repetition of
its main prompt, and all follow-ups. Only *after* its last stage does the queue
stop: auto-send flips off and the next pending item is not started. Items that
repeat only once behave the same way.

The hold is honoured on every path an item can finish on, including a manual
**Continue** on the item and a resend — an item never slips past the pause
because of *how* it happened to finish.

The flag stays on the item rather than being consumed, so re-staging and
sending it again pauses the queue again. Clear it with the same button; it
remains visible (inverted) on a finished item precisely so a leftover flag
cannot hide. The one exception is an item with a done notification: the
flag moves to the notification, so the queue pauses after the notification.

### Done notification

Under every item's prompt is a collapsible **Done notification** section: a
prompt queued right after the item when the item is finished — all its
pre-prompts, repetitions (or `<prefix>*` todos), follow-ups and template
iterations done — or when it ended in an error that will not recover (no API
key, a request the API refused, retries exhausted). Waiting out a usage quota
or a rate limit is not such an error, so nothing is queued then.

- The notification is queued ahead of every other pending item and runs with
  the item's transport, profile and session. Its header reads *notification of
  <item>*.
- `${itemOutcome}` in it reads `done` or `error: <message>`.
- The bell icon in the section's title switches it off (the prompt is kept, not
  queued) and on again. The prompt can be changed until the item is sent, also
  while it is running.
- It is queued once per run: a failed item retried by hand that then succeeds
  does not notify twice; Send Now on a sent item starts a new run.

### Items from other quests

An agent in one quest's window can put a prompt into the queue of another
quest's window on the same machine with `tomAi_sendItemToQuest` (also over
MCP). The target window takes it up at once — or when a window of that quest
starts — and queues it with its own defaults; the item shows **from
<quest>** in its header. The sender may give the profile, an existing session
of the target quest, or a new session based on one (without a name, a
temporary session deleted when the item and its notification are done), and a
done-notification prompt, typically one that sends a message back. In those
prompts `${senderQuest}` is the sending quest.

### Interrupt for continuation

**Stop** and **Pause** each cover one kind of interruption: Stop cancels the
running prompt and reverts the item to Staged (a fresh restart from repetition
1); Pause lets the running repetition finish and holds before the *next* one.
Neither fits the case where *you* have to interrupt — the network is about to
go away — and want the running repetition to simply run again once you are
back. That is the **Interrupt for continuation** button (`codicon-debug-disconnect`,
next to Stop in the toolbar, and on the running item's own row):

- The running prompt is cancelled immediately; any partial answer is discarded.
- The item is held at its **current repetition** with the status
  `INTERRUPTED — RESENDS ON RESUME`, and Auto-send switches off.
- Re-enabling Auto-send (the play toggle, Auto-start on reload, or
  Auto-continue's timer) re-sends **that same repetition** with the same text
  first, then the loop carries on. The held row also offers **Resend** (replay
  now) and **Move back to Staged** (abandon the continuation).

The state survives a window reload; Restart Queue leaves a held item alone.

### Watchdog and Health Check

A background watchdog runs every 60 seconds to ensure queue reliability:

- Verifies the answer directory exists and is accessible
- Checks the file watcher is active and restarts it if needed
- Detects stalled pending items and triggers processing
- Supplements primary file watching with polling every 30 seconds

### Queue Editor

Open with `Ctrl+Shift+6` or `@T: Open Prompt Queue`. The editor provides:

- **Toolbar**: Auto-send, Auto-start, Auto-pause, Auto-continue toggles, Restart Queue, **Stop** (cancel the running prompt and revert it to Staged) and **Interrupt for continuation** (see above)
- **Entry list**: Per-item cards with status color coding, type badges, progress indicators
- **Staged item form**: Template, repeat count, answer wait minutes, repeat prefix/suffix, pre-prompts
- **Per-item controls**: Preview, send now, move up/down, delete, toggle reminder, pause after this, interrupt for continuation (on the running item); an interrupted item offers Resend and Move back to Staged
- **Sessions**: an Anthropic item shows the session it runs in (speech-bubble chip in its header), with a `*` after the name when that session is based on another; its tooltip names the base and the lifetime (new for every prompt or every queue iteration), and a session the item will create when it is sent reads from the item's spec. A click on a staged or pending item opens the session picker (an existing session, a new one, one based on another, or the queue default). The transport gear asks for the session as its last step. The context bar at the top reads *Quest: … | Role: … | Session: …*: **Session** is the queue's default session, the one every item that names none runs in (unset: the queue's own `default`), shown with its base and lifetime, e.g. *Session: walk based on prep (per iteration)*; **Role** is the role chat variable. Both are underlined links: a click opens a VS Code picker — the roles under `_ai/roles/` (or none), or the session picker. Agents set it with `session` on `tomAi_addQueueItem` / `tomAi_updateQueueItem` and create sessions with `tomAi_createSession` — see [Named sessions](#named-sessions).

## 5) Timed Requests

Timed requests fire prompts on a schedule or at regular intervals. Open the editor with `Ctrl+Shift+7` or `@T: Open Timed Requests`.

### Schedule Modes

- **Interval**: Fire every N minutes (configurable `intervalMinutes`)
- **Scheduled**: Fire at specific times (`HH:MM` format), optionally date-restricted

### Entry Fields

| Field | Description |
| --- | --- |
| Template | Prompt template to use |
| Answer wrapper | Whether to apply answer wrapper |
| Interval (minutes) | Time between fires (interval mode) |
| Scheduled times | Specific fire times (scheduled mode) |
| Repeat count | Number of times to repeat each fire |
| Repeat prefix/suffix | Text affixes per repetition |
| Send maximum | Maximum total fires before auto-pause |
| Sent count | Fires so far (tracking) |
| Answer wait (minutes) | Auto-advance timeout instead of answer file wait |
| Reminder | Template, timeout, enabled flag |

### Send Maximum and Auto-pause

When `sendMaximum` is set on an interval entry, the entry automatically pauses after `sentCount` reaches the limit. This prevents unbounded firing when the user is away.

### Global Schedule Slots

Timer entries respect global schedule slots that restrict when entries can fire:

- Day-of-week restrictions (weekday, specific days)
- Time-of-day windows (`timeFrom` / `timeTo`)
- Month filtering

### Tick Process

The timer engine ticks every 30 seconds. On each tick:

1. Checks global schedule slots
2. For each active entry, evaluates whether it should fire
3. Skips entries that already have a pending item in the queue (prevents duplicates)
4. Enqueues via the prompt queue manager (never sends directly)
5. Updates `lastSentAt`, `sentCount`, and persists state

## 6) Bridge operations

Bridge and automation commands:

- `@T: Restart Bridge`
- `@T: Switch Bridge Profile...`
- `@T: Start Tom CLI Integration Server`
- `@T: Stop Tom CLI Integration Server`
- `@T: Start Process Monitor`

## 7) Status, config, and diagnostics

Use:

- `@T: Extension Status Page`
- `@T: Open Extension Settings`
- `@T: Open Config File`
- `@T: Toggle Bridge Debug Logging`

## 8) Output Channels

The extension provides dedicated output channels for observability:

| Channel | Source | Purpose |
| --- | --- | --- |
| Tom Prompt Queue | `promptQueueManager.ts` | Queue state changes, send events (each naming where the prompt goes: `via copilot`, or `via anthropic (profile …, session …)`), answer detection, watchdog health checks |
| Tom Timed Requests | `timerEngine.ts` | Tick heartbeats, fire decisions, schedule evaluation, entry lifecycle |
| Tom Debug | `debugLogger.ts` | General debug logging across all categories |
| Tom Tests | `tests.ts` | Test execution output |
| Tom Dartbridge Log | `vscode-bridge.ts` | Bridge communication logs |
| Tom Conversation Log | `aiConversation-handler.ts` | AI conversation turns |
| Tom AI Chat Log | `tomAiChat-handler.ts` | Tom AI Chat interactions |
| Tom Tool Log | `tomAiChat-handler.ts` | Tool invocation logs |
| Tom AI Chat Responses | `tomAiChat-handler.ts` | Chat response content |
| Tom AI Local LLM | `localLlm-handler.ts` | Local LLM interactions |
| Tom AI Local Log | `localLlm-handler.ts` | Local LLM debug output |

Queue and timed request channels include ISO timestamps on every log line and can be enabled/disabled at runtime.

## 9) Trails and history

The Anthropic + Tom AI Chat subsystems write three kinds of trail:

- **Raw trail** — `_ai/trail/anthropic/<quest>/` (and per-subsystem siblings). Every turn produces `<ts>_prompt_<rid>.userprompt.md`, `<ts>_payload_<rid>.payload.md`, `<ts>_answer_<rid>.answer.json`, plus `<ts>_toolrequest_*.json` / `<ts>_toolanswer_*.json` for each tool call. Inspect via the Raw Trail Viewer editor.
- **Live trail** — `_ai/quests/<quest>/live-trail.md`. Rolling-window markdown (last 5 prompt blocks). Streams thinking / tool_use / tool_result / assistant-text events as they arrive. Best viewed via the **Open Live Trail** button (MD Browser in live mode follow-tails the file).
- **Session history** — `_ai/quests/<quest>/history/history.json` (+ `history.md` rendering). Rolling compacted context used by `trim_and_summary` on the direct transport. SDK-managed mode uses `default.session.json` instead.

Clear the session (reset history + tool trail + SDK session id) via the subpanel's Clear button or `@T: Clear Anthropic Session`.

## 10) Keyboard productivity

See [quick_reference.md](quick_reference.md) for every keybinding and the commands they run.

## 11) Reinstall and reload

If extension changes do not appear:

1. reinstall the extension package in the target VS Code host,
2. reload window,
3. rerun the affected command.

Building and installing the package is described in the extension README's
Installation section.
