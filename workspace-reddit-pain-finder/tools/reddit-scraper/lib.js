'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// Two-tier pain detection: strong signals (standalone) + weak signals (need first-person/negative context)
const PAIN_STRONG =
  /\b(frustrat\w*|nightmare|scam|rip.?off|overpriced|regret|complain\w*|rant|horrible|awful|terrible|nightmare|dishonest|incompetent|mislead\w*|ripped off|screwed|furious|livid|disgusted)\b/i;
const PAIN_WEAK =
  /\b(problem|issue|stuck|broken|fail\w*|disappoint\w*|annoying|waste|mistake|worst|struggling|hate|unfair|ridiculous|expensive)\b/i;
const PAIN_FIRST_PERSON =
  /\b(I|my|we|our|I'm|I've|we're|we've|me)\b/i;

// Legacy compat export
const PAIN_KEYWORDS = PAIN_STRONG;

function scorePain(text) {
  if (!text) return 0;
  // Strong signal: any strong keyword = pain
  if (PAIN_STRONG.test(text)) return 2;
  // Weak signal: only counts if first-person context present
  if (PAIN_WEAK.test(text) && PAIN_FIRST_PERSON.test(text)) return 1;
  return 0;
}

const BOT_AUTHORS = new Set([
  'AutoModerator', '[deleted]', '[removed]', 'BotDefense',
  'RemindMeBot', 'sneakpeekbot', 'RepostSleuthBot', 'WikiSummarizerBot',
  'SaveVideo', 'stabbot', 'sub_doesnt_exist_bot', 'LocationBot',
  'haikusbot', 'nice-scores', 'FatFingerHelperBot',
]);

