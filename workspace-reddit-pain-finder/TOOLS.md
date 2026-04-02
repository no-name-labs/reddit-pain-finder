# TOOLS — reddit-pain-finder

## Shell Tools

### search.js
- **Path:** `tools/reddit-scraper/search.js`
- **Purpose:** Discover relevant subreddits for a topic
- **Input:** `--queries "q1" "q2" [--max N]`
- **Output:** JSON to stdout with ranked subreddit list
- **Auth:** Uses Reddit session cookies from `storage-state.json`

### scrape.js
- **Path:** `tools/reddit-scraper/scrape.js`
- **Purpose:** Scrape posts and comments from a single subreddit
- **Input:** `--subreddit "Name" --lookback <hours> [--max-pages N] [--no-comments]`
- **Output:** Summary JSON to stdout, full data to `data/analysis/`
- **Auth:** Uses Reddit session cookies from `storage-state.json`

## Data Files

### state.json
- **Path:** `data/state.json`
- **Purpose:** Persists approved subreddit list between sessions
- **Format:** `{ "topic": "...", "approvedSubreddits": [...], "updatedAt": "ISO" }`

### Analysis Output
- **Path:** `data/analysis/<subreddit>-<timestamp>.json`
- **Purpose:** Full scrape results for each subreddit
- **Format:** Posts with comments, metadata, timestamps

## Authentication

Reddit authentication is handled via Playwright browser session cookies stored in `tools/reddit-scraper/storage-state.json`. No API keys required — we use Reddit's internal endpoints.

## Anti-Bot Measures

- Jittered delays between requests (800ms + random 0–40%)
- Realistic Chrome user-agent string
- Session cookies with CSRF tokens
- Referer headers matching normal browsing patterns
- Rate-limited: one request at a time, no parallelism
