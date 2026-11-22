# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/basecil/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/basecil/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122

`mend` applies the edits AI models write to a tree of text files, in all four
formats models use: unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. It
reads them to one written specification (`SPEC.md`), finds the lines an edit
names even when the model drifted their whitespace or indentation (three
matching tiers), and changes every file or none.

## The program

`main.ts` (Node 22, standard library only), run as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or stdin when absent or `-`. `--format` picks one
of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default,
detected per SPEC.md section 4). `--check` does everything but write;
`--strict` matches lines exactly (tier 0 only).

Exit codes: 0 with one line per changed path plus `ok: <n> files`; 1 with
one `error: <code> <path>` per failed edit plus `failed: <k> of <n> edits`
and nothing written; 2 with exactly one line (`error: usage`,
`error: no-patch`, `error: format`, or `error: parse <N>`).

`runner.ts` is the kit's trial runner, kept as it is: in a trial the grader
runs `node main.ts` with `MAKEFUN_ENV_URL` set, and `main.ts` hands over to
it. `SPEC.md` is the whole contract.

## The bounty

$100 over 10 places ($10 each). Each submission runs one live trial on the
100 public practice checks; the 750 best practice scores at the deadline go
on to three scored instances drawn from a sealed pool of 300, and places go
by mean score, best first. The house enters a strict applier (exact line
matching only) — a reward needs a mean score above it, so the fuzzy tiers
are the edge. Entries close Tue 2026-11-24 14:00 UTC.
