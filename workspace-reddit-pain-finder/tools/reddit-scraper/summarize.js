'use strict';

/**
 * summarize.js — Extract compact analysis-ready summary from scraped data
 *
 * Usage:
 *   node summarize.js <path-to-scraped-json> [--max-posts 50] [--max-comment-chars 200]
 *
 * Output: Compact JSON to stdout with post titles, truncated bodies, and top comments.
 * Designed to keep output under ~15KB for agent context window efficiency.
 */

const fs = require('fs');
const path = require('path');

const { scorePain } = require('./lib');

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '…';
}

function hasPainSignal(text) {
  return scorePain(text) > 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node summarize.js <scraped-json-path> [--max-posts N]');
    process.exit(1);
  }

  const filePath = args[0];
  let maxPosts = 30;
  let maxCommentChars = 150;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--max-posts' && args[i + 1]) maxPosts = parseInt(args[++i], 10);
    if (args[i] === '--max-comment-chars' && args[i + 1]) maxCommentChars = parseInt(args[++i], 10);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const posts = (raw.posts || []).slice(0, maxPosts);

  // Separate pain and non-pain posts, limit pain to top 10 by engagement
  const allMapped = posts.map((p) => {
      const titlePain = hasPainSignal(p.title);
      const bodyPain = hasPainSignal(p.body);
      const painComments = (p.comments || [])
        .filter((c) => hasPainSignal(c.body))
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 5);
      const topComments = (p.comments || [])
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 3);

      // Merge pain comments and top comments, deduplicate
      const seen = new Set();
      const selectedComments = [];
      for (const c of [...painComments, ...topComments]) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          selectedComments.push({
            author: c.author,
            score: c.score,
            body: truncate(c.body, maxCommentChars),
            pain: hasPainSignal(c.body),
          });
        }
      }

      const isPain = titlePain || bodyPain || painComments.length > 0;
      return {
        title: p.title,
        body: isPain ? truncate(p.body, 150) : undefined,
        author: isPain ? p.author : undefined,
        score: p.score,
        commentCount: p.commentCount,
        pain: isPain,
        comments: isPain ? selectedComments.slice(0, 3) : undefined,
      };
    });

  // Sort pain posts by engagement (score + comments), keep top 10
  const painPosts = allMapped
    .filter((p) => p.pain)
    .sort((a, b) => (b.score + b.commentCount) - (a.score + a.commentCount))
    .slice(0, 10);
  const otherPosts = allMapped.filter((p) => !p.pain);

  const summary = {
    subreddit: raw.subreddit,
    lookbackHours: raw.lookbackHours,
    postsCount: raw.stats ? raw.stats.postsCount : posts.length,
    commentsCount: raw.stats ? raw.stats.commentsCount : 0,
    painPostCount: painPosts.length,
    posts: [...painPosts, ...otherPosts.slice(0, 5)], // top 10 pain + 5 non-pain for context
  };

  process.stdout.write(JSON.stringify(summary) + '\n');
}

main();
