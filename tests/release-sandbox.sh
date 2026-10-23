#!/usr/bin/env bash
# Rehearse scripts/release.sh in throwaway repos; never touches the real checkout.
# Usage: tests/release-sandbox.sh [path/to/release.sh]
#   KEEP=1     keep the sandbox dir for inspection
#   SANDBOX_SEED=/path  seed files to copy (defaults to this repo)
set -uo pipefail

script_path="${1:-$(cd "$(dirname "$0")/.." && pwd)/scripts/release.sh}"
[ -f "$script_path" ] || { echo "sandbox: no such script: $script_path" >&2; exit 2; }
script_path="$(cd "$(dirname "$script_path")" && pwd)/$(basename "$script_path")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
seed="${SANDBOX_SEED:-$(cd "$here/.." && pwd)}"
work="$(mktemp -d "${TMPDIR:-/tmp}/release-sandbox.XXXXXX")"
trap '[ "${KEEP:-0}" = 1 ] || rm -rf "$work"' EXIT
seed_version="$(node -p "require('$seed/package.json').version")"

pass=0 fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s  (%s)\n' "$1" "$2"; }
check(){ local d="$1" c="$2"; if eval "$c"; then ok "$d"; else bad "$d" "$c"; fi; }

fixture() { # $1 = name, $2 = "first" to skip the baseline release commit
  local d="$work/$1"
  rm -rf "$d"
  repo="$d/repo"; remote="$d/remote.git"
  mkdir -p "$repo/scripts"
  git init -q --bare --initial-branch=main "$remote"
  git -C "$repo" init -q --initial-branch=main
  git -C "$repo" config user.email sandbox@example.invalid
  git -C "$repo" config user.name "Release Sandbox"
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config tag.gpgsign false
  cp "$script_path" "$repo/scripts/release.sh"; chmod +x "$repo/scripts/release.sh"
  cp "$seed/package.json" "$seed/cordis.patch.yml" "$seed/README.md" "$repo/"
  cp -R "$seed/lib" "$repo/lib"
  git -C "$repo" add -A
  git -C "$repo" commit -qm "chore: fixture"
  if [ "${2:-}" != first ]; then            # baseline so this is a *second* release
    printf '\n// baseline\n' >> "$repo/lib/index.js"
    git -C "$repo" commit -qam "release: $seed_version"
  fi
  git -C "$repo" remote add github "$remote"
  git -C "$repo" push -q github main
  baseline="$(git -C "$repo" rev-parse HEAD)"
}

fingerprint() { # $1 = repo -> stable snapshot of every observable state
  local r="$1"
  {
    echo "head    $(git -C "$r" rev-parse HEAD)"
    echo "branch  $(git -C "$r" rev-parse --abbrev-ref HEAD)"
    echo "status  $(git -C "$r" status --porcelain=v1 | sort | tr '\n' '|')"
    echo "refs    $(git -C "$r" for-each-ref --format='%(refname) %(objectname)' | sort | tr '\n' '|')"
    echo "tags    $(git -C "$r" tag -l | tr '\n' '|')"
    echo "index   $(git -C "$r" ls-files -s | sha1sum | cut -d' ' -f1)"
    echo "pkg     $(sha1sum < "$r/package.json" | cut -d' ' -f1)"
    echo "remote  $(git -C "$remote" for-each-ref --format='%(refname) %(objectname)' | sort | tr '\n' '|')"
  }
}

run_release() { # $1 = repo; sets rc/out/err
  errf="$(mktemp)"; out="$(cd "$1" && RELEASE_REMOTE=github bash scripts/release.sh 2>"$errf")"; rc=$?
  err="$(cat "$errf")"; rm -f "$errf"
}

bumped() { node -e 'const v=require(process.argv[1]).version.split(".");v[2]=String(+v[2]+1);console.log(v.join("."))' "$1/package.json"; }
ver()    { node -p "require('$1/package.json').version"; }

echo "sandbox: script $script_path"
echo "sandbox: seed   $seed (version $seed_version)"
echo "sandbox: work   $work"

echo "[0] nothing new after a release -> refused, cites that release"
fixture up-to-date
short="$(git -C "$repo" rev-parse --short "$baseline")"
before="$(fingerprint "$repo")"; run_release "$repo"; after="$(fingerprint "$repo")"
check "exit 1"                   '[ "$rc" -eq 1 ]'
check "cites $short"             'grep -q "no shipped code changed since $short" <<<"$err"'
check "fingerprint identical"    '[ "$before" = "$after" ]'

