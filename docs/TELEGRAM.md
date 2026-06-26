# Telegram Notifications

Receive job cards on Telegram after each scan, with one-tap **Keep / Skip / Later** buttons.

```
🔍 New Job Found

🏢 Acme Corp — Senior Backend Engineer
📍 Remote, EU
💼 Greenhouse
🔗 https://boards.greenhouse.io/acme/jobs/12345

Source: JustJoin.it
Found: 2026-06-26
```

## Setup

### 1. Create a Telegram bot

1. Open Telegram, search for **@BotFather**, start a chat.
2. Send `/newbot` and follow the prompts (name + username).
3. BotFather replies with a token like `123456:ABC-DEF1234…` — copy it.

### 2. Get your chat ID

1. Search for **@userinfobot** on Telegram, start a chat, send `/start`.
2. It replies with your numeric ID, e.g. `987654321`.

### 3. Start a chat with your bot

Search for your bot's username and send it `/start` — this is required before it can message you.

### 4. Add credentials to `.env`

```bash
cp .env.example .env   # if you haven't already
```

Edit `.env` and fill in:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234...
TELEGRAM_CHAT_ID=987654321
```

## Usage

### Send notifications after a scan

```bash
node scan.mjs --notify
```

Each new offer is sent as a Telegram card with **✅ Keep / ❌ Skip / ⏰ Later** buttons.
A summary card is sent at the end.

The scan process itself exits immediately after sending — it does **not** wait for you to tap the buttons.

### Handle button taps (persistent listener)

Run the listener in a separate terminal (or as a background process):

```bash
node telegram-bot.mjs
```

Telegram queues button callbacks for up to 24 hours, so you can start the listener at any time and it will still process earlier taps.

Press **Ctrl+C** to stop.

#### What each button does

| Button | Action |
|--------|--------|
| ✅ Keep | Records URL in `data/telegram-state.json → kept[]` |
| ❌ Skip | Records URL in `data/telegram-state.json → skipped[]` |
| ⏰ Later | No state change — job remains in pipeline |

> **Note on Skip:** The skipped list is currently a record only. It is not automatically wired back into scan dedup. To prevent a skipped URL from reappearing in future scans, move or delete its entry from `data/pipeline.md`.

## State file

`data/telegram-state.json` is created automatically on first use:

```json
{
  "kept": ["https://..."],
  "skipped": ["https://..."],
  "pendingCards": {
    "1234567": { "url": "https://...", "title": "Senior BE", "company": "Acme" }
  }
}
```

`pendingCards` maps Telegram message IDs to job metadata so the listener can resolve which job a button belongs to (Telegram limits `callback_data` to 64 bytes, which is shorter than most job URLs).

## Troubleshooting

**Bot sends nothing / no error**
Check that `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set and non-empty in `.env`. The functions are intentional no-ops when either is absent to prevent crashes on machines without Telegram configured.

**409 Conflict when starting the listener**
Another process is already polling with the same token. Stop the other process first — Telegram only allows one active poller per bot token.

**Buttons stop responding**
Telegram expires callback_query updates after ~24 hours. Tapping a button on an older card will show "Already handled or not tracked."

**`node --check telegram-bot.mjs` fails**
Run `pnpm install` to ensure `node-telegram-bot-api` is installed.
