#!/usr/bin/env bash
# Install the multipi dev loop into a target project:
#   scripts/                  (versioned with the target)
#   .pi/extensions/multipi-devloop/   (extension + agents copy for the bundled fallback)
#   .pi/agents/               (role prompts; project layer, overrides the bundled copy)
#   .pi/skills/devloop*/      (orchestrator skills)
# Idempotent: re-running syncs from this repo. Usage: install.sh [target-repo]   (default: current dir)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
plugin_root=$(cd "$here/.." && pwd)
target=${1:-.}
target=$(cd "$target" && pwd)

# A worktree's .git is a FILE pointing at the main repo, not a directory — and bare
# repos have neither at the top level. Validate with git itself so a stray file named
# .git in a non-repo never passes (any of the shapes git accepts is acceptable here).
git -C "$target" rev-parse --git-common-dir >/dev/null 2>&1 || { echo "install: $target is not a git repository" >&2; exit 2; }

# 1. scripts/ — the deterministic backbone, versioned inside the target (skipped when installing
#    the plugin into itself)
if [ "$(realpath "$plugin_root/scripts")" != "$(realpath "$target/scripts" 2>/dev/null || echo "$target/scripts")" ]; then
	mkdir -p "$target/scripts"
	cp -f "$plugin_root"/scripts/*.sh "$target/scripts/"
	mkdir -p "$target/scripts/lib"
	cp -f "$plugin_root/scripts/lib/"*.sh "$target/scripts/lib/"
	chmod +x "$target"/scripts/*.sh "$target/scripts/lib/"*.sh
	# The operator's ask-mint CLI (spec §6). Deliberately NOT a .sh name: it is the
	# operator's tool, never a loop script, and the seeded Bash(*multipi-approve*)
	# deny keeps the policy'd session from minting its own approvals.
	cp -f "$plugin_root"/scripts/multipi-approve "$target/scripts/"
	chmod +x "$target/scripts/multipi-approve"
	# policy shims (ticket #41): the Layer-2 git/gh wrappers + shared helper. Kept OUT of the
	# scripts/*.sh trusted set on purpose: they are not loop programs, and the §5 identity
	# check keys on both the checkout's scripts dir and the .sh suffix.
	mkdir -p "$target/scripts/policy-shims/lib"
	cp -f "$plugin_root/scripts/policy-shims/git" "$plugin_root/scripts/policy-shims/gh" "$target/scripts/policy-shims/"
	cp -f "$plugin_root/scripts/policy-shims/lib/"*.sh "$target/scripts/policy-shims/lib/"
	chmod +x "$target/scripts/policy-shims/git" "$target/scripts/policy-shims/gh"
fi

# 2. extension (self-contained copy, incl. agents for the bundled-dir fallback)
dest_ext="$target/.pi/extensions/multipi-devloop"
mkdir -p "$dest_ext"
cp -f "$plugin_root/extension/index.ts" "$dest_ext/"
mkdir -p "$dest_ext/src"
cp -f "$plugin_root/extension/src/"*.ts "$dest_ext/src/"
mkdir -p "$dest_ext/agents"
cp -f "$plugin_root/agents/"*.md "$dest_ext/agents/"
# The extension's package.json is OWNED BY THE INSTALLER (ticket #37): it is
# rewritten on every sync — never copied — so a stale local copy (an npm-init'd
# type:commonjs manifest left in the extension dir to host the runtime probe's
# node_modules) can no longer survive an upgrade and force CJS parsing of the
# ESM .ts sources (which silently kills the doctor's factory report). Same
# ownership class as the scripts/ copy: the installer, not the target repo,
# decides the bytes. The dep pins mirror this repo's package.json devDeps.
cat >"$dest_ext/package.json" <<'EOF'
{
  "name": "multipi-devloop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "typebox": "1.3.27"
  }
}
EOF
cp -f "$plugin_root/extension/tsconfig.json" "$dest_ext/" 2>/dev/null || true

# 3. role prompts at the project layer (these win over the bundled copy)
mkdir -p "$target/.pi/agents"
cp -f "$plugin_root/agents/"*.md "$target/.pi/agents/"

# 4. orchestrator skills
for skill in "$plugin_root"/skills/*/; do
	name=$(basename "$skill")
	mkdir -p "$target/.pi/skills/$name"
	cp -f "$skill"SKILL.md "$target/.pi/skills/$name/SKILL.md"
done

# 5. templates for the setup skill to reference
mkdir -p "$target/.pi/templates"
cp -f "$plugin_root/templates/devloop.json" "$target/.pi/templates/devloop.json"

echo "install: multipi dev loop installed into $target"
echo "install: next: write $target/.devloop.json (see .pi/templates/devloop.json), then run scripts/doctor.sh"
