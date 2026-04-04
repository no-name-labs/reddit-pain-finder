# Reddit Pain Finder for OpenClaw

Reddit Pain Finder is an OpenClaw agent that discovers Reddit communities relevant to a given topic, scrapes recent posts and comments, and extracts concrete pain points that real people are experiencing.

Built for entrepreneurs and product teams who want to find prospects by locating buyer-relevant pain in Reddit communities.

## Features

- Subreddit discovery with relevance scoring and pain-signal ranking
- Batch scraping with pre-analysis (accurate pain counts before LLM sees the data)
- Telegram keyboard interface with approval flow
- Configurable lookback periods (8h, 24h, 7 days)
- Hot thread links in every pain section
- Graduated mega-sub penalty to keep results focused
- Exact-match niche community preservation
- Honest coverage reporting (collected vs actual comments)
- Bounded retry policy (max 1 retry, no infinite loops)
- Optional HTTPS proxy support for cloud deployments

## Requirements

- Existing OpenClaw installation with a running gateway
- Node.js 22+
- Telegram group with Topics enabled

No separate Telegram bot token needed — the agent uses the same bot that OpenClaw is already running.
No Reddit account needed — the agent uses Reddit's public JSON API via headless Chromium (Playwright).

## Install

Works on both macOS and Linux (Ubuntu 22.04+).

```bash
git clone https://github.com/no-name-labs/reddit-pain-finder.git
cd reddit-pain-finder
./scripts/install.sh
```

Non-interactive install:

```bash
./scripts/install.sh \
  --non-interactive \
  --telegram-group-id "<GROUP_ID>" \
  --telegram-topic-id "<TOPIC_ID>"
```

The installer will:
1. Copy workspace files to `~/.openclaw/workspace/workspace-reddit-pain-finder/`
2. Install Node.js dependencies (cheerio + playwright)
3. Download headless Chromium (+ system deps on Linux)
4. Patch `openclaw.json` with agent entry and Telegram binding
5. Restart the gateway

## Running on Cloud Servers (AWS, GCP, Hetzner, etc.)

Reddit blocks requests from most datacenter IP ranges — you'll get `403 Blocked` on any request from an EC2 or similar VPS. A residential HTTPS proxy solves this.

### Setup