function isBot(author) {
  if (!author) return true;
  if (BOT_AUTHORS.has(author)) return true;
  if (/bot$/i.test(author)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(baseMs) {
  const jitter = Math.floor(Math.random() * baseMs * 0.4);
  return baseMs + jitter;
}

function cleanText(value) {
  if (!value) return '';
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanInlineText(value) {
  return cleanText(value).replace(/\s*\n\s*/g, ' ');
}

function parseNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function absoluteRedditUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `https://www.reddit.com${value}`;
  return value;
}

function isLoginUrl(url) {
  return /\/login(\/|$)|\/account\/login/i.test(url || '');
}

async function readLoginErrorText(page) {
  const alertLocator = page.locator(
    'faceplate-alert, [cause="user-interaction-failed"], [role="alert"]',
  );
  const count = await alertLocator.count().catch(() => 0);
  if (count <= 0) return '';
  return cleanInlineText(await alertLocator.first().textContent().catch(() => ''));
}

function nowIsoFilename() {
  return new Date().toISOString().replace(/:/g, '-');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createLogger(enabled) {
  return (...args) => {
    if (enabled) console.error('[reddit-scraper]', ...args);
  };
}

function normalizeCredential(value) {
  const normalized = cleanInlineText(value || '');
  if (!normalized) return '';
  if (/^your_reddit_(username|password)$/i.test(normalized)) return '';
  return normalized;
}

function extractBlockText($, root) {
  const paragraphs = [];
  root.find('p').each((_, element) => {
    const text = cleanText($(element).text());
    if (text) paragraphs.push(text);
  });
  if (paragraphs.length > 0) return paragraphs.join('\n\n');
  return cleanInlineText(root.text());
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }
  const rawConfig = readJson(configPath);
  const projectDir = path.dirname(configPath);

  return {
    defaultSubredditUrl: '',
    headless: true,
    forceLogin: false,
    manualLoginTimeoutSec: 180,
    requestDelayMs: 800,
    lookbackHours: 24,
    maxFeedPages: 8,
    maxCommentsPerPost: 200,
    fetchComments: true,
    outputDir: path.resolve(projectDir, rawConfig.outputDir || './output'),
    storageStatePath: path.resolve(projectDir, rawConfig.storageStatePath || './storage-state.json'),
    locale: 'en-US',
    timeoutMs: 45000,
    verbose: false,
    userAgent: DEFAULT_USER_AGENT,
    ...rawConfig,
    headless: rawConfig.headless !== undefined ? rawConfig.headless : true,
    username: normalizeCredential(rawConfig.username),
    password: normalizeCredential(rawConfig.password),
    outputDir: path.resolve(projectDir, rawConfig.outputDir || './output'),
    storageStatePath: path.resolve(projectDir, rawConfig.storageStatePath || './storage-state.json'),
  };
}

// ---------------------------------------------------------------------------
// Cookie banner & login
// ---------------------------------------------------------------------------

async function dismissCookieBanner(page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Reject Optional Cookies")',
    'button:has-text("Reject non-essential")',
    'button:has-text("Reject Non-essential")',
    '[data-testid="accept-all-cookies-button"]',
    '[data-testid="reject-nonessential-cookies-button"]',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) > 0) {
      await button.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
}

async function ensureLoggedIn(context, config, log) {
  const hasSavedState = fs.existsSync(config.storageStatePath);
  if (hasSavedState && !config.forceLogin) {
    log('Using existing storage state:', config.storageStatePath);
    return;
  }

  if (!config.username || !config.password) {
    throw new Error(
      'Config must include "username" and "password" when storage-state.json is missing or forceLogin=true.',
    );
  }

  log('Performing login (headless:', config.headless, ')');
  const page = await context.newPage();

  await page.goto('https://www.reddit.com/login/', {
    waitUntil: 'domcontentloaded',
    timeout: config.timeoutMs,
  });

  await page.waitForTimeout(1500);
  await dismissCookieBanner(page);

  const usernameInput = page.locator('input[name="username"]').first();
  const passwordInput = page.locator('input[name="password"]').first();

  await usernameInput.waitFor({ state: 'visible', timeout: config.timeoutMs });
  await usernameInput.fill(config.username);
  await page.waitForTimeout(300);
  await passwordInput.fill(config.password);
  await page.waitForTimeout(400);

  const submitButton = page
    .locator('button.login, button:has-text("Log In"), button[type="submit"]')
    .first();
  await submitButton.waitFor({ state: 'visible', timeout: config.timeoutMs });
  await submitButton.click({ timeout: 10000 });
  log('Submitted login form; current URL:', page.url());

  if (!config.headless) {
    const settleMs = Math.min(config.manualLoginTimeoutSec * 1000, 15000);
    await page.waitForTimeout(settleMs);
    const loginError = await readLoginErrorText(page);
    if (loginError) throw new Error(`Reddit login failed: ${loginError}`);
    await context.storageState({ path: config.storageStatePath });
    log('Saved storage state after headed login settle');
    await page.close().catch(() => {});
    return;
  }

  const deadline = Date.now() + config.manualLoginTimeoutSec * 1000;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const onLoginRoute = isLoginUrl(currentUrl);
    const hasUsername = (await page.locator('input[name="username"]').count().catch(() => 0)) > 0;
    const hasPassword = (await page.locator('input[name="password"]').count().catch(() => 0)) > 0;

    if (!onLoginRoute && !hasUsername && !hasPassword) {
      await context.storageState({ path: config.storageStatePath });
      log('Saved storage state to', config.storageStatePath);
      await page.close();
      return;
    }

    const loginError = await readLoginErrorText(page);
    if (loginError) throw new Error(`Reddit login failed: ${loginError}`);

    const otherPages = context.pages().filter((c) => c !== page);
    for (const candidate of otherPages) {
      const candidateUrl = candidate.url();
      if (!candidateUrl || candidateUrl === 'about:blank' || isLoginUrl(candidateUrl)) continue;
      await context.storageState({ path: config.storageStatePath });
      log('Saved storage state from redirected page', candidateUrl);
      await page.close().catch(() => {});
      return;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(
    `Login was not confirmed within ${config.manualLoginTimeoutSec}s.`,
  );
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

async function fetchText(context, url, config, log, referer) {
  log('GET', url);
  const response = await context.request.get(url, {
    failOnStatusCode: false,
    timeout: config.timeoutMs,
    headers: {
      'user-agent': config.userAgent,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': `${config.locale},en;q=0.9`,
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      ...(referer ? { referer } : {}),
    },
  });

  const text = await response.text();
  log('Status', response.status(), 'bytes', text.length);

  if (!response.ok()) {
    throw new Error(`Request failed with status ${response.status()} for ${url}`);
  }

  return text;
}

async function fetchJson(context, url, config, log, referer) {
  log('GET (json)', url);

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await context.request.get(url, {
      failOnStatusCode: false,
      timeout: config.timeoutMs,
      headers: {
        'user-agent': config.userAgent,
        accept: 'application/json, text/plain, */*',
        'accept-language': `${config.locale},en;q=0.9`,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        ...(referer ? { referer } : {}),
      },
    });

    const status = response.status();
    log('Status', status, 'attempt', attempt + 1);

    if (status === 429) {
      // Rate limited — back off and retry
      const retryAfter = parseInt(response.headers()['retry-after'] || '15', 10);
      const backoffMs = Math.max(retryAfter * 1000, 5000) + jitteredDelay(2000);
      log('Rate limited (429), backing off', Math.round(backoffMs / 1000), 'seconds');
      await sleep(backoffMs);
      continue;
    }

    const text = await response.text();
    log('Bytes', text.length);

    if (!response.ok()) {
      throw new Error(`Request failed with status ${status} for ${url}`);
    }

    return JSON.parse(text);
  }

  throw new Error(`Rate limited after 3 retries for ${url}`);
}

// ---------------------------------------------------------------------------
// Feed parsing (HTML partials from shreddit)
// ---------------------------------------------------------------------------

function getLastFeedPartialUrl($) {
  const candidates = $('faceplate-partial[src*="/svc/shreddit/community-more-posts/"]')
    .map((_, element) => $(element).attr('src'))
    .get()
    .filter(Boolean);

  if (candidates.length > 0) {
    return absoluteRedditUrl(candidates[candidates.length - 1]);
  }

  const reloadUrl = $('shreddit-feed').first().attr('reload-url');
  return absoluteRedditUrl(reloadUrl);
}

function parsePostElement($, element) {
  const post = $(element);
  const id = post.attr('id');
  if (!id || !id.startsWith('t3_')) return null;

  const postType = post.attr('post-type') || 'unknown';
  const title = cleanInlineText(post.attr('post-title') || '');
  const permalink = absoluteRedditUrl(post.attr('permalink'));
  const contentUrl = absoluteRedditUrl(post.attr('content-href'));
  const bodyNode = post.find('shreddit-post-text-body').first();
  const body = bodyNode.length > 0 ? extractBlockText($, bodyNode) : '';

  const thumbnail = absoluteRedditUrl(
    post.find('[slot="thumbnail"] img').first().attr('src') ||
      post.find('[slot="post-media-container"] img').first().attr('src'),
  );

  const imageUrls = unique(
    post
      .find('[slot="thumbnail"] img, [slot="post-media-container"] img')
      .map((_, img) => absoluteRedditUrl($(img).attr('src')))
      .get(),
  );

  const videos = post
    .find('[slot="post-media-container"] shreddit-player, [slot="post-media-container"] video')
    .map((_, media) => {
      const node = $(media);
      const src = absoluteRedditUrl(node.attr('src') || node.attr('preview'));
      const poster = absoluteRedditUrl(node.attr('poster'));
      if (!src && !poster) return null;
      return { src: src || null, poster: poster || null };
    })
    .get()
    .filter(Boolean);

  return {
    id,
    shortId: id.replace(/^t3_/, ''),
    subreddit: post.attr('subreddit-name') || null,
    title,
    body,
    author: post.attr('author') || null,
    createdAt: post.attr('created-timestamp') || null,
    permalink,
    contentUrl,
    domain: post.attr('domain') || null,
    postType,
    score: parseNumber(post.attr('score'), 0),
    commentCount: parseNumber(post.attr('comment-count'), 0),
    thumbnail,
    media: { images: imageUrls, videos },
    comments: [],
  };
}

function parseFeedHtml(html) {
  const $ = cheerio.load(html);
  const posts = [];
  const seen = new Set();

  $('shreddit-post').each((_, element) => {
    const parsed = parsePostElement($, element);
    if (!parsed || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    posts.push(parsed);
  });

  return { posts, nextUrl: getLastFeedPartialUrl($) };
}

// ---------------------------------------------------------------------------
// Comment parsing
// ---------------------------------------------------------------------------

function parseCommentElement($, element) {
  const comment = $(element);
  const id = comment.attr('thingid');
  if (!id || !id.startsWith('t1_')) return null;

  const author = comment.attr('author') || null;
  if (isBot(author)) return null; // filter bots in HTML path too

  const bodyNode = comment.find('[slot="comment"]').first();
  const body =
    bodyNode.length > 0
      ? extractBlockText($, bodyNode)
      : cleanInlineText(comment.text());

  return {
    id,
    parentId: comment.attr('parentid') || null,
    postId: comment.attr('postid') || null,
    author,
    createdAt: comment.attr('created') || null,
    depth: parseNumber(comment.attr('depth'), 0),
    score: parseNumber(comment.attr('score'), 0),
    permalink: absoluteRedditUrl(comment.attr('permalink')),
    body,
  };
}

function parseCommentsHtml(html, maxCommentsPerPost) {
  const $ = cheerio.load(html);
  const comments = [];
  const seen = new Set();

  $('shreddit-comment').each((_, element) => {
    const parsed = parseCommentElement($, element);
    if (!parsed || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    comments.push(parsed);
  });

  return {
    totalComments: parseNumber(
      $('shreddit-comment-tree-stats').first().attr('total-comments'),
      comments.length,
    ),
    comments: comments.slice(0, maxCommentsPerPost),
  };
}

function buildCommentsUrl(post) {
  if (!post.subreddit || !post.shortId) return null;
  return (
    `https://www.reddit.com/svc/shreddit/comments/r/${post.subreddit}/${post.shortId}` +
    '?seeker-session=true&render-mode=partial&referer='
  );
}

// ---------------------------------------------------------------------------
// JSON API collection (primary — more complete, no HTML parsing)
// ---------------------------------------------------------------------------

function parseJsonPost(d) {
  return {
    id: d.name || `t3_${d.id}`,
    shortId: d.id,
    subreddit: d.subreddit,
    title: cleanInlineText(d.title || ''),
    body: cleanText(d.selftext || ''),
    author: d.author || null,
    createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    contentUrl: d.url_overridden_by_dest || d.url || null,
    domain: d.domain || null,
    postType: d.is_self ? 'text' : 'link',
    score: d.score || 0,
    commentCount: d.num_comments || 0,
    over18: d.over_18 || false,
    comments: [],
    commentsTotal: d.num_comments || 0,
  };
}

function flattenCommentTree(node, linkId, maxDepth) {
  const comments = [];
  if (!node || !node.data) return comments;

  if (node.kind === 't1') {
    const d = node.data;
    if (!isBot(d.author)) {
      comments.push({
        id: d.name || `t1_${d.id}`,
        parentId: d.parent_id || null,
        postId: linkId,
        author: d.author || null,
        createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
        depth: d.depth || 0,
        score: d.score || 0,
        permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
        body: cleanText(d.body || ''),
      });
    }

    // Recurse into replies
    if (d.replies && d.replies.data && d.replies.data.children) {
      for (const child of d.replies.data.children) {
        if (child.kind === 't1' && (maxDepth === 0 || (child.data.depth || 0) < maxDepth)) {
          comments.push(...flattenCommentTree(child, linkId, maxDepth));
        }
      }
    }
  }

  return comments;
}

async function collectRecentPostsAuto(context, target, config, log) {
  // Try JSON API first, fall back to HTML if rate-limited
  try {
    const testUrl = `https://www.reddit.com/r/${target.subreddit}/new.json?limit=1&raw_json=1`;
    const testResp = await context.request.get(testUrl, {
      failOnStatusCode: false,
      timeout: 15000,
      headers: { 'user-agent': config.userAgent },
    });
    if (testResp.status() === 429) {
      log('JSON API rate-limited (429), falling back to HTML endpoints');
      return collectRecentPosts(context, target, config, log);
    }
  } catch (err) {
    log('JSON API probe failed, falling back to HTML:', err.message);
    return collectRecentPosts(context, target, config, log);
  }
  return collectRecentPostsJson(context, target, config, log);
}

async function collectCommentsAuto(context, posts, config, log) {
  // Try JSON API first, fall back to HTML if rate-limited
  if (posts.length === 0) return { totalCollected: 0, totalActual: 0 };
  const firstPost = posts.find((p) => p.commentCount > 0);
  if (!firstPost) return { totalCollected: 0, totalActual: 0 };

  try {
    const testUrl = `https://www.reddit.com/r/${firstPost.subreddit}/comments/${firstPost.shortId}.json?limit=1&raw_json=1`;
    const testResp = await context.request.get(testUrl, {
      failOnStatusCode: false,
      timeout: 15000,
      headers: { 'user-agent': config.userAgent },
    });
    if (testResp.status() === 429) {
      log('JSON API rate-limited for comments, falling back to HTML');
      const count = await collectComments(context, posts, config, log);
      // Calculate actual totals for HTML fallback
      let totalActual = 0;
      for (const p of posts) totalActual += p.commentsTotal || p.commentCount || 0;
      return { totalCollected: count, totalActual };
    }
  } catch (err) {
    log('JSON comment probe failed, falling back to HTML:', err.message);
    const count = await collectComments(context, posts, config, log);
    let totalActual = 0;
    for (const p of posts) totalActual += p.commentsTotal || p.commentCount || 0;
    return { totalCollected: count, totalActual };
  }
  return collectCommentsJson(context, posts, config, log);
}

async function collectRecentPostsJson(context, target, config, log) {
  const cutoffMs = Date.now() - config.lookbackHours * 60 * 60 * 1000;
  const posts = [];
  const seenIds = new Set();
  let after = null;
  let pagesFetched = 0;

  while (pagesFetched < config.maxFeedPages) {
    if (pagesFetched > 0) await sleep(jitteredDelay(config.requestDelayMs));

    let url = `https://www.reddit.com/r/${target.subreddit}/new.json?limit=100&raw_json=1`;
    if (after) url += `&after=${after}`;

    try {
      const data = await fetchJson(context, url, config, log, `https://www.reddit.com/r/${target.subreddit}/`);
      if (!data || !data.data || !data.data.children) break;

      let pageHasFreshPosts = false;

      for (const child of data.data.children) {
        if (child.kind !== 't3' || !child.data) continue;
        const post = parseJsonPost(child.data);
        if (seenIds.has(post.id)) continue;
        seenIds.add(post.id);

        const createdMs = post.createdAt ? Date.parse(post.createdAt) : NaN;
        if (!Number.isFinite(createdMs) || createdMs < cutoffMs) continue;

        pageHasFreshPosts = true;
        posts.push(post);
      }

      pagesFetched += 1;
      after = data.data.after;

      if (!pageHasFreshPosts || !after) break;
    } catch (err) {
      log('JSON feed page failed:', err.message);
      break;
    }
  }

  return { posts, pagesFetched };
}

async function collectCommentsJson(context, posts, config, log) {
  let totalCollected = 0;
  let totalActual = 0;
  if (!config.fetchComments) return { totalCollected, totalActual };

  for (const post of posts) {
    if (post.commentCount <= 0) continue;

    await sleep(jitteredDelay(config.requestDelayMs));

    try {
      // Fetch initial comment tree via JSON API (limit=200 reduces payload + rate pressure)
      const url =
        `https://www.reddit.com/r/${post.subreddit}/comments/${post.shortId}.json` +
        `?limit=200&depth=8&sort=confidence&raw_json=1`;

      const data = await fetchJson(context, url, config, log, post.permalink);
      if (!Array.isArray(data) || data.length < 2) continue;

      const commentListing = data[1];
      if (!commentListing || !commentListing.data) continue;

      const comments = [];

      for (const child of commentListing.data.children) {
        if (child.kind === 't1') {
          comments.push(...flattenCommentTree(child, post.id, 10));
        }
      }

      // Deduplicate
      const seen = new Set();
      post.comments = [];
      for (const c of comments) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          post.comments.push(c);
        }
      }
      post.commentsTotal = post.commentCount; // actual total from Reddit metadata
      totalCollected += post.comments.length;
      totalActual += post.commentsTotal;
    } catch (err) {
      log('Failed to fetch comments for', post.id, err.message);
      post.comments = [];
    }
  }

  return { totalCollected, totalActual };
}

// ---------------------------------------------------------------------------
// Legacy HTML collection (fallback)
// ---------------------------------------------------------------------------

async function collectRecentPosts(context, target, config, log) {
  const cutoffMs = Date.now() - config.lookbackHours * 60 * 60 * 1000;
  const posts = [];
  const seenIds = new Set();
  let nextUrl = target.feedUrl;
  let pagesFetched = 0;

  while (nextUrl && pagesFetched < config.maxFeedPages) {
    if (pagesFetched > 0) await sleep(jitteredDelay(config.requestDelayMs));

    const referer = pagesFetched === 0 ? `https://www.reddit.com/r/${target.subreddit}/` : target.feedUrl;
    const html = await fetchText(context, nextUrl, config, log, referer);
    const { posts: parsedPosts, nextUrl: parsedNextUrl } = parseFeedHtml(html);

    let pageHasFreshPosts = false;

    for (const post of parsedPosts) {
      if (seenIds.has(post.id)) continue;
      seenIds.add(post.id);

      const createdMs = post.createdAt ? Date.parse(post.createdAt) : NaN;
      if (!Number.isFinite(createdMs) || createdMs < cutoffMs) continue;

      pageHasFreshPosts = true;
      posts.push(post);
    }

    pagesFetched += 1;

    if (!pageHasFreshPosts) break;
    if (!parsedNextUrl || parsedNextUrl === nextUrl) break;
    nextUrl = parsedNextUrl;
  }

  return { posts, pagesFetched };
}

async function collectComments(context, posts, config, log) {
  let totalComments = 0;
  if (!config.fetchComments) return totalComments;

  for (const post of posts) {
    if (post.commentCount <= 0) continue;

    const commentsUrl = buildCommentsUrl(post);
    if (!commentsUrl) continue;

    await sleep(jitteredDelay(config.requestDelayMs));

    try {
      const html = await fetchText(context, commentsUrl, config, log, post.permalink);
      const parsed = parseCommentsHtml(html, config.maxCommentsPerPost);
      post.comments = parsed.comments;
      post.commentsTotal = parsed.totalComments;
      totalComments += post.comments.length;
    } catch (err) {
      log('Failed to fetch comments for', post.id, err.message);
      post.comments = [];
    }
  }

  return totalComments;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function createSession(configPath) {
  const config = loadConfig(configPath);
  const log = createLogger(config.verbose);

  const needsFreshLogin = config.forceLogin || !fs.existsSync(config.storageStatePath);
  if (needsFreshLogin && (!config.username || !config.password)) {
    throw new Error(
      'Missing Reddit credentials. Fill username/password in config or provide a valid storage-state.json.',
    );
  }

  const browser = await chromium.launch({ headless: config.headless });
  const contextOptions = {
    locale: config.locale,
    userAgent: config.userAgent,
    viewport: { width: 1440, height: 900 },
  };

  if (fs.existsSync(config.storageStatePath) && !config.forceLogin) {
    contextOptions.storageState = config.storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  await ensureLoggedIn(context, config, log);

  return { context, browser, config, log };
}

async function closeSession(session) {
  if (!session) return;
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

function parseTarget(rawUrl) {
  if (!rawUrl) throw new Error('Subreddit URL or name is required.');

  let normalizedUrl;
  if (/^https?:\/\//i.test(rawUrl)) {
    normalizedUrl = rawUrl;
  } else if (rawUrl.startsWith('/r/') || rawUrl.startsWith('r/')) {
    normalizedUrl = `https://www.reddit.com/${rawUrl.replace(/^\//, '')}`;
  } else {
    normalizedUrl = `https://www.reddit.com/r/${rawUrl}/`;
  }

  const url = new URL(normalizedUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  const rIndex = parts.indexOf('r');

  if (rIndex === -1 || !parts[rIndex + 1]) {
    throw new Error(`Could not extract subreddit from: ${rawUrl}`);
  }

  const subreddit = parts[rIndex + 1];
  const feedUrl = `https://www.reddit.com/r/${subreddit}/new/`;

  return { subreddit, inputUrl: normalizedUrl, feedUrl };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  DEFAULT_USER_AGENT,
  PAIN_KEYWORDS,
  PAIN_STRONG,
  PAIN_WEAK,
  BOT_AUTHORS,
  scorePain,
  // Utilities
  sleep,
  jitteredDelay,
  cleanText,
  cleanInlineText,
  parseNumber,
  unique,
  absoluteRedditUrl,
  nowIsoFilename,
  readJson,
  createLogger,
  isBot,
  // Config
  loadConfig,
  // Session
  createSession,
  closeSession,
  // HTTP
  fetchText,
  fetchJson,
  // JSON API collection (primary, with HTML fallback)
  collectRecentPostsAuto,
  collectCommentsAuto,
  collectRecentPostsJson,
  collectCommentsJson,
  parseJsonPost,
  flattenCommentTree,
  // Legacy HTML collection (fallback)
  collectRecentPosts,
  collectComments,
  parseFeedHtml,
  parseCommentsHtml,
  // Target
  parseTarget,
};
