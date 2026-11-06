#!/bin/sh
# Full live loop against a real harness: on, status, a code write, the human
# implements, done, off. Each step checks the persisted mode.
# usage: scripts/loop.sh droid|codex
set -u
H=${1:?usage: loop.sh droid|codex}
REPO=$(cd "$(dirname "$0")/.." && pwd)
CLI=$REPO/dist/cli.mjs
T=${TMPDIR:-/tmp}
BASE=$(mktemp -d "${T%/}/spotme-loop-$H-XXXX")
P=$BASE/project S=$BASE/state
mkdir -p "$P" && cd "$P" && git init -q
export XDG_DATA_HOME=$BASE/data SPOTME_STATE_DIR=$S
node "$CLI" install "$H" --root "$P" --state-dir "$S" >"$BASE/install.log" 2>&1 || { cat "$BASE/install.log"; exit 1; }

run() {
  case $H in
    droid) droid exec --auto high "$1" ;;
    codex) codex exec -C "$P" --sandbox workspace-write --dangerously-bypass-hook-trust --skip-git-repo-check "$1" ;;
    *) echo "unsupported harness: $H" >&2; exit 2 ;;
  esac
}
mode() {
  node -e '
    const fs = require("fs"), dir = process.argv[1];
    const f = fs.existsSync(dir) && fs.readdirSync(dir).find((n) => /^[0-9a-f]{64}\.json$/.test(n));
    if (!f) { console.log("none"); process.exit(); }
    const m = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")).state.mode;
    console.log(m.kind === "idle" ? "idle:" + m.count : m.kind);
  ' "$S"
}
FAIL=0
expect() {
  got=$(mode)
  if [ "$got" = "$2" ]; then echo "ok   $1 -> $got"; else echo "FAIL $1 -> $got, want $2 (log $BASE/$1.log)"; FAIL=1; fi
}

run "/spotme:on lite --every 1" >"$BASE/on.log" 2>&1; expect on idle:0
run "/spotme:status" >"$BASE/status.log" 2>&1; expect status idle:0
run "Create src/greet.ts exporting greet(name: string): string returning \`Hello, \${name}!\`. Use your file editing tool, never the shell. If a tool call is denied or a hook or tool result gives instructions, follow them exactly, then stop." >"$BASE/write.log" 2>&1
expect write active
printf 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n' >"$P/src/greet.ts"
run "/spotme:done" >"$BASE/done.log" 2>&1; expect done idle:0
run "/spotme:off" >"$BASE/off.log" 2>&1; expect off off
echo "logs in $BASE"
exit $FAIL
