# j-word-agent

> AI-powered EU job search pipeline — scans 50+ job boards, scores listings with
> a structured A–F report, builds tailored CVs, notifies you on Telegram, and
> auto-fills or preps an apply cheat-sheet for every matching role.

Forked from [santifer/career-ops](https://github.com/santifer/career-ops) and
extended with EU/UK/Nordic job board integrations, an autonomous RPi/Docker
scheduler, LinkedIn guest-API search, and a Telegram-first review flow.

---

## How it works

```
portals.yml / portals.eu.yml
        │
        ▼
  scan.mjs ──► providers/ ──► EU boards (JustJoin, NoFluffJobs,
        │                       Remotive, LinkedIn, 50+ company pages)
        │
        ▼
  pipeline.md  ◄── new job URLs land here
        │
        ▼
  AI evaluation mode ──► reports/  (0–5 score, A–F blocks, EU signals)
        │
        ▼
  generate-pdf.mjs ──► output/  (tailored CV PDF)
        │
        ▼
  telegram-bot.mjs ──► Telegram job cards  (Keep / Skip / Apply buttons)
        │
        ├─ Tier 1 (Greenhouse, Lever, Ashby)
        │   └─ relay-server.mjs ──► Playwright auto-fill ──► submit from phone
        │
        └─ Tier 2/3 (Workday, Taleo, manual)
            └─ apply-card.mjs ──► cheat-sheet sent to Telegram
```

The whole pipeline runs autonomously via `scheduler.mjs --daemon`: three
scheduled scans per day, a 20:00 daily digest, a circuit breaker on repeated
failures, and an 8-command Telegram control panel.

---

## Quick start

```bash
git clone https://github.com/WioN780/j-word-agent.git
cd j-word-agent

# Install dependencies (skip postinstall that tries apt-get on non-Debian systems)
npm install --ignore-scripts
npx playwright install chromium       # ~150 MB headless browser

# Configure
cp .env.example .env
nano .env                             # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                                      # RELAY_SECRET, PI_HOSTNAME

cp config/profile.example.yml config/profile.yml
nano config/profile.yml               # your name, target roles, comp range

cp templates/portals.example.yml portals.yml

# Test
node scan.mjs --dry-run               # preview — writes nothing
node scan.mjs --notify                # scan + push Telegram cards
```

---

## Key commands

| Command | What it does |
|---|---|
| `node scan.mjs --dry-run` | Preview scanner output without writing anything |
| `node scan.mjs --notify` | Scan all portals, push Telegram job cards for new results |
| `node scan.mjs --verify` | Scan + Playwright liveness check on every URL found |
| `node scheduler.mjs --once` | One full cycle: scan → CV → notify, then exit |
| `node scheduler.mjs --daemon` | Continuous daemon: 3× daily scans, 20:00 digest, Telegram commands |
| `node telegram-bot.mjs` | Standalone Telegram listener (keep/skip/apply callbacks) |
| `node relay-server.mjs` | Phone review bridge on port 3847 (Tailscale-accessible) |
| `make start` | Start scheduler + relay via systemd (RPi) |
| `make stop` | Stop both systemd services |
| `make restart` | Restart after config changes |
| `make logs` | Tail live journalctl stream for both services |
| `make status` | Curl relay `/health` and pretty-print the JSON |
| `make scan` | `node scheduler.mjs --once` shorthand |
| `docker compose up -d` | Start scheduler + relay in Docker (amd64 + arm64) |
| `./cops scan` | Run scan inside the Docker dev container |
| `./cops shell` | Interactive bash inside the dev container |

---

## Telegram control panel

Start `node telegram-bot.mjs` (or use `scheduler.mjs --daemon`, which includes
the listener). Then message your bot:

| Command | Action |
|---|---|
| `/status` | Scheduler state, circuit-breaker health, today's stats |
| `/scan` | Trigger an immediate scan |
| `/linkedin <keywords>` | On-demand LinkedIn guest-API job search |
| `/pause` · `/stop` | Pause auto-scanning |
| `/resume` · `/start` | Resume (also resets circuit breaker) |
| `/pending` | List jobs waiting for your Keep/Skip/Apply decision |
| `/usage` | Check Claude Code subscription rate-limit usage |

---

## File map

| Path | Purpose |
|---|---|
| **`scan.mjs`** | Zero-token portal scanner; auto-discovers `providers/*.mjs` at startup |
| **`providers/`** | HTTP/API adapters: Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, Breezy, LinkedIn guest API, and more |
| **`parsers/`** | EU board parsers (JustJoin.it, NoFluffJobs, Remotive) wired in via EU-FORK markers in scan.mjs |
| **`scheduler.mjs`** | Autonomous daemon: cron-style scan times, circuit breaker (3-failure gate), disk-usage monitor, Telegram command handler |
| **`telegram-bot.mjs`** | Push job cards with Keep/Skip/Apply/Later buttons; handle callbacks; `/linkedin` on-demand search |
| **`relay-server.mjs`** | Express server bridging Telegram → live Playwright browser session → mobile approval; `/health` endpoint |
| **`ats-detector.mjs`** | URL-only ATS tier detection — Tier 1 (Greenhouse/Lever/Ashby), Tier 2 (Workday), Tier 3 (everything else) |
| **`apply-card.mjs`** | Generates pre-filled apply cheat-sheets for Tier 2/3 jobs and sends them via Telegram |
| **`generate-pdf.mjs`** | Playwright HTML → PDF renderer for tailored CV output |
| **`session-manager.mjs`** | Manages active Playwright browser sessions used by the relay server |
| **`modes/`** | AI agent evaluation prompts (English default + 13 translated variants) |
| **`config/scheduler.yml`** | Scan times, daily application limit, enabled stages, liveness check toggle |
| **`config/profile.yml`** | Your profile: target roles, compensation range, location, work-auth, EU preferences |
| **`portals.yml`** | Company career pages and job boards to scan (user layer — never auto-updated) |
| **`portals.eu.yml`** | EU-specific boards: JustJoin.it, NoFluffJobs, Remotive (EU-FORK extension) |
| **`portals.linkedin.yml`** | LinkedIn guest-API query templates — copy entries to `portals.eu.yml` to activate |
| **`data/`** | Runtime state: `scan-history.tsv`, `pipeline.md`, `applications.md`, `scheduler-state.json`, `scheduler.log` |
| **`output/`** | Generated CV PDFs |
| **`reports/`** | AI evaluation reports (`{num}-{company}-{date}.md`) |
| **`docs/`** | Setup guides written for this fork |
| **`scripts/`** | `install-rpi.sh` (Node/Playwright/system libs), `setup-systemd.sh`, service templates |
| **`Makefile`** | RPi operational shortcuts: install, start, stop, logs, scan, status |
| **`Dockerfile`** | Full dev image with Go toolchain + LaTeX (used by `./cops`) |
| **`Dockerfile.daemon`** | Slim production image (~2.5 GB smaller) for scheduler + relay containers |
| **`docker-compose.yml`** | Daemon services by default; interactive workspace via `--profile dev` |

---

## Deployment

### RPi + Void Linux

Full step-by-step: **[docs/RPI_SETUP.md](docs/RPI_SETUP.md)**

```bash
# One-time setup
bash scripts/install-rpi.sh              # Node ≥ 20, Playwright arm64, system libs
sudo bash scripts/setup-systemd.sh --start   # install + enable systemd services

# Ongoing
make logs                                # live log tail
make status                              # relay health check
make restart                             # apply config changes
```

> **Void Linux note:** the installer uses `xbps-install` for system libs and
> explicitly skips `playwright install --with-deps` (which calls apt-get). Both
> glibc aarch64 and x86_64 are supported. Void musl is not supported (Chromium
> crashes on musl ≥ 1.2.5).

### Docker (amd64 + arm64)

```bash
docker compose up -d          # start scheduler + relay (production daemons)
docker compose --profile dev up -d   # + interactive AI-agent workspace
./cops up                     # same as above via the cops wrapper
docker compose logs -f        # follow both daemon logs
```

Health check (unauthenticated):

```bash
curl http://localhost:3847/ping
# → {"ok":true}
```

Full health with scheduler stats:

```bash
curl "http://localhost:3847/health?token=$RELAY_SECRET" | jq .
```

---

## EU coverage

**Job boards** (auto-scanned via `portals.eu.yml`):
- JustJoin.it (Poland)
- NoFluffJobs (Poland, remote Europe)
- Remotive (remote worldwide, EU-heavy)
- LinkedIn guest API (any keyword/location, no login)

**Evaluation** (`modes/` + EU-FORK blocks in AGENTS.md):
- Detects EU context from currency, geography, and regulatory signals (GDPR, EU AI Act, Blue Card)
- Scores salary transparency, visa/relocation clarity, remote policy, English proficiency match
- Sub-archetypes: EU Backend, EU ML/AI/Data, EU DevOps/Platform/SRE, Generic EU SWE

**Language modes** (copy-paste into `modes/` or set `language.modes_dir` in profile):

| Folder | Market |
|---|---|
| `modes/de/` | DACH — 13. Monatsgehalt, Probezeit, Tarifvertrag, AGG |
| `modes/fr/` | France/Belgium/Switzerland — CDI, convention SYNTEC, RTT, mutuelle |
| `modes/ar/` | MENA — مكافأة نهاية الخدمة, فترة التجربة |
| `modes/ja/` | Japan — 正社員, 賞与, みなし残業 |
| `modes/tr/` | Turkey — SGK, kıdem tazminatı, brüt/net maaş |

---

## Setup guides

| Guide | Content |
|---|---|
| [docs/TELEGRAM.md](docs/TELEGRAM.md) | Bot setup, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID |
| [docs/RPI_SETUP.md](docs/RPI_SETUP.md) | Full RPi + Void Linux deployment walkthrough |
| [docs/RELAY.md](docs/RELAY.md) | Relay server + Tailscale setup for mobile form review |
| [docs/LINKEDIN.md](docs/LINKEDIN.md) | LinkedIn guest-API research findings, rate limits, query params |
| [docs/PROFILE_SETUP.md](docs/PROFILE_SETUP.md) | How to fill in `config/profile.yml` |
| [DOCKER.md](DOCKER.md) | Docker architecture, multi-arch notes, troubleshooting |

---

## Credits

Core architecture, ATS detection, evaluation modes, CV pipeline, and EU language
modes from [santifer/career-ops](https://github.com/santifer/career-ops) — the
upstream project this fork builds on. Licensed MIT.
