'use strict';

/**
 * batch-scrape.js — Scrape multiple subreddits, pre-analyze, output compact results
 *
 * Uses JSON API (not HTML partials) for feeds and comments.
 * Fetches initial comment tree (limit=200, depth=8) for top 20 posts by engagement.
 * Counts pain signals across ALL data BEFORE truncation → accurate frequencies.
 * Filters bot/mod noise.
 *
 * Usage:
 *   node batch-scrape.js --subs "Sub1,Sub2,Sub3" --lookback 48 [--max-pages 5] [--config path]
 *
 * Output: Compact pre-analyzed JSON to stdout.
 */

const path = require('path');
const {
  createSession,
  closeSession,
  collectRecentPostsAuto,
  collectCommentsAuto,
  parseTarget,
  isBot,
  scorePain,
} = require('./lib');

// ---------------------------------------------------------------------------
// Pain analysis on raw data (BEFORE any truncation)
// ---------------------------------------------------------------------------

function hasPain(text) {
  return scorePain(text) > 0;
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '…';
}

/**
 * Analyze ALL posts+comments for a subreddit.
 * Returns accurate counts + curated quotes, without sending raw data to the LLM.
 */
function analyzeSubreddit(posts) {
  let totalPainPosts = 0;
  let totalPainComments = 0;
  let totalComments = 0;
  let totalCommentsActual = 0; // from Reddit metadata (num_comments)

  const painEvidence = []; // { source: 'post'|'comment', text, author, score, postTitle, subreddit }

  for (const post of posts) {
    const postText = (post.title || '') + ' ' + (post.body || '');
    const postIsPain = hasPain(postText);
    totalCommentsActual += post.commentsTotal || post.commentCount || 0;

    if (postIsPain) {
      totalPainPosts++;
      painEvidence.push({
        source: 'post',
        text: post.body ? post.title + ': ' + post.body : post.title,
        author: post.author,
        score: post.score,
        postTitle: post.title,
        subreddit: post.subreddit,
        permalink: post.permalink,
      });
    }

    for (const c of post.comments || []) {
      totalComments++;
      if (hasPain(c.body)) {
        totalPainComments++;
        painEvidence.push({
          source: 'comment',
          text: c.body,
          author: c.author,
          score: c.score,
          postTitle: post.title,
          subreddit: post.subreddit,
          permalink: c.permalink,
        });
      }
    }
  }

  // Sort by engagement and select top quotes
  painEvidence.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  // Build compact output: top 15 pain quotes with context
  const topQuotes = painEvidence.slice(0, 15).map((e) => ({
    type: e.source,
    quote: truncate(e.text, 250),
    author: e.author,
    score: e.score,
    inPost: truncate(e.postTitle, 100),
    permalink: e.permalink,
  }));

  // Also include a few non-pain high-engagement posts for context
  const contextPosts = posts
    .filter((p) => !hasPain((p.title || '') + ' ' + (p.body || '')))
    .sort((a, b) => (b.score + b.commentCount) - (a.score + a.commentCount))
    .slice(0, 3)
    .map((p) => ({ title: p.title, score: p.score, commentCount: p.commentCount }));

  return {
    postsCount: posts.length,
    commentsCollected: totalComments,
    commentsActual: totalCommentsActual,
    painPostCount: totalPainPosts,
    painCommentCount: totalPainComments,
    totalPainMentions: totalPainPosts + totalPainComments,
    topPainQuotes: topQuotes,
    contextPosts,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    subs: [],
    configPath: path.join(__dirname, 'config.json'),
    lookbackHours: 48,
    maxPages: 5,
    maxCommentsPerPost: 500,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case '--subs': result.subs = args[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--config': result.configPath = path.resolve(args[++i]); break;
      case '--lookback': result.lookbackHours = parseInt(args[++i], 10) || 48; break;
      case '--max-pages': result.maxPages = parseInt(args[++i], 10) || 5; break;
      case '--max-comments': result.maxCommentsPerPost = parseInt(args[++i], 10) || 500; break;
      default: break;
    }
    i++;
  }

  if (result.subs.length === 0) {
    console.error('Usage: node batch-scrape.js --subs "Sub1,Sub2,Sub3" --lookback 48');
    process.exit(1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  let session = null;

  // Force exit 30s before the 180s gateway timeout to flush partial results
  const forceExitTimer = setTimeout(() => {
    console.error('[batch-scrape] Force exit: approaching gateway timeout');
    process.exit(0);
  }, 150 * 1000);

  try {
    session = await createSession(args.configPath);
    session.config.lookbackHours = args.lookbackHours;
    session.config.maxFeedPages = args.maxPages;
    session.config.fetchComments = true;
    session.config.maxCommentsPerPost = args.maxCommentsPerPost;

    const results = [];

    for (const subName of args.subs) {
      const startTime = Date.now();
      try {
        const target = parseTarget(subName);
        session.log('Scraping', target.subreddit, '(JSON API)');

        // Use JSON API with HTML fallback for feeds
        const { posts, pagesFetched } = await collectRecentPostsAuto(
          session.context, target, session.config, session.log,
        );

        // Only fetch comments for top 20 posts by engagement to stay within rate limits.
        // Sort by (commentCount + score) desc, pick top 20.
        const sortedPosts = [...posts].sort(
          (a, b) => (b.commentCount + b.score) - (a.commentCount + a.score),
        );
        const postsForComments = sortedPosts.slice(0, 20);
        const skippedPosts = posts.length - postsForComments.length;
        if (skippedPosts > 0) {
          session.log(`Skipping comments for ${skippedPosts} low-engagement posts`);
        }

        // Use JSON API with HTML fallback for comments
        const { totalCollected, totalActual } = await collectCommentsAuto(
          session.context, postsForComments, session.config, session.log,
        );

        // Pre-analyze ALL data before truncation
        const analysis = analyzeSubreddit(posts);

        results.push({
          subreddit: target.subreddit,
          ...analysis,
          scrapeTimeMs: Date.now() - startTime,
        });

        session.log(
          `Done ${target.subreddit}: ${posts.length} posts, ` +
          `${totalCollected}/${totalActual} comments collected, ` +
          `${analysis.totalPainMentions} pain mentions in ${Math.round((Date.now() - startTime) / 1000)}s`,
        );
      } catch (err) {
        session.log(`Failed ${subName}: ${err.message}`);
        results.push({
          subreddit: subName,
          error: err.message,
          postsCount: 0,
          commentsCollected: 0,
          commentsActual: 0,
          painPostCount: 0,
          painCommentCount: 0,
          totalPainMentions: 0,
          topPainQuotes: [],
          contextPosts: [],
        });
      }
    }

    const output = {
      ok: true,
      lookbackHours: args.lookbackHours,
      subredditCount: results.length,
      totalPosts: results.reduce((s, r) => s + r.postsCount, 0),
      totalCommentsCollected: results.reduce((s, r) => s + r.commentsCollected, 0),
      totalCommentsActual: results.reduce((s, r) => s + r.commentsActual, 0),
      totalPainMentions: results.reduce((s, r) => s + r.totalPainMentions, 0),
      subreddits: results,
    };

    process.stdout.write(JSON.stringify(output) + '\n');
    clearTimeout(forceExitTimer);
  } catch (err) {
    clearTimeout(forceExitTimer);
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(1);
  } finally {
    setTimeout(() => process.exit(0), 5000);
    await closeSession(session);
  }
}

main();
