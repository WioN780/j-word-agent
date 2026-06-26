# Relay Server

Mobile-friendly web UI for reviewing and submitting job applications from your phone. The relay server runs on a Raspberry Pi (or any always-on host) and is accessed via Tailscale.

```
┌────────────┐    Telegram     ┌───────────┐    Tailscale    ┌───────────┐
│  scan.mjs  │ ──────────────→ │   Phone   │ ──────────────→ │    RPi    │
│  (finds    │  "Ready to      │  (tap URL │   HTTP GET      │  relay-   │
│   jobs)    │   review" link  │   to      │                 │  server   │
└────────────┘                 │   review) │ ←────────────── │  .mjs     │
                               │           │   HTML + live   │           │
      ┌────────────────────────│  Approve  │   screenshot    │  Browser  │
      │  Telegram              │  / Reject │ ──────────────→ │  Session  │
      │  confirmation          └───────────┘   POST submit   │  (PW)    │
      ▼                                                      └───────────┘
```

## Prerequisites

- **Node.js** 18+
- **Playwright** (installed via `npm install`)
- **Tailscale** set up on both the RPi and your phone
- **Telegram bot** already configured (see [TELEGRAM.md](TELEGRAM.md))

## Setup

### 1. Install Express

```bash
npm install express
```

### 2. Configure environment variables

Add these to your `.env`:

```env
# Relay server
RELAY_SECRET=your_strong_random_secret_here
PI_HOSTNAME=your-pi.tailnet-name.ts.net
RELAY_PORT=3847   # optional, defaults to 3847
```

**Generate a strong secret:**

```bash
# Linux/macOS
openssl rand -hex 32

# PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

**Find your Tailscale hostname:**

```bash
tailscale status
# Look for your RPi's hostname, e.g. "raspi4.tail12345.ts.net"
```

### 3. Start the server

```bash
node relay-server.mjs
```

You should see:

```
🔗 career-ops relay server running
   Local:     http://localhost:3847/
   Tailscale: http://your-pi.tailnet-name.ts.net:3847/
   Health:    http://localhost:3847/health?token=***

   Token auth: enabled
   Pending:    2 applications
```

### 4. Run as a service (recommended)

Create a systemd service so it starts automatically:

```bash
sudo nano /etc/systemd/system/j-word-agent-relay.service
```

```ini
[Unit]
Description=career-ops relay server
After=network.target tailscaled.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/career-ops
ExecStart=/usr/bin/node relay-server.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable j-word-agent-relay
sudo systemctl start j-word-agent-relay
sudo systemctl status j-word-agent-relay   # verify it's running
```

## Routes

All routes require authentication via `?token=<RELAY_SECRET>` or `Authorization: Bearer <RELAY_SECRET>` header.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Dashboard — lists all pending applications |
| GET | `/apply/:job_id` | Review page — job info, live screenshot, Approve/Reject buttons |
| POST | `/apply/:job_id/approve` | Clicks submit in browser, sends Telegram confirmation |
| POST | `/apply/:job_id/reject` | Closes browser tab, marks application rejected |
| GET | `/screenshot/:job_id` | Returns live PNG screenshot (used for auto-refresh polling) |
| GET | `/health` | JSON health check |

## How It Works

### Workflow

1. **scan.mjs** finds a Tier 1 job (Greenhouse/Ashby/Lever)
2. **session-manager.mjs** opens the browser, fills the form, saves to `data/pending-applications.json`
3. **telegram-bot.mjs** sends a card with a relay URL: `http://PI_HOSTNAME:3847/apply/JOB_ID?token=SECRET`
4. You tap the link on your phone → see the form screenshot
5. Screenshot auto-refreshes every 3 seconds via JS polling
6. Tap **Approve & Submit** → relay clicks submit → Telegram confirmation
7. Or tap **Reject** → relay closes the browser tab → marked as rejected

### Screenshot Refresh

The review page (`/apply/:job_id`) includes a JavaScript snippet that polls `/screenshot/:job_id` every 3 seconds. This gives you a live view of the browser form, so you can verify fields are filled correctly before approving.

### Security

- All routes are gated behind `RELAY_SECRET`
- Token can be passed as query param (`?token=...`) or Authorization header
- The server binds to `0.0.0.0` but is only reachable via Tailscale (private network)
- No sensitive data is exposed in URLs beyond the auth token
- `<meta name="robots" content="noindex, nofollow">` on all pages

## Telegram Integration

When a Tier 1 job's form is filled and ready for review, the Telegram bot sends:

```
📋 Ready for Review

🏢 Acme Corp — Senior Backend Engineer
🟢 Greenhouse · Can auto-fill

Review & submit from your phone:
http://your-pi.tailnet-name.ts.net:3847/apply/12345?token=***
```

The callback listener (`node telegram-bot.mjs`) is enhanced with an **📋 Apply** button that triggers the relay flow for Tier 1 jobs.

## Health Check

```bash
curl "http://localhost:3847/health?token=YOUR_SECRET"
```

```json
{
  "status": "ok",
  "uptime": 3600.5,
  "timestamp": "2026-06-26T10:00:00.000Z",
  "pending_applications": 2,
  "total_applications": 15,
  "active_sessions": 1,
  "version": "1.0.0"
}
```

## Troubleshooting

**Server won't start: "RELAY_SECRET is not set"**
Add `RELAY_SECRET=...` to your `.env` file. See setup step 2.

**Can't reach from phone**
1. Check Tailscale is running on both devices: `tailscale status`
2. Verify the hostname: `ping your-pi.tailnet-name.ts.net`
3. Check the port is open: `curl http://localhost:3847/health?token=YOUR_SECRET`

**"Unauthorized" error**
Make sure your `?token=` parameter matches `RELAY_SECRET` in `.env` exactly.

**Screenshot shows "unavailable"**
The browser session may have closed. Re-run `node session-manager.mjs <url>` to reopen it.

**409 Conflict with Telegram**
Only one process can poll the Telegram bot at a time. Stop other `telegram-bot.mjs` processes first.
