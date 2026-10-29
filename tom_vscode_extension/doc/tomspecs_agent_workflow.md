# Working on TomSpecs documents with the extension's tools

A recipe for an agent — in a chat panel, a queued prompt or an external MCP
client — that has to read, fill or check a TomSpecs specification, and then take
it through Phase 4 (CodeSpecs). Every step names the tool to call. The full tool
reference is [llm_tools.md](llm_tools.md) §4.23–§4.25.

The tools work on `*.docspecs.yaml` and on SOM-rendered `*.md` files, through
the TomSpecs runtime bundled with the extension. Paths are document paths: the
root section id, then field segments and list items `<LIST>-<n>`, for example
`SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`.
Take them from the outline; do not compose them.

## Edit a specification

1. **Find the document.** `tomAi_specListDocuments`, with `dir` set to the folder
   you expect it in or without it for the whole workspace. Each document comes
   with its root, its model-version stamp and whether it is editable; when the
   answer says `truncated`, `stoppedBy` tells why (raise `timeBudgetMs` or
   `maxResults`, or narrow `dir`).
2. **Look at it.** `tomAi_specOutline` on the file, from the root or from a
   path, `depth` 1–3. It shows every declared child, filled or not, so it also
   shows where content can go. Keep the `revision` it returns.
3. **Ask what the model allows.** `tomAi_specReflect` with `file` and `path`:
   the node's kind, its form fields with types and enum values, and the children
   that may be added there now (`addable`).
4. **Find things.** `tomAi_specSearch` (text, class, section id, path glob,
   empty / non-empty), then `tomAi_specSearchIterate` for further pages.
   `tomAi_specGetSection` reads one node with its values.
5. **Change it — in one batch.** `tomAi_specApplyEdits` with an ordered list of
   edits and the `expectedRevision` from step 2. Add an item with
   `addNode … as: "req"` and fill it through `$req/…` paths in the same batch:

   ```json
   {
     "file": "specs/meridian.docspecs.yaml",
     "expectedRevision": "<from the outline>",
     "edits": [
       { "op": "addNode", "parentPath": "SBP/introductionAndScope/requirements/functionalRequirements", "childSegment": "FRE-REQU-LST", "headline": "FR-07 — Archive closed orders", "as": "req" },
       { "op": "setFormField", "path": "$req/FRED", "field": "description", "value": "The system must archive closed orders." },
       { "op": "setFormField", "path": "$req/FREP", "field": "priority", "value": "could" }
     ]
   }
   ```

   The batch is one approval, one write and one undo step; any failing edit
   writes nothing and names the edit. `dryRun: true` returns the diff first. The
   single-edit tools (`tomAi_specSetFormField`, `tomAi_specAddNode`, …) are for
   one change; `tomAi_specAddNode` alone can already add an item with its
   `headline` and form `fields`.
6. **Check it.** `tomAi_specValidate` on the file: the decode, schema and
   instance tiers, each finding with the `path` to fix. The edit answers already
   say which findings the change introduced or resolved.
7. **Read it as a person will.** `tomAi_specRender`, optionally for one
   subtree, gives the DocSpecs Markdown. `tomAi_specConvert` writes the other
   format.

## Work with review annotations

Questions, reviewer comments and inline change marks are text inside content
values (SOM §11.9). Read and change them with these tools, never by editing the
Markdown by hand: the runtime keeps every byte outside the annotation as it was.

1. **See what is open.** Across several documents first, if there are several:
   `tomAi_specAnnotations` with `dir` instead of `file` answers, for every SOM
   document under the folder, its counts (questions, open questions, comments,
   marks) and the totals — which documents a round still has to work through.
   Then `tomAi_specAnnotations` on the file (or with `path` for
   a subtree): the comments with the paragraph each one follows, the questions
   with their options, recommended option and answer (`openOnly: true` for the
   unanswered ones), the inline marks `M-1`, `M-2`, … and the `marksRevision`.
2. **Answer and ask.** `tomAi_specSetAnswer` writes an answer (`(b) because …`).
   `tomAi_specInsertQuestion` asks a new question — directly after a comment
   (`afterComment: "C-12"`) to ask about it, or after a paragraph — with options
   `(a) …`, `(b) …` and the `recommended` letter, which is written bold.
   `tomAi_specInsertComment` adds a comment after a paragraph (paragraphs are the
   blank-line separated blocks of the value, from 0). Rather than count them,
   name the paragraph by its text: `afterTextStart` (it begins with the text) or
   `afterTextContains`; an anchor that matches no paragraph, or more than one, is
   refused with the paragraphs to choose from. `tomAi_specEditComment`
   changes one; `tomAi_specAssignCommentIds` numbers the comments a reviewer
   wrote without an id.
3. **Apply and close.** Once an answer or a comment has been worked into the
   document, `tomAi_specResolveAnnotation` removes it. Change marks are decided
   with `tomAi_specDecideMarks`: by id at the `marksRevision` from step 1, or
   `all: "accept"` under a path.
4. **Read the result.** `tomAi_specRender` with `withoutAnnotations: true`
   shows the document as it reads once every mark is accepted and every comment
   and question removed; the file is not changed.

