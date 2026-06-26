# career-ops on a Raspberry Pi — Full Setup Guide

> **Platform:** Void Linux aarch64 (glibc) — RPi 3 B+, 4, or 5  
> **Managed by:** `scheduler.mjs` (scan daemon) + `relay-server.mjs` (phone bridge)  
> **Init system:** systemd (or runit — Void's native, see [Runit alternative](#runit-alternative))

---

## Table of contents

1. [Hardware requirements](#1-hardware-requirements)
2. [OS requirements](#2-os-requirements)
3. [Installation](#3-installation)
4. [Configuration](#4-configuration)
5. [Systemd services](#5-systemd-services)
6. [Runit alternative (Void native)](#6-runit-alternative-void-native)
7. [First run and testing](#7-first-run-and-testing)
8. [Monitoring](#8-monitoring)
9. [Updating](#9-updating)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Hardware requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Model | RPi 3 B+ (aarch64 OS) | RPi 4 / 5, 4 GB+ RAM |
| RAM | 1 GB (tight) | 4 GB (Playwright is happy) |
| Storage | 4 GB free | 16 GB SD or USB SSD |
| Network | Wi-Fi or Ethernet | Ethernet for reliability |
| Display | Not required (headless) | — |

> **RAM note:** Playwright's Chromium uses ~300–500 MB per instance. On a 1 GB RPi 3,
> enable swap (`mkswap`/`swapon`) or set `verify_liveness: false` in `config/scheduler.yml`
> to skip the browser-based liveness check during scans.

---

## 2. OS requirements

### ✅ Supported

- **Void Linux aarch64 (glibc)** — flash `void-live-aarch64-DATE.img`  
  This is the standard 64-bit Void image. Check with:
  ```bash
  uname -m           # must print: aarch64
  ldd --version      # must NOT contain "musl"
  ```

### ❌ Not supported

| OS / variant | Reason |
|---|---|
| Void Linux **musl** aarch64 | Chromium crashes on musl ≥ 1.2.5 (CLONE_SETTLS, [void-packages#55571](https://github.com/void-linux/void-packages/issues/55571)) |
| Raspbian / RPi OS **32-bit** (armv7l) | Playwright bundled Chromium requires 64-bit. Use `--use-system-chromium` flag (installs system `chromium` via xbps) |
| Any other Void flavour | Untested. Standard Debian/Ubuntu RPi OS works fine too — use `npx playwright install chromium --with-deps` instead |

### Detect your Void variant

```bash
# Check architecture
uname -m

# Check glibc vs musl
xbps-query -p architecture 2>/dev/null | grep musl && echo "MUSL — NOT SUPPORTED" || echo "glibc — OK"
```

---

## 3. Installation

### 3.1 Clone the repository

```bash
# Clone to your home directory (or /opt/career-ops for a system install)
cd ~
git clone https://github.com/santifer/career-ops.git
cd career-ops
```

### 3.2 Run the installer

```bash
bash scripts/install-rpi.sh
```

The installer:
1. Verifies aarch64 + glibc (exits on musl)
2. Checks/installs Node.js ≥ 20 via xbps
3. Runs `npm install --ignore-scripts` (skips the `--with-deps` postinstall that breaks on Void)
4. Downloads Playwright's bundled Chromium for arm64 (`~150 MB`)
5. Installs Chromium runtime libraries via `xbps-install`
6. Creates `data/`, `output/`, `reports/` directories
7. Copies `.env.example` → `.env` if not present
8. Validates required `.env` variables

**Optional flags:**

```bash
# For 32-bit ARM (armv7l) or if bundled Chromium fails:
bash scripts/install-rpi.sh --use-system-chromium

# Skip browser download (already installed):
bash scripts/install-rpi.sh --skip-playwright
```

#### Playwright on arm64 — what's happening under the hood

```
npm install --ignore-scripts       # skip postinstall (uses apt, breaks on Void)
npx playwright install chromium    # download arm64 Chromium binary (~150 MB)
xbps-install -Sy nss libdrm ...   # install runtime libs that --with-deps would normally handle
```

> **Why not `--with-deps`?** Playwright's `--with-deps` calls `apt-get`, which doesn't
> exist on Void Linux. The installer handles the dependency installation manually.

> **Why not `chrome`?** Google Chrome does **not** have an arm64 Linux build.
> Always use `chromium` (Playwright's open-source build) on arm64.

---

## 4. Configuration

### 4.1 Fill in `.env`

```bash
nano .env    # or: vim .env
```

Required variables:

```bash
# ── Telegram ──────────────────────────────────────────────────────────────────
# 1. Create a bot: message @BotFather → /newbot
# 2. Get your chat ID: message @userinfobot
TELEGRAM_BOT_TOKEN=7123456789:AAFooBar...
TELEGRAM_CHAT_ID=123456789

# ── Relay server ──────────────────────────────────────────────────────────────
# Generate: openssl rand -hex 32
RELAY_SECRET=abc123...

# Tailscale hostname or local IP of this RPi (used in phone review links)
PI_HOSTNAME=my-rpi.tail12345.ts.net
RELAY_PORT=3847
```

See `docs/TELEGRAM.md` for the Telegram setup walkthrough.  
See `docs/RELAY.md` for the relay + Tailscale setup walkthrough.

### 4.2 Tune `config/scheduler.yml`

```yaml
# Scan at 08:00, 12:00, 18:00 every day
scan_times:
  - "08:00"
  - "12:00"
  - "18:00"

# Stop scanning once 10 jobs have passed the filter today
max_applications_per_day: 10

# Set to false on memory-constrained RPi (no Playwright for liveness check)
verify_liveness: false

# Stages to run each cycle
enabled_stages:
  - scan
  - cv
  - notify
```

### 4.3 Set up portals

```bash
# If portals.yml doesn't exist yet:
cp templates/portals.example.yml portals.yml
nano portals.yml
```

---

## 5. Systemd services

> Void Linux ships **runit** as the default init. If you prefer native runit,
> skip to [§6](#6-runit-alternative-void-native).  
> To use systemd on Void: `sudo xbps-install -Sy systemd`

### 5.1 Install and enable services

```bash
sudo bash scripts/setup-systemd.sh --start
```

This:
1. Copies `scripts/systemd/*.service` to `/etc/systemd/system/`
2. Substitutes `__PROJECT_DIR__`, `__SERVICE_USER__`, `__NODE_BIN__` with real paths
3. Runs `systemctl daemon-reload`
4. Enables and starts both services

Custom paths / user:

```bash
sudo bash scripts/setup-systemd.sh \
  --user pi \
  --dir /home/pi/career-ops \
  --start
```

### 5.2 Service files

| Service | Description |
|---|---|
| `j-word-agent-scheduler` | Runs `scheduler.mjs --daemon` — the main scan loop |
| `j-word-agent-relay` | Runs `relay-server.mjs` — the phone review bridge |

Both services:
- Restart on failure after 30 s (with a 5-failure-per-10-minute systemd-level circuit breaker)
- Start after `network-online.target`
- Load environment from `.env` via `EnvironmentFile=`
- Log to journald (viewable with `make logs`)

### 5.3 Makefile shortcuts

```bash
make start     # systemctl start both services
make stop      # systemctl stop both services
make restart   # systemctl restart both (after config changes)
make logs      # live journalctl tail (Ctrl-C to exit)
make status    # curl relay /health and print JSON
make scan      # node scheduler.mjs --once (one cycle, foreground)
```

### 5.4 Uninstall

```bash
sudo bash scripts/setup-systemd.sh --uninstall
```

---

## 6. Runit alternative (Void native)

Void Linux's default init is **runit**. No extra packages are needed.
Create service directories under `/etc/sv/` (link to `/var/service/` to enable).

### 6.1 j-word-agent-scheduler

```bash
sudo mkdir -p /etc/sv/j-word-agent-scheduler
sudo tee /etc/sv/j-word-agent-scheduler/run << 'EOF'
#!/bin/sh
# career-ops scheduler service
exec 2>&1
cd /home/pi/career-ops
exec chpst -u pi env -i \
  $(cat /home/pi/career-ops/.env | grep -v '^#' | grep '=' | xargs) \
  node /home/pi/career-ops/scheduler.mjs --daemon
EOF
sudo chmod +x /etc/sv/j-word-agent-scheduler/run
```

### 6.2 j-word-agent-relay

```bash
sudo mkdir -p /etc/sv/j-word-agent-relay
sudo tee /etc/sv/j-word-agent-relay/run << 'EOF'
#!/bin/sh
exec 2>&1
cd /home/pi/career-ops
exec chpst -u pi env -i \
  $(cat /home/pi/career-ops/.env | grep -v '^#' | grep '=' | xargs) \
  node /home/pi/career-ops/relay-server.mjs
EOF
sudo chmod +x /etc/sv/j-word-agent-relay/run
```

### 6.3 Log service (optional)

```bash
sudo mkdir -p /etc/sv/j-word-agent-scheduler/log
sudo tee /etc/sv/j-word-agent-scheduler/log/run << 'EOF'
#!/bin/sh
exec svlogd -tt /var/log/j-word-agent-scheduler
EOF
sudo chmod +x /etc/sv/j-word-agent-scheduler/log/run
sudo mkdir -p /var/log/j-word-agent-scheduler
```

### 6.4 Enable services

```bash
# Enable (link into /var/service)
sudo ln -s /etc/sv/j-word-agent-scheduler /var/service/
sudo ln -s /etc/sv/j-word-agent-relay     /var/service/

# Status
sv status j-word-agent-scheduler
sv status j-word-agent-relay

# Stop / start
sv stop j-word-agent-scheduler
sv start j-word-agent-scheduler

# Logs (if log service set up)
tail -f /var/log/j-word-agent-scheduler/current
```

---

## 7. First run and testing

### 7.1 Smoke test: one scan cycle

```bash
# Run one full cycle in the foreground and exit
make scan
# or: node scheduler.mjs --once
```

Expected output:
```
[2025-01-15 08:00:01] ══════════════════════════════════════
[2025-01-15 08:00:01] 🤖 career-ops scheduler — mode: once
[2025-01-15 08:00:01]    Stages: scan, cv, notify
[2025-01-15 08:00:01] ══════════════════════════════════════
[2025-01-15 08:00:01] 🔍 Scan cycle #1 starting
[2025-01-15 08:00:01]   $ node scan.mjs --notify
[2025-01-15 08:00:08] ✅ Scan complete — 5 new offer(s), 0 error(s)
[2025-01-15 08:00:08]   📄 CV stage: rendering output/cv.html → output/cv-2025-01-15.pdf
[2025-01-15 08:00:10]   ✅ CV stage: output/cv-2025-01-15.pdf generated
[2025-01-15 08:00:10] ✅ --once cycle complete
```

### 7.2 Test the relay server

```bash
# Start relay in a separate terminal
node relay-server.mjs

# In another terminal
make status
```

Expected:
```json
{
  "status": "ok",
  "uptime_hours": 0.0,
  "last_scan": "2025-01-15T08:00:10.000Z",
  "pending_applications": 0,
  "today_stats": { "scanned": 1, "passed": 5, "cvs_generated": 1 },
  "disk_usage_mb": 64
}
```

### 7.3 Test Telegram commands

With `node scheduler.mjs --daemon` running, message your bot:

```
/status   → see scheduler health
/scan     → trigger immediate scan
/pending  → list unreviewed job cards
/usage    → Claude Code usage (if active session)
/pause    → pause scheduler
/resume   → resume (also resets circuit breaker)
```

### 7.4 Verify services survive restart

```bash
# Start services
make start

# Verify both are active
systemctl is-active j-word-agent-scheduler j-word-agent-relay

# Simulate reboot (test auto-start)
sudo reboot

# After reboot
systemctl status j-word-agent-scheduler
systemctl status j-word-agent-relay
```

---

## 8. Monitoring

### Live logs

```bash
# Both services in one stream
make logs
# or:
journalctl -u j-word-agent-scheduler -u j-word-agent-relay -f --output=short-iso

# Scheduler only (last 100 lines)
journalctl -u j-word-agent-scheduler -n 100

# Relay only
journalctl -u j-word-agent-relay -n 50

# Since last boot
journalctl -u j-word-agent-scheduler -b
```

### Scheduler log file

The scheduler also writes to `data/scheduler.log`:

```bash
tail -f data/scheduler.log
```

### Health endpoint

```bash
make status
# or directly:
curl -s "http://localhost:3847/health?token=YOUR_RELAY_SECRET" | jq .
```

The `/health` endpoint returns:

```json
{
  "status": "ok",
  "uptime_hours": 12.4,
  "last_scan": "2025-01-15T12:00:05.000Z",
  "pending_applications": 2,
  "total_applications": 47,
  "today_stats": {
    "scanned": 3,
    "passed": 8,
    "cvs_generated": 1
  },
  "disk_usage_mb": 124,
  "active_sessions": 0,
  "scheduler_paused": false,
  "circuit_open": false,
  "version": "1.0.0"
}
```

### Circuit breaker status

If the scheduler detects 3 consecutive scan failures, it opens the circuit breaker and pauses itself. You'll receive a Telegram message:

```
🔴 Circuit breaker triggered

3 consecutive scan failures detected. Possible causes:
• Playwright / Chromium crash (memory exhaustion on RPi)
• Network outage
• Configuration error

Scheduler is paused. Check logs, then send /resume to reset.
```

To recover:

```bash
# 1. Check what's failing
journalctl -u j-word-agent-scheduler -n 50

# 2. Fix the root cause (see Troubleshooting below)

# 3. Resume via Telegram
/resume

# or restart the service
make restart
```

---

## 9. Updating

```bash
cd ~/career-ops

# Pull latest
git pull

# Update deps (skip postinstall — re-install Playwright separately)
npm install --ignore-scripts

# Re-download Playwright Chromium if version changed
npx playwright install chromium

# Restart services
make restart
```

Or use the built-in updater:

```bash
node update-system.mjs check
node update-system.mjs apply
make restart
```

---

## 10. Troubleshooting

### Playwright/Chromium fails to start

**Symptom:** `scan.mjs` exits non-zero, `journalctl` shows `Missing libraries` or `Exec format error`

**Fix — glibc missing libraries:**
```bash
# Re-run the library install step
sudo xbps-install -Sy nss nspr libdrm mesa at-spi2-core dbus glib \
  pango cairo gtk+3 libX11 libXcomposite libXdamage libXext \
  libXfixes libXrandr libXi libxcb alsa-lib fontconfig freetype harfbuzz
```

**Fix — wrong arch (32-bit):**
```bash
# Use system Chromium instead
bash scripts/install-rpi.sh --use-system-chromium
```

**Fix — Chromium binary not found:**
```bash
# Reinstall Playwright's bundled browser
npx playwright install chromium

# Verify location
ls ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome
```

### Void Linux musl error

```
❌ Void Linux musl detected!
Playwright's bundled Chromium requires glibc and will not run on musl.
```

Re-flash with the glibc image: `void-live-aarch64-DATE.img` (not the `-musl-` variant).

### Relay server not accessible from phone

1. Verify the service is listening:
   ```bash
   ss -tlnp | grep 3847
   ```
2. Check `PI_HOSTNAME` in `.env` is your Tailscale IP or hostname
3. Verify Tailscale is connected: `tailscale status`
4. Try accessing: `http://PI_HOSTNAME:3847/?token=YOUR_RELAY_SECRET`

### "RELAY_SECRET not set" in `make status`

```bash
# View your secret
grep RELAY_SECRET .env

# Or set it in the shell for this command
RELAY_TOKEN=mysecret make status
```

### Scheduler paused by daily limit

```
⛔ Daily limit reached (10 jobs passed filter today).
Scheduler is paused. Send /resume to continue.
```

Either send `/resume` via Telegram, or adjust `max_applications_per_day` in `config/scheduler.yml` and restart:

```bash
make restart
```

### output/ directory growing too large (>500 MB)

The scheduler warns via Telegram when `output/` exceeds 500 MB. To clean up:

```bash
# List largest files
ls -lhS output/ | head -20

# Archive PDFs older than 30 days
mkdir -p ~/career-ops-archive
find output/ -name "*.pdf" -mtime +30 -exec mv {} ~/career-ops-archive/ \;
```

### Node.js version too old

```bash
# Void Linux usually has a current Node in xbps:
sudo xbps-install -Sy nodejs

# Verify
node --version   # should be ≥ v20
```

### Checking circuit breaker state

```bash
cat data/scheduler-state.json | python3 -m json.tool
```

Look for `"circuitOpen": true` and `"consecutiveScanFailures"`. Send `/resume` via Telegram to reset after fixing the underlying issue.

### Port 3847 conflicts

```bash
# Check what's on the port
ss -tlnp sport = :3847

# Use a different port in .env:
RELAY_PORT=8080
make restart
```

---

## Appendix: directory structure

```
~/career-ops/
├── .env                        ← your secrets (never commit)
├── config/
│   ├── scheduler.yml           ← timing, limits, stages
│   └── profile.yml             ← your profile
├── data/
│   ├── scheduler.log           ← timestamped run log
│   ├── scheduler-state.json    ← persisted scheduler state (circuit breaker, stats)
│   ├── applications.md         ← application tracker
│   ├── pipeline.md             ← inbox of URLs to evaluate
│   └── telegram-state.json     ← Telegram button state
├── output/                     ← generated CV PDFs
├── reports/                    ← evaluation reports
├── scripts/
│   ├── install-rpi.sh          ← production installer
│   ├── setup-systemd.sh        ← systemd service installer
│   └── systemd/
│       ├── j-word-agent-scheduler.service
│       └── j-word-agent-relay.service
├── scheduler.mjs               ← main orchestrator daemon
├── relay-server.mjs            ← phone review bridge
├── telegram-bot.mjs            ← Telegram card sender / callback handler
├── scan.mjs                    ← zero-token job board scanner
└── Makefile                    ← operational shortcuts
```