1. Get a residential proxy. We tested with [SmartProxy](https://www.smartproxy.com) (~$7/mo for 1GB). Free tier is enough for light use.

2. Install with the `--proxy` flag:

```bash
./scripts/install.sh \
  --non-interactive \
  --telegram-group-id "<GROUP_ID>" \
  --telegram-topic-id "<TOPIC_ID>" \
  --proxy "http://user:pass@gate.smartproxy.com:10000"
```

3. **Merge proxy into the gateway's `.env`** so it persists across restarts:

```bash
# The installer writes to ~/.openclaw/reddit-pain-finder.env
# but the gateway typically sources ~/.openclaw/.env on startup.
# Merge the proxy vars into the main .env:
cat ~/.openclaw/reddit-pain-finder.env >> ~/.openclaw/.env
```

Or add the lines manually:

```bash
# Append to ~/.openclaw/.env
HTTPS_PROXY=http://user:pass@gate.smartproxy.com:10000
HTTP_PROXY=http://user:pass@gate.smartproxy.com:10000
```

4. **Restart the gateway** so it picks up the new env vars:

```bash
# If using nohup (typical EC2 setup):
pkill -f openclaw-gateway
source ~/.openclaw/.env
OPENCLAW_HOME=/home/ubuntu nohup openclaw gateway >> /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>&1 &

# If using systemd:
systemctl --user restart openclaw-gateway

# If using macOS launchd:
openclaw gateway restart
```

Child processes (search.js, batch-scrape.js) inherit env vars from the gateway — so the proxy only needs to be set once on the gateway process.

### Important notes

- **Password encoding:** If your proxy password contains `+`, replace it with `%2B` in the URL. Example: password `+PNd5B` becomes `%2BPNd5B` in the URL.
- **SmartProxy ports:** Port `10001` may not work with Playwright's CONNECT tunnel. Use port `10000` instead — tested and confirmed working.
- **Timeout:** Scraping through a proxy is slower. Consider increasing `agents.defaults.timeoutSeconds` in `openclaw.json` to `1800` (30 min) if analyses get killed.
- **Proxy env must reach the gateway process.** If you start the gateway manually (`nohup openclaw gateway &`), make sure to `source ~/.openclaw/reddit-pain-finder.env` first. The install script writes the env file but can't always inject it into a running gateway.

### Verify proxy works

```bash
# Quick test from the server
HTTPS_PROXY="http://user:pass@gate.smartproxy.com:10000" \
  node ~/.openclaw/workspace/workspace-reddit-pain-finder/tools/reddit-scraper/search.js \
  --queries "back pain" 2>/dev/null
```

If you see results — proxy is working. If `total: 0` — check the env vars and proxy port.

## Usage

After install, interact with the bot in your Telegram topic:

1. `/research_subreddits <topic>` - discover relevant communities
2. Tap **Approve** to save the recommended list
3. Tap **Analysis 8h**, **Analysis 24h**, or **Analysis 7 days**
4. Get a structured pain report with quotes, links, and prospect locations

### Commands

| Command | Description |
|---------|-------------|
| `/research_subreddits <topic>` | Find subreddits for a pain topic |
| `/run_analysis [period]` | Scrape approved subs and generate pain report |
| `show state` | Show current topic and approved subreddits |
| `/reset` | Clear state and start fresh |

### Example Topics

- Consumer pain: `back pain`, `sleep apnea`, `acne treatment`
- B2B workflow: `bookkeeping`, `invoice collection`
- Brand-specific: `QuickBooks frustration`
- Technical: `CI flaky tests`
- Niche B2B: `email deliverability`

## Workspace Structure

```
workspace-reddit-pain-finder/
  IDENTITY.md           # System prompt and protocols
  TOOLS.md              # Tool documentation
  PROMPTS.md            # Command reference
  AGENTS.md             # Agent metadata
  SOUL.md               # Behavioral rules
  USER.md               # User context (customize after install)
  tools/
    telegram-buttons.js # Telegram keyboard interface
    reddit-scraper/
      lib.js            # Core scraping library (Playwright + optional proxy)
      search.js         # Subreddit discovery
      batch-scrape.js   # Batch scrape + pre-analysis
      scrape.js         # Single-sub scraper (debug)
      summarize.js      # Post-hoc summarizer (debug)
      package.json      # Dependencies (cheerio, playwright)
  data/
    state.json          # Approved subreddit list (created at runtime)
```

## Configuration

### Scraper Settings

After install, you can tune `~/.openclaw/workspace/workspace-reddit-pain-finder/tools/reddit-scraper/config.json`:

```json
{
  "requestDelayMs": 1200,
  "lookbackHours": 168,
  "maxFeedPages": 15,
  "maxCommentsPerPost": 200,
  "fetchComments": true
}
```

No Reddit credentials needed — the agent uses Reddit's public JSON API via Playwright.

### Telegram

The installer configures Telegram bindings automatically. To change the group or topic later, edit `~/.openclaw/openclaw.json`.

### Model

Default model: `anthropic/claude-sonnet-4-6`. Change in `openclaw.json` under the agent entry.

## Upgrade

```bash
git pull
./scripts/install.sh
```

## Uninstall

```bash
./scripts/uninstall.sh
```

Or manually remove:
- `~/.openclaw/workspace/workspace-reddit-pain-finder`
- `~/.openclaw/agents/reddit-pain-finder`
- The agent entry and binding from `~/.openclaw/openclaw.json`

Then restart OpenClaw.

## Known Limitations

- **Cloud IP blocking:** Reddit blocks datacenter IPs (AWS, GCP, Hetzner). Use a residential proxy — see [setup guide above](#running-on-cloud-servers-aws-gcp-hetzner-etc).
- **Stale results after `/reset`:** Gateway may deliver in-flight tool results after a session reset. This is a platform-level issue, not fixable at agent level.
- **Sparse topics:** Some topics (e.g., "CI flaky tests", "invoice collection") have few dedicated Reddit communities. The agent will report honestly instead of padding with irrelevant mega-communities.
- **Rate limiting:** Reddit rate-limits aggressive scraping. The agent uses jittered delays and bounded retries, but large analyses may hit 429 errors.
- **No authentication:** The agent uses Reddit's public JSON API without login. No access to NSFW or private subreddits.

## License

MIT
