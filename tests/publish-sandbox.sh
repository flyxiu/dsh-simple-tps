#!/usr/bin/env bash
# Rehearse scripts/publish-github.sh in throwaway repositories; never touches the
# real checkout or the real mirror.
# Usage: tests/publish-sandbox.sh
#   KEEP=1  keep the sandbox dir for inspection
set -uo pipefail

script_path="$(cd "$(dirname "$0")/.." && pwd)/scripts/publish-github.sh"
[ -f "$script_path" ] || { echo "publish-sandbox: no such script: $script_path" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/publish-sandbox.XXXXXX")"
trap '[ "${KEEP:-0}" = 1 ] || rm -rf "$work"' EXIT

pass=0 fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s  (%s)\n' "$1" "$2"; }
check(){ local d="$1" c="$2"; if eval "$c"; then ok "$d"; else bad "$d" "$c"; fi; }

repo="$work/repo"
mirror="$work/mirror.git"
mkdir -p "$repo/scripts" "$repo/lib" "$repo/docs"
cp "$script_path" "$repo/scripts/publish-github.sh"; chmod +x "$repo/scripts/publish-github.sh"

git init -q --bare --initial-branch=main "$mirror"
git -C "$repo" init -q --initial-branch=main
git -C "$repo" config user.email sandbox@example.invalid
git -C "$repo" config user.name "Publish Sandbox"
git -C "$repo" config commit.gpgsign false

# The mirror starts without internal notes, exactly like the rewritten history.
printf '{"name":"fixture","version":"0.0.1"}\n' > "$repo/package.json"
printf 'export const answer = 42\n' > "$repo/lib/index.js"
printf '# readme\n' > "$repo/README.md"
git -C "$repo" add -A
git -C "$repo" commit -qm "chore: fixture"
git -C "$repo" remote add github "$mirror"
git -C "$repo" push -q github main
git -C "$repo" fetch -q github main
git -C "$repo" update-ref refs/heads/public github/main

# Internal notes exist in the private history only; HEAD carries them again.
mkdir -p "$repo/docs"
printf '# internal design\n' > "$repo/docs/设计.md"
printf '# agent handoff\n' > "$repo/AGENTS.md"
git -C "$repo" add -A
git -C "$repo" commit -qm "docs: internal notes"

run_publish() { # sets rc/out
  out="$(cd "$repo" && PUBLISH_REMOTE=github bash scripts/publish-github.sh 2>&1)"; rc=$?
  return 0
}
mirror_tree() { git -C "$mirror" ls-tree -r --name-only main | sort | tr '\n' ' '; }
mirror_head() { git -C "$mirror" rev-parse main; }

echo "publish-sandbox: script $script_path"
echo "publish-sandbox: work   $work"

echo "[1] docs-only change publishes nothing"
before="$(mirror_head)"
run_publish
check "exit 0"                     '[ "$rc" -eq 0 ]'
check "says nothing pushed"        'grep -q "already carries this tree" <<<"$out"'
check "mirror head unchanged"      '[ "$(mirror_head)" = "$before" ]'

echo "[2] a shipped change publishes one filtered commit"
printf 'export const answer = 43\n' > "$repo/lib/index.js"
git -C "$repo" commit -qam "fix: answer"
run_publish
check "exit 0"                     '[ "$rc" -eq 0 ]'
check "mirror advanced"            '[ "$(mirror_head)" != "$before" ]'
check "no docs in the mirror"      '! grep -q "docs/" <<<"$(mirror_tree)"'
check "no AGENTS.md in the mirror" '! grep -q "AGENTS.md" <<<"$(mirror_tree)"'
check "lib shipped"                'grep -q "lib/index.js" <<<"$(mirror_tree)"'
check "readme shipped"             'grep -q "README.md" <<<"$(mirror_tree)"'
check "one commit appended"        '[ "$(git -C "$mirror" rev-list --count main)" -eq 2 ]'
check "commit message carried"     '[ "$(git -C "$mirror" log -1 --format=%s main)" = "fix: answer" ]'
check "content matches"            '[ "$(git -C "$mirror" show main:lib/index.js)" = "export const answer = 43" ]'

echo "[3] republishing the same tree is a no-op"
before="$(mirror_head)"
run_publish
check "exit 0"                     '[ "$rc" -eq 0 ]'
check "says nothing pushed"        'grep -q "already carries this tree" <<<"$out"'
check "mirror head unchanged"      '[ "$(mirror_head)" = "$before" ]'

echo "[4] dirty tracked files are refused"
printf 'dirty\n' >> "$repo/lib/index.js"
before="$(mirror_head)"
run_publish
check "exit 1"                     '[ "$rc" -eq 1 ]'
check "names the reason"           'grep -q "modified; commit or stash first" <<<"$out"'
check "mirror head unchanged"      '[ "$(mirror_head)" = "$before" ]'
git -C "$repo" checkout -q -- lib/index.js

echo "[5] a missing remote is skipped, not failed"
out="$(cd "$repo" && PUBLISH_REMOTE=nosuchremote bash scripts/publish-github.sh 2>&1)"; rc=$?
check "exit 0"                     '[ "$rc" -eq 0 ]'
check "says nothing pushed"        'grep -q "nothing pushed" <<<"$out"'

echo "[6] an unseeded public branch is refused with the seed command"
git -C "$repo" update-ref -d refs/heads/public
run_publish
check "exit 1"                     '[ "$rc" -eq 1 ]'
check "points at the seed line"    'grep -q "seed it from the mirror" <<<"$out"'

echo "publish-sandbox: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
