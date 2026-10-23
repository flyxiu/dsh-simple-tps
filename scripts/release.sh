#!/usr/bin/env bash
# Cut a release: bump the patch version, commit it, and push the branch the
# plugin market follows. The market compares the branch HEAD against the commit
# recorded in each user's lockfile, so a pushed commit is what surfaces the
# update button.
set -euo pipefail

cd "$(dirname "$0")/.."

# The remote the market follows. This clone names it `github`; a fork usually
# calls its own `origin`, so allow it to be overridden.
remote="${RELEASE_REMOTE:-github}"
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "release: expected branch main, found $branch" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "release: working tree is dirty; commit or stash first" >&2
  exit 1
fi

# A version bump tells every subscriber there is something worth installing, so
# it has to correspond to a change they would notice. Documentation, tests and CI
# edits ship nothing new: the market still reports an update because the version
# went up, users take the trip through the installer, and the plugin behaves
# exactly as it did. Refuse rather than let that happen.
#
# Shipped code is lib/ and cordis.patch.yml. package.json is handled separately
# below because most of it is prose: rewriting `description` or `keywords` changes
# nothing a subscriber would notice, while the `dsh` block decides how the plugin
# loads and `files` decides what gets published.
source_paths=(lib cordis.patch.yml)

# The range is "since the last release commit", not HEAD~1: a feature often
# lands as several commits, and only one of them would show up in a one-commit
# window. HEAD~1 also misses a release made immediately after another.
last_release="$(git log --grep='^release: ' -n 1 --format=%H -- . || true)"
if [ -n "$last_release" ]; then
  base="$last_release"
  since="${last_release:0:7}"
elif empty_tree="$(git hash-object -t tree /dev/null 2>/dev/null)"; then
  # Nothing has been released yet, so every shipped file counts as unreleased.
  # The empty tree rather than the root commit: diffing against the root would
  # report "nothing changed" when the root itself already carried the code.
  base="$empty_tree"
  since="the beginning"
else
  base="$(git rev-list --max-parents=0 HEAD)"
  since="the first commit"
fi

changed="$(git diff --name-only "$base" HEAD -- "${source_paths[@]}")"

# The manifest counts only in two places: the `dsh` block decides how the plugin
# loads, and `files` decides what a subscriber actually downloads. Everything else
# in the manifest is prose or tooling: rewriting `description`, `keywords`,
# `repository` or `scripts` changes nothing a user would notice, so it must not
# bump the version.
#
# `exports`, `main`, `type` and the dependency maps do affect loading, and this
# narrower gate would let them ship silently, so they are reported as a note.
# They are deliberately not in the gate: only `dsh` and `files` release.
if ! git diff --quiet "$base" HEAD -- package.json; then
  manifest_keys="$(node -e '
    const { execFileSync } = require("node:child_process")
    const read = (rev) => {
      try {
        return JSON.parse(execFileSync("git", ["show", rev + ":package.json"], { encoding: "utf8" }))
      } catch {
        return {}
      }
    }
    const gate = ["dsh", "files"]
    const outside = ["type", "main", "exports", "dependencies", "peerDependencies"]
    const [base, head] = process.argv.slice(1)
    const before = read(base)
    const after = read(head)
    const changedIn = (keys) => keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    const shipped = changedIn(gate)
    const rest = changedIn(outside)
    if (rest.length > 0) {
      process.stderr.write("release: note: " + rest.join(", ") + " changed outside the release gate; only dsh and files release\n")
    }
    process.stdout.write(shipped.join("\n"))
  ' "--" "$base" HEAD)"
  for key in $manifest_keys; do
    changed="$changed
package.json [$key]"
  done
fi

changed="$(printf '%s\n' "$changed" | sed '/^$/d')"
if [ -z "$changed" ]; then
  echo "release: no shipped code changed since $since" >&2
  echo "release: documentation, tests and CI do not need a version bump — push them without one." >&2
  echo "release: nothing was changed; no version bumped, no commit, no push." >&2
  exit 1
fi

echo "release: shipped changes since the last release:"
echo "$changed" | sed 's/^/release:   /'

# -s prints just the new version; strip the v prefix npm adds so the commit
# message reads 0.1.2 rather than v0.1.2.
version="$(npm version patch --no-git-tag-version -s)"
version="${version#v}"
echo "release: $version"

git add package.json
git commit -m "release: $version"
git push "$remote" "$branch"

echo "release: pushed $version to $remote"
