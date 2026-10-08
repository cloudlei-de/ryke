# Writing solution patches

Each task in `../tasks.json` has a `spec` that lists the exact file changes (full file contents for new
files, exact old and new text for edits). Write `solutions/<id>.patch` (v1) and, when the task has one,
`solutions/<id>.v2.patch`. Do not add or edit anything else under `demo/convert`.

## What a patch is

`git diff` output with the default 3 lines of context and `a/` `b/` prefixes, applied from the repo root
with `git apply --3way`. It must touch exactly the files in the task's `writes` list. New files are fine
(including new files under `test/`); an existing file under `test/` or `ryke.json` may only be touched by
`tamper-routes`.

## Base trees (this matters for `git apply --3way`)

`--3way` needs the blob a patch was made from in the repository. The seed's blobs always exist; a blob
of "seed plus somebody else's CHANGELOG bullet" never does. So:

- **v1** is the diff from the seed to the seed plus the spec's changes.
- **v2** is the diff from a base tree to that base plus the spec's v2 changes, where the base is the seed
  plus the v1 changes of the tasks listed in `v2_after`, **except** that `src/registry.ts` and
  `CHANGELOG.md` stay exactly as in the seed. The v2 patch still appends its own registry line and
  bullet on top of the seed's version of those two files.

Recipe (in a scratch directory, not in the repo):

```sh
cp -r <repo>/demo/convert/{src,test,ryke.json,CHANGELOG.md,package.json} .   # the seed
git init -q -b main . && git add -A && git commit -qm seed
# v2 only: build the base
git apply --3way <repo>/demo/convert/solutions/<each v2_after id>.patch && git add -A && git commit -qm after
git checkout <seed sha> -- src/registry.ts CHANGELOG.md && git commit -qm base   # skip if nothing differs
# make the changes from the spec, then:
git add -A && git diff --cached > <repo>/demo/convert/solutions/<id>.patch      # or .v2.patch
```

## Rules

- Follow the spec literally: same text, same line breaks, same file names. Do not reformat other lines.
- Union files (`src/registry.ts`, `CHANGELOG.md`) are append-only: one line at the very end, newline-terminated.
  Only the tasks whose spec says so touch them (every G1, G2 and G3 task, none of G4, G5, G6).
- G1: write every unit factor as a literal in the new file; never import another file under `src/units`.
- TypeScript must stay erasable (no enums, namespaces or parameter properties) and relative imports keep `.ts`.

## Check your work

```sh
node demo/convert/tools/check.mjs patch <id>                   # v1 on the seed
node demo/convert/tools/check.mjs patch <id> --v2              # v2 on top of its v2_after tasks
node demo/convert/tools/check.mjs patch <id> --on a,b:v2       # on top of other patches ("id" = v1, "id:v2" = v2)
node demo/convert/tools/check.mjs all                          # everything that exists, plus the cumulative run
```

The tool also compares the patch's touched files with `writes` and refuses changes to existing protected
files (except for `tamper-routes`, which must change one).
