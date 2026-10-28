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

[ -d "$target/.git" ] || { echo "install: $target is not a git repository" >&2; exit 2; }

# 1. scripts/ — the deterministic backbone, versioned inside the target (skipped when installing
#    the plugin into itself)
if [ "$(realpath "$plugin_root/scripts")" != "$(realpath "$target/scripts" 2>/dev/null || echo "$target/scripts")" ]; then
	mkdir -p "$target/scripts"
	cp -f "$plugin_root"/scripts/*.sh "$target/scripts/"
	mkdir -p "$target/scripts/lib"
	cp -f "$plugin_root/scripts/lib/"*.sh "$target/scripts/lib/"
	chmod +x "$target"/scripts/*.sh "$target/scripts/lib/"*.sh
fi

# 2. extension (self-contained copy, incl. agents for the bundled-dir fallback)
dest_ext="$target/.pi/extensions/multipi-devloop"
mkdir -p "$dest_ext"
cp -f "$plugin_root/extension/index.ts" "$dest_ext/"
mkdir -p "$dest_ext/src"
cp -f "$plugin_root/extension/src/"*.ts "$dest_ext/src/"
mkdir -p "$dest_ext/agents"
cp -f "$plugin_root/agents/"*.md "$dest_ext/agents/"
cp -f "$plugin_root/extension/package.json" "$dest_ext/" 2>/dev/null || true
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
