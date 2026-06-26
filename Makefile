# career-ops — Makefile for Raspberry Pi production management
#
# Usage:
#   make install   → runs scripts/install-rpi.sh
#   make start     → start both systemd services
#   make stop      → stop both systemd services
#   make restart   → restart both services
#   make logs      → live journalctl tail for both services
#   make scan      → run one full scan cycle and exit
#   make status    → curl the relay /health endpoint (JSON)
#   make setup     → install systemd services (needs sudo)
#
# Required tools: node, systemctl, curl, jq (optional, for pretty status)

.PHONY: install start stop restart logs scan status setup help

# ── Read config from .env ─────────────────────────────────────────────────────
# These are read at rule expansion time, not at include time, so missing .env
# doesn't cause make to fail on unrelated targets.

_relay_port  = $(shell grep -s '^RELAY_PORT=' .env  | head -1 | cut -d= -f2 | tr -d "\"'" | grep . || echo 3847)
_relay_token = $(shell grep -s '^RELAY_SECRET=' .env | head -1 | cut -d= -f2 | tr -d "\"'")

RELAY_PORT  ?= $(shell echo $(_relay_port))
RELAY_TOKEN ?= $(shell echo $(_relay_token))

SERVICES = j-word-agent-scheduler j-word-agent-relay

# ── Targets ───────────────────────────────────────────────────────────────────

## install: run the RPi install script (installs Node, Playwright, system libs)
install:
	bash scripts/install-rpi.sh

## setup: install and enable systemd services (needs sudo)
setup:
	sudo bash scripts/setup-systemd.sh --start

## start: start both services
start:
	systemctl start $(SERVICES)
	@echo "✅ Services started"
	@systemctl is-active --quiet j-word-agent-scheduler && echo "  scheduler: running" || echo "  scheduler: not running"
	@systemctl is-active --quiet j-word-agent-relay    && echo "  relay:     running" || echo "  relay:     not running"

## stop: stop both services
stop:
	systemctl stop $(SERVICES) || true
	@echo "⏹  Services stopped"

## restart: restart both services (applies after config changes)
restart:
	systemctl restart $(SERVICES)
	@echo "🔄 Services restarted"

## logs: live log stream for both services (Ctrl-C to exit)
logs:
	journalctl -u j-word-agent-scheduler -u j-word-agent-relay -f --output=short-iso

## scan: run one full scan cycle (foreground, exits when done)
scan:
	node scheduler.mjs --once

## status: query the relay /health endpoint
status:
	@if [ -z "$(RELAY_TOKEN)" ]; then \
	  echo "⚠️  RELAY_SECRET not set in .env — health check requires auth"; \
	  echo "   Run: grep RELAY_SECRET .env"; \
	  exit 1; \
	fi
	@URL="http://localhost:$(RELAY_PORT)/health?token=$(RELAY_TOKEN)"; \
	echo "→ GET $$URL"; \
	if command -v jq >/dev/null 2>&1; then \
	  curl -sf "$$URL" | jq .; \
	else \
	  curl -sf "$$URL" | python3 -m json.tool 2>/dev/null || curl -sf "$$URL"; \
	fi

## help: show this help
help:
	@echo ""
	@echo "career-ops — Makefile targets"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  make /'
	@echo ""
