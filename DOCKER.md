# Running career-ops in Docker

Two modes in one compose file:

| Mode | Who it's for | Command |
|---|---|---|
| **Daemon** (default) | RPi / server production | `docker compose up -d` |
| **Dev workspace** | AI-agent interactive use | `docker compose --profile dev up -d` or `./cops up` |

---

## Architecture

```
docker-compose.yml
├── scheduler    (Dockerfile.daemon) ← autonomous scan loop
├── relay        (Dockerfile.daemon) ← phone review bridge, port 3847
└── career-ops   (Dockerfile, profile:dev) ← interactive AI-agent workspace
```

Two images:

| Image | Based on | Extra tools | Size |
|---|---|---|---|
| `j-word-agent:daemon` | playwright:v1.61.0-jammy | none | ~1.5 GB |
| `j-word-agent:local` | playwright:v1.61.0-jammy | Go, LaTeX | ~4 GB |

Both images work on **linux/amd64** and **linux/arm64** (Raspberry Pi 3 B+, 4, 5).

---

## Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version`)
- ~2 GB free disk (daemon image) or ~5 GB (full dev image)
- `.env` file with `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RELAY_SECRET`, `PI_HOSTNAME`

---

## Production daemons (RPi / server)

### Start

```bash
docker compose up -d
```

Starts `scheduler` and `relay`. Both restart automatically on failure.

### Check status

```bash
docker compose ps

# Live logs from both
docker compose logs -f

# Relay health endpoint (requires RELAY_SECRET in .env)
make status
# or:
curl -s "http://localhost:3847/health?token=$(grep RELAY_SECRET .env | cut -d= -f2)" | jq .
```

### Stop / restart

```bash
docker compose down                    # stop and remove containers
docker compose restart scheduler relay # apply config changes
```

### Rebuild after code changes

```bash
git pull
docker compose build          # rebuild daemon image
docker compose up -d          # recreate containers
```

---

## Interactive AI-agent workspace

Use this when you need to run `./cops`, evaluate offers, generate CVs, etc.

### Start

```bash
# Starts all three services (career-ops + scheduler + relay)
docker compose --profile dev up -d

# or use the ./cops wrapper:
./cops up
```

### Daily use (`./cops`)

| Task | Command |
|---|---|
| Health check | `./cops doctor` |
| One-shot scan | `./cops scan` |
| Generate PDF | `./cops pdf output/cv.html output/cv.pdf` |
| Merge tracker | `./cops merge` |
| Interactive shell | `./cops shell` |
| Daemon status | `./cops daemon` |
| Daemon logs | `./cops daemon-logs` |
| Rebuild images | `./cops rebuild` |

Unknown subcommands fall through to `docker compose exec`:

```bash
./cops npm test
./cops bash -c 'find reports -name "*.md" | wc -l'
./cops node scheduler.mjs --once
```

---

## First-time setup

```bash
# 1. Clone
git clone https://github.com/santifer/career-ops.git
cd career-ops

# 2. Configure
cp .env.example .env
nano .env   # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RELAY_SECRET, PI_HOSTNAME

# 3. Build and start daemons
docker compose up -d

# 4. Verify scheduler is running
docker compose logs scheduler | tail -20

# 5. Verify relay is healthy
docker compose ps relay    # should show (healthy)
```

---

## Health checks

**Relay** uses an unauthenticated `/ping` endpoint:

```
GET http://localhost:3847/ping
→ {"ok":true}
```

The full `/health` endpoint (requires token) returns scheduler stats + disk usage:

```bash
curl -s "http://localhost:3847/health?token=$RELAY_SECRET" | jq .
```

```json
{
  "status": "ok",
  "uptime_hours": 12.4,
  "last_scan": "2025-01-15T12:00:05.000Z",
  "pending_applications": 2,
  "today_stats": { "scanned": 3, "passed": 8, "cvs_generated": 1 },
  "disk_usage_mb": 124,
  "scheduler_paused": false,
  "circuit_open": false
}
```

**Scheduler** is healthy once `data/scheduler-state.json` exists (written after the first scan cycle).

---

## Configuration

All configuration is on the **host filesystem** (bind-mounted):

| File | Purpose |
|---|---|
| `.env` | Secrets and ports |
| `config/scheduler.yml` | Scan times, limits, stages |
| `config/profile.yml` | Your career profile |
| `portals.yml` | Companies and job boards to scan |

Edit any file on the host and restart the affected container:

```bash
# After editing config/scheduler.yml:
docker compose restart scheduler

# After editing .env:
docker compose down && docker compose up -d
```

---

## Data persistence

Everything that matters lives on the host:

```
./data/              ← scan history, tracker, scheduler state, logs
./output/            ← generated CV PDFs
./reports/           ← evaluation reports
./config/            ← profile + scheduler config
./portals.yml        ← company/job-board config
```

`docker compose down` is safe — no data is lost. Only the containers are removed.

---

## Multi-architecture (Raspberry Pi)

The `mcr.microsoft.com/playwright:v1.61.0-jammy` base image supports both
`linux/amd64` and `linux/arm64`. Docker automatically pulls the right variant.

```bash
# On RPi (arm64), this builds the arm64 image automatically:
docker compose build
docker compose up -d
```

> **arm64 note:** Playwright's bundled `chromium` works on arm64.
> `chrome` (Google Chrome) does **not** have an arm64 Linux build.
> The Dockerfiles use the base image's pre-installed Chromium — no download needed.

---

## Updating

```bash
git pull
docker compose build          # rebuild daemon image with new code + deps
docker compose up -d          # recreate containers from new image
```

Or use the built-in updater:

```bash
./cops update:check
./cops update
docker compose build && docker compose up -d
```

---

## Logs and debugging

```bash
# Follow all logs
docker compose logs -f

# Scheduler only
docker compose logs -f scheduler

# Relay only
docker compose logs -f relay

# Last 100 lines of scheduler
docker compose logs --tail=100 scheduler

# Shell inside scheduler container
docker compose exec scheduler bash

# One-shot scan (foreground, exits when done)
docker compose exec scheduler node scheduler.mjs --once
```

---

## Troubleshooting

### Containers keep restarting

```bash
docker compose logs scheduler | tail -30
```

Common causes:
- `.env` missing or empty — secrets required at startup
- Port 3847 already in use — change `RELAY_PORT` in `.env`
- Playwright Chromium crash — check logs for OOM; increase `shm_size` or set `verify_liveness: false`

### `/ping` returns connection refused

The relay isn't running or hasn't finished starting yet:

```bash
docker compose ps relay
docker compose logs relay | tail -20
```

### Scheduler shows `circuit_open: true` in /health

Three consecutive scan failures tripped the circuit breaker. Check logs, fix the issue, then:

```bash
# Via Telegram
/resume

# Or restart the container
docker compose restart scheduler
```

### node_modules volume conflicts

If you switch between the full image and daemon image, volumes can get out of sync:

```bash
# Nuclear reset — removes named volumes and rebuilds from scratch.
# Data files (data/, output/, reports/) are on bind-mounts and are NOT affected.
docker compose down -v
docker compose build
docker compose up -d
```

### Permission errors on generated files

The container runs as root. If output files end up root-owned on the host:

```bash
sudo chown -R "$USER" data/ output/ reports/
```

Or add `user: "${UID}:${GID}"` to each service in `docker-compose.yml` (export both vars first).

### API keys not reaching the container

Keys must be in `.env` (not just exported in your shell):

```bash
echo "TELEGRAM_BOT_TOKEN=..." >> .env
docker compose down && docker compose up -d
```