echo "[1] shipped code change -> release goes through"
fixture source-change
want="$(bumped "$repo")"
printf '\n// sandbox tweak\n' >> "$repo/lib/index.js"
git -C "$repo" commit -qam "feat: tweak projection"
head_before="$(git -C "$repo" rev-parse HEAD)"
run_release "$repo"
check "exit 0"                  '[ "$rc" -eq 0 ]'
check "version $seed_version -> $want" '[ "$(ver "$repo")" = "$want" ]'
check "one release commit on top" '[ "$(git -C "$repo" rev-parse HEAD~1)" = "$head_before" ] && [ "$(git -C "$repo" log -1 --format=%s)" = "release: $want" ]'
check "pushed to remote main"   '[ "$(git -C "$remote" rev-parse main)" = "$(git -C "$repo" rev-parse HEAD)" ]'
check "tree left clean"         '[ -z "$(git -C "$repo" status --porcelain)" ]'
check "only package.json in the commit" '[ "$(git -C "$repo" show --name-only --format= HEAD)" = "package.json" ]'
check "no tag created"          '[ -z "$(git -C "$repo" tag -l)" ]'

echo "[1b] code change followed by a docs commit -> released, docs not listed"
fixture code-then-docs
want="$(bumped "$repo")"
printf '\n// sandbox tweak\n' >> "$repo/lib/index.js"
git -C "$repo" commit -qam "feat: tweak projection"
printf '\n<!-- sandbox note -->\n' >> "$repo/README.md"
git -C "$repo" commit -qam "docs: sandbox note"
head_before="$(git -C "$repo" rev-parse HEAD)"
run_release "$repo"
check "exit 0"                    '[ "$rc" -eq 0 ]'
check "version $seed_version -> $want" '[ "$(ver "$repo")" = "$want" ]'
# The base is the last release: commit, not HEAD~1, so the code change two
# commits back still counts even though the tip only touches README.
check "lists lib/index.js"        'grep -q "release:   lib/index.js" <<<"$out"'
check "does not list README.md"   '! grep -q "README.md" <<<"$out"'
check "release commit on the docs commit" '[ "$(git -C "$repo" rev-parse HEAD~1)" = "$head_before" ] && [ "$(git -C "$repo" log -1 --format=%s)" = "release: $want" ]'
check "pushed to remote main"     '[ "$(git -C "$remote" rev-parse main)" = "$(git -C "$repo" rev-parse HEAD)" ]'

echo "[1c] bundler patch change -> released"
fixture patch-file
printf '\n# sandbox note\n' >> "$repo/cordis.patch.yml"
git -C "$repo" commit -qam "feat: patch tweak"
run_release "$repo"
check "exit 0"                   '[ "$rc" -eq 0 ]'
check "lists cordis.patch.yml"   'grep -q "release:   cordis.patch.yml" <<<"$out"'
check "pushed to remote main"    '[ "$(git -C "$remote" rev-parse main)" = "$(git -C "$repo" rev-parse HEAD)" ]'

echo "[1d] files field edit -> released (shipped contents changed)"
fixture manifest-files
node -e 'const f=process.argv[1]+"/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.files.push("CHANGELOG.md");fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$repo"
git -C "$repo" commit -qam "feat: ship the changelog"
run_release "$repo"
check "exit 0"                   '[ "$rc" -eq 0 ]'
check "package.json listed"      'grep -q "release:   package.json" <<<"$out"'
check "pushed"                   '[ "$(git -C "$remote" rev-parse main)" = "$(git -C "$repo" rev-parse HEAD)" ]'

echo "[1e] docs commit first, source commit last -> released, docs not listed"
fixture docs-then-code
printf '\n<!-- sandbox note -->\n' >> "$repo/README.md"
git -C "$repo" commit -qam "docs: sandbox note"
printf '\n// sandbox tweak\n' >> "$repo/lib/index.js"
git -C "$repo" commit -qam "feat: tweak projection"
run_release "$repo"
check "exit 0"                   '[ "$rc" -eq 0 ]'
check "lists lib/index.js"       'grep -q "release:   lib/index.js" <<<"$out"'
check "does not list README.md"  '! grep -q "README.md" <<<"$out"'

echo "[2] documentation-only change -> refused, zero side effects"
fixture docs-only
printf '\n<!-- sandbox note -->\n' >> "$repo/README.md"
git -C "$repo" commit -qam "docs: sandbox note"
head_before="$(git -C "$repo" rev-parse HEAD)"
before="$(fingerprint "$repo")"; run_release "$repo"; after="$(fingerprint "$repo")"
check "exit 1"                      '[ "$rc" -eq 1 ]'
check "explains the refusal"        'grep -q "no shipped code changed" <<<"$err"'
check "promises zero side effects"  'grep -q "no version bumped, no commit, no push" <<<"$err"'
check "no stdout chatter"           '[ -z "$out" ]'
check "every ref/worktree byte identical" '[ "$before" = "$after" ]'
check "HEAD still the docs commit"  '[ "$(git -C "$repo" rev-parse HEAD)" = "$head_before" ]'
check "version still $seed_version" '[ "$(ver "$repo")" = "$seed_version" ]'

