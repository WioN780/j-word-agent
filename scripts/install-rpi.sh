#!/usr/bin/env bash
# scripts/install-rpi.sh — j-word-agent production installer for Raspberry Pi / Void Linux
#
# Tested on: Void Linux aarch64 (glibc) — RPi 3 B+, 4, 5
#
# ⚠️  MUSL WARNING: Do NOT run this on Void Linux musl. Playwright's bundled
#     Chromium requires glibc. Chromium from xbps also crashes on musl ≥ 1.2.5
#     due to CLONE_SETTLS (void-packages #55571). Use glibc Void Linux instead.
#
# ⚠️  ARCH WARNING: Playwright's bundled Chromium supports linux-arm64 (aarch64)
#     but NOT linux-arm (armv7l / 32-bit). On RPi 2 or 32-bit OS installs,
#     use the system Chromium workaround documented at the end of this script.
#
# Usage:
#   bash scripts/install-rpi.sh
#   bash scripts/install-rpi.sh --skip-playwright   # if browser already installed
#   bash scripts/install-rpi.sh --use-system-chromium  # use xbps chromium instead

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
YEL='\033[1;33m'
GRN='\033[0;32m'
CYN='\033[0;36m'
BLD='\033[1m'
RST='\033[0m'

ok()   { echo -e "${GRN}✅ $*${RST}"; }
warn() { echo -e "${YEL}⚠️  $*${RST}"; }
err()  { echo -e "${RED}❌ $*${RST}" >&2; }
info() { echo -e "${CYN}ℹ️  $*${RST}"; }
hdr()  { echo -e "\n${BLD}── $* ──${RST}"; }

# ── Flags ─────────────────────────────────────────────────────────────────────

SKIP_PLAYWRIGHT=false
USE_SYSTEM_CHROMIUM=false

for arg in "$@"; do
  case "$arg" in
    --skip-playwright)     SKIP_PLAYWRIGHT=true ;;
    --use-system-chromium) USE_SYSTEM_CHROMIUM=true ;;
    --help|-h)
      echo "Usage: $0 [--skip-playwright] [--use-system-chromium]"
      exit 0 ;;
  esac
done

# ── Script location → project root ────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo -e "\n${BLD}j-word-agent RPi installer${RST}"
echo   "Project: $PROJECT_DIR"
echo   "Date:    $(date '+%Y-%m-%d %H:%M:%S')"

# ── 1. Architecture check ─────────────────────────────────────────────────────

hdr "Architecture"

ARCH="$(uname -m)"
info "Detected arch: $ARCH"

if [[ "$ARCH" == "aarch64" ]]; then
  ok "arm64 (aarch64) — Playwright bundled Chromium fully supported"
elif [[ "$ARCH" == "armv7l" ]]; then
  warn "32-bit ARM (armv7l) detected. Playwright bundled Chromium does NOT support 32-bit."
  warn "Enabling --use-system-chromium automatically."
  USE_SYSTEM_CHROMIUM=true
else
  warn "Unexpected arch: $ARCH — assuming x86_64, proceeding."
fi

# Detect Void Linux musl
if command -v xbps-install &>/dev/null; then
  if [[ "$(xbps-query -p architecture | grep -o 'musl')" == "musl" ]] 2>/dev/null; then
    err "Void Linux musl detected!"
    echo   "Playwright's bundled Chromium requires glibc and will not run on musl."
    echo   "Void Linux Chromium from xbps also crashes on musl ≥ 1.2.5 (void-packages#55571)."
    echo   "Please reinstall Void Linux using the glibc image (void-live-aarch64-*.img)."
    exit 1
  fi
fi

# ── 2. Node.js version check ──────────────────────────────────────────────────

hdr "Node.js"

REQUIRED_NODE=20

install_node_void() {
  info "Installing Node.js via xbps-install..."
  if [[ "$(id -u)" == "0" ]]; then
    xbps-install -Sy nodejs
  else
    sudo xbps-install -Sy nodejs
  fi
}

if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -ge $REQUIRED_NODE ]]; then
    ok "Node.js $(node --version) — requirement met (≥ v${REQUIRED_NODE})"
  else
    warn "Node.js $(node --version) is too old (need ≥ v${REQUIRED_NODE})"
    if command -v xbps-install &>/dev/null; then
      install_node_void
    else
      err "Cannot auto-install Node.js — xbps-install not found."
      echo   "Install Node.js 20+ manually from https://nodejs.org"
      exit 1
    fi
  fi
else
  warn "Node.js not found"
  if command -v xbps-install &>/dev/null; then
    install_node_void
  else
    err "Cannot auto-install Node.js — xbps-install not found."
    echo   "Install Node.js 20+ from https://nodejs.org, then re-run this script."
    exit 1
  fi
fi

# Verify again after possible install
NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VER" -lt $REQUIRED_NODE ]]; then
  err "Node.js $(node --version) still below v${REQUIRED_NODE} after install attempt."
  exit 1
fi

# ── 3. npm dependencies ───────────────────────────────────────────────────────

