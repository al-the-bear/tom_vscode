# Phase-4 CodeSpecs fixture

A snapshot of `tom_ai/ai_build/tom_specs_samples/phase4_codespecs_run`, for the
query, trace, validate and step-context tests (`codespecs-trace-tools.test.ts`,
`codespecs-validate-tools.test.ts`):

- `codespec/` — the sample's generated trio (`shared`, `client`, `server`), its
  recorded `validation_report.json` and the trio's IR (`irspecs/`, three
  `*.ir.yaml`, what `irspecs from-codespecs` writes from the trio; the `ir`
  tests of `codespecs-validate-tools.test.ts` and `codespecs-workflow-tools.test.ts`),
  copied from the sample's `codespec/`;

- `codespecs_extracts/` — the sample's 27 `*.extract.yaml`, written by its
  stage 2 to its gitignored `build/codespecs_extracts/`;
- `backlinks.json` — the back-link index of the sample's generated trio, written
  by `validate_codespecs --backlinks`, with the inputs made package-relative.

To refresh, from `tom_ai/ai_build`:

```bash
SAMPLE=tom_specs_samples/phase4_codespecs_run
FIX=../vscode/tom_vscode_extension/src/tools/__tests__/fixtures/phase4
(cd $SAMPLE && dart run)
cp $SAMPLE/build/codespecs_extracts/*.extract.yaml $FIX/codespecs_extracts/
cp -R $SAMPLE/codespec/{shared,client,server,irspecs,validation_report.json} \
   $FIX/codespec/
cd tom_specs_clitool && dart run tom_specs_clitool:validate_codespecs \
   --backlinks --shared ../$SAMPLE/codespec/shared \
   --client ../$SAMPLE/codespec/client --server ../$SAMPLE/codespec/server
```

and save the last command's output as `backlinks.json`, with `inputs` set to
`codespec/shared` / `codespec/client` / `codespec/server`. CT-10 fails when
the extracts here differ from a sample run on the same machine; CV-6 fails
when `codespec/` here (the trio, its IR and its report) differs from the
sample's `codespec/`.
