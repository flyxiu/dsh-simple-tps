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

Pushing a tag is separate and only matters if a GitHub Release is wanted:

```bash
git push github --tags
```

## Development

```bash
npm test        # both suites: client registration/fold, host projection
```

`lib/client.js` is hand-written in the module-loader format with no build step; editing
it takes effect on a page reload. `lib/index.js` runs in the host process and needs a
restart. See the README for the slot and projection internals.
