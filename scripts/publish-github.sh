#!/usr/bin/env bash
# Publish the shipped subset to the public mirror.
#
# The GitHub repository is public and the Gitea one is private, so internal notes
# (docs/, AGENTS.md) must never appear there. The mirror is rebuilt from the
# current HEAD tree with those paths removed. Every publish appends one commit to
# the local `public` branch and pushes it to the mirror's main, so hashes of
# earlier publishes stay valid for installs pinned to a commit.
set -euo pipefail

cd "$(dirname "$0")/.."

remote="${PUBLISH_REMOTE:-github}"
branch="${PUBLISH_BRANCH:-main}"
ref="public"

# Internal paths that stay in the private repository.
private_paths=(docs AGENTS.md)

# Forks and throwaway checkouts have no public remote; publish is a no-op there.
if ! git remote get-url "$remote" >/dev/null 2>&1; then
  echo "publish: no remote named $remote; nothing pushed"
  exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "publish: tracked files are modified; commit or stash first" >&2
  exit 1
fi

head="$(git rev-parse HEAD)"
message="$(git log -1 --format=%s "$head")"

index_file="$(mktemp)"
trap 'rm -f "$index_file"' EXIT
GIT_INDEX_FILE="$index_file" git read-tree "$head"
for path in "${private_paths[@]}"; do
  GIT_INDEX_FILE="$index_file" git rm -r --cached --quiet --ignore-unmatch "$path" >/dev/null 2>&1 || true
done
tree="$(GIT_INDEX_FILE="$index_file" git write-tree)"

parent="$(git rev-parse --verify --quiet "refs/heads/$ref" || true)"
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "publish: $ref already carries this tree; nothing pushed"
  exit 0
fi

if [ -n "$parent" ]; then
  commit="$(git commit-tree "$tree" -p "$parent" -m "$message")"
else
  echo "publish: no local $ref branch; seed it from the mirror first" >&2
  echo "publish: git fetch $remote $branch && git update-ref refs/heads/$ref $remote/$branch" >&2
  exit 1
fi
git update-ref "refs/heads/$ref" "$commit"

echo "publish: $(git rev-parse --short "$commit") -> $remote/$branch"
git push "$remote" "$ref:$branch"