**Write changes as marks.** When the reviewer is to see what you changed, pass
`marked: true` to `tomAi_specSetContent` / `tomAi_specSetFormField` (or the
batch's `setContent` / `setFormField`): the new text is written with its
differences as inline marks, which the reviewer accepts or rejects. Editing a
marked passage again updates its mark rather than nesting one. Only text takes
marks; a typed or enum field is refused (`notText`).

**Collect a round's answers.** `tomAi_specExtractAnswers` returns the
`answers.md` of a round — answered questions and comments, per document, with
their sections and lines (`includeOpen`, `includeMarks` add the rest) — and
writes nothing; `tomAi_specWriteAnswers` writes it into the step folder
(`output`). The annotations stay in the document. At the end of a round,
`tomAi_specRemoveAllAnnotations` accepts every mark and removes every comment
and question in one write — collect the answers first.

Several of these in one write: `tomAi_specApplyEdits` takes them as ops of the
same names, e.g.

```json
{
  "file": "specs/meridian.docspecs.yaml",
  "edits": [
    { "op": "setAnswer", "questionId": "BQ-01", "answer": "(b)" },
    { "op": "resolveAnnotation", "id": "C-3" },
    { "op": "decideMarks", "all": "accept", "path": "SBP/introductionAndScope" }
  ]
}
```

Plain DocSpecs Markdown that is not a SOM document (a file with a
`<!-- docspec: … -->` header) has its own four tools: `tomAi_docspecsOutline`,
`tomAi_docspecsGetSection`, `tomAi_docspecsReplaceSection` and
`tomAi_docspecsValidate`.

## Show the user the current version

At the end of a step the user should look at the document as it now is, not at
an earlier copy left open from a previous step folder:

- `tomAi_closeEditor` closes the text editors of the document's rendition in
  every group; a tab with unsaved changes is kept and named in `keptDirty`
  (or saved first with `save: true`) — nothing the user typed is lost.
- `tomAi_closeMdBrowser` with `under` (the phase's spec folder) and
  `exceptFilePath` (the working rendition) closes the MD Browser panels showing
  earlier versions; a panel with an answer or edit still open is kept and
  reported unless `force: true`. `tomAi_listMdBrowserPanels` shows what is open.
- `tomAi_openInMdBrowser` (reuse, the default) brings the working rendition to
  the front, or opens it once.

## Take it through Phase 4 (CodeSpecs)

**Where is it?** `tomAi_specCodeSpecsStatus` with the document (and `questId`,
`shared` once they exist) answers every stage below in one call — done, not
started, outdated, incomplete, failing, blocked or not checked — and `next`, the
first stage not done with the tool that moves it. Start there, and come back to
it after each step. How to do a stage is in its runbook:
`tomAi_specCodeSpecsGuide` with `runbook` (`codespecs-next-step`,
`codespecs-stage-a`, `-extraction`, `-stage-b`, `-stage-c`, `-authoring-step`,
`-validate`); the same tool reads the two guides the workflow is written in,
`codespecs_prompt.md` and `codespecs_mapping.md`, section by section.

1. **Stage A, the mechanical gate.** `tomAi_specCodeSpecsGate` on the
   document: checks A1–A5, each finding with the path to fix. A closed gate
   stops here; fix the findings with the edit tools above.
2. **Extract.** `tomAi_specCodeSpecsRouting` shows how every section is routed;
   `tomAi_specCodeSpecsWriteExtracts` writes one extract per area beside the
   document (`generated-doc/codespecs_extracts/`). `tomAi_specCodeSpecsExtract`
   and `tomAi_specCodeSpecsQueryExtracts` read them.
3. **Stage B, one verdict per area.** For each area, read its extract and
   record `sufficient`, `not applicable` or `insufficient` with
   `tomAi_specCodeSpecsSetVerdict`. `tomAi_specCodeSpecsVerdicts` lists what is
   still missing.
4. **Stage C, the todo tree.** `tomAi_specCodeSpecsPlanTodos` with `dryRun`
   first, then for real: `csopen<n>` questions (the queue pauses on them),
   `csproj1` for the three projects, `csgen1`–`csgen31` for the authoring steps.
5. **Author a step.** Each `csgen<n>` reads only what
   `tomAi_specCodeSpecsStepContext` returns for its step: its areas' extracts,
   the contract entries for their markers and the output project.
6. **Validate and trace.** `tomAi_specCodeSpecsValidate` runs the 41 checks
   over the generated projects (clean, violations or a usage error); checks
   whose extra input was not given are listed as not run, never as passed.
   tom_code_specs' vocabulary, which checks 40 and 41 need, ships with the
   extension and is passed by default.
   `tomAi_specCodeSpecsTrace` follows a token from the specification to the code
   that cites it, or back.

## Over MCP

The extension's MCP server serves the same tools. A client without the API key
gets the read-only floor: every tool above that only reads, and none that
writes — and only from this machine or the fleet VPN; from any other network it
needs the key. See [mcp_server.md](mcp_server.md) §4 and §4.1. An MCP client also
finds the CodeSpecs guides as resources (`codespecs-guide://prompt`,
`codespecs-guide://mapping`, one section at `codespecs-guide://<guide>/<number>`)
and the stage runbooks as prompts, with the key or, without it, from this machine
or the VPN.
