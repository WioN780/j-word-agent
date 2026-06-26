#!/usr/bin/env bash
# scripts/setup-systemd.sh — Install career-ops systemd services
#
# Run as root (or with sudo). Copies service templates from scripts/systemd/
# to /etc/systemd/system/, substitutes the project path and user, then
# enables and optionally starts both services.
#
# Usage:
#   sudo bash scripts/setup-systemd.sh
#   sudo bash scripts/setup-systemd.sh --user myuser --dir /opt/career-ops
#   sudo bash scripts/setup-systemd.sh --start          # also start services now
#   sudo bash scripts/setup-systemd.sh --uninstall      # remove & disable services

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'
CYN='\033[0;36m'; BLD='\033[1m'; RST='\033[0m'

ok()   { echo -e "${GRN}✅ $*${RST}"; }
warn() { echo -e "${YEL}⚠️  $*${RST}"; }
err()  { echo -e "${RED}❌ $*${RST}" >&2; }
info() { echo -e "${CYN}ℹ️  $*${RST}"; }
hdr()  { echo -e "\n${BLD}── $* ──${RST}"; }

# ── Defaults ──────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_TEMPLATES="$SCRIPT_DIR/systemd"
SYSTEMD_DIR="/etc/systemd/system"

# Default to the user who invoked sudo (or current user)
SERVICE_USER="${SUDO_USER:-$(whoami)}"
SERVICE_DIR="$PROJECT_DIR"
DO_START=false
DO_UNINSTALL=false

SERVICES=(j-word-agent-scheduler j-word-agent-relay)

# ── Parse arguments ───────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)     SERVICE_USER="$2"; shift 2 ;;
    --dir)      SERVICE_DIR="$2";  shift 2 ;;
    --start)    DO_START=true;     shift ;;
    --uninstall) DO_UNINSTALL=true; shift ;;
    --help|-h)
      echo "Usage: sudo $0 [--user USER] [--dir /path/to/career-ops] [--start] [--uninstall]"
      exit 0 ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Root check ────────────────────────────────────────────────────────────────

if [[ "$(id -u)" != "0" ]]; then
  err "This script must be run as root."
  echo "  Try: sudo bash scripts/setup-systemd.sh"
  exit 1
fi

# ── systemd availability check ────────────────────────────────────────────────

if ! command -v systemctl &>/dev/null; then
  err "systemctl not found."
  echo ""
  echo "  Void Linux uses runit by default, not systemd."
  echo "  To install systemd: xbps-install -Sy systemd"
  echo "  Or, use the runit services documented in docs/RPI_SETUP.md"
  echo "  (they work out of the box on Void without installing anything extra)."
  exit 1
fi

# ── Uninstall path ────────────────────────────────────────────────────────────

if $DO_UNINSTALL; then
  hdr "Uninstalling services"
  for svc in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
      systemctl stop "$svc"
      ok "Stopped $svc"
    fi
    if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
      systemctl disable "$svc"
      ok "Disabled $svc"
    fi
    if [[ -f "$SYSTEMD_DIR/$svc.service" ]]; then
      rm "$SYSTEMD_DIR/$svc.service"
      ok "Removed $SYSTEMD_DIR/$svc.service"
    fi
  done
  systemctl daemon-reload
  ok "Services removed"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────

echo -e "\n${BLD}career-ops systemd service installer${RST}"
info "Project dir: $SERVICE_DIR"
info "Service user: $SERVICE_USER"

hdr "Validating prerequisites"

# Verify user exists
if ! id -u "$SERVICE_USER" &>/dev/null; then
  err "User '$SERVICE_USER' does not exist."
  echo "  Create with: useradd -m $SERVICE_USER"
  exit 1
fi
ok "User '$SERVICE_USER' exists"

# Verify project dir
if [[ ! -f "$SERVICE_DIR/scheduler.mjs" ]]; then
  err "scheduler.mjs not found in $SERVICE_DIR"
  echo "  Make sure --dir points to the career-ops project root."
  exit 1
fi
ok "Project directory validated"

# Verify .env exists
if [[ ! -f "$SERVICE_DIR/.env" ]]; then
  warn ".env not found in $SERVICE_DIR — services will start without environment variables"
  warn "Run: bash scripts/install-rpi.sh first"
fi

# Find node binary
NODE_BIN="$(command -v node 2>/dev/null || echo '')"
if [[ -z "$NODE_BIN" ]]; then
  err "node not found in PATH"
  exit 1
fi
ok "Node.js at $NODE_BIN"

hdr "Installing service units"

install_service() {
  local name="$1"
  local template="$SERVICE_TEMPLATES/$name.service"
  local dest="$SYSTEMD_DIR/$name.service"

  if [[ ! -f "$template" ]]; then
    err "Service template not found: $template"
    exit 1
  fi

  # Substitute placeholders
  sed \
    -e "s|__PROJECT_DIR__|$SERVICE_DIR|g" \
    -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$template" > "$dest"

  ok "Installed $dest"
}

for svc in "${SERVICES[@]}"; do
  install_service "$svc"
done

hdr "Enabling services"

systemctl daemon-reload
ok "daemon-reload complete"

for svc in "${SERVICES[@]}"; do
  systemctl enable "$svc"
  ok "Enabled $svc (starts on boot)"
done

if $DO_START; then
  hdr "Starting services"
  for svc in "${SERVICES[@]}"; do
    systemctl start "$svc"
    ok "Started $svc"
  done

  sleep 2

  hdr "Status check"
  for svc in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$svc"; then
      ok "$svc is running"
    else
      warn "$svc is not active — check: journalctl -u $svc -n 30"
    fi
  done
fi

hdr "Done"
echo ""
echo "  Start services now:"
echo "    make start"
echo "    # or: systemctl start j-word-agent-scheduler j-word-agent-relay"
echo ""
echo "  View logs:"
echo "    make logs"
echo "    # or: journalctl -u j-word-agent-scheduler -u j-word-agent-relay -f"
echo ""
echo "  Health check:"
echo "    make status"
echo ""
if ! $DO_START; then
  warn "Services are enabled but NOT started yet."
  warn "Run 'make start' or 'systemctl start j-word-agent-scheduler j-word-agent-relay'"
fi
