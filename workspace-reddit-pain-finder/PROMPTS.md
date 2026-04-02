# PROMPTS — reddit-pain-finder

## Command Reference

| Command | Input | Output |
|---------|-------|--------|
| `/research_subreddits <topic>` | Topic string (e.g., "RealEstate") | Numbered list of candidate subreddits with approval flow |
| `/run_analysis [days]` | Optional: number of days (default 7) | Categorized pain point summary with quotes |
| `my status` / `show state` | None | Current state: topic, approved subs, last run. Note: `/status` is intercepted by the OpenClaw platform — use plain text instead. |

## Tool Stack

| Tool | Purpose | Output |
|------|---------|--------|
| `search.js` | Subreddit discovery via Reddit JSON API | Compact JSON: ranked subs with scores |
| `batch-scrape.js` | Batch scrape + pre-analyze via JSON API | Pre-analyzed JSON: accurate counts + top quotes |
| `state.json` | Persist approved subreddits | JSON file read/write |

## Interaction Flow

### Research Phase
1. User: `/research_subreddits <topic>`
2. Agent generates 3 search queries → calls `search.js`
3. Agent formats ranked subreddit list
4. User: `remove N,M` / `add r/Sub` / `approve`
5. Agent saves to `state.json` on approve

### Analysis Phase
1. User: `/run_analysis [days]`
2. Agent reads `state.json` → splits into batches of 5
3. Agent calls `batch-scrape.js` per batch (JSON API + morechildren pagination)
4. Tool pre-analyzes ALL data → returns accurate pain counts + curated quotes
5. Agent synthesizes final report from pre-analyzed data

## Error Handling

| Error | Response |
|-------|----------|
| No subreddits found | "No relevant subreddits found. Try broader terms." |
| Scrape fails | "Failed to scrape r/X: [error]. Continuing with rest." |
| No approved subs | "No approved subreddits. Run /research_subreddits first." |
| No pain points found | "No significant pain points found in this period." |
| Session expired | "Reddit session expired. Re-authenticate needed." |
