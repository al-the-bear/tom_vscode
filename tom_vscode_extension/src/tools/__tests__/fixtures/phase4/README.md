# Phase-4 CodeSpecs fixture

A snapshot of `tom_ai/ai_build/tom_specs_samples/phase4_codespecs_run`, for the
query, trace, validate and step-context tests (`codespecs-trace-tools.test.ts`,
`codespecs-validate-tools.test.ts`):

- `codespec/` — the sample's generated trio (`shared`, `client`, `server`) and its
  recorded `validation_report.json`, copied from the sample's `codespec/`;

- `codespecs_extracts/` — the sample's 27 `*.extract.yaml`, written by its
  stage 2 to its gitignored `build/codespecs_extracts/`;
- `backlinks.json` — the back-link index of the sample's generated trio, written
  by `validate_codespecs --backlinks`, with the inputs made package-relative.

To refresh, from `tom_ai/ai_build`:

```bash
(cd tom_specs_samples/phase4_codespecs_run && dart run)
cp tom_specs_samples/phase4_codespecs_run/build/codespecs_extracts/*.extract.yaml \
   ../vscode/tom_vscode_extension/src/tools/__tests__/fixtures/phase4/codespecs_extracts/
cd tom_specs_clitool && dart run tom_specs_clitool:validate_codespecs --backlinks \
   --shared ../tom_specs_samples/phase4_codespecs_run/codespec/shared \
   --client ../tom_specs_samples/phase4_codespecs_run/codespec/client \
   --server ../tom_specs_samples/phase4_codespecs_run/codespec/server
```

and save the last command's output as `backlinks.json`, with `inputs` set to
`codespec/shared` / `codespec/client` / `codespec/server`. CT-10 fails when the
extracts here differ from a sample run on the same machine. CV-6 fails when the trio here differs from the
sample's `codespec/`; refresh it with
`cp -R tom_specs_samples/phase4_codespecs_run/codespec/{shared,client,server,validation_report.json} ../vscode/tom_vscode_extension/src/tools/__tests__/fixtures/phase4/codespec/`.