hdr "npm dependencies"

# On Void Linux the postinstall script runs:
#   npx playwright install chromium --with-deps
# --with-deps uses apt-get which does not exist on Void. We skip postinstall
# here and handle Playwright installation separately in step 4.

if [[ -d node_modules ]]; then
  info "node_modules exists — running npm install to sync"
else
  info "Installing npm dependencies..."
fi

npm install --ignore-scripts
ok "npm dependencies installed"

# ── 4. Playwright Chromium ────────────────────────────────────────────────────

hdr "Playwright Chromium"

if $SKIP_PLAYWRIGHT; then
  warn "--skip-playwright set — skipping browser download"

elif $USE_SYSTEM_CHROMIUM; then
  # ── Option B: system Chromium from xbps ───────────────────────────────────
  info "Installing system Chromium via xbps-install..."
  if command -v xbps-install &>/dev/null; then
    if [[ "$(id -u)" == "0" ]]; then
      xbps-install -Sy chromium
    else
      sudo xbps-install -Sy chromium
    fi
    ok "System Chromium installed"
  else
    err "xbps-install not found — cannot install system Chromium"
    exit 1
  fi

  # Locate the chromium binary
  CHROMIUM_BIN=""
  for p in /usr/bin/chromium /usr/bin/chromium-browser /usr/lib/chromium/chromium; do
    if [[ -x "$p" ]]; then
      CHROMIUM_BIN="$p"
      break
    fi
  done

  if [[ -z "$CHROMIUM_BIN" ]]; then
    err "Cannot find chromium binary after install"
    exit 1
  fi

  ok "System Chromium at: $CHROMIUM_BIN"

  # Add PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to .env if not already set
  if [[ -f .env ]] && ! grep -q 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH' .env; then
    echo "" >> .env
    echo "# System Chromium (arm32 / use-system-chromium mode)" >> .env
    echo "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$CHROMIUM_BIN" >> .env
    info "Added PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$CHROMIUM_BIN to .env"
  fi

  # Tell Playwright where the browser is by creating a minimal browsers.json shim
  # Playwright checks PLAYWRIGHT_BROWSERS_PATH; pointing it to our helper dir
  # lets existing code work without changes.
  info "Configuring Playwright to use system Chromium..."
  PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

  # Find the chromium versioned dir Playwright expects
  PW_CHROMIUM_DIR=$(npx playwright install chromium --dry-run 2>&1 \
    | grep -oE 'chromium-[0-9]+' | head -1 || echo "")

  if [[ -n "$PW_CHROMIUM_DIR" ]]; then
    LINK_DIR="$PW_CACHE/$PW_CHROMIUM_DIR/chrome-linux"
    mkdir -p "$LINK_DIR"
    ln -sf "$CHROMIUM_BIN" "$LINK_DIR/chrome"
    ok "Symlinked $CHROMIUM_BIN → $LINK_DIR/chrome"
  else
    warn "Could not determine Playwright chromium directory — symlink not created."
    warn "You may need to set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH manually in .env"
    warn "and launch with: chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })"
  fi

else
  # ── Option A: Playwright's bundled arm64 Chromium (recommended for aarch64) ─

  info "Downloading Playwright bundled Chromium for arm64..."
  info "This downloads ~150 MB. It may take several minutes on a slow connection."

  # We explicitly do NOT pass --with-deps because Void uses xbps, not apt.
  # System dependencies are installed in the next step.
  npx playwright install chromium

  ok "Playwright Chromium downloaded"
fi

# ── 5. Chromium system library dependencies ───────────────────────────────────

hdr "Chromium system libraries"

# These are required even in headless mode because Chromium links against them.
# This list mirrors what `playwright install-deps` would install on Debian/Ubuntu,
# translated to Void Linux xbps package names.

VOID_CHROMIUM_DEPS=(
  # Core: NSS (HTTPS), NSPR
  nss nspr

  # Printing / fonts
  cups-libs fontconfig freetype harfbuzz

  # DRM / GPU (needed even in headless for hardware-accelerated compositing)
  libdrm mesa

  # IPC / accessibility
  at-spi2-core dbus glib

  # Text rendering
  pango cairo

  # GTK (Chromium links against it for dialogs, even headless)
  gtk+3

  # Display / X11 (linked by Chromium even in --headless=new mode)
  libX11 libXcomposite libXdamage libXext libXfixes
  libXrandr libXi libxcb libXrender

  # Misc
  alsa-lib expat libuuid
)

if command -v xbps-install &>/dev/null; then
  info "Installing Chromium runtime dependencies via xbps-install..."
  if [[ "$(id -u)" == "0" ]]; then
    xbps-install -Sy "${VOID_CHROMIUM_DEPS[@]}" || \
      warn "Some packages may already be installed or not found — continuing"
  else
    sudo xbps-install -Sy "${VOID_CHROMIUM_DEPS[@]}" || \
      warn "Some packages may already be installed or not found — continuing"
  fi
  ok "System libraries installed"
