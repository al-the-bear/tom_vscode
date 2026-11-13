# @Tom Extension User Guide

## 1) What the extension provides

The extension combines VS Code automation, bridge-based scripting, Copilot workflows, Anthropic chat with tools, local LLMs through Anthropic profiles, a prompt queue with timed requests, and dedicated output channels for observability.

## 2) Panels and layout

Current bottom panel layout:

- `@CHAT` (`tomAi.chatPanel`): **Copilot**, **ANTHROPIC/LLM** and **Logs** in an
  accordion layout (pin, rotate). Each of the two chat subpanels can send its
  prompt to the prompt queue. The Logs section shows one session's live trail,
  prompts, answers and running prompt, with a session switch; the session's
  history, memory and Clear are behind it — see [Logs Panel](#logs-panel).
- `@WS` (`tomAi.wsPanel`): Guidelines, Documentation, Settings, Issues, Tests, Quest TODO. The Documentation section's sub-tabs hold the document editor and the quest's own documents — see [Documentation Panel](#documentation-panel).

Both subpanels are queue-compatible.

### Setting up a workspace, creating quests

- **Setup New Workspace Folder** (`@T: Setup New Workspace Folder`; also the
  button on the panels of a folder without `.tom/` and at the top of the Status
  Page, beside **Create new quest**) unpacks the workspace template the VSIX carries — the configuration, the
  guidelines, CLAUDE.md, the `_ai` roles, processes, schemas and prompts, and
  the starting quest `tomai_introduction` — into a folder you pick or create. A
  folder that is not empty shows what is in it first (**Set up anyway** goes
  on). For each file that already exists you choose **Overwrite**, **Skip**,
  **Overwrite All**, **Skip All** or **Cancel** (what was written stays); the
  end reports what was written, overwritten and skipped (**Show the file
  list**). Then it says what in `.tom/tom_vscode_extension.json` to adapt (the
  bridge profiles' paths, `bridge.executables`, the Local LLM endpoint, the API
  key's environment variable; **Open the configuration**) and asks what to open:
  the introduction quest or the folder, each in a new window, or stay here.
- **Create New Quest** (`@T: Create New Quest`) asks the quest id (letters,
  digits and `_`, not taken) and a name, creates `_ai/quests/<id>/` with the
  quest's files (empty but for their headings), adds the quest to the Active
  Quests table of `_copilot_guidelines/quests_and_processes.md`, and offers to
  open the quest's workspace. Its one todo,
  `questsetup1_<code>-define-the-quest`, defines the quest with you in question
  rounds when you run it in the queue or the chat. Agents run the command with
  `{ id, name, offerOpen }` (the `!create quest` pattern prompt does).
- **No quest is open:** while the window's workspace is not a quest's (quest
  `default`), @CHAT, @WS and the @TOM views PROCESS, QUEST NOTES, QUEST TODOS,
  SESSIONS and SESSION TODOS show a banner *No quest is open. Open a quest
  workspace (`_ai/quests/<id>/<id>.code-workspace`) or create one.* with **Create
  new quest** and **Setup new workspace folder**.
- **The quest overview once:** the first time a quest's window opens on a
  machine, its `overview.<quest>.md` opens in the MD Browser (the focus stays
  where it is; not when a restored tab shows it already). It is remembered per
  quest in the VS Code profile's global state (`tomAi.questOverview.shown`);
  afterwards the overview is in @WS › Documentation › Quest Overview.

### Guidelines Panel

The Guidelines panel in @WS provides a document browser for copilot guidelines. Features:

- **Project dropdown**: Filter guidelines by project (shows projects with `_copilot_guidelines/` folders)
- **Quest dropdown**: Filter guidelines by quest (shows quests when quest project type selected)
- **Link navigation**: Click links to navigate within the panel or open in Markdown Browser

### Logs Panel

The Logs section of @CHAT shows what one Anthropic session wrote: its live trail,
its prompts and answers, and the prompt it last sent. Every session — `default`
(the prompt queue), `chat` (the ANTHROPIC/LLM panel) and each named session — keeps
these in `_ai/quests/{quest}/history/sessions/{session}/`. It is read-only; use
the toolbar to edit.

- **Session actions**: behind the session switch, six icons work on the
  selected session — its raw trail viewer, its summary trail in the trail
  viewer, its rolling history and its live trail in the MD Browser, the memory
  panel on its quest memory, and clearing its history (asks first).
- **Session switch**: above the sub-tabs, one button per session, the most
  recently used first. With more than four sessions a dropdown holding every
  session comes first, and the buttons are the four most recently used; the
  chosen session shows in the dropdown when it has no button. The list follows
  sessions created and deleted while the section is open, and a session without
  that file yet shows a line saying so. The choice is one for the whole Logs
  section: switching the session on any sub-tab switches it on all of them, and
  it survives a window reload; without one the tabs show `default`.
- **Sub-tabs**: **MD Trail** (the session's `live-trail.md`, rendered), **Trail**
  (the same file as highlighted source), **Prompts** / **Answers** (the session's
  `{quest}.anthropic.prompts.md` / `.answers.md`), **Current Prompt** (see below)
- **Remembered selection**: the active sub-tab and each sub-tab's session are
  restored after a window reload
- **Auto-refresh**: re-reads every 2.5 s while the section is expanded; a file
  that has not changed costs no read
- **256 KB window**: a larger file is shown from the end its newest content is
  at — the last 256 KB (marked `(tail)`) of the two trail tabs, the first 256 KB
  (marked `(head)`) of the others
- **Follow scrolling**: the view opens at that same end, and a reader still
  sitting there stays there as the file grows; scrolling away to study something
  holds that position

The quest's own documents moved to the **Documentation** section (see
[Documentation Panel](#documentation-panel)).

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

The files behind it are the session's own copy in its trail folder
(`history/sessions/{session}/trail/current_prompt.*.md`), which is gitignored —
they change on every prompt, so they are deliberately kept out of what git
tracks. They are written for every Anthropic transport (direct SDK, Agent SDK,
vscodeLm) and persist after the answer arrives, so the tab still shows the last
prompt sent when nothing is running. Internal calls that run in no session
(history compaction, memory extraction) write none.
- **Toolbar**: **Refresh** re-reads the selected file from disk; **Open in
  editor** opens it in a normal text editor

### Documentation Panel

The Documentation section of @WS has its own sub-tabs:

- **Documents** — the document editor: pick a group (Workspace, Projects,
  Notes) and a file, edit it, open it in an editor or the MD viewer.
- The quest's documents, read-only like the Logs (the same toolbar, 2.5 s
  refresh and 256 KB window): **Quest Progress** (`progress.{quest}.md`),
  **Quest Overview** (`overview.{quest}.md`), **Quest Notes**
  (`quest-notes.{quest}.md`), **Quest Refresh** (`quest_refresh.{quest}.md`),
  **DocUpdate** (`quest_documentation_update.{quest}.md`), **Deferred**
  (`deferred.{quest}.md`), **Questions** (`questions.{quest}.md` — every question
  the model asked you and the answer you gave), **Decisions**
  (`decisions.{quest}.md` — the decisions carried by each todo, copied here when
  the todo is archived as completed). The three journals (Deferred, Questions,
  Decisions) are appended to and open at their end; the others open at the top.
  These are one set per quest, shared by every session. Not every quest has
  every document; a missing one is reported in the viewer.

### Markdown Browser

The Markdown Browser is a standalone webview panel for reading markdown documents with full navigation:

- **Open via**: the `@T: Open in MD Browser` command, link clicks in the Guidelines panel, or the tools (`tomAi_openInMdBrowser`, with `live: true` for follow-tail mode)
- **Document picker**: Grouped by Guidelines, Workspace Docs, Notes, Roles, Quests, Copilot Instructions, and Projects
- **Quest dropdown**: Secondary dropdown to filter quest documents when in quest context
- **Link resolver**: Clickable `.md` links navigate within the browser; special link types include `quest:`, `issue:`, `todo:`, and `test:` protocols; non-`.md` files open in the VS Code editor; external URLs open in the system browser
- **Links in plain text**: a path to a Markdown file written as plain text — `iterations/notes.md`, `../other.md`, `clarifications.sbp.md` — is a link like any Markdown link, resolved relative to the document and then to the workspace root (code blocks are left alone).
- **Tab titles name the file**: `MD: <name>` (`MD (live): <name>` for a live panel); while another MD Browser shows a different file of the same name — a step folder's copy of a document, say — both titles add the parent folder. Agents see the same list with `tomAi_listMdBrowserPanels` (and in `tomAi_getOpenEditors`), including whether a panel has an in-place editor open with unsaved text.
- **Grill me / Explain in detail**: every unanswered question block (the review syntax, plain Markdown and TomSpecs documents alike) has two buttons after its answer button. **Grill me** (flame) runs the *Grill me* Assist prompt: the agent asks you narrowing questions in the question panel until the question can be answered, then proposes the answer. **Explain in detail** (book) runs the *Explain in detail* prompt: the agent writes a note beside the document (`<document folder>/notes/<question id>-explained.md`), shows it with its dig-deeper choices, and may end with a proposed answer. Both run outside the queue in the ANTHROPIC/LLM panel, in a temporary session (`tmp-…`) based on the session the document's work runs in — the session of the process's current position, else `default` — so they do not wait for a running walk; the temporary session is removed when the turn ends. If the panel is busy, you are told to try again. When the turn has ended and the question is still open, the question panel asks for its answer with the question's own choices: **Accept the proposed answer** (when the agent proposed one), each option — the recommended one marked *(recommended)* — and **Leave it open**: select one, add your own words in the field under the question if you like (with an option they are written after it, `(b) …`), and **Send answers**; words without a choice are an answer of their own. What you send is written into the Answer line. While the agent works between two of your answers — after you answered a round and before its next question, the proposal or the end — the MD Browser panel on the document and the @CHAT panel show an overlay: *the agent is thinking about the next step on DP-19*, the document, and how long it has been thinking. **Cancel** stops the turn: the document stays as it is (a proposal already written stays), and no answer is written; a notification says it was cancelled. When the turn fails, the overlay shows the error (**Dismiss**, or it goes after 15 seconds); it never stays once the turn has ended. A notification then says how the question ended — what was written into which file and line (**Open file** opens it there), that the agent answered it during the turn, that it is left open, or why the answer could not be written — and the same line is added under the turn's answer in its prompt queue entry and to the Tom Prompt Queue output channel.
- **Proposed answers**: a proposal written under a question (`> **Proposed answer** (<source>, <date>): …`) shows **Accept** (writes it into the Answer line and removes it), **Edit** (opens it in an editor; saving writes the edited text into the Answer line) and **Discard** (removes it, the answer stays as it is). In a TomSpecs document the agent proposes as a reviewer comment instead.
- **An agent asking through a document**: an agent can open a file with its own buttons (Continue, Cancel, whatever its flow needs) and a **Keep this file** checkbox, checked by default, in a bar above the toolbar (`tomAi_askInMdBrowser`). It waits for your click — a queued prompt holds there — and goes on with the button you clicked; the bar then shows the answer. With the box unchecked the file is deleted and its panel closed as the flow goes on, also when the agent's deadline passes or you close the panel. At a review of the quest's process the bar carries **Finish review round**: one click closes that panel (only that one), confirms the review, moves the process on and queues the next step's prompt — or opens the decision when the process has one next.
- **After a window reload**: VS Code brings the MD Browser tabs back but starts each one only when it is shown; showing it reopens its file. Until then agents see the tab as `dormant`, with the file it showed, and can close it. A tab whose file no longer exists is closed when the window starts.
- **Open here or in a new browser**: hovering a link to a `.md` document shows a small popup with **Open here** and **Open in new MD Browser**; a plain click still opens it here.
- **Section references** (DocSpecs documents): a reference to section ids written `OUTER > INNER` (upper case ids joined by `>`, also inside backticks) is a link to that heading — the outer ids pick among headings that share the inner id. A single upper-case id with more than four letters (`PLTPLN`, `ASMRE-ASMP-PERSONA-ARCHETYPES`; ids may contain `-`) is a link too, to the first heading with that id, except inside that heading. References that name no heading stay plain text. A reference broken across lines is not one: the line starting with `>` is a quote.
- **Back and forth within the document**: following a section reference or an in-document anchor remembers where you were. The second pair of arrows, in the bar under the toolbar, goes back to it and forward again; the trail starts fresh for another document.
- **Search**: the search box in the same bar finds text in the document as you type (case-insensitive), shows which match is current and how many there are (*147/356*; *0/0* when nothing matches), and highlights the matches. It starts where you are reading — at the first match from the top of the view, and while you type on it stays on the current match — and counts every match in the document. Enter / Shift+Enter or the up / down arrows step through them, and after the last match comes the first from the top; a match inside a folded section unfolds it; Esc or the × in the box clears it; Cmd/Ctrl+F jumps to the box.
- **Line number support**: Links with `#L10` or `#L10-L20` fragments open source files at the specified line
- **Auto-reload**: File watcher (debounced ~200 ms) monitors the currently viewed file and re-renders on external changes; scroll position is preserved across same-file re-renders in normal mode
- **Reload** (the refresh button): renders the file again in any case — also when its text has not changed, and with a text area open (which is closed; the reading position stays)
- **While a change is saved** — Save, Save and next, a one-click answer, accepting / rejecting / removing a mark or a comment, accept / reject all — the browser shows a *Saving…* indicator with a wait cursor and takes no clicks or typing until the change is done (or refused)
- **While a text area is open** the search box and the review navigation (↑ / ↓ and the kinds) are disabled, so nothing scrolls or re-renders under the text you are writing; they come back when it is saved or discarded
- **Live mode (follow-tail)**: Opened by a session's live-trail action in the @CHAT Logs section, or by `tomAi_openInMdBrowser` with `live: true`. Auto-scrolls to the bottom on each re-render as events stream in; pauses when the user scrolls up and resumes when they return to the bottom
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
- **Reviewing changes**: in edit mode every change mark has an accept (✓) and a reject (✗) button, and every inline comment an edit (✎) and a remove button; one click decides that one mark, and the file is written by the TomSpecs runtime's rules — an accepted change keeps its new text, a rejected one its old text, a removed comment leaves the text it was on, and no double spaces are left behind. Every change also has a **Comment** button: it opens an editor under the paragraph, and Save writes a *change comment* right after the change, quoting it — `{~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~] why shorter? <<}` (SOM §11.9.3) — so the comment still says what it was about once the change is decided. A change's own comment is drawn beside it, once, with its own edit and remove buttons; accepting or rejecting the change keeps the comment and records the outcome in its quote, and such a comment is then drawn with the change and its outcome as a label (*30 → 15 (accepted): why shorter?*). Edit opens a comment's text in an editor under its paragraph — a `{>> comment <<}` alone, a change comment (its quote is kept) or a highlight's comment (on a highlight without one it reads *Add a comment*). Save has the TomSpecs runtime write it; saved empty, the comment is removed (a highlight keeps its marked text). A comment holding a mark delimiter (`{>>`, `{==`, `{++`, `{--`, `{~~`, `<<}`) or a blank line is refused in the editor, which keeps the text. A comment block's trash button removes it with one click. The action bar's **Accept all changes** (✓✓) and **Reject all changes** buttons decide every change mark of the document at once (comments stay for their own decision); the notification that follows offers **Undo** while the file is unchanged.
- **Stepping through a review**: the action bar's ↑ / ↓ buttons step through the kinds ticked in the popup the button between them opens (the count beside them says which target is current and how many the ticked kinds have, *2/14*; *–/14* before the first step, updated as you decide, answer or save) — **Changes**, **Comments** (comment blocks), **Inline comments**, **Questions**, **Unanswered** questions, **Marked: check here** (every `___check here___` marker) and **Agent comments** (comment blocks and inline comments an agent signed, `agent_<role>`), one or several at once, in document order (**Unanswered** is ticked when a document opens — the usual review; the button names them: *Unanswered*, *Changes + 2*, *All*, *Nothing*) — from the reading position, wrapping at the ends; the current one is outlined. After a save, an accepted or rejected change or a removed comment, the next step goes on from there: the question after the one just answered, the change after the one just decided (changing the ticked kinds goes on from the current target too). Stepping shows the context at the top of the view — a question's text above its answer, the paragraph a comment block is on — keeping the target itself, or the answer's open text area, in view. While **Unanswered** is ticked, stepping to an unanswered question opens its answer with the recommended option filled in. Under the kinds, **Whose** lists every author the document names — a comment block's `(author)` and the attribution tokens after marks (`{@alice}`, `{@agent_spec_author}`, SOM §11.9.8) — and *(no author)*, all ticked; unticking one leaves that author's comments and changes out of the arrows and the count (questions and markers are found whoever wrote them). The choice is kept while the browser is open, and an author new to the document comes in ticked. With your **review member id** set (Status Page, **Team review**, `review.memberId`) the comments you write here are signed with it, Whose names it *(you)*, and your own lines are marked with a green bar: your comments, the changes attributed to you (`{@<id>}`) and the individual answers that list you (`**Answer (<id>, …):**`). The spec tools write answers and marked changes as yours by default then. Below Whose, **Changed since** (*Any time*, *The last hour*, *Today*, *The last 24 hours*, *The last 7 days*, or *A chosen time…* with a date and time field) leaves out the comments, changes and questions not written or changed since then — the button then reads *… · since*; markers and conflicts carry no time and stay.
- **Change times**: when a comment, question, answer or change was written (SOM §11.9.10, `2026-11-07T14:05+01:00` in the document) is shown as a small label after its author — *just now*, *5 min ago*, *3 h ago*, *2 d ago*, after a week the date and time — with the full time and its offset as the tooltip; the labels follow the clock when you come back to the browser. What you write here records the time too: a new or edited comment's header `(<author>, <time>)`, an answer's marker `**Answer (<time>):**` (an emptied answer is `**Answer:**` again).
- **Team review rounds**: an agent runs a review by several people through files. It creates a round folder next to the document (`review-rounds/<name>-<date>/`) with one copy per team member, named by member id (`alice.md`, `alice.docspecs.yaml`); each member reviews their own copy in the MD Browser. The agent then tells you who has returned theirs, merges the copies into `merged/` — each change and answer marked with who made it, a conflict block `⚖️ X-1` wherever two members changed the same passage differently — and writes the decision you take for each conflict. A copy from somebody not on the team counts as a guest's: the agent asks for their name and role. The team comes from the document's review team, else the solution blueprint's (for the document type, else its default); for a plain Markdown file you name it.
- **Consolidating a team review** (the merged document of a round): every change, vote, comment and individual answer carries a **chip** with the member's display name in the member's colour (names from the round's `round.yaml`, the document's review team and its revision history; an id nobody names is shown as it is). `**Answer (alice, bob):**` lines read *Answer (Alice Owner, Bob Dev):*. **Team** on the action bar opens the legend: each member with role (guests marked), **Only …** to dim everyone else's marks, comments and answers and leave them out of the arrows (**Everyone** undoes it), and ✓✓ / ✗ to accept or reject **all of one member's changes** (with Undo); below it the **revision history** with each round's team and reviewers, guests marked. A base mark the members voted on shows the votes (✓ Alice, ✗ Bob). A **conflict block** (`⚖️ X-1`) has one button per alternative and **Keep base**; **Decide** writes the chosen text into the paragraph and removes the block, **Rewrite…** opens the editor with the chosen text, **Keep open…** writes `open:` with a summary of the positions as its decision (a conflict about a form field, another value or an item is recorded as its decision and applied when the annotations are removed). A question the members answered opens its team-answer editor with the option most of them chose; **Keep open** beside it writes `open:` with each member's answer. Beside the arrows, the counter (*1 ⚖ · 2 ? · 3 ±*) says how many conflicts, open questions and undecided changes are left, and **Next unresolved** steps through them.
- **Agents' annotations and the check-here marker**: an agent signs what it writes into a reviewed document as `agent_<role>` (e.g. `agent_spec_author`; the annotation tools sign so when no author is given). An attribution token after a mark is drawn small after it. `___check here___` marks a section or comment that especially needs your eye; it is drawn as a yellow *check here* badge instead of bold italic text, and an agent's comment that uses it says why.
- **Long comments**: a comment block or inline comment longer than 200 characters carries two buttons, always shown: the eye shows the whole comment as Markdown in an overlay over the browser (close with ✕, Escape or a click beside it), the other opens it in the Markdown preview editor.
- **Editing is guarded**: a save is refused, and the text area stays open with the reason, when the file changed since it was shown, or when it has unsaved changes in an editor. With **CR/LF** on everything can be edited as usual, except a paragraph that holds a converted line break (an escaped `\n` or a bare CR in the file): its lines are not the file's lines, so it shows no editing buttons until CR/LF is off. When the file changes on disk while a text area is open — an agent wrote a proposal or an answer, Grill me accepted one — a text area with nothing typed in it is closed and the new version shows at once; when you have typed something, a bar names the questions that changed and asks: **Show the new version** (your typed text is dropped) or **Keep my text** (the new version shows when you close the text area; saving text typed against the old version is refused when its lines changed, so it never overwrites the new answer). After such a refresh the panel scrolls to the question that changed and marks it for a moment. A write by the agent's Markdown and spec tools renders every MD Browser panel on that file at once.

### Processes

A **process** is a named way of working through a quest, so you do not have to explain it to the agent again in every prompt. It has **phases**; each phase has **steps**, and a step can group **sub-steps** (the step is then just their group). A step or sub-step can name the **role** doing it. Every phase ends with a **quality gate** step and can have a **post-gate** step whose todos are done after the gate passed and before the next phase starts. Phases, steps and sub-steps can be **repeatable** — run in several iterations, optionally up to a maximum.

Processes live in `_ai/processes/<id>/`: `<id>.process.yaml` is the structure and `<id>.md` the description.

- **Process editor** — the hierarchy icon button at the bottom of every @CHAT subpanel (or `@T: Open Process Editor`). The list on the left shows every process; **+** creates one from a one-phase skeleton, the copy button duplicates the selected one under a new id. The form edits the name, summary, Markdown description and every phase, step, sub-step, gate and post-gate step: id, name, role, repeatable / maximum, description, **prompt** (what is to be done when it runs — Proceed puts it into the prompt it queues), **session** (the session its prompts run in, shown like the queue's session link — `name based on X, per prompt, profile`, or *inherited*; a click opens the session picker: an existing session, or a new one described by its base, lifetime, profile and name — the editor only writes the definition, Proceed creates the session; the ✕ clears it, so it is inherited from the step, then the phase, then the process; `${phase-iteration}`, `${step-iteration}` and `${substep-iteration}` in a name are filled in). The process itself has a **Session of every prompt** field: e.g. a per-prompt session with a profile makes every Proceed prompt start fresh. A profile this window does not have is refused on save, and the post-gate todos with an optional quest-todo id prefix, and on a gate **If the gate fails** — run it again, or back to one of the phase's steps (`onFail`). A phase, a step and a post-gate step (not a gate) have **optional** and a **runs** choice: *always runs*, *runs when a variable…* (a variable, then *is*, *is not*, *is one of* — comma-separated —, *is set* or *is not set*) or *runs when the agent judges…* (a text); see *Optional and conditional phases and steps* below. Problems are listed as you type; **Save** (Ctrl/Cmd+S) refuses an invalid definition. The descriptions are edited only here.
- **PROCESS view** (@TOM sidebar, first, above QUEST NOTES) — where the active quest is: process, phase, step and sub-step as dropdowns, each iteration with **−** / **+**, the role the step names, and the post-gate todos when in that step. **?** shows a description; the pencil opens the editor. Normally the agent keeps this current; you can set any of it by hand. **+** starts the next iteration (a new phase iteration starts again at its first step, a new step iteration at its first sub-step); **−** only corrects the number. A gate always has **+**: a failed gate is run again.
- **Action bar** (top of the PROCESS view) — the moves the process allows from the current position, as icon buttons (the tooltip says where each leads). The position shown is **what runs next**: nothing runs until you press **Proceed**.
  - **Proceed** (▶) — runs the current phase, step or sub-step: its prompt goes into the prompt queue, followed by a **process-move marker** (`⏭ move the process to …`). Everything the step's prompt queues in turn — todo walks, closing items — goes in before the marker. When the queue reaches the marker with all of them done, the state moves on to the next position, which runs only when you press Proceed again. Until then the view shows **⏳ running — N items left** and the next position, and Proceed is disabled; the queue editor shows each item's position (`[⚙ …]`) and the marker (`[⏭ process move]`). If an item of the step fails, the marker is held and the view shows **failed — see the queue**; Proceed then offers **Repeat the step** (queue it again) or **Move on** (as if it had finished). Skip, Back and setting the state by hand remove the marker; the step's items stay in the queue. After a **decision point** — every gate, the end of every phase, every repeatable sub-step and the end of every repeatable step (e.g. step 03 of the tom_specs process, after its verdict review) — it moves to the **decision** after it instead;
  - **Decide…** (a fork icon, framed) — Proceed at a decision. The view shows a *Decision — how does the process go on?* box listing the options; the button opens a dialog with them: **Go on to …** (the next position), **Repeat …** for every repeatable level that ends there (sub-step, step, phase — below its maximum; the iteration counts up and the first step / sub-step inside it is next), and after a gate **Gate passed — go on to …** / **Gate failed — run the gate again** or **— back to …** (the step the gate names in `onFail`, set in the process editor). A step entered again within the same round of its phase continues at its next iteration — the `onFail` step after a failed gate, and the steps after it as they come round again — so session names and todo prefixes that carry the iteration do not repeat an earlier round's; Back returns to the iteration a step was at. At the end of the process the forward option is **Finish the process** — the state file then records `completed: true` and the view says *The process is finished*; **Reopen** takes it back. Nothing is queued: the choice only moves the state. Beside the options the dialog offers **Grill me** (the agent asks you narrowing questions until it is clear which choice fits) and **Explain a decision** (the agent explains each choice); both run their Assist prompt in the ANTHROPIC/LLM panel, in a temporary session based on the process's session, and write their advice to a note in the quest's process folder (`_ai/quests/<quest>/process/decision-<time>-grill-me|explain.md`), shown in the MD Browser with the decision's own choices (**Go on to …**, **Repeat …**, **Gate passed** / **Gate failed** …) — a click takes that choice — and **Back to the decision**, which opens the decision again beside the note. A short answer may come through the question panel instead; when the agent's turn ends without the button having been used, the decision opens again by itself (unless you decided meanwhile). The decision stays yours. The decisions are not written in the definition: the extension puts one after every decision point;
  - **Continue in …** (a decision option) — a **follow-up process** the process, the phase or the step names (`followUps:`, edited in the process editor under *Follow-up processes*): instead of going on in this process, the position switches to the named process at its phase and step (the first ones by default), in the same run, the run's chat variables kept. A phase offers its follow-ups at the decision after its gate (or post-gate step), a step at its end (a step with follow-ups ends at a decision), the process at the end of its last phase. The switch records where it came from: the variables the follow-up names to carry (`carry`) with their values, and its **call context** (`context`: texts such as file names or comments, resolved when the switch is made), which the follow-up's prompts read as `${origin.<name>}`; `${process-origin}` is `<process>/<phase>`. The PROCESS view shows the chain (*Continued from …*), the quest's decisions journal records each switch, and the agent's process context says where it came from. Only the quest's own process (not a subprocess or branch) offers follow-ups; `tomAi_validateProcess` and the editor check that the target exists.
  - **Skip** — to the next position without running this one; **Back** — to the previous position, a correction (iterations are kept).
  - **Leave out** (step-out icon, labelled *phase* or *step*) — at the start of an optional or conditional phase, and in an optional or conditional step: past the whole phase or step, without running it. Unlike Skip it is recorded, with its reason, in the process state (see below).
  - **Start Subprocess or Branch…** (step-into icon in the view's title bar, `@T: Start Subprocess or Branch…`) — the processes the running step lists in its definition: `subprocesses:` (a level that hands a result back) and `branches:` (a level that hands nothing back); nothing else starts from a step. You pick one and what the step does when it ends — **Go on past the step**, **Run the step again**, or **Ask me at the end** (then the decision *… finished — go on to …* / *Run the step … again*). The process starts at its first position as a new level of the quest's process stack: the step below waits, only the new level moves, and its first Proceed goes in the queue behind the step below's items that are still there. Any depth, and a process may start itself again; a start beyond the depth set on the Status Page (**Process nesting**, default 5) asks first. When the level finishes its process, it is removed and the step below goes on. A process can declare **inputs** and **outputs** (name, kind — document, list of documents, folder — description, required), edited in the process editor: the step's list entry fills the inputs (`inputs:` in the definition, texts with placeholders resolved when the level starts, e.g. `docs/${step}.md`), and the level's prompts see them as `${input.<name>}`; a subprocess's agent sets the outputs (`tomAi_setProcessState {outputs}`, else an output's default value) before it finishes, and they come back to the step below as `${sub.<process>.<name>}`. A branch and an aborted level hand nothing back.
  - **The levels in the view** — while a subprocess or branch runs, every level below it is a collapsed section (its kind — the quest's process, a subprocess, a branch — its process and where it waits, the follow-up it gets, its inputs and the outputs handed back to it); the running level is open, with its kind, **Abort**, its inputs and the outputs set so far. The quest's own process is chosen only in the bottom section's **Process** dropdown — any process; switching while levels run asks first, since it leaves every level — and the running level shows its process without a dropdown: what starts from a step is only what the step lists.
  - **The agent's suggestions** — at the end of a step the agent may suggest processes the step lists (`tomAi_suggestSubprocess`, each with its reason and the follow-up it recommends). The view lists them under the running step (*Suggested: …*, **Review…** greyed while the step still runs, **Dismiss**); once the step's queue items are done the step's move waits and the process branching editor opens by itself, the suggested processes first with the agent's reason and recommendation. Start one, or Dismiss — the suggestions go and the process moves on as the step's run would have. The agent never starts or aborts a level; it sees the running level, a *Parent processes* list above it, and reads the stack with `tomAi_getProcessStack`, `tomAi_getProcessState {level}` and `tomAi_getSubprocessRuns`. A subprocess or branch that names no session runs in the session of the step that started it.
  - **Start a subprocess or branch…** in the *Your turn* box of a user-action step that lists processes opens the **process branching editor**: one card per listed process (both lists) — subprocess or branch, its summary and the entry's description, where it starts, the inputs the step fills — with a *When it ends* choice and **Start**; **Dismiss** closes the page, and it closes by itself once a level started or the position moved on. A process the agent suggested comes first, with its reason and its recommended follow-up selected.
  - **The process editor** edits, per step and sub-step, the **Subprocesses** and **Branches** lists — each entry a process (picked from the defined ones), an optional description, and a field for each input the process declares — and, at the top, the process's own **Inputs** and **Outputs**.
  - **Abort Subprocess or Branch** (step-out icon) — asks first, then removes the running level (where it stood goes to the quest's decisions journal) and the step below goes on with its follow-up.
  - **Confirm done** (a person icon, framed) — Proceed at a **user action**: a step or sub-step the process marks as yours (`userAction: true`), such as reviewing a document or answering its questions. The view shows it in a highlighted *Your turn — user action* box with what is to be done (its description), and the steps and sub-steps that are user actions carry 👤 in the dropdowns. A user action runs no prompt: the button opens no action page but a confirmation saying that this is a user action, what is to be done, and that you hereby confirm you have done it; **I confirm I have done it** moves the process on (after a decision point, to its decision).
  - **Documents** — a step or sub-step that names the documents it puts in front of you (`documents:` in the definition, a review step's) shows a link to each under its description, in the *Your turn* box at a user action: a Markdown document opens in the MD Browser (a panel already on it is brought to the front), a process definition in the process editor, any other file in its default editor. A link whose path is not known yet (a chat variable it uses is not set) or whose file does not exist yet is greyed out and says why. The process editor edits them per step and sub-step (**Documents**: a path with placeholders — `${<chat variable>}`, `${input.<name>}`, `${output.<name>}`, `${dirname:<variable>}` — and a label).
  - **Finish review round** — the button a review's results carry in the MD Browser when an agent step's closing item shows them (the tom_specs process does, `${finish-review-round}`). It is Confirm done for that review, made from the document: the click closes that panel, confirms the review, moves the process on and queues the next step's prompt; when the next position is a decision, the decision dialog opens instead. What the agent shows depends on what is under review: with one document, its current version is brought to the front and carries the button; with several, the agent writes a review document `review_<phase>_<step>_repetition_<n>_<timestamp>.md` in the round folder (`${reviewFile}` in the Assist prompt), which links each document with what changed and what to look at, opens the documents and puts the button on the review document. Panels still showing older copies are closed first.

  Every button except Proceed only moves the state, at once. Proceed opens the **action page**: what runs, where the state goes afterwards (or that it stays for your decision), the **session** the prompt is queued in (the one the process names for this position, else the queue default; **Change…** opens the session picker for this prompt only), the `prompt` fields of what runs here (at a phase's first step the phase's too, at a step's first sub-step the step's too), a field for **custom instructions** and a live preview of the prompt. A session the process names that does not exist yet is created from the definition (its base too) when you confirm. **Add to queue** (Ctrl/Cmd+Enter) adds the prompt and its process-move marker to the prompt queue, which sends the prompt; the state moves when the queue reaches the marker (a position that queues no prompt, such as a user action, moves at once); **Cancel** changes nothing. The queued prompt — and every prompt it queues in turn, such as the todo walks of a planning step — runs as the position it belongs to: its role and the *Current process* section of its system prompt are those of that position.
- **Optional and conditional phases and steps** — a phase or step (not a gate) may be `optional: true` and may carry a `when:` condition, in one of two notations; the key says who decides:
  - `when: {var: spec-mode, equals: change}` (or `notEquals`, `in: [a, b]`, `set: true | false`) — **the extension decides**, from the chat variables (a custom one by its name or as `custom.<name>`, the built-ins, and a subprocess's `input.<name>`). A move forward — Proceed, Skip, Go on, Gate passed, Leave out, a repeated phase, the start of a process or subprocess — passes every phase and step it enters whose test fails, and records it. A variable that is not set decides nothing (except `set`): the phase or step is entered, and the agent judges it.
  - `when: {judge: the change touches the data model}` — **the agent decides** when Proceed runs the step (for a phase, its first step): the *Current process* section gives it the condition; when it does not hold the agent does none of the work and calls `tomAi_setProcessState {leaveOut: "<why>"}`, and when the step's queue run ends the process leaves the phase or step out instead of moving on through it.
  - `optional: true` — you decide: **Leave out** in the action bar.

  Alternatives are two steps (or phases) with conditions that exclude each other: e.g. a first step where you set `spec-mode` to `initial` or `change`, then one step `when: {var: spec-mode, equals: initial}` and one `when: {var: spec-mode, equals: change}` — Proceed from the first goes to the one chosen, and from it past the other. The PROCESS view shows a phase's and the step's note (*optional*, *runs only when …* and whether it holds now), marks optional and conditional entries ⁇ and left-out steps *— left out* in the dropdowns, and lists under **Left out** what was left out — where, why and by whom (its condition, you, the agent), newest first — so which alternative ran is the one not listed. The record (`skipped` in the state file, at most 50) stays with the run until another process is chosen.
- **Process template editor** (the snippet button at the right of the action bar, the *Edit template* button on the action page, or `@T: Open Process Template Editor`) — the Proceed prompt template, the same for every process, stored in the extension config under `processActionTemplates.proceed`. The list on the right inserts a placeholder at the cursor: the action variables (`${custom-instructions}`, `${action-prompt}` — the `prompt` fields of what runs here, `${action-note}` — a note for a repeated run, `${action-position}`, `${action-after}` — what the view does after queuing, `${action-label}`, `${action-target}`), the process variables of the position being run, and the chat variables. The preview resolves the edited text at the current position. **Default** puts the built-in template back; an empty template queues nothing.
- **State per quest** — the position is stored in `_ai/quests/<quest>/process-state.<quest>.yaml`, so it is the same in every window and on every machine, and switching the quest switches it. Moving to a step that names a role also sets the `role` chat variable; choosing *— none —* as the process clears the process variables and sets `role` back to `default`. The Chat Variables view lists the process variables read-only under *Process*; a long description is shortened, and hovering it opens a scrollable popup with the whole text.
- **Runs** — a quest may hold several process positions, *runs* (another change worked on in parallel, or another process in the same window), each in `process-state.<quest>.<run>.yaml`; the quest's own file is the run `default`, always there. A window works on one run at a time; the PROCESS view, the process chat variables and the agents' process tools follow it. Each run has its own conversations: a session the process names (`work`) is the run's own in a run other than `default` — `work@chg1` — and so are the items its Proceed queues; the SESSIONS view lists a run's sessions under the run (`@chg1`), and deleting runs asks whether their sessions go too. Each run has its own custom chat variables — its run parameters, such as `design` or `change`: selecting a run switches what `${custom.design}` reads, a Proceed of a run reads its run's even while the window works on another, and a deleted run's variables go with it. The **Runs** list at the top of the PROCESS view shows every run of the quest, the last changed first (agents' moves and other windows' included), with its process, position and change time, the window's run marked: a click works on another run, **+** asks for a name (letters, digits, `_`, `-`) and a process (or none yet) and creates the run as the window's run, the trash asks which runs to delete (`default` is never offered) and confirms. Agents create, list, select and delete runs with `tomAi_createProcessRun`, `tomAi_listProcessRuns`, `tomAi_selectProcessRun` and `tomAi_deleteProcessRuns`; a Proceed moves the run it was started in, also after the window switched to another.
- **Processes written by an agent** — an agent can create a process: `tomAi_validateProcess` checks its draft (the schema, the editor's rules, the roles), `tomAi_writeProcess` writes `<id>.process.yaml` and `<id>.md` when the draft is valid (an existing process only with `replace`, after your approval) and opens it in the process editor for you to look at.
- **Moves offered in a question** — an agent asking you something can put buttons into the question (`choices` on `tomAi_askUser` and on the Agent SDK's question tool): a plain answer, or a move of the quest's process to a position of the current process. Clicking a move button makes the move at once, exactly as the PROCESS view would, and tells the agent where the process is now; the decision is your click, not the agent's reading of an answer. Branches and subprocesses can be offered only when the current step lists them; clicking one asks what the step does when it ends and then starts it, as the PROCESS view does (the depth confirmation, the inputs its entry fills) — the agent is told what started, or why nothing did (the step moved on since, you cancelled).
- **In the system prompt** — every Anthropic profile includes a *Current process* section while a process is set: the positions, the steps of the phase, the post-gate todos and the descriptions. The values are also chat variables (`process`, `phase`, `step`, `substep`, `phase-iteration`, `step-iteration`, `substep-iteration`, `process-description`, `phase-description`, `step-description`, `substep-description`, `phase-prompt`, `step-prompt`, `substep-prompt`, `session`) and placeholders (`${process-context}` for the whole block). The agent moves the state with `tomAi_setProcessState`.

### @TOM VSC: resource-hungry extensions

The **@TOM VSC** sidebar's RESOURCES view lists the helper processes of this window's extension host (language servers, analysers, git, …) grouped by the extension that started them, with memory, CPU and age; a group opens to its processes. **Pause** stops a process or all of an extension's (SIGSTOP: no CPU, its idle memory is left to the system, the extension does not notice) — its editor features wait until you **Resume** it; **Kill** (asked first) ends a hung one, which its extension may start again. Windows offers Kill only. **Profiles**: switch to a lean VS Code profile (its own set of enabled extensions — the supported way to turn extensions off), create one from the current profile, or open the profiles editor. **Settings (this workspace)**: toggles for Dart analysis, Git's repository scan and the watcher / search excludes of `ztmp/`, `build/`, `.dart_tool/`, `node_modules/`. The view refreshes every 5 s while visible; the status-bar item with the window's total (refreshed every 30 s) opens it.

### Window Status Panel

The Window Status panel is an Explorer sidebar view showing the state of all open @Tom windows:

- **Multi-window overview**: One card per open window displaying workspace name and active quest
- **Subsystem status**: Per-subsystem indicators (Queue, Anthropic, Copilot) with color coding:
  - **Orange**: Prompt sent, awaiting answer
  - **Green**: Answer received
- **Relative timestamps**: Shows how long ago each state change occurred
- **Servers**: behind the indicators, the servers the window runs with their ports, e.g. `CLI :19901 · MCP :19921`
- **Heartbeat**: every window rewrites its heartbeat (time, process id, servers) every 30 seconds; a window whose heartbeat is older than 90 seconds is shown dimmed and marked *gone*. A window of an older build writes no heartbeat and is not judged.
- **What each window is doing**: with every heartbeat, and about a second after it changes, a window also writes its host, role, process position, the ANTHROPIC/LLM panel's profile and session, and a queue summary (auto-send, paused, items per status, the defaults, the item being sent). An agent or MCP client reads all of it, with each quest's sessions and the Anthropic profiles, through `tomAi_getQuestWindowStatus` — the lookup before `tomAi_sendItemToQuest`.
- **Reload needed**: a window that runs an older build of the extension than the one installed is marked *reload needed*; the tooltip names both builds. Reload that window to run the installed build.
- **Auto-refresh**: File watcher on `_ai/local/*.window-state.json` with periodic refresh every 3 seconds
- **Cleanup**: Delete button to remove stale window entries

#### Which build a window runs

A window loads the extension once, when it starts; a build installed later reaches it only after a reload. Every compile writes `out/build-info.json` (commit, uncommitted changes, build time), and each window compares the build it runs with the installed one every 30 seconds and whenever it gains focus. When a newer build is installed, the status bar shows **Reload: newer Tom AI build** (click it to reload the window), the Status Page shows an **Extension build** section with a **Reload window** button, and the WINDOW STATUS view marks the window. Nothing reloads by itself: a reload ends a queue send that is running. Agents read the same through `tomAi_getWorkspaceInfo` (`build`) and `tomAi_getQuestWindowStatus` (`build` per window).

The @TOM sidebar holds the quest's views (Process, Quest Notes, Quest Todos, Sessions, Session Todos); @TOM WS the workspace's (VS Code Notes, Workspace Notes, Workspace Todos, TODO Log, Window Status).

#### Notes views

VS CODE NOTES (`~/.tom/notes/global_notes.md`), WORKSPACE NOTES (a notes file you pick or create) and QUEST NOTES (`quest-notes.<quest>.md`) each edit one Markdown file and save as you type. Their toolbar: 👁️ **Preview Markdown**, 📄 **Open in Editor**, 📖 **Open in MD Browser** (the file in the Markdown Browser) and ↗️ **Open in MD Viewer** (the file in the external Markdown application the workspace config maps to `.md` files in `externalApplications.mappings`; without such a mapping it warns that none is configured); VS CODE NOTES also has 📋 **Copy** and 🗑️ **Clear**, WORKSPACE NOTES 📁 **Change file**. To send notes to a model, use the @CHAT panels.

### Issues Panel

The @WS **Issues** section lists the issues of the repositories it finds in the workspace's git remotes, plus the ones the panel configuration adds (`issuePanels`; **Tests** works the same for test reports). The repository dropdown offers one repository, **All Repos**, or **My Repos (<account>)**: the repositories of the GitHub account VS Code is signed in with, without forks and without clones of other people's repositories. The choice appears once the account's repositories are known (it asks GitHub whether each is a fork) and only when an account is signed in. New issues need one repository chosen.

The table's **Repo** column, right of the comment count, names the repository each issue is from as `<repo-name>/<owner>` (`tom_vscode/al-the-bear`), so the name comes first; it sorts like the other columns.

### Quest TODO Panel

The Quest TODO panel (the `@WS` Quest TODO section, and the editor that opens for any `*.todo.yaml` file) manages quest todos with status tracking.

#### Prefix groups

The list is grouped by **todo-id prefix** — the characters before the id's number, so `qr1-…` and `qr3-…` share the group `qr`. A group's name may start with a number, which then belongs to the prefix and orders the groups: `001_cleanup1` and `001_cleanup2` are todos 1 and 2 of the group `001_cleanup`. Ids with no number after their prefix (`cleanup`, `001_cleanup`) or made of digits only collect in a group called **Unprefixed**, which always sits last. The groups are in natural order of their prefix (`001_cleanup` before `002_…` before `qr`), whatever the list's sort, so every group is always in the same place; the filter decides which todos show. Inside a group the todos follow the **Sort** picker: by **id** in the order of their number (`qr2` before `qr10`) when no field is chosen, or by the fields you pick (id, quest, status, priority, title, dates), ties by id. The picker's **Group by prefix** checkbox (on by default) turns the grouping off: the list is then one plain list in that order. Reset turns grouping back on. Each group is headed by a thin separator line showing the prefix, the number of todos in brackets, and a triangle that expands or collapses the group.

The list opens **fully collapsed** — after a window reload or a VS Code restart you see only the separator lines. Expand the groups you need; the **Expand all** toolbar button opens every group and **Collapse all** closes them again. Expanding a group sticks for the rest of the session, including across todo refreshes.

#### Your own todos (👤)

A todo marked `user_action: true` is yours to do — a review, an answer, a look at a screen. Its title is **purple** in every todo list and it carries 👤. (A row's left border shows its status, not this mark: **blue** for in progress, **yellow** for blocked.) The **👤 toolbar button** shows only those todos and opens every prefix group, so none hides in a collapsed one; press it again to see all todos. The filter (funnel button) has a **User action** section for the same choice: your own todos, the others, or (nothing ticked) both. Set the mark with the *Your to do* checkbox when you create the todo (the new-todo form) or later in its detail form, where you can also clear it.

#### Queued todos (⏵#N)

A todo the prompt queue will run carries **⏵#N**: N is the number the Prompt Queue editor shows the queue item with (#1 at the top). Hover over it to see every queue item that will run the todo — `Queued: #2` or `Queued: #2 (first), #5`. A prefix group's header carries the mark too when any of its todos is queued (the tooltip says how many), so a collapsed group still shows it. The marks follow the queue: when an item is added, finished or removed, the list updates.

A queue item knows its todos by its **todo id pattern**: the todo's id when you add one todo to the queue (*Add to queue*, the stack's *Queue each*, *Guide me* into the queue), `<prefix>*` for a todo-group walk, several separated by commas. The queue editor shows it on the item (*todos …*). An item marks its todos until it has finished; a walk marks its open todos (not completed or cancelled), only in the quest whose queue it is.

Work that has to wait for you — a check that can only run after you reload the window, say — is written as a 👤 todo for your part plus the work itself, `status: blocked` with `blocked_by` naming the 👤 todo. A `prefix*` queue walk passes both; once you complete the 👤 todo, the walk releases the blocked one and sends it.

#### Todos that block others (⛓️)

A todo's **Blocked By** names the todos it waits for. The other end is kept for you: each todo carries a **`blocking`** list — the todos whose Blocked By names it (by id in the same quest, as `quest/id` from another quest) — which every save keeps in step, whether it comes from the todo panel, a todo tool or a script. A todo that blocks at least one open todo shows **⛓️** next to its status icon; hover it to see which. Its detail form shows a read-only **Blocking** row whose entries open the blocked todo. To change the relation, edit Blocked By on the blocked todo; Blocking follows. The filter has a **Blocking** section: the todos that block open todos, the others, or (nothing ticked) both.

#### Filtering by date

The filter's **Date Ranges** rows — **Created**, **Updated** and **Completed** — each take a from and a to date, both inclusive, either one optional. A Completed range shows only todos whose `completed_date` lies inside it, so a todo that was never completed is hidden while a Completed bound is set.

#### Moving todos between files

Four top-bar buttons move todos between files instead of destroying them:

- **Archive completed todo** — moves the selected *completed* todo to the file's `-archived` sibling (e.g. `todos.myquest.todo.yaml` → `todos-archived.myquest.todo.yaml`), stamping it with the archive date. Enabled only for completed todos.
- **Archive all completed** — bulk-archives every completed todo in the current file.
- **Delete todo (to file)** — moves the selected *non-completed* todo to the `-deleted` sibling, stamping the deletion date. Completed todos can only be archived, not deleted.
- **Delete all cancelled** — bulk-moves every cancelled todo to the `-deleted` sibling.

Archived/deleted sibling files are **terminal**: they can be viewed but never archived or deleted *from*, and the buttons hide when browsing them. A todo moved to the `-deleted` file remains recoverable (unlike the per-row hard-delete). There is no separate backup file mechanism anymore.

Archiving a **completed** todo also **copies** any decisions it carried into the quest's `decisions.<quest>.md` journal (@WS → Documentation → Decisions), stamped with the todo id and the archive timestamp. It is a copy, not a move — the archived todo keeps its decisions. Two cases are deliberately left out: deleting never journals (a deleted todo's decisions were never acted on), and neither does archiving a todo that has not reached `completed` — the Archive button works on any status, and a todo archived half-done was abandoned rather than concluded.

A further set of top-bar buttons changes a todo **without** moving it to a terminal file:

- **Rename a todo** — the ✎ button beside the **ID** field in a todo's detail opens VS Code's input box with the id; enter the new one. It refuses, in the box as you type, an empty id, a space, a path character, an id the todo schema's id pattern refuses (the message names the rule, read from `_ai/schemas/yaml/todo.schema.json`) and an id the quest already has (archived and deleted todos count). The todo keeps every field and its place, its notes say which id it had, and every `blocked_by` / `dependencies` entry naming it follows — in the quest's todo files, and as `<quest>/<id>` in other quests'; the old id stays as a cancelled stub naming the new one in the `-deleted` file beside it (the `_ai` commit guard refuses an id that vanishes) — when it was committed; an id that never was needs none and gets none; a prompt already in the queue keeps the old id in its text. Quest todos only (not session or workspace todos). Moving todos into another group renames them the same way.
- **Mark selected todo completed** / **Mark selected todo cancelled** / **Mark selected todo not-started** — set the selected todo's status in place (the completed action also stamps the completion date). With a non-empty todo stack they act on the whole stack after a single confirmation.
- **Move to another group / quest / workspace / another quest** (the ⬆️ button on a todo's row) — asks where to move it: **Quest todos** (the todo's own quest file, offered when it is not already there), **Move to another group…** (see below), **Workspace todos** (`workspace.todo.yaml`), or **Move to quest…**, which opens a second picker listing every quest and moves the todo into that quest's `todos.<quest>.todo.yaml`. With more than one todo stacked it moves the whole stack; the picker then reads *Move N stacked todos to…* instead of *Move this todo to…*. Works in quest, session and workspace mode. A todo that leaves its quest gets `[moved from quest: <id>]` added to its notes; a todo whose id the target already holds is left where it is and reported.
  - **A whole group** — a group separator (the line naming a prefix, e.g. `annot`) has its own ⬆️ button: it moves every open todo of that group with the same pickers, as if they were stacked. Completed and cancelled todos stay; a group with none open has no button.
  - **Another group** — **Move to another group…** (offered when the todos all belong to one quest) moves them into another id group of that quest: a second picker lists the quest's groups that hold live todos, alphabetically (not the one the todos are all in, nor a group only archived or deleted todos hold), and **Enter a prefix…** to type a group by hand — a new one, or one of those not listed. The todos are added at the **end of the group**: numbered after the group's highest number **below 999** (archived and deleted todos count, so no id is taken twice) and placed after its last such todo, in the file that holds it. A todo numbered **999 or higher** (`<prefix>999`, …) is the group's **finalizer**: the moved todos go before it and it stays last. Each todo keeps the text after its number (`mov1_bb-x` → `fin3_bb-x`), its notes say which id it had, and every `blocked_by` / `dependencies` entry naming it in the quest follows the new id. A group with no free number below 999 is refused, and so are new ids the todo schema's id pattern refuses (also when numbered into another quest). The same finalizer rule holds when todos are numbered into a group of another quest (below).
- **Rename group…** (the ✏️ button on a group separator) — gives the group a new prefix in one step: an input box with the prefix; its line below previews the new ids (`ww3_akfd-x` → `xx3_akfd-x`) and refuses a prefix with a digit after its leading number, a space or a path character, one whose new ids the todo schema's id pattern refuses (the rule named), or one whose ids the quest already has. Every live todo of the group is renamed as by **Rename a todo** (references follow in this quest and others, a stub per committed old id); archived and deleted todos keep the old prefix. The message names the quest documents that still mention the old prefix — they are not rewritten. Agents do the same with `tomAi_renameTodoPrefix` (with `dryRun`). Quest todos only.
- **Queue Group Prompt** (the 🔁 button on a group separator) — queues a walk over the group: a queue item with the repeat count `<prefix>*` (see *Todo iteration* under the Prompt Queue) whose prompt you pick from a list: **Default**, **Default + `<addition>`** for each global addition and each of the quest's additions, and the quest's own prompts. To add text of your own for this walk only, pick a prompt with its ✎ button, or **Default + an addition I type…**: a panel shows the prompt and a multi-line box (Ctrl/Cmd+Enter queues, Escape cancels); what you type follows the prompt after a blank line and is not stored. The last entry opens the group prompt editor. A walk goes over the todos of the window's quest, so the button refuses a list showing another quest. When the group has nothing left to walk over, the item is queued in `ERROR` with the reason and you are told.
- **Group prompt editor** (`@T: Open Group Prompt Editor`, or the picker's last entry) — edits those prompts. **Global**: the **Default** (the built-in one until you save your own; *Use built-in* deletes yours; it asks the agent to do the todo, report it, and wait actively for anything it starts, since nothing can call back once it has answered and the next todo is sent) and **Additions**, appended to the default after a blank line. **Quest** (chosen at the top): an **own default** that replaces the global one for that quest, **Additions**, and **Prompts** sent instead of the default. The files are Markdown: `_ai/group_prompts/default.md` and `additions/<name>.md`; `_ai/quests/<quest>/group_prompts/default.md`, `additions/<name>.md` and `prompts/<name>.md`. A click on a variable inserts it at the cursor — `${repeatTodoId}`, `${repeatTodoTitle}` and `${repeatNumber}` are filled in for the todo each send of the walk works on; the preview shows what the walk sends with the selected entry, unsaved text included. Save writes every changed entry.
  - **Ids in the other quest** — when the todos enter a quest they are not in, a third picker asks how they are named there, once for all of them: number them into one of that quest's groups (those holding live todos, alphabetically, each with its count and the ids the moved todos would get — the group's prefix and consecutive numbers after its highest, each id keeping the text after its own number, e.g. `vscannot3_ajtf-tools` → `annot10_ajtf-tools`), **Enter a prefix…** to number them under a prefix of your own (a new group starts at 1; the input box previews the new ids and refuses a prefix with a digit, a space or a path character), or **Keep the ids as they are**. A renamed todo's notes say which id it had, and the `blocked_by` / `dependencies` among the moved todos follow the new ids.
- **Move selected to other todo file** — opens a quick pick of the quest's other `*.todo.yaml` files (including the `-archived` and `-deleted` siblings), plus a *New todo file…* option, and moves the selected todo (or the whole stack) into the chosen file. Available only in concrete quest mode. Clicking a todo in any of the quest's todo files loads its details, and the details pane refreshes automatically after a status change.

#### Decisions and the `decision-needed` status

A todo can carry a list of **decisions** — open questions that must be answered before the work can start. Each entry has three fields: a one-line **summary**, the **decision needed** (what exactly has to be decided, and the options), and the **decision** itself once made. In the details pane they render as a collapsible list: collapsed you see just the summary line, expanded all three fields.

A todo with unanswered decisions belongs in status **`decision-needed`** (❓), which sorts directly after `blocked` and ahead of `not-started`. It is a normal dropdown choice and the four quest-todo tools round-trip it, so the model can create a todo already in that state — the workspace rule is that a todo whose scope contains a user decision is created as `decision-needed` with the decisions filled in, rather than as `not-started`. A `prefix*` queue walk never runs it and holds when it is the next todo of the walk; the todos before it run first; see [Todo iteration](#todo-iteration-prefix). The todo views show it with a yellow **decision-needed** chip (its tooltip lists the open decisions, also beside the status in the detail), and a group header carries a yellow **❓** with the count of its todos with open decisions (the tooltip names them), so you see there is something to answer without a walk having to stop.

**Repeated todos** (🔁 in the list, the rule in its tooltip): a todo with a **Repeat** rule in its detail — by hand, N days / weeks / months after it is done, daily, weekly on chosen weekdays, monthly or yearly on a day, the last day, the nth weekday (*the second Tuesday*, *the last Friday*) or the first / last working day, at a time, until a date or for a number of times — is not completed when it is done: it goes to **waiting-for-repeat** (⏳), and its next repetition is computed (a calendar rule from its schedule, *after N …* from when it was done). The **Repeated todos** entry in the Timed Requests list (add it with its toolbar button; start / stop, interval, Check now) moves every due one back to **not-started**, also once when a window starts. ⏭️ **Repeat now** brings one back at once; a todo repeated by hand waits for that, and a `prefix*` queue walk runs it once per walk. Done for the last time (its count or end date reached), it is completed. The detail shows how often it was done and when it comes back.

**Session todos** (the Session Todos view and the panel's session mode) belong to **one session** of the quest: the steps an agent notes for itself while it carries out a quest todo, in the flow of that session. Each session keeps them in its own file, `_ai/quests/<quest>/history/sessions/<session>/session-todos.todo.yaml` (machine-local, not versioned), and they are **deleted with the session**. An agent's session todo goes to the session its prompt runs in. The view's **session switch** has a button for each of the most recent sessions that have todos (a dropdown with all of them when there are more), each with its open-todo count; what you add there goes to the session shown. The SESSIONS view shows each session's count (☑ n), and deleting a session with open todos says how many go with it. The former per-machine file is taken over once when a window starts: its open todos become the `default` session's.

#### Todo stack (batch send)

Each list row shows a small clickable circle **under its status icon**. Clicking it adds the todo to the **todo stack**; the circle then shows the todo's 1-based stack position. **Shift-click** (with at least one todo already stacked) adds every todo between the last picked one and the clicked one, in the current list order. Clicking a stacked circle again removes that todo and renumbers the rest. The **Clear todo stack** toolbar button empties the stack.

With a non-empty stack, the send buttons switch to batch mode:

- **Save to Queue** — adds **one prompt per stacked todo** to the prompt queue, in stack order, each embedded via the selected template (e.g. the Execute TODO template).
- **Send** (Copilot or Anthropic, following the queue's transport) — combines **all stacked todos into a single prompt**: one block per todo, get one numbered `REQUIRED: Add responseValue #TODO_<n>=…` line each, and the combined text is inserted into the selected template. With no template selected, the blocks (plus the response-value lines) are sent as-is.

Every send of a todo from the panel — Send, Save to Queue, single or stacked — carries the todo's whole record: its reference, then *Here is the complete YAML of the todo:* and the todo as stored (every field, decisions with their answers, notes, references; not `blocking`), the same block a todo walk appends. Execute TODO, Guide me through a user action and Explain TODO work from it, and so does any template of your own.

## 3) Sending prompts

### Anthropic

The ANTHROPIC/LLM subpanel in `@CHAT` is the primary AI chat surface. Every turn picks a **profile** that bundles model + transport + history mode + user-message template.

The profiles are the workspace config's `anthropic.profiles` (`.tom/tom_vscode_extension.json`), edited in `@T: Open Prompt Template Editor`. Besides a few task profiles (read-only research, precise code edits, role + quest context) and the Local LLM profiles, the Anthropic models each come in three flavors:

- **Direct** — raw Anthropic SDK. History injected via `trim_and_summary` compaction. Memory placeholders (`${memory}`, `${memory-shared}`, `${memory-quest}`) expanded before send.
- **Agent SDK T&S** — routes through `@anthropic-ai/claude-agent-sdk` but still uses in-extension history compaction. Memory pulled via `tomAi_memory_*` tools on demand.
- **Agent SDK SDK-MM** — Agent SDK with SDK-managed continuity. The session id persists in a `<name>.session.json` in `_ai/quests/<quest>/history/` (gitignored; `chat` for the panel, `default` for the queue, or a named session) so the next turn resumes in place. Works with Claude Code's session selector.

Around the prompt: the profile picker with its edit button, the session button (below), the user-message template picker, Preview, Send and Stop, **Keep**, and the three queue buttons (below).

- **No double sends**: **Send** and the three queue buttons (of the Copilot panel too) are paused for 2 seconds after a click, and a queue add or send whose text, transport, profile and template equal one taken in the last 3 seconds is ignored — the status bar says *Already queued* / *Already sent*. The todo detail's **Send** / **Queue** and **Guide me** buttons have the same guard.
- **Keep** decides, for each prompt slot 1–9 on its own, whether the slot's text stays after **Send** or a queue add (checked, the default) or is cleared. The box shows the active slot's setting; it is saved with the drafts, so it holds over a window reload. A queue add clears the slot only once the queue has taken the prompt.
- **Fresh** (after Keep; off by default, saved with the drafts) sends the prompt in a new one-prompt session based on the panel's session: it starts from that session's conversation and changes nothing in it. The session is deleted, its trail and history included, as soon as the answer is in, so it never shows in the session list and no follow-up prompt can reach it — the next Send with Fresh starts another one. A fresh session is never busy, so the send never waits for its base. The status line names it: *Fresh session (based on chat, discarded)*. The prompt and its answer stay in the prompt queue's CHAT SENT entry. The status bar holds the Chat Variables and Process editors, the prompt queue and queue templates, the Status Page, Recreate history / Recreate memory, Run Quest Refresh, `history.md`, the quest memory and the shared memory in the MD Browser, and a model list (read-only: the models the API returns; the profile's configuration decides the model). The live trail, the session's history, the raw and summary trails, the memory panel and clearing a session's history are in the @CHAT **Logs** section, behind its session switch (see [Logs Panel](#logs-panel)).

#### Named sessions

A conversation lives in a **session**: a `<name>.session.json` file in the quest's `history/` folder (machine-local, gitignored). On the Agent SDK transport with SDK-managed history it holds the SDK conversation the session continues; on the direct API transport the session has a history of its own (below). The panel uses its own session `chat`, the prompt queue `default` — and any number of named sessions can be created and chosen:

- **The session button** (speech-bubble icon, right of the profile) shows the session the panel sends in — its name, what it is based on, its lifetime when it is not one conversation, and its model when it has a profile (e.g. *walk based on prep (per iteration) · claude-opus-5-5*). A click opens VS Code's picker: the quest's sessions with what each one does, **New session…**, and **New session based on…**. The choice is kept per quest; *The panel's own session (chat)* goes back to the default. Picking a session that has a profile selects that profile in the panel; you can still choose another. **Send** runs in the session picked here. **Save to Queue** queues the prompt with the prompt queue's own profile and session (the queue editor's defaults); the button beside it (add + person icon) queues it with **this panel's** profile and session instead, so it continues the panel's conversation as Send would. Both keep the panel's user-message template and repeat count. **Queue next** (add + step-into icon) queues the prompt so it is the **next one sent**, always with the prompt queue's profile and session: it goes in pending directly under the item that is sending (in front of the other pending items), and when that item is repeating (a repeat count above 1 or a `prefix*` walk) it is marked to go **between its iterations** — what Save to Queue, Send next and Send between iterations in the queue editor would do.
- **The user-input panel — one open question per run**: everything a prompt waits for you on — a question (*tomAi_askUser*, the Agent SDK's own question with choices), a tool approval, a plan proposal, a picker that could not be a QuickPick, and the asks waiting in the MD Browser — is in one panel, **Tom AI — Waiting for you**, with **one tab per process run** that has something open (a badge counts them). Sessions of different runs ask at the same time: each run has at most one open question (a second ask of the same run is refused as before), and you answer them in any order. The panel opens when a question, a picker or a plan arrives and nothing is open; while you work in it, another run's question only adds or updates its tab. An approval also shows in the @CHAT panel (the run named), a plan as its overlay there; either answers it. Asks in the MD Browser stay in their own panels (two runs asking about one file get two panels); the panel lists them with **Show it**. Pickers: VS Code shows one QuickPick at a time, so while one run's picker is on screen, another run's is answered in the panel (items, your own words, Dismiss). Plan mode is per run, too. Stopping a turn denies only that turn's approvals. From Telegram, with several questions open, reply `<run>: your answer`. The questions journal names each question's run.
- **Waiting for your reply**: while the prompt of a running queue item waits for you — a question (*tomAi_askUser*, the picker, a question in the MD Browser, the Agent SDK's own question) or a tool approval — its entry in the Prompt Queue editor turns **orange** and carries **[⏳ waiting for your reply]** (or *approval*, *your decision on a plan*, *your answer in the MD Browser*), until you answer — a running chat send too. A click on it opens the user-input panel on the item's run tab, or brings its MD Browser to the front. A *tomAi_askUser* question says since when — **[⏳ waiting for your answer since 20:31 (9 h 25 min)]** — with an **Open question** button: closing the user-input panel leaves everything waiting, and the button, the command **@T: Show Pending Question** or the status-bar item **Waiting for you** (shown while anything waits, with the count per run) opens it again. **Continue** on a running item always asks first: **Answer now** (only while its turn waits for your answer: opens the question, the turn goes on with your answer), **Resend this stage** (ends the turn and sends the same prompt again; the agent is told its turn was interrupted), **Skip to the next todo** (or *stage*) — or Cancel, which does nothing. Resend and Skip close a waiting question unanswered, and so does Stop; the agent is told why. The ↻ button on a running item resends its stage directly (it asks first when a question is waiting).
- **Waiting on something outside the turn**: an agent that has to wait for something only time resolves — pub.dev's 12 new versions of a package in 24 hours, a rate window — calls `tomAi_waitFor`. Its item shows **⏳ Waiting: pub.dev limit: 12 versions in 24 h — until 14:20 (1 h 5 min left)** in the Prompt Queue editor (the time left counts down; the details are in the tooltip), and its run's tab names the wait. Its run sends nothing else meanwhile; other runs do. The wait ends by itself at its time and the agent goes on. **Interrupt the wait and move on** (on the line, or under **Continue**, which also offers **Keep waiting**, Resend and Skip) tells the agent you moved on: it ends its turn with a note of what is still to do, and the item steps back behind the next item of its run (held as staged when nothing follows). When it runs again, its stage is sent again with a note, and the agent goes on from its note. Stop, Resend and Skip end the wait with the turn.
- **Waiting for background work**: a running item whose turn ended while work it started still runs (a background command, a command stream) shows **⏳ Waiting for background work — 2 tasks, 1 h 20 min of 6 h** in the Prompt Queue editor (not in the @CHAT panel). **?** lists the running tasks with their commands and output file (or handle). **Wait without limit** waits until they end, **Keep waiting up to 6 h** starts the limit again from now, **Stop waiting** ends the turn now and the queue goes on; **Continue** offers the same three, plus Resend and Skip. A turn that ended with work still running — the limit reached, or Stop waiting — has a **red** answer chip, and its answer names what was still running.
- **A todo walk checks each todo**: when an iteration's turn ends and its todo is not completed (and is not blocked, waiting for a decision, or waiting for your answer), the queue asks the agent in the same session to finish it — at most twice by default (`walkContinuations` on the item, `walk-continuations` for the queue). The chip then says **1 continuation**, and the answer shows the final turn with the earlier answer folded below. Still unfinished: the item shows **[⚠ needs attention]** with the reason, auto-send goes off, and the walk waits; turn auto-send on to go on with the next todo. In a question panel, an *answer* button selects that answer for its question (click it again to clear it); each such question has a field for your own words, and nothing is sent until **Send answers**, which sends every question's selection and words together. A button that moves the process or starts a branch or subprocess acts on its click. A question panel closes when its question is answered, times out, is cancelled — or when the prompt that asked ends first (stopped, aborted, failed): the question then ends unanswered and the agent is told so. An answer typed into a panel whose question has already closed is not sent; the panel closes and says so.
- **The run select** (*Run: …*, right of the session button; the Copilot subpanel has one beside its template) picks the process run the subpanel works on: `default` first, then the quest's other runs, the one the PROCESS view shows marked *(PROCESS view)*. Picked, **Send** runs in the run's session — the session picked with the session button in that run, `<session>@<run>` (the panel's own `chat` and the queue's `default` are shared and stay as they are) — and while it runs it reads and writes that run's chat variables and sees that run's process position (`${process}`, `${step}`, the *Current process* section); the Copilot subpanel resolves the placeholders of its send the same way. **Save to Queue** (both subpanels) queues the item in that run. The choice is kept per subpanel, window and quest, independent of the PROCESS view's run — a select on another run than the PROCESS view's is framed — and a run deleted elsewhere puts the subpanel back on `default`.
- **Chat sends in the prompt queue**: every send to the ANTHROPIC/LLM chat — the panel's Send, *Send to Anthropic/LLM* from the editor, a todo's Send or Guide me, Telegram — is shown in the prompt queue: **CHAT** while it runs, **CHAT SENT** once it ended. The entry reads like a sent queue item: the header (time, source, profile, session, tokens), the complete prompt, and the answer as soon as it arrived — its first 600 characters with the expand / collapse toggle that shows the whole answer in place, and the two buttons that show it as Markdown (over the queue, in the preview editor) — or the error as a warning. The queue never sends, retries or counts these items; *Clear sent* removes the finished ones. A CHAT entry can always be removed: a send still running is stopped with it, one that no longer runs is only removed. A chat send that gets no result within the prompt queue's response timeout (the queue editor's *Timeout*, default 60 minutes) is stopped and its entry ends with that error. Only one chat send runs at a time. Sends from places without a session picker (the editor command, the todo panel, Telegram) always run in the `chat` session.
- **A session Claude Code no longer has** — when a prompt resumes a session whose conversation Claude Code does not have (*No conversation found with session ID …*; it keeps conversations per machine, and the session files travel with `_ai` to the other hosts), the extension forgets the stored id and sends the prompt again in a new session, once and by itself. The live trail says so; the session continues in the new conversation from then on, without the earlier one's context.
- **Two prompts never share a session.** A session is busy while a queue item or another chat send runs in it (in this window or another of the quest). A chat send into a busy session is not started; you choose. When the prompt running there is an Agent SDK prompt, the first choice is **Send now as an update to the running prompt in session X**: your text goes into that conversation as another message while it runs (the SDK's streaming input), so the running prompt takes it into account; the queue lists it as a chat send (source *update*) that ends with the answer to the update. The other choices: **Run next in session X** (queued directly under the running item, between its iterations when it repeats — as **Send between iterations** does), **Run after the current item in session X** (queued after it, once all its iterations are done), or **Send now in session Y** for each session that is free at that moment (not offered while a send of the panel itself runs: one Anthropic chat request runs at a time). The panel's Send button stays enabled while its prompt runs, so a second Send reaches this choice. Dismissing the choice sends nothing and keeps the text. Telegram and scripts, which cannot be asked, are refused with the name of the running item. The other way round, the prompt queue does not start an item while a chat send runs in its session: the item shows **[waiting for session X]** and goes once the chat send has ended.
- **New session…** and **New session based on…** (which first asks for the base) ask for the session's lifetime:
  - **Continue** — one conversation. With a base, its first prompt starts from the base's conversation (an SDK fork); later prompts continue the new session, and the base is never changed.
  - **New for every prompt** — every prompt starts again, from the base's current conversation or fresh without a base, and nothing is saved, so the base can hold preparatory context (read the spec, the guidelines, …) while the prompts in this session never change the context of the ones after them.
  - **New for every queue iteration** — each round of a queued item's repeat count, or each todo of a `<prefix>*` walk, starts again from the base (or fresh); that iteration's pre-prompts, main prompt and follow-ups continue it.
- Then for the **profile** the session runs with: its prompts use it unless the queued item names its own profile; without one they use the queue default. The session list shows each session's model.
- **The SESSIONS view** (@TOM sidebar, above SESSION TODOS) lists the quest's sessions — `default` (the queue's) and `chat` (the panel's) always, then every session file — with what each is based on, its lifetime, profile and model, whether it has a conversation yet and when it was last used. **+** in its title bar creates a session (the picker's new-session steps); per row, **Reset** forgets the conversation — its history and its Agent SDK session — and keeps the base, lifetime, profile, its trails and its quest memory (a based session starts from its base again; `default` and `chat` can be reset too), and **Delete** removes the session with its whole storage after a confirmation naming what goes: `history/sessions/<name>/` (history, prompts/answers trail, live trail, raw trail, tool results) and its quest memory `_ai/memory/<quest>/<name>/` — not while another session is based on it. **Remove unused sessions** (the trash icon in the title bar) offers, in one multi-select, every named session nothing uses any more — no queue item still to run (any status but sent) runs in it or is created from it, it is not the queue's default session, no process definition names it (as session or base, a name with `${…}` placeholders standing for every session it can become; a process run's session `<name>@<run>` counts as named while `<name>` is and its run exists, so a deleted run's sessions are offered), no other session is based on it, and it is not a temporary session; those without a conversation are ticked, the rest are yours to tick. The ticked ones are deleted like Delete does, after one confirmation; when nothing is unused it says so and names what keeps the others.
- **Clear** (the @CHAT Logs section's clear-history action) forgets the selected session's conversation; a session you created keeps its definition (base, lifetime and profile) and starts again from it.
- A queued item can name a session that does not exist yet, as a name or with its base, lifetime and profile: it is created before the item's first prompt is sent. An item whose profile keeps its conversation elsewhere than the session's existing one (an Agent SDK session continued by a direct-API profile, or the reverse) is refused when it is queued.

On the **direct API transport** the extension sends the history itself — the compacted history, the last raw turns and the rounds not yet compacted — so a session's history is files of its own:

- every session keeps its own in `history/sessions/<name>/`, `chat` (the panel) and `default` (the queue) included, so the panel and the queue no longer share a history, and a queued prompt or a process step that names a session reads and writes only that history;
- **Continue** with a base: the session's history is copied from the base's once, on its first prompt, and continues on its own; the base is never changed;
- **New for every prompt**: every prompt reads the base's current history, or none without a base, and nothing is saved or compacted;
- **New for every queue iteration**: the session's folder holds the current iteration's history and is started again from the base's (or empty) when the next iteration begins.

The trails are per session too (§9); **Recreate history from trail** rebuilds each chosen session's history from its own trail.

### Plan mode

An agent can enter **plan mode** (`tomAi_enterPlanMode`) to read and plan before it changes anything. While it is on, the ANTHROPIC/LLM subpanel shows a yellow **Plan mode: read and plan only** badge, and every write tool — the extension's and Claude Code's Bash, Write, Edit, … — is refused on every transport; reading and asking you still work. When the agent has a plan it proposes it: the plan appears in the user-input panel on its run's tab (and in the @CHAT panel) with **Accept and leave plan mode** and **Keep planning** (with an optional note to the agent). Only you end plan mode — by accepting a plan, or with the badge's **Leave plan mode** button. Plan mode is per process run: a turn of one run that enters it does not hold another run's writes, and the badge shows the plan mode of the panel's run.

### Claude Code hooks

The hooks you set up for Claude Code (`~/.claude/settings.json`, the workspace's `.claude/settings.json` and `.claude/settings.local.json`) run on every profile: on direct, Local LLM and VS Code LM the extension runs them itself — PreToolUse, PostToolUse, UserPromptSubmit, Stop and SessionStart, with Claude Code's input and its exit-code and decision rules — and on the Agent SDK they run once, in the SDK. A hook's messages and failures show in the status line and the live trail. Details: [anthropic_handler.md §8](anthropic_handler.md#8-claude-code-hooks-all-transports).

### MCP servers on direct and Local LLM

The MCP servers you set up for Claude Code — in the workspace's `.mcp.json`, or with `claude mcp add` (they land in `~/.claude.json`) — give their tools to direct and Local LLM profiles too, named `mcp__<server>__<tool>`. Project servers from `.mcp.json` run only once approved (as Claude Code asks you to; or list them in `enabledMcpjsonServers` in `.claude/settings.local.json`). Their tools ask for approval like the extension's write tools, unless the server marks them read-only. Details: [llm_tools.md §4.11c](llm_tools.md#411c-tools-of-external-mcp-servers).

### Send to Anthropic/LLM

The editor's text goes to the @CHAT ANTHROPIC/LLM panel's current profile and session, as if it had been typed there — on an Anthropic or a Local LLM configuration. From the command palette, the editor context menu or the `Ctrl+Shift+L` chord menu:

- `@T: Send to Anthropic/LLM` (`l`) — the selection, with the default user-message template;
- `@T: Send to Anthropic/LLM (Default Template)` (`s`) — the selection, or the whole file without one, with the default template;
- `@T: Send to Anthropic/LLM (Pick Template)` (`t`) — the same with a template picked from the one template store.

The answer appears in the panel and in the session's live trail. While a turn is running, a second send is refused with a notice.

### Copilot

Use command palette or editor context menu:

- `@T: Send to Copilot`
- `@T: Send to Copilot (Default Template)`
- `@T: Send to Copilot (Pick Template)`

Each opens Copilot Chat with the text — the selection, or the whole file for the template variants without one — wrapped in the template for the two template variants. They always go to Copilot; the ANTHROPIC/LLM panel has its own commands (above).

The templates are the one template store, the user-message templates (template editor: **Anthropic — User Message**); **Default Template** uses the one marked default. A template (or a process step's prompt) can name the tools its prompts need with a line `<!-- tools: tomAi_specApplyEdits, TomSpecs (edit) -->`: on the direct API they are sent in full next to the core set and the rest is found by tool search, on Local LLM and VS Code LM the core set plus these tools are the whole list ([llm_tools.md §5.0](llm_tools.md#50-tools-a-request-carries)). In `@CHAT`, Copilot supports templates, prompt slots, answer-file notifications, and response-value extraction.

The **Copilot Queue Wrapper** (template editor: **Copilot — Queue Wrapper**, config `copilot.queueWrapper`; a built-in default when not set) goes around every Copilot send that waits for an answer — queue items, the todo panel's buttons, `tomAi_askCopilot` — and makes Copilot write the answer file the queue waits for. The subpanel's own **Send** wraps only when its **Wrap** checkbox is ticked (off by default); Preview shows the prompt as Send would send it.

#### CHAT Action Bar

The Copilot section in `@CHAT` includes an action bar with:

- **R** (Repeat count): Number of times to repeat the prompt (text input, 24px wide). Accepts a plain integer, a chat-variable name (resolved at dispatch), or a `prefix*` pattern (see [Repeat and Affix Support](#repeat-and-affix-support))
- **W** (Answer wait minutes): Minutes to wait before auto-advancing without an answer file. When set to 0, uses classic answer-file detection. When > 0, the queue auto-advances after the specified time (text input, 24px wide)
- **Template picker**: Select a prompt template (the user-message templates)
- **Wrap** (beside Send): send the prompt inside the Copilot Queue Wrapper, so Copilot writes an answer file
- **Queue button**: Add the current prompt to the queue with the configured repeat count and wait time

### Local LLM (Ollama / OpenAI-compatible)

A local model is used through an **Anthropic profile** whose configuration is a Local LLM configuration (`localLlm.configurations`, edited in the Status Page's **LLM Configurations** section). Pick that profile in the ANTHROPIC/LLM subpanel or name it on a queue item: the Anthropic handler's tool loop, approval gate, templates, sessions and trails apply, and each model call goes to the configured Ollama or OpenAI-compatible endpoint. See [llm_configuration.md §5](llm_configuration.md#5-local-llm-configuration-localllm-section).

The tool trail's past-tool-access tools (`tomAi_listPastToolCalls`, `tomAi_searchPastToolResults`, `tomAi_readPastToolResult`) let the model recall prior tool output by replay key (`t1`, `t2`, …) across turns, on every Anthropic profile.

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
- **The user's own todos are passed**: a todo marked `user_action: true` (👤 in the todo panel; the *Your to do* checkbox in the new-todo and detail forms) is work only you can do — a review, an answer, a look at a screen. The walk does not send it: it stays `not-started`, the next todo of the series goes instead, and the Prompt Queue log names the passed ids. When only such todos are left the main stage ends.
- **An open decision holds the walk when it is next**: a `decision-needed` todo is never run. The walk runs the todos before it (lowest number first) and holds when the todo it would take next is the `decision-needed` one: the queue item goes to `DECISION-NEEDED`, auto-send switches off, and the waiting id is logged. A decision at the end of a group therefore stops nothing before it.
- **The held item does not hold the rest of the queue**: restart the queue and the other prompts run — the blocked one is skipped for as long as its decisions are open. Answer them (set the todo back to `not-started`) and it returns to `PENDING` by itself the next time the queue picks an item; there is nothing to click. It is never overridden — an item is released only once the todo it was held at has its decisions answered (a later `decision-needed` todo of the series holds it again when the walk reaches it).
- **The answer stays on the todo**: when the prompt's answer arrives and the todo is completed by then, that answer is written onto the todo (`last_answer`, the last run's only). The todo panel shows it in the completed todo's Dates section: **Answer** with the two markdown preview buttons (below). An agent cannot set the field, and archiving the todo removes it.
- **Markdown preview buttons**: beside **Description**, **Notes** and **Agent answer** in the todo detail sit two small icons. The eye shows the text rendered as Markdown in an overlay over the whole panel, list and detail (close it with ✕, Escape or a click outside); the second opens it in the markdown preview editor in the editor area. Description and Notes are shown as they are in the form, unsaved edits included. The Prompt Queue editor has the same two icons in the **Answer** block of an item (a finished item, or a repeating one after its first round). A repeated item keeps the answer of **every repetition**: chips under its Answer, one per repetition — the todo's id for a todo walk (`<prefix>*`), the repetition's number for a counted repetition — the latest highlighted; a click shows that repetition's answer (its key in the Answer title, and in the two Markdown buttons). A repetition answered again (a resend) replaces its answer. A sent todo walk whose answers were not recorded (it ran before this) gets its chips from the session trails: the latest answer that reported each of its todos.
- **Agent answer**: every saved todo has this row, whatever its status. Its buttons show the newest answer in the quest's session trails that reported the todo (the `TODO=<ref>` response value an agent adds when it worked on a todo, from the chat or the queue); without one, the answer a todo walk stored (`last_answer`); without that, a note that none is recorded yet.
- **Session and run of the panel**: the top bar (beside *Template:*) and every todo detail's **Run** row show the panel's **session button** (speech bubble and the session its sends run in; a click picks another session or creates one, as in the @CHAT panel) and its **Run** select (the quest's runs, `default` first, the PROCESS view's run marked; no run is created here). It is one selection for the bar, the detail and both quest todo views (the @TOM sidebar's QUEST TODOS and @WS › Quest TODO), kept per window and quest over a reload and independent of the @CHAT panel's; until you pick one the session is `chat`. Every todo the panel sends or queues uses it: a Send runs in that session — in a run other than `default` the run's own session, `<session>@<run>` — with the run's chat variables and process position, and a queued item names the session and belongs to the run. A run deleted elsewhere falls back to `default`. The bar's Send follows the transport of that run's queue defaults.
- **Send and Queue**: every saved todo's detail has a **Run** row with the session and run controls and two buttons. **Send** runs the todo now in the panel's session and run (with the @CHAT ANTHROPIC/LLM panel's profile), **Queue** adds it to the prompt queue (staged, like the toolbar's queue button, in the panel's session and run). Both always send on Anthropic, whatever the queue's transport, and pick the template themselves: the Status Page's **Todo buttons** template for user-action todos (default *Guide me through a user action*) for a todo marked 👤, the one for other todos (default *Execute TODO*) for every other todo.
- **Guide me**: beside the **Your to do** (👤) checkbox of a saved todo, two buttons send the todo with the Todo buttons template for user-action todos: the speech-bubble one in the @CHAT ANTHROPIC/LLM panel now, the list one into the prompt queue (on Anthropic, staged). When the speech-bubble one's turn has ended and the todo is not completed, the question panel asks what now: **Mark it completed**, **Mark it in progress** (unless it is), **Queue it** (into the prompt queue, staged, with the template for other todos — default *Execute TODO*) or **Leave it as it is**, selected and sent with **Send answers**; your own words in the field under the question (with a choice or alone) are added to the todo's notes with the date. The same happens after **Send** of a todo marked 👤, which runs the same template.
- **If the send fails**: the todo is handed back to `not-started`, so the retry picks up the same todo rather than skipping it.
- **When nothing is left**: the main stage ends and the item proceeds to its follow-ups.
- **Nothing to walk over from the start**: an item whose walk has nothing to do when it is queued — no todo of the prefix, or only completed, cancelled, in-progress or your own (👤) todos — goes to `ERROR` at once, and the error says why (*Nothing to iterate over: …*, with the count of each status). It does not fall back to a single run. Add or reopen a todo and set the item to staged or pending: the check runs again, and the item goes back when the walk has work. An item queued with pre-prompts is not checked, since a pre-prompt may create the todos; adding a pre-prompt to a held item stages it again.
- **Placeholders**: `${repeatTodoId}` is the picked todo's full id, `${repeatTodoTitle}` its title (its description when it has none), and `${repeatNumber}` its number. All three work in the prompt text and in the repeat prefix/suffix.
- **The todo comes with every prompt**: each prompt the walk sends for a todo — its pre-prompts (with the todo it picks next), the main prompt and its follow-ups (with the todo walked last) — ends with *Here is the complete YAML of the todo:* and the todo as stored (every field, decisions with their answers, notes, references; not `blocking`), headed by its file. Your own walk prompts need no placeholder for it, and a stage running in a fresh session still has the whole todo.
- **In the queue entry header**: the current todo's full id appears as a badge next to the `[MP …]` progress, e.g. `SENDING [MP 7/9] [dsa7-review]`. The rep-number is read-only in this mode, since the walk is driven by todo status rather than by the counter.
- **Caveat**: if a prompt resets its todo back to `not-started`, that todo will be picked up again.

### Answer Detection

The queue uses RequestId-based answer file matching:

- A unique request ID is embedded in each prompt via the answer wrapper template
- The file watcher monitors the answer directory for `*_answer.json` files
- A fallback polling mechanism (every 30 seconds) catches missed file events
- When `answerWaitMinutes` > 0, the queue auto-advances after the specified time without requiring an answer file

### Automation Settings

Every process run has its own queue settings: the ones below, the defaults new items take (transport, profile, session, prompt template), the walk continuations, and the Copilot answer timeout and reminder template. Each run's tab (see *Process runs* below) shows and sets that run's settings. Only the compaction and memory-extraction models are shared by all runs (above the tabs). The settings are kept in `queue-settings.yaml` under `runs:`. The file's top-level keys (one set for the whole queue, also the old shape of the file) are the start values: the settings of a run that has none of its own yet. **Make default** (the pin button in a tab's toolbar, *Make these settings the default for new runs*) writes the tab's settings there: runs without settings of their own and runs created later start from them, runs with their own keep them. The status bar says what changed; the button is disabled while the tab's settings already are the default. The walk continuations are not copied.

| Setting | Default | Description |
| --- | --- | --- |
| Auto-send | Off | Send the run's pending items one after another |
| Auto-start | Off | Turn the run's auto-send on when the window starts |
| Auto-pause | On | Pause the run's auto-send when its items are all done |
| Auto-continue | Off | Resume the run after a reload (see below) |

Without Auto-start a run starts paused at every window start: its auto-send is
off until you turn it on (or Auto-continue does). **Auto-continue** (only when
Auto-start is off) turns the run's auto-send on 30 s after the window starts if
one of its items is interrupted or is pending with repetitions left. A run
created after the window started takes the start values.

Turning **Auto-send** off never interrupts the item that is already running —
it finishes its stages and then its run stops instead of starting the next
one; the other runs go on. This holds for every transport and however the running item finishes
(answer file, answer-wait timeout, manual **Continue**, or a resend).

A few explicit actions deliberately start an item even while its run's
auto-send is off, because that is what they are for: **Send now** on an item,
the per-item **Retry now** on a waiting or retrying item, and **Retry All
Errors** (which turns the auto-send of the runs it retries back on for the
cascade). The background health check also resumes an item whose rate-limit or
retry window has just elapsed. Everything that stops a run by itself — an
error, an interrupt for continuation, a walk that needs attention or waits for
a decision, out of credit, Auto-pause, *pause after this* — stops only the run
the item belongs to.

### Send between iterations

A queue item that repeats its main prompt — a repeat count above 1 or a
`prefix*` todo walk — holds the queue until its loop ends. To send something in
between, put that prompt directly under the running loop item (Send next does
that). On that item, Send next turns into **Send between iterations** (the
step-into icon): click it and the item is marked **[⇄ between iterations]**.
When the loop has finished its current iteration, it steps aside: the marked
item is sent, and the loop then goes on with its next iteration. Click the
icon again to unmark; marking another item moves the mark. If the loop ends
with its current iteration, the marked item simply runs next. With auto-send
off the loop holds as usual and the mark stays. **Queue next** in the
ANTHROPIC/LLM subpanel does all of this in one click for a new prompt.

### Let the next item go first

The other way round: an iteration item (a repeat count above 1 or a `prefix*`
todo walk), pending or sending, has a **Let the next item go first** button
(the step-over icon; also among Continue's choices on a running item). On a
**sending** one the running iteration finishes normally — its answer is kept,
its todo handled as usual, its waits (background work, a question) and the
check of an unfinished todo first — and then, instead of its next iteration,
the item steps back to pending with its walk position kept and moves behind
the next pending item of its run's lane; that item is sent, and when it ends
the walk resumes with its next todo. Until it yields the item shows
**[yields after this iteration]**; click the button again to keep iterating
instead. On a **pending** item the button moves it at once behind the next
pending item of its lane. Without a following pending item in its lane the
button is disabled and its tooltip says why. Agents do the same with
`tomAi_updateQueueItem` and `letNextGoFirst: true` (`false` cancels it).

### Waiting for a session

A pending item whose session a chat send is running in waits: it shows
**[waiting for session X]** and the queue (and **Send now**) starts it only
once that chat send has ended, so two prompts never share a conversation.
From the chat, a send into a session a queue item runs in offers to queue it
next or after the current item, or to send it in a free session (see
*Two prompts never share a session* under the ANTHROPIC/LLM panel).

### Editing a pending item

A pending item has an **edit** button (pencil) in its header. It opens the
prompt in a text box with **Save** and **Cancel**; the item keeps its place in
the queue. While the box is open the queue does not send that item: when its
turn comes (also as the item sent between iterations), the queue waits until
you save or cancel, then sends it. Typing goes on undisturbed while the queue
redraws. Closing the queue editor ends an open edit without saving. A staged
item's prompt is edited in place as before.

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
temporary session deleted when the item and its notification are done; the
SESSIONS view lists it last, tagged *temporary*), and a
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

- **Compaction models** (the row above the toolbar): **Compaction model** and **Memory extraction model**, the same choices and settings as the Status Page's History Compaction section (`compaction.compactionModel`, `compaction.memoryExtractionModel`) — a change in either place shows in the other.
- **Toolbar**: Auto-send, Auto-start, Auto-pause, Auto-continue toggles, Restart Queue, **Stop** (cancel the running prompt and revert it to Staged) and **Interrupt for continuation** (see above)
- **Entry list**: Per-item cards with status color coding, type badges, progress indicators
- **Staged item form**: Template, repeat count, answer wait minutes, repeat prefix/suffix, pre-prompts; the prompt and the repeat prefix/suffix take `Ctrl+Shift+Space` completion — slash commands, skills, files (see [Keyboard productivity](#10-keyboard-productivity))
- **Per-item controls**: Preview, send now, move up/down, delete, toggle reminder, pause after this, interrupt for continuation (on the running item); an interrupted item offers Resend and Move back to Staged
- **Out of budget**: when a prompt stops because the API credit balance is too low, the item shows an *Out of budget* panel — the profile and session that stopped, a profile picker, **Continue on profile** (sends it on the picked profile with a note pointing to the stopped session's live trail — the *Out of budget* Assist prompt, see [Assist prompts](#assist-prompts)) and **Resend** (the last request again, once there is credit). A profile can name the profile to continue on and switch to it by itself (profile editor: *Out of Budget: Continue On*, *Switch Automatically*); the picker then starts on that profile. An agent can do the same (also when you ask it from Telegram): `tomAi_resendQueueItem` with `profileId`.
- **Sessions**: an Anthropic item shows the session it runs in (speech-bubble chip in its header), with a `*` after the name when that session is based on another; its tooltip names the base and the lifetime (new for every prompt or every queue iteration), and a session the item will create when it is sent reads from the item's spec. A click on a staged or pending item opens the session picker (an existing session, a new one, one based on another, or the queue default). The transport gear asks for the session as its last step. The context bar at the top of a run's tab reads *Quest: … | Run: … | Position: … | Role: … | Session: … | Variables: …*, all of that tab's run: **Position** is the run's process position (a click opens its state file, `process-state.<quest>.<run>.yaml`); **Role** is the role chat variable for the window's run, and for another run the role its step names (shown, not picked); **Session** is the run's default session, the one every item of the run that names none runs in (unset: the run's own `default`), shown with its base and lifetime, e.g. *Session: walk based on prep (per iteration)*; **Variables** counts the run's own chat variables (they are listed in its tooltip) and opens the Chat Variables editor for the run. The Chat Variables and Context & Settings buttons open their editors for the tab's run too; each editor names the run in its title (*Chat Variables — run collab*) and in a run line. The Chat Variables editor then shows and edits that run's custom variables and shows its process position; the built-in variables (quest, role, projects, todo) and the Context & Settings editor's values are the window's, shared by every run. Both are underlined links: a click opens a VS Code picker — the roles under `_ai/roles/` (or none), or the session picker. Agents set it with `session` on `tomAi_addQueueItem` / `tomAi_updateQueueItem` and create sessions with `tomAi_createSession` — see [Named sessions](#named-sessions).
- **Process runs, one tab each**: right below the headline and the shared compaction / memory-extraction models, the editor has a tab per process run — the quest's runs and any run that has items, `default` first. Each tab is that run's queue: its items only, its toolbar (Add, auto-send play / pause, Auto-Start, Auto-Pause, Auto-Continue, Restart, Stop, Interrupt, Send All Staged, Retry / Delete Errors, Clear Sent / All, Collapse / Expand — each acting on the run's items) and its defaults row (transport, profile, prompt template, session; the answer timeout and reminder template only while the run's default transport is Copilot). The tab says whether its run sends, waits or is paused and how many open items it has; the window's run is marked and selected first, and the selected tab is kept over a reload. Every item belongs to a run (the chip `run chg1` in its header, beside the todos chip): the run of the Proceed it was queued from, else the tab it was added in; its sessions are that run's (`<session>@<run>`). On a staged or pending item the run chip is a button: it lists the quest's other runs, and the item moves into the one you pick — to the end of that run's queue, its session becoming that run's (`<session>@<run>`), a *between iterations* or *let the next item go first* mark dropped. An item of a Proceed run stays in its run. A chat send shows in the tab of the run it ran in, else the default run's.
- **One lane per run**: each process run has its own lane — one item sends per lane at a time, the lanes send in parallel, and each run's items go in their order (a lane whose next item cannot start waits; its later items do not jump ahead), so a run's process-move marker moves it exactly when its own step is done. Two prompts never share a conversation: an item waits while another sending item runs in its session, and the Copilot transport sends one item at a time. A tab's play / pause is its run's auto-send: a paused run starts nothing, and its sending item stops before its next prompt (SENDING (PAUSED)). Chat sends are outside the lanes. `tomAi_listQueue` reports a run's settings (`run`, default the window's) and every run's auto-send (`runs`); the Status Page's *Queue & Timer* switches and Telegram's `queue_pause`, `halt` and `continue` act on the window's run unless a run is named.

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
- `@T: Start Tom Process Monitor`

They need DartScript, the `tom_bs` bridge binary, for the platform the window runs on. A VSIX carries it only for the platform it was built on, and only when that build had a Dart SDK. Without it the bridge is not started (one line in the bridge log, no message), and every DartScript command — these, `@T: Execute File`, `@T: Execute as Script`, `@T: Toggle Bridge Debug Logging`, `@T: Print Configuration`, `@T: Run Tests`, Telegram `/bridge restart`, `/bridge mode` and `/cli-integration start` — stops with `"<feature> needs DartScript, which is not available on <platform>: the tom_bs binary is missing."` (its name and platform filled in) and a **What does this mean?** button that opens the Missing Dart Binaries page (§7). A `tom_bs` configured or copied in later works on the next `@T: Restart Bridge`, without a reload.

## 7) Status, config, and diagnostics

Use:

- `@T: Extension Status Page`
- `@T: Open Extension Settings`
- `@T: Open Config File`
- `@T: Toggle Bridge Debug Logging`

### VS Code settings (`tomAi.*`)

Most of the extension's configuration is in its config file (`@T: Open Config File`). The VS Code settings it contributes, each read by the extension:

| Setting | What it does |
| --- | --- |
| `tomAi.configPath` | The extension config file (`~` and `${workspaceFolder}` resolved) |
| `tomAi.aiFolder` | The AI folder's name (default `_ai`) |
| `tomAi.queueFolder` | The prompt queue's folder (default `${aiFolder}/queue`) |
| `tomAi.bridge.requestTimeout` | How long a Dart bridge request may take, ms (default 30 000, at least 1 000) |
| `tomAi.bridge.restartDelay` | The wait before the bridge restarts after it stopped, ms (default 5 000) |
| `tomAi.bridge.maxRestarts` | Automatic restarts in a row before the extension gives up (default 10; 0: none); the count starts again when the bridge answers, or when you start it |
| `tomAi.timedRequests.tickInterval` | How often the timed-request engine looks for due entries, ms (default 30 000, at least 1 000; read when the engine starts) |
| `tomAi.todo.workspaceTodoFile`, `tomAi.todo.questTodoPattern`, `tomAi.notes.questNotesPattern` | The files of the WORKSPACE TODOS, QUEST TODOS and quest-notes views |
| `tomAi.guidelines.excludeGlobs` | Projects the Guidelines panel's Project list leaves out (default `tom/zom_*/**`) |
| `tomAi.projectDetection.excludeGlobs` | Folders the workspace's project scan skips (default `tom/zom_*/**`) |

The trail is switched on and off on the Status Page (the config file's `trail.raw.enabled`), not by a VS Code setting.

### Provider SDKs

The extension does not carry the model providers' SDKs; it installs them on request into its own storage, where they stay across extension updates. **`@T: Provider SDKs`** (also the **Provider SDKs** button in the Status Page's first section, which names the providers installed) opens the page:

- a row per provider with a checkbox, the installed versions and the versions this build is tested with; check or uncheck and click **Install / Uninstall**;
- **Check for updates** asks the npm registry for newer releases; a provider with one shows **update to …** (with *(new major)* when the API may change), which installs it; **Update all** installs every update found; **install this build's versions** goes back. Nothing updates by itself;
- the log of the last run and its outcome.

When no provider is installed, the page opens when the extension starts. The **Anthropic** provider is the direct API SDK (`@anthropic-ai/sdk`, also used by history compaction and memory extraction) and the Agent SDK with its Claude CLI for this platform. An install downloads the packages from the npm registry (no npm or Node needed), checks each one's integrity, and is used by the next prompt without a reload. The 🤖 dot of the ANTHROPIC/LLM panel shows whether the Agent SDK and its CLI are installed.

### Missing binaries on this platform

Three features run programs a VSIX carries only for some platforms: DartScript (`tom_bs`), CodeSpecs validation (`validate_codespecs`) and the TomSpecs process checks (`spec_checks`). The extension checks them when it starts, for the platform it runs on, so the same VSIX gives the right answer on every machine. The Anthropic transports need the provider SDKs, which no VSIX carries: see [Provider SDKs](#provider-sdks).

- **`@T: Missing Dart Binaries (DartScript / CodeSpecs validation)`** opens a page filled for this machine: what is missing, what does not work and what keeps working, how to install the Dart SDK, how to build the binaries there, and how to configure prebuilt ones (`bridge.executables.tom_bs` / `bridge.executables.validate_codespecs` per platform in `.tom/tom_vscode_extension.json`) or copy them into the extension's `bin/<platform>/`. It opens by itself once per extension build and platform when a binary is missing.
- The status bar shows **Dart binaries missing** while one is; a click opens the page.
- The Status Page has a **Dart binaries** section: the platform, each binary as *configured*, *bundled* or *missing* (warned), and **Open the page**. The bridge row says *Not available (tom_bs missing)* instead of *Disconnected*.
- Without `validate_codespecs`, `tomAi_specCodeSpecsValidate` answers that it is missing; Trace and Status skip validation and a warning `"CodeSpecs validation skipped: validate_codespecs is not available on <platform>."` with **What does this mean?** shows once per tool and window session.
- **`@T: Missing Agent SDK (provider SDK or Claude CLI not installed)`**: without the Anthropic provider (or with no Claude CLI for this platform) an Anthropic prompt fails before it runs, and the error (once per window session) has **Install provider SDKs** (the Provider SDKs page) and **What does this mean?** (this page).

WINDOW STATUS marks a window with **no Dart binaries**; agents read the same as `dartBinaries` in `tomAi_getWorkspaceInfo` and `tomAi_getQuestWindowStatus`.

### Todo buttons

The Status Page's **Todo buttons** section chooses the templates the todo detail's **Send** / **Queue** buttons wrap a todo in: one for todos marked 👤 user action (also used by the **Guide me** buttons; *(default: Guide me through a user action)*), one for every other todo (*(default: Execute TODO)*). Both dropdowns offer the Anthropic templates; ✏️ opens the template the row runs in the Global Template Editor (category *Anthropic — User Message*); **Save Todo Buttons** stores the choices (`anthropic.todoButtonTemplates`).

### Assist prompts

The prompts the extension runs to help you are templates of one category, **Assist Prompts**, in the Global Template Editor (`@T: Open Prompt Template Editor`): **Grill me** and **Explain in detail** on an open question in the MD Browser, **Explain a decision** and **Grill me at a decision** at a process decision (the Decide… dialog), **Finish review round** at a review, and **Out of budget** — the prompt a queue item continues with on another profile when its profile ran out of credit. Six default templates of those names are put into the config when a window starts (`assistPrompts.templates`, ids `grill-me`, `explain-in-detail`, `explain-decision`, `grill-me-decision`, `finish-review-round`, `out-of-budget`); an edited one is kept, an unedited earlier default is brought to the current one.

Which template each use runs is chosen on the Status Page, section **Assist prompts**: one row per use with a dropdown — *(default: …)* runs the use's default template — and ✏️ (opens the template the row runs in the editor), ➕ (a new template) and 🗑️ (deletes the chosen template; the uses that chose it run their default again); **Save Assist Prompts** stores the choices (`assistPrompts.selected`). Each use fills its own placeholders before the prompt expands as any prompt does; the editor lists them under the template — Out of budget's are the stopped profile (`${stoppedProfile}`, `${stoppedProfileId}`), its model (`${stoppedModel}`), session (`${stoppedSession}`), the time it stopped (`${stoppedAt}`), the API's message (`${budgetMessage}`), the session's live trail (`${liveTrail}`), the profile it continues on (`${toProfile}`, `${runsInSession}`, `${sessionNote}`) and the original prompt (`${originalPrompt}`).

## 8) Output Channels

The extension provides dedicated output channels for observability:

| Channel | Source | Purpose |
| --- | --- | --- |
| Tom Prompt Queue | `promptQueueManager.ts` | Queue state changes, send events (each naming where the prompt goes: `via copilot`, or `via anthropic (profile …, session …)`), answer detection, watchdog health checks |
| Tom Timed Requests | `timerEngine.ts` | Tick heartbeats, fire decisions, schedule evaluation, entry lifecycle |
| Tom Extension Debug Log | `debugLogger.ts` | General debug logging across all categories |
| Tom Tests | `tests.ts` | Test execution output |
| Tom Dartbridge Log | `vscode-bridge.ts` | Bridge communication logs |
| Tom Tool Log | `toolLog.ts` | Tool invocation logs (one line per agent tool call) |
| Tom AI Anthropic Chat | `anthropic-output-channels.ts` | Anthropic turns |
| Tom AI Anthropic Chat Responses | `anthropic-output-channels.ts` | Anthropic response content |
| Tom AI Compaction and Memory Extraction | `compaction-log.ts` | History compaction and memory extraction passes |
| Tom AI: MCP Server | `mcpServerLog.ts` | MCP server requests |
| Tom AI Local Log | `localLlm-handler.ts` | Local LLM debug output (endpoint, timing, retries) |

The Tom Extension Debug Log is also written to
`ztmp/tom_extension_debug.<quest>.log` in the workspace, one file per quest
window, started afresh when the window activates. Its start-up lines show why a
panel was slow to appear: how long each step of the activation took, when each
view was resolved and first shown (`webview.startup`), every time the extension
host was busy for 250 ms or more in the first two minutes (`extension.startup`,
whichever extension held it), and every panel message that took 500 ms or more
to handle.

Queue and timed request channels include ISO timestamps on every log line and can be enabled/disabled at runtime.

## 9) Trails and history

Every Anthropic session — `chat` (the panel), `default` (the queue) and every named one — keeps all it writes in its own folder, `_ai/quests/<quest>/history/sessions/<session>/`:

- **History** — `compacted_history.md`, `history.json` (+ `history.md` rendering), `rawTurns.json`, `compaction_rounds.json`. Rolling compacted context used by `trim_and_summary`; read back from the same folder. SDK-managed mode keeps the conversation in the Agent SDK, its id in `<session>.session.json`.
- **Trail pair** — `<quest>.anthropic.prompts.md` / `.answers.md`, the session's prompts and answers; **Recreate history** and **Recreate memory** rebuild from this session's own pair.
- **Live trail** — `live-trail.md`. Rolling-window markdown (last 5 prompt blocks). Streams thinking / tool_use / tool_result / assistant-text events as they arrive. Best viewed via the live-trail action in the @CHAT Logs section (for the session selected there; the MD Browser in live mode follow-tails the file).
- **Raw trail** — `trail/`. Every turn produces `<ts>_prompt_<rid>.userprompt.md`, `<ts>_payload_<rid>.payload.md`, `<ts>_answer_<rid>.answer.json`, plus tool request / answer files; `compaction/` and `memory/` hold the background passes, `tool_results/t<n>.json` the session's tool results (keys continue past what is stored, so nothing is overwritten). Inspect via the Raw Trail Viewer editor.
- **Quest memory** — `_ai/memory/<quest>/<session>/`; `${memory}` and the memory tools use the running session's, plus `_ai/memory/shared/`.
- **Retention** — the raw trail keeps at most **Max raw files per folder** (Status Page, Trail; default 1000) in `trail/`, `compaction/` and `memory/` each. The stored tool results (`tool_results/t<n>.json`) are pruned after each send: older than **Stored tool results — keep days** (default 30) or beyond **at most per session** (default 1000, the newest kept) go; 0 switches a limit off. `tomAi_readPastToolResult` answers a pruned key *pruned by retention*. `rawTurns.json` and `compaction_rounds.json` are the conversation itself and are kept bounded by compaction.

Git tracks a session's `compacted_history.md`, snapshot and `live-trail.md`; the rest is machine-local. On a quest's first use a window moves its files from the older per-quest layout (`history/`, the quest folder's `live-trail.md`, `_ai/trail/anthropic/<quest>/`, `_ai/memory/<quest>/`) into the `default` session, once per machine.

**Choosing the sessions.** Every button that works on this storage asks which sessions first: a multi-select of the quest's sessions (the SESSIONS view's list — `default`, `chat`, the session files, temporary ones marked, and storage left without a file) with **All sessions** on top and the panel's session preselected. That holds for the subpanel's **Recreate history** and **Recreate memory** — both then confirm, naming the sessions — and for the panel's **Recreate** actions. **Open session history**, **Open live trail**, the summary trail, the raw trail, the memory panel and **Clear** are in the @CHAT Logs panel behind its session switch and work on the session selected there (Clear asks first). The Status Page's compaction **Dry Run** (each chosen session's rolling history) and **Trail Viewer**, the memory panel (its **Session** button: whose quest memory it shows and edits) and the command `Tom AI: Migrate compaction format` (the chosen sessions in every quest; **All sessions** means every session of every quest) ask the same way. To clear the queue's `default` session, use **Clear** in the Logs section with `default` selected, or **Reset** on its row in the SESSIONS view.

## 10) Keyboard productivity

See [quick_reference.md](quick_reference.md) for every keybinding and the commands they run.

**Completion in prompt fields.** `Ctrl+Shift+Space` in a prompt field (the @CHAT panels, the Queue Editor's add form, timed requests, notes): after `/` it offers the **slash commands** (`.claude/commands/<name>.md`, a sub-folder making `/<folder>:<name>`) and the **skills** (`.claude/skills/`) of the workspace and its parent folders, after `@` the **files of the quest folder** (`_ai/quests/<quest>/`) — no queue files, other quests or code: your own files first (those open in an editor at the top), then the technical ones (the `history/` folder, `extension_config.*`, `process-state.*`, session files, archived and deleted todos). With no quest open it offers the workspace's files. Choosing a command asks for its arguments (its `argument-hint` shown) and inserts its prompt with them filled in — `$ARGUMENTS` the whole text, `$1` … `$9` the words (quotes keep words together); a command without placeholders gets them appended as `ARGUMENTS: …`. Escape on the question inserts nothing.

## 11) Reinstall and reload

If extension changes do not appear:

1. reinstall the extension package in the target VS Code host,
2. reload window,
3. rerun the affected command.

Building and installing the package is described in the extension README's
Installation section.
