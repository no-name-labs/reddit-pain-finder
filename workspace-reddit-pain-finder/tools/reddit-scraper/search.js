'use strict';

/**
 * search.js — Subreddit discovery CLI
 *
 * Usage:
 *   node search.js --queries "real estate" "housing" [--config path] [--max 20]
 *
 * Output: JSON to stdout with ranked subreddit candidates.
 * Logs go to stderr so stdout stays clean JSON.
 */

const path = require('path');
const {
  createSession,
  closeSession,
  fetchJson,
  fetchText,
  sleep,
  jitteredDelay,
  scorePain,
} = require('./lib');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    queries: [],
    configPath: path.join(__dirname, 'config.json'),
    maxResults: 20,
  };

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--config' && args[i + 1]) {
      result.configPath = path.resolve(args[i + 1]);
      i += 2;
    } else if (args[i] === '--max' && args[i + 1]) {
      result.maxResults = parseInt(args[i + 1], 10) || 20;
      i += 2;
    } else if (args[i] === '--queries') {
      i += 1;
      while (i < args.length && !args[i].startsWith('--')) {
        result.queries.push(args[i]);
        i += 1;
      }
    } else if (!args[i].startsWith('--')) {
      result.queries.push(args[i]);
      i += 1;
    } else {
      i += 1;
    }
  }

  if (result.queries.length === 0) {
    console.error('Usage: node search.js --queries "topic1" "topic2" [--config path] [--max N]');
    process.exit(1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reddit JSON search — subreddits
// ---------------------------------------------------------------------------

async function searchCommunities(session, query) {
  const { context, config, log } = session;
  const url =
    `https://www.reddit.com/subreddits/search.json` +
    `?q=${encodeURIComponent(query)}&limit=25&sort=relevance&raw_json=1`;

  try {
    const data = await fetchJson(context, url, config, log, 'https://www.reddit.com/');
    if (!data || !data.data || !data.data.children) return [];

    return data.data.children
      .filter((c) => c.kind === 't5' && c.data)
      .map((c) => {
        const d = c.data;
        return {
          name: d.display_name,
          subscribers: d.subscribers || 0,
          activeUsers: d.accounts_active || 0,
          description: (d.public_description || '').slice(0, 300),
          over18: d.over18 || false,
          url: `https://www.reddit.com${d.url || `/r/${d.display_name}/`}`,
          created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
        };
      });
  } catch (err) {
    log('searchCommunities failed for query:', query, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reddit JSON search — recent posts (to find active subreddits)
// ---------------------------------------------------------------------------

async function searchRecentPosts(session, query, timeFilter = 'week') {
  const { context, config, log } = session;
  const results = [];

  // Fetch 1 page (100 posts) per query — enough for discovery while staying fast
  let after = null;
  for (let page = 0; page < 1; page++) {
    const url =
      `https://www.reddit.com/search.json` +
      `?q=${encodeURIComponent(query)}&sort=new&t=${timeFilter}&limit=100&type=link&raw_json=1` +
      (after ? `&after=${after}` : '');

    try {
      const data = await fetchJson(context, url, config, log, 'https://www.reddit.com/');
      if (!data || !data.data || !data.data.children) break;

      for (const c of data.data.children) {
        if (c.kind !== 't3' || !c.data) continue;
        const d = c.data;
        results.push({
          subreddit: d.subreddit,
          subredditSubscribers: d.subreddit_subscribers || 0,
          title: d.title || '',
          selftext: (d.selftext || '').slice(0, 500),
          score: d.score || 0,
          numComments: d.num_comments || 0,
          over18: d.over_18 || false,
          createdUtc: d.created_utc,
        });
      }

      after = data.data.after;
      if (!after) break;
      await sleep(jitteredDelay(config.requestDelayMs));
    } catch (err) {
      log('searchRecentPosts page', page, 'failed for query:', query, err.message);
      break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Merge, score, and rank
// ---------------------------------------------------------------------------

function mergeAndScore(communitySets, postSets, queries) {
  const subs = new Map(); // name -> merged data
  const directMatches = new Set(); // subs found in community search (directly relevant)

  // Process community search results
  for (const communities of communitySets) {
    for (const c of communities) {
      directMatches.add(c.name);
      if (!subs.has(c.name)) {
        subs.set(c.name, {
          name: c.name,
          subscribers: c.subscribers,
          activeUsers: c.activeUsers,
          description: c.description,
          over18: c.over18,
          url: c.url,
          postHits: 0,
          painHits: 0,
          totalScore: 0,
          totalComments: 0,
          sampleTitles: [],
          directMatch: true,
        });
      } else {
        const existing = subs.get(c.name);
        existing.directMatch = true;
        if (c.subscribers > existing.subscribers) existing.subscribers = c.subscribers;
        if (c.activeUsers > existing.activeUsers) existing.activeUsers = c.activeUsers;
        if (!existing.description && c.description) existing.description = c.description;
      }
    }
  }

  // Process post search results
  for (const posts of postSets) {
    for (const p of posts) {
      const name = p.subreddit;
      if (!subs.has(name)) {
        subs.set(name, {
          name,
          subscribers: p.subredditSubscribers,
          activeUsers: 0,
          description: '',
          over18: p.over18,
          url: `https://www.reddit.com/r/${name}/`,
          postHits: 0,
          painHits: 0,
          totalScore: 0,
          totalComments: 0,
          sampleTitles: [],
          directMatch: false,
        });
      }

      const entry = subs.get(name);
      entry.postHits += 1;
      entry.totalScore += p.score;
      entry.totalComments += p.numComments;

      const text = p.title + ' ' + p.selftext;
      if (scorePain(text) > 0) {
        entry.painHits += 1;
      }

      if (entry.sampleTitles.length < 3) {
        entry.sampleTitles.push(p.title.slice(0, 120));
      }

      if (p.subredditSubscribers > entry.subscribers) {
        entry.subscribers = p.subredditSubscribers;
      }
    }
  }

  // Score
  const queryLower = queries.map((q) => q.toLowerCase().replace(/\s+/g, ''));
  const results = [...subs.values()].map((s) => {
    // Subscriber score: log10 normalized (0–1). 10M subs → ~1.0
    const subscriberScore = Math.min(Math.log10(Math.max(s.subscribers, 1)) / 7, 1);
    // Activity score: based on how many posts matched in recent search
    const activityScore = Math.min(s.postHits / 30, 1);
    // Pain score: ratio of pain-keyword posts to total
    const painScore = s.postHits > 0 ? Math.min(s.painHits / Math.max(s.postHits * 0.3, 1), 1) : 0;
    // Engagement: comments and upvotes per post
    const avgEngagement = s.postHits > 0 ? (s.totalScore + s.totalComments) / s.postHits : 0;
    const engagementScore = Math.min(avgEngagement / 100, 1);

    // Name match: subreddit name closely matches a query word.
    // Three checks:
    //   1. nameLow.includes(q) — sub name contains full query (r/lowerbackpain contains "backpain")
    //   2. q.includes(nameLow) — query contains full sub name, only if sub name is >= 60%
    //      of query length (prevents "sleep" matching "sleepapnea")
    //   3. exact word match — sub name exactly equals an individual query word >= 6 chars
    //      (r/Accounting matches query word "accounting" from "accounting bookkeeper",
    //       but r/sleep (5 chars) doesn't qualify — too short/generic)
    const nameLower = s.name.toLowerCase().replace(/[_-]/g, '');
    const queryWords = queries.flatMap((q) => q.toLowerCase().split(/\s+/));
    const hasNameMatch =
      queryLower.some(
        (q) => nameLower.includes(q) || (q.includes(nameLower) && nameLower.length >= q.length * 0.6),
      ) ||
      queryWords.some((w) => w.length >= 6 && nameLower === w);

    // Direct match from community search gets bonus ONLY if name also matches.
    // Without name match, community search returns adjacent subs (r/Fitness for "back pain")
    // which are noise, not signal.
    const directMatchBonus = s.directMatch && hasNameMatch ? 0.35 : (s.directMatch ? 0.05 : 0);
    const nameMatchBonus = hasNameMatch ? 0.35 : 0;

    // Graduated penalty for large subs without name match.
    // Without name match, these are adjacent communities riding on broad queries.
    // r/smallbusiness (2.4M) for "bookkeeping" shouldn't outrank r/Bookkeeping (76K).
    // r/AskDocs with 1 back pain post shouldn't outrank r/backpain.
    // BUT: subs with genuine activity (postHits >= 5) get a softer penalty —
    //   r/Accounting (1.2M, 12 postHits) is legitimately relevant for "bookkeeping".
    let megaSubPenalty = 0;
    if (!hasNameMatch) {
      const hasActivity = s.postHits >= 5;
      if (s.subscribers > 2000000) megaSubPenalty = hasActivity ? 0.15 : 0.30;
      else if (s.subscribers > 500000) megaSubPenalty = hasActivity ? 0.10 : 0.20;
      else if (s.subscribers > 100000) megaSubPenalty = 0.08;
    }

    s.relevanceScore =
      Math.round(
        Math.min(
          subscriberScore * 0.1 +
            activityScore * 0.2 +
            painScore * 0.25 +
            engagementScore * 0.05 +
            directMatchBonus +
            nameMatchBonus -
            megaSubPenalty,
          1.0,
        ) * 100,
      ) / 100;

    return s;
  });

  // Filter: NSFW, too small, and noise (generic mega-subs with 1-2 stray hits)
  return results
    .filter((s) => !s.over18)
    .filter((s) => s.subscribers >= 500 || s.postHits >= 2)
    .filter((s) => {
      // Keep subs with high relevance (name match):
      // - exact/close name matches always kept (r/backpain, r/lowerbackpain)
      // - partial matches need 5K+ members to filter joke/dead subs (r/tekkenbackpain)
      if (s.relevanceScore >= 0.6) {
        const nameLow = s.name.toLowerCase().replace(/[_-]/g, '');
        const isExactMatch = queryLower.some((q) => nameLow === q || q === nameLow);
        const isCloseMatch = queryLower.some((q) => {
          // "lowerbackpain" closely matches "backpain" — the query is a major component
          const overlap = q.length >= 4 && nameLow.includes(q) && q.length >= nameLow.length * 0.6;
          return overlap;
        });
        if (isExactMatch || isCloseMatch) return true;
        // Non-name-match subs: require meaningful activity, not just 1 stray hit.
        // This prevents mega-subs like r/AskDocs from appearing for "back pain"
        // just because someone posted there once.
        if (s.postHits >= 3 || (s.subscribers >= 5000 && s.painHits >= 1)) return true;
      }
      // Keep subs with strong activity signal AND reasonable relevance
      // (prevents stray pain hits in r/movies from bubbling up)
      if ((s.painHits >= 3 || s.postHits >= 5) && s.relevanceScore >= 0.45) return true;
      // Drop the rest — stray hits from mega-subs are noise
      return false;
    })
    .sort((a, b) => {
      const scoreDiff = b.relevanceScore - a.relevanceScore;
      if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
      return b.subscribers - a.subscribers; // tiebreaker
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { queries, configPath, maxResults } = parseArgs(process.argv);
  let session = null;

  try {
    session = await createSession(configPath);

    const communitySets = [];
    const postSets = [];

    for (const query of queries) {
      // Search communities
      const communities = await searchCommunities(session, query);
      communitySets.push(communities);
      await sleep(jitteredDelay(session.config.requestDelayMs));

      // Search recent posts
      const posts = await searchRecentPosts(session, query);
      postSets.push(posts);
      await sleep(jitteredDelay(session.config.requestDelayMs));
    }

    // Also search with pain-oriented queries (limited to 2 to stay fast)
    const baseQuery = queries[0];
    const painQueries = [`${baseQuery} problem`, `${baseQuery} frustrated help`];

    for (const pq of painQueries) {
      const posts = await searchRecentPosts(session, pq, 'month');
      postSets.push(posts);
      await sleep(jitteredDelay(session.config.requestDelayMs));
    }

    const ranked = mergeAndScore(communitySets, postSets, queries);
    // Compact output — only essential fields to keep tool result small
    const compact = ranked.slice(0, maxResults).map((s) => ({
      name: s.name,
      members: s.subscribers,
      score: s.relevanceScore,
      painHits: s.painHits,
      postHits: s.postHits,
      desc: (s.description || '').slice(0, 80),
      sample: (s.sampleTitles[0] || '').slice(0, 80),
    }));
    const output = {
      ok: true,
      queries,
      total: ranked.length,
      subreddits: compact,
    };

    // stdout = clean compact JSON, stderr = logs
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (err) {
    const output = { ok: false, error: err.message, queries };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  } finally {
    // Force exit BEFORE closeSession to prevent Playwright browser.close() from hanging
    setTimeout(() => process.exit(0), 5000);
    await closeSession(session);
  }
}

main();
