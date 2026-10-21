#!/usr/bin/env bash
# Cut a release: bump the patch version, commit it, and push the branch the
# plugin market follows. The market compares the branch HEAD against the commit
# recorded in each user's lockfile, so a pushed commit is what surfaces the
# update button.
set -euo pipefail

cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "release: expected branch main, found $branch" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "release: working tree is dirty; commit or stash first" >&2
  exit 1
fi

# -s prints just the new version; strip the v prefix npm adds so the commit
# message reads 0.1.2 rather than v0.1.2.
version="$(npm version patch --no-git-tag-version -s)"
version="${version#v}"
echo "release: $version"

git add package.json
git commit -m "release: $version"
git push github "$branch"

echo "release: pushed $version to github"
