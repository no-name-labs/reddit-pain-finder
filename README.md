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

## Requirements

- Existing OpenClaw installation with a running gateway
- Node.js 22+
- Telegram group with Topics enabled (agent binds to the existing OpenClaw bot)

No separate Telegram bot token needed — the agent uses the same bot that OpenClaw is already running.
No Reddit account needed — the agent uses Reddit's public JSON API.

## Install

Run on the machine that hosts OpenClaw:

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

### Proxy (required for cloud servers)

Reddit blocks requests from most cloud IP ranges (AWS, GCP, Azure). If you're running on a cloud server, you need an HTTPS proxy with a residential IP.

Set the proxy before starting the gateway:

```bash
export HTTPS_PROXY="http://user:pass@proxy-host:port"
```

Or add it to your OpenClaw environment so it persists across restarts.

Recommended providers: [Webshare](https://www.webshare.io) (~$5/mo), [SmartProxy](https://www.smartproxy.com) (~$7/mo for 1GB residential).

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
      lib.js            # Core scraping library
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

No Reddit credentials needed — the agent uses Reddit's public JSON API with standard HTTP requests.

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

- **Stale results after `/reset`:** Gateway may deliver in-flight tool results after a session reset. This is a platform-level issue, not fixable at agent level.
- **Sparse topics:** Some topics (e.g., "CI flaky tests", "invoice collection") have few dedicated Reddit communities. The agent will report honestly instead of padding with irrelevant mega-communities.
- **Rate limiting:** Reddit rate-limits aggressive scraping. The agent uses jittered delays and bounded retries, but large analyses may hit 429 errors.
- **No authentication:** The agent uses Reddit's public JSON API without login. This means no access to NSFW or private subreddits.

## License

MIT