else
  warn "xbps-install not found — skipping system library install."
  warn "Chromium may fail to start if required libs are missing."
  warn "On non-Void systems, run: npx playwright install-deps chromium"
fi

# ── 6. Directory structure ────────────────────────────────────────────────────

hdr "Directories"

mkdir -p data output batch/tracker-additions data/apply-cards interview-prep reports jds
ok "data/, output/, batch/, reports/ created"

# ── 7. Environment file ───────────────────────────────────────────────────────

hdr "Environment (.env)"

if [[ -f .env ]]; then
  ok ".env already exists — not overwriting"
else
  if [[ -f .env.example ]]; then
    cp .env.example .env
    ok "Copied .env.example → .env"
  else
    # Create a minimal .env template
    cat > .env << 'ENVEOF'
# j-word-agent environment — fill in all values before starting services

# ── Telegram bot (required for notifications & commands) ──────────────────────
# Get token from @BotFather, get chat ID from @userinfobot
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# ── Relay server (required for phone-based form review) ───────────────────────
# Generate a long random secret: openssl rand -hex 32
RELAY_SECRET=
# Your Raspberry Pi's Tailscale hostname or LAN IP
PI_HOSTNAME=
RELAY_PORT=3847
ENVEOF
    ok "Created minimal .env template"
  fi
  warn "Edit .env and fill in all required values before starting!"
fi

# ── 8. Validate required .env variables ──────────────────────────────────────

hdr "Environment validation"

# Load .env for validation (simple key=value parsing, no bash eval)
declare -A ENV_VALS
while IFS='=' read -r key val; do
  # Skip comments and blank lines
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  # Strip inline comments and surrounding quotes
  val="${val%%#*}"
  val="${val%"${val##*[![:space:]]}"}"
  val="${val#\"}" val="${val%\"}"
  val="${val#\'}" val="${val%\'}"
  ENV_VALS["$key"]="$val"
done < <(grep -v '^#' .env 2>/dev/null || true)

VALIDATION_FAILED=false

check_var() {
  local var="$1" desc="$2" required="${3:-true}"
  local val="${ENV_VALS[$var]:-}"
  if [[ -z "$val" ]]; then
    if [[ "$required" == "true" ]]; then
      err "$var is not set — $desc"
      VALIDATION_FAILED=true
    else
      warn "$var is not set — $desc (optional)"
    fi
  else
    ok "$var is set"
  fi
}

check_var "TELEGRAM_BOT_TOKEN" "required for Telegram notifications"
check_var "TELEGRAM_CHAT_ID"   "required for Telegram notifications"
check_var "RELAY_SECRET"       "required for relay server auth"
check_var "PI_HOSTNAME"        "RPi hostname/IP for relay links" false

if $VALIDATION_FAILED; then
  warn ""
  warn "Some required variables are missing. Edit .env and re-run this script."
  warn "See docs/TELEGRAM.md and docs/RELAY.md for setup instructions."
  echo ""
fi

# ── 9. Quick smoke test ───────────────────────────────────────────────────────

hdr "Smoke test"

info "Testing Node.js modules..."
if node -e "require('js-yaml'); require('dotenv'); require('node-telegram-bot-api'); console.log('OK')" 2>/dev/null; then
  ok "Core Node.js modules load successfully"
else
  err "Module load test failed — check npm install output above"
fi

info "Testing Playwright Chromium..."
if $USE_SYSTEM_CHROMIUM && [[ -n "${CHROMIUM_BIN:-}" ]]; then
  if "$CHROMIUM_BIN" --version &>/dev/null; then
    ok "System Chromium: $($CHROMIUM_BIN --version 2>/dev/null | head -1)"
  else
    warn "System Chromium binary found but --version failed"
  fi
elif ! $SKIP_PLAYWRIGHT; then
  PW_TEST=$(node -e "
    import('playwright').then(m => {
      return m.chromium.launch({ headless: true }).then(b => {
        return b.close().then(() => console.log('OK'));
      });
    }).catch(e => { console.error(e.message); process.exit(1); });
  " 2>&1 || true)
  if echo "$PW_TEST" | grep -q 'OK'; then
    ok "Playwright Chromium launches successfully"
  else
    warn "Playwright Chromium launch test failed:"
    echo "$PW_TEST" | head -5 | sed 's/^/    /'
    warn "This may be OK if you're on a system without a display."
    warn "Chromium runs headless in production — re-test after deployment."
  fi
fi

# ── 10. Summary ───────────────────────────────────────────────────────────────

hdr "Installation complete"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit .env and fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,"
echo "     RELAY_SECRET, and PI_HOSTNAME"
echo ""
echo "  2. Set up systemd services (or runit — see docs/RPI_SETUP.md):"
echo "       bash scripts/setup-systemd.sh"
echo ""
echo "  3. Run a test scan to verify the full pipeline:"
echo "       make scan"
echo "       # or: node scheduler.mjs --once"
echo ""
echo "  4. Start services:"
echo "       make start"
echo ""
echo "  See docs/RPI_SETUP.md for detailed instructions."
echo ""
