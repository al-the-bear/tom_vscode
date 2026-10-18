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

1. **Find the document.** `tomAi_specListDocuments` with `dir` set to the folder
   you expect it in. Each document comes with its root, its model-version stamp
   and whether it is editable.
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
       { "op": "addNode", "parentPath": "SBP/introductionAndScope/requirements/functionalRequirements", "childSegment": "FRE-REQU-LST", "as": "req" },
       { "op": "setFormField", "path": "$req/FRED", "field": "description", "value": "The system must archive closed orders." },
       { "op": "setFormField", "path": "$req/FREP", "field": "priority", "value": "could" },
       { "op": "setHeadline", "path": "$req", "headline": "FR-07 — Archive closed orders" }
     ]
   }
   ```

   The batch is one approval, one write and one undo step; any failing edit
   writes nothing and names the edit. `dryRun: true` returns the diff first. The
   single-edit tools (`tomAi_specSetFormField`, `tomAi_specAddNode`, …) are for
   one change.
6. **Check it.** `tomAi_specValidate` on the file: the decode, schema and
   instance tiers, each finding with the `path` to fix. The edit answers already
   say which findings the change introduced or resolved.
7. **Read it as a person will.** `tomAi_specRender`, optionally for one
   subtree, gives the DocSpecs Markdown. `tomAi_specConvert` writes the other
   format.

Plain DocSpecs Markdown that is not a SOM document (a file with a
`<!-- docspec: … -->` header) has its own four tools: `tomAi_docspecsOutline`,
`tomAi_docspecsGetSection`, `tomAi_docspecsReplaceSection` and
`tomAi_docspecsValidate`.

## Take it through Phase 4 (CodeSpecs)

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
   whose extra input was not given — 40 and 41 among them — are listed as not
   run, never as passed.
   `tomAi_specCodeSpecsTrace` follows a token from the specification to the code
   that cites it, or back.

## Over MCP

The extension's MCP server serves the same tools. A client without the API key
gets the read-only floor: every tool above that only reads, and none that
writes. See [mcp_server.md](mcp_server.md) §4.
