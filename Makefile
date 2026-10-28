SHELL := /bin/bash

SCRIPTS := $(wildcard scripts/*.sh scripts/lib/*.sh)

check: shellcheck smoke

shellcheck:
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck $(SCRIPTS) tests/fake-gh; \
	else \
		echo "WARNING: shellcheck not installed — skipping. Install it; the loop must not silently skip."; \
	fi

smoke:
	bash tests/smoke.sh

.PHONY: check shellcheck smoke
