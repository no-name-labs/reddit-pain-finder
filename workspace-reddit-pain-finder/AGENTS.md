# AGENTS — reddit-pain-finder

## Agent Overview

| Field | Value |
|-------|-------|
| Agent ID | `reddit-pain-finder` |
| Model | `anthropic/claude-sonnet-4-6` |
| Type | Research Tool |
| Purpose | Discover and analyze user pain points from Reddit |
| Telegram Topic | Reddit (topic 1655) |

## Tool Stack

| Tool | API | Purpose |
|------|-----|---------|
| `search.js` | Reddit JSON `/subreddits/search.json`, `/search.json` | Subreddit discovery |
| `batch-scrape.js` | Reddit JSON `/r/{sub}/new.json`, `/comments/{id}.json`, `/api/morechildren.json` | Batch scrape + pre-analyze |
| `state.json` | Local file | Persist approved subreddit list |

## Workspace Structure

```
workspace-reddit-pain-finder/
├── IDENTITY.md          # System prompt
├── TOOLS.md             # Tool documentation
├── PROMPTS.md           # Command reference
├── AGENTS.md            # This file
├── docs/
│   └── E2E_TEST_SCOPE.md # End-to-end test scope and acceptance criteria
├── SOUL.md              # Behavioral rules
├── USER.md              # User context
├── auth-profiles.json   # LLM auth credentials
├── models.json          # Model config
├── tools/
│   └── reddit-scraper/  # Node.js scraping tools
│       ├── lib.js       # Core library (JSON API + HTML fallback)
│       ├── search.js    # Subreddit discovery CLI
│       ├── batch-scrape.js  # Batch scrape + pre-analysis
│       ├── scrape.js    # Single-sub scraper (debug)
│       ├── summarize.js # Post-hoc summarizer (debug)
│       ├── config.json  # Reddit credentials
│       ├── package.json
│       └── storage-state.json  # Browser session
├── data/
│   ├── state.json       # Approved subreddit list
│   └── analysis/        # Scrape output cache
└── skills/
    └── SKILL_INDEX.md
```

## E2E Coverage

The canonical end-to-end test scope for this agent lives in
`docs/E2E_TEST_SCOPE.md`.
