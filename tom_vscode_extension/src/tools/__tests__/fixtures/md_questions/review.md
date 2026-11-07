# Review

Fixture for the Markdown question tools (md-question-tools.test.ts). The
questions follow the review syntax of the completions document.

## Answered

> **❓ CC-1 — Where the explanation appears:**
> - **(a)** in a note beside the document
> - (b) only in the question panel
>
> **Answer:** (a), and the MD Browser shows it

> ⬆️ **C-1** (Claude): Read as (a).

## Open, the recommendation by a line

> **❓ CC-2 — The order of the work:** two pieces, which first?
> - (a) the runtime first
>   and then the browser
> - (b) the browser first
>
> *Recommendation:* (b): the browser is smaller.
>
> **Answer:**

> ⬆️ **C-2** (Claude): A comment after the open question.

## A block of several questions

> **❓ BQ-1 — owner:** who owns it?
> - (a) the team
> - **(b)** nobody
>
> **Answer:** (a)
>
> **BQ-2 — field:** which field?
> - (a) name
> - (b) id, recommended
>
> **Answer:**

## Code that looks like a question

```markdown
> **❓ FAKE-1 — not a question:** it is in a fence
> - (a) yes
>
> **Answer:** never read
```

## Outside a quote

**❓ PL-1 — Plain:** a question outside a blockquote
- (a) one
- (b) two

**Answer:** (b)
continued on the next line

## Without an answer line

> **❓ NA-1 — No answer:** there is nothing to write to.
> - (a) only

## Twice

> **❓ DUP-1 — First:** the first copy
>
> **Answer:**

> **❓ DUP-1 — Second:** the second copy
>
> **Answer:**

## With a proposal

> **❓ PR-1 — Proposed:** a proposal is already here
> - (a) keep
> - (b) drop
>
> **Answer:**
>
> **Proposed answer** (grill me, 2026-11-01): (a) keep it,
> because it works.
