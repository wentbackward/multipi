SHELL := /bin/bash

check: ts shellcheck smoke hygiene

ts:
	npm run check

# Run from scripts/ so the `$scripts_dir/lib/common.sh` dot-sources resolve to the
# input file and are followed (shellcheck 0.11.0 resolves them CWD-relative).
shellcheck:
	@if command -v shellcheck >/dev/null 2>&1; then \
		(cd scripts && shellcheck *.sh lib/*.sh ../tests/fake-gh ../tests/fake-pi); \
	else \
		echo "WARNING: shellcheck not installed — skipping. Install it; the loop must not silently skip."; \
	fi

smoke:
	bash tests/smoke.sh

hygiene:
	bash tests/hygiene.sh

.PHONY: check shellcheck smoke hygiene