echo "[2b] prose-only manifest edit (description/keywords) -> refused"
fixture manifest-prose
node -e 'const f=process.argv[1]+"/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.description+=" (sandbox)";p.keywords.push("sandbox");fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$repo"
git -C "$repo" commit -qam "chore: reword manifest"
before="$(fingerprint "$repo")"; run_release "$repo"; after="$(fingerprint "$repo")"
check "exit 1"                   '[ "$rc" -eq 1 ]'
check "fingerprint identical"    '[ "$before" = "$after" ]'

echo "[2c] loading-affecting manifest edit (dsh.engines) -> released"
fixture manifest-load
node -e 'const f=process.argv[1]+"/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.dsh.engines.dsh=">=0.3.0";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$repo"
git -C "$repo" commit -qam "feat: raise engine floor"
run_release "$repo"
check "exit 0"                   '[ "$rc" -eq 0 ]'
check "package.json listed"      'grep -q "package.json" <<<"$out"'
check "pushed"                   '[ "$(git -C "$remote" rev-parse main)" = "$(git -C "$repo" rev-parse HEAD)" ]'

echo "[2d] tests and CI only -> refused, zero side effects"
fixture tests-ci-only
mkdir -p "$repo/tests" "$repo/.github/workflows"
printf 'console.log("sandbox")\n' > "$repo/tests/run.mjs"
printf 'on: push\n' > "$repo/.github/workflows/ci.yml"
git -C "$repo" add -A
git -C "$repo" commit -qm "test: case, ci: workflow"
before="$(fingerprint "$repo")"; run_release "$repo"; after="$(fingerprint "$repo")"
check "exit 1"                    '[ "$rc" -eq 1 ]'
check "explains the refusal"      'grep -q "no shipped code changed" <<<"$err"'
check "fingerprint identical"     '[ "$before" = "$after" ]'

echo "[2e] loading key outside the gate (exports) -> refused, but flagged as a note"
fixture manifest-exports
node -e 'const f=process.argv[1]+"/package.json",fs=require("fs"),p=JSON.parse(fs.readFileSync(f));p.exports["./extra"]="./lib/extra.js";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$repo"
git -C "$repo" commit -qam "feat: add subpath export"
before="$(fingerprint "$repo")"; run_release "$repo"; after="$(fingerprint "$repo")"
check "exit 1"                    '[ "$rc" -eq 1 ]'
check "flags exports as outside"  'grep -q "exports changed outside the release gate" <<<"$err"'
check "no stdout chatter"          '[ -z "$out" ]'
check "fingerprint identical"     '[ "$before" = "$after" ]'

echo "[3] first release (no release: commit) -> released from the beginning"
fixture first-release first
first_head="$(git -C "$repo" rev-parse HEAD)"
want="$(bumped "$repo")"
run_release "$repo"
check "exit 0"                    '[ "$rc" -eq 0 ]'
# An empty-tree base is the only base that can list the root commit's own files;
# the root-commit fallback would diff to nothing and refuse.
check "lists every shipped path"  'grep -q "lib/index.js" <<<"$out" && grep -q "lib/client.js" <<<"$out" && grep -q "cordis.patch.yml" <<<"$out"'
check "version $seed_version -> $want" '[ "$(ver "$repo")" = "$want" ]'
check "commit + push on top"      '[ "$(git -C "$repo" rev-parse HEAD~1)" = "$first_head" ] && [ "$(git -C "$remote" rev-parse main)" = "$(git -C "$repo" rev-parse HEAD)" ]'

echo "[4] dirty tree -> refused before any write"
fixture dirty
printf 'wip\n' >> "$repo/lib/index.js"
before="$(fingerprint "$repo")"; run_release "$repo"; after="$(fingerprint "$repo")"
check "exit 1"                   '[ "$rc" -eq 1 ]'
check "names the dirty tree"     'grep -q "working tree is dirty" <<<"$err"'
check "fingerprint identical"    '[ "$before" = "$after" ]'

echo "[5] off main -> refused before any write"
fixture off-main
git -C "$repo" switch -qc feature
printf '\n// sandbox\n' >> "$repo/lib/index.js"; git -C "$repo" commit -qam "feat: sandbox"
before="$(fingerprint "$repo")"; run_release "$repo"; after="$(fingerprint "$repo")"
check "exit 1"                   '[ "$rc" -eq 1 ]'
check "names the branch"         'grep -q "expected branch main" <<<"$err"'
check "fingerprint identical"    '[ "$before" = "$after" ]'

echo
echo "sandbox: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
