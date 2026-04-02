'use strict';

/**
 * scrape.js — Single-subreddit scraper CLI
 *
 * Usage:
 *   node scrape.js --subreddit "RealEstate" [--lookback 168] [--max-pages 15]
 *                   [--no-comments] [--config path] [--output path]
 *
 * Output: Writes full JSON to output file, prints summary to stdout.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  createSession,
  closeSession,
  collectRecentPosts,
  collectComments,
  parseTarget,
  nowIsoFilename,
} = require('./lib');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    subreddit: null,
    configPath: path.join(__dirname, 'config.json'),
    lookbackHours: 168, // 7 days default
    maxPages: 15,
    fetchComments: true,
    maxCommentsPerPost: 200,
    outputDir: path.join(__dirname, '..', '..', 'data', 'analysis'),
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case '--subreddit':
      case '-s':
        result.subreddit = args[++i];
        break;
      case '--config':
        result.configPath = path.resolve(args[++i]);
        break;
      case '--lookback':
      case '-l':
        result.lookbackHours = parseInt(args[++i], 10) || 168;
        break;
      case '--max-pages':
        result.maxPages = parseInt(args[++i], 10) || 15;
        break;
      case '--max-comments':
        result.maxCommentsPerPost = parseInt(args[++i], 10) || 200;
        break;
      case '--no-comments':
        result.fetchComments = false;
        break;
      case '--output':
      case '-o':
        result.outputDir = path.resolve(args[++i]);
        break;
      default:
        if (!args[i].startsWith('-') && !result.subreddit) {
          result.subreddit = args[i];
        }
    }
    i++;
  }

  if (!result.subreddit) {
    console.error(
      'Usage: node scrape.js --subreddit "SubredditName" [--lookback 168] [--max-pages 15] [--no-comments]',
    );
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

  try {
    session = await createSession(args.configPath);

    // Override config with CLI args
    session.config.lookbackHours = args.lookbackHours;
    session.config.maxFeedPages = args.maxPages;
    session.config.fetchComments = args.fetchComments;
    session.config.maxCommentsPerPost = args.maxCommentsPerPost;

    const target = parseTarget(args.subreddit);
    session.log('Scraping', target.subreddit, 'lookback:', args.lookbackHours, 'hours');

    // Collect posts
    const { posts, pagesFetched } = await collectRecentPosts(
      session.context,
      target,
      session.config,
      session.log,
    );

    // Collect comments
    let totalComments = 0;
    if (args.fetchComments) {
      totalComments = await collectComments(
        session.context,
        posts,
        session.config,
        session.log,
      );
    }

    // Build result
    const result = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      subreddit: target.subreddit,
      feedUrl: target.feedUrl,
      lookbackHours: args.lookbackHours,
      stats: {
        pagesFetched,
        postsCount: posts.length,
        commentsCount: totalComments,
        requestDelayMs: session.config.requestDelayMs,
      },
      posts,
    };

    // Ensure output directory exists
    await fsp.mkdir(args.outputDir, { recursive: true });

    // Write full data to file
    const outputPath = path.join(
      args.outputDir,
      `${target.subreddit}-${nowIsoFilename()}.json`,
    );
    await fsp.writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

    // Print summary to stdout (agent reads this)
    const summary = {
      ok: true,
      subreddit: target.subreddit,
      lookbackHours: args.lookbackHours,
      postsCount: posts.length,
      commentsCount: totalComments,
      pagesFetched,
      outputPath,
      topPosts: posts.slice(0, 5).map((p) => ({
        title: p.title,
        score: p.score,
        commentCount: p.commentCount,
        author: p.author,
      })),
    };

    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } catch (err) {
    const output = {
      ok: false,
      error: err.message,
      subreddit: args.subreddit,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  } finally {
    // Force exit BEFORE closeSession to prevent Playwright browser.close() from hanging
    setTimeout(() => process.exit(0), 5000);
    await closeSession(session);
  }
}

main();
