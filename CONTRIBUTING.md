# Contributing

## Release

Releases are cut from `main` only. The plugin market follows this branch: it compares
the branch HEAD against the commit recorded in each user's lockfile, so a pushed
commit is what makes the update button appear. Version numbers are informational
for GitHub-source installs — the commit is the real signal.

```bash
npm run release
```

`scripts/release.sh` refuses to run on a dirty tree or off `main`, bumps the patch
version, commits it, and pushes. Subscribers see the update on their next market check.

It pushes to the remote named `github`, which is what this clone calls the GitHub
repository. Others name their own `origin`; set `RELEASE_REMOTE` to override:

```bash
RELEASE_REMOTE=origin npm run release
```

Pushing a tag is separate and only matters if a GitHub Release is wanted:

```bash
git push <remote> --tags
```

### Rehearse a change to the release script

Never point a modified `scripts/release.sh` at this checkout first. `tests/release-sandbox.sh`
rebuilds throwaway repos under `$TMPDIR`, each with its own bare remote, pushes a baseline,
then runs the release script against them:

```bash
npm run test:sandbox                      # current script
npm run test:sandbox -- path/to/release.sh  # a candidate script
KEEP=1 npm run test:sandbox               # keep the temp dirs to poke at
```

Covered: a change under `lib/` and a `cordis.patch.yml` edit release; a `dsh` block or
`files` field edit releases; docs-only, tests/CI-only, "nothing new since the last
release", and prose-only `package.json` edits (`description`, `keywords`) are refused
with an unchanged fingerprint of HEAD, refs, tags, index, `package.json` and remote; an
edit to a loading key outside the gate (`exports`) is refused and reported as a note; a
repo with no `release:` commit releases from the beginning; a dirty tree and a
non-`main` branch are refused before anything is written.

The refusal cases compare a fingerprint taken before and after, so "no side effects" is
asserted, not assumed. Add a case before changing the script's rules; the mutation check
is that a deliberately broken script must fail the suite.

## Development

```bash
npm test        # both suites: client registration/fold, host projection
```

`lib/client.js` is hand-written in the module-loader format with no build step; editing
it takes effect on a page reload. `lib/index.js` runs in the host process and needs a
restart. See the README for the slot and projection internals.
