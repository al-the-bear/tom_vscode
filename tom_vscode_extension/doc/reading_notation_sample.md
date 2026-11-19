# The reading notation: a sample

Open this file in the MD Browser to see how it shows the reading notation (the DocSpecs specification's *Reading Notation*). Every registered kind is here, as a block and inline, with the citation shapes, the attributes and an unknown kind. The **Reading** group in the toolbar switches each kind's mode; the eye button shows all marked text at once.

## Blocks

::: {.provenance label="Where this section came from" source="../README.md"}
_Extrapolated from the extension's README and the product owner's notes of 2026-11-16._
:::

Rights scoped to a node apply to its subtree.

::: editorial
**The provenance notes.** Every statement names where it came from; a statement without a note was written for this document.
:::

::: aside
An aside: neither provenance, trace nor editorial, and not needed to state the requirements.
:::

::: trace
(-> C2.1, TR-07, BQ-405)
:::

::: rejected
Text an import could not place: it stays here until someone decides where it belongs.
:::

## Inline

A requirement backed by its sources (-> C2.1, TR-07), taken from a file (<- ../README.md#tom-ai-extension) or extrapolated from one (<~ ../doc/user_guide.md). It may carry [a short aside]{.aside}, [a provenance note]{.provenance label="From the kickoff"}, [an editorial remark]{.editorial} and [a trace]{.trace} as spans.

A span may hold other notation: [an aside with a citation (-> FR-54) and **emphasis**]{.aside}.

## Content shown compactly

::: refs
[DAENT-ENTI-TENANT](#data) [DAENT-ENTI-USER](#data) [BIRU-BUSI-DATA-SCOPED-KEYS](#rules)
:::

::: records
| Id | Given | When | Then |
| --- | --- | --- | --- |
| ACE-CRIT-1 | a tenant with two users | one user changes a shared setting | the other user sees the change after a reload |
| ACE-CRIT-2 | a node with scoped rights | a child node is added | the child inherits the rights of its parent |
:::

## Nesting and unknown kinds

:::: {.provenance label="An outer note"}
The outer note holds an inner one.

::: aside
The inner aside, collapsed on its own inside the opened outer note.
:::
::::

::: {.example}
A kind the browser does not know is shown as it is: its fences and braces are hidden, its content shown.
:::

`::: {.provenance}` in a code span and the block below are literal:

```markdown
::: aside
not a div
:::
```

\::: an escaped fence is text too.
