# Skill Index — reddit-pain-finder

| Intent | Tool | Notes |
|--------|------|-------|
| Find subreddits for a topic | `search.js` | JSON API search, ranks by relevance + pain signal density |
| Scrape + analyze subreddits | `batch-scrape.js` | JSON API with morechildren pagination, pre-analyzes before output |
| Check current state | `read state.json` | Approved subreddit list, last analysis time |
