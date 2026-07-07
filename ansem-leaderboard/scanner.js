#!/usr/bin/env node
/**
 * $ANSEM Leaderboard Scanner  (v2)
 * ---------------------------------------------------------
 * Three passes per run:
 *   1. TOP crawl      — X's "relevancy" sort, catches the biggest
 *                       posts across the full 7-day window
 *   2. NEWEST crawl   — recency sort, catches fresh posts
 *   3. REFRESH pass   — re-checks view counts on posts already
 *                       tracked, so impressions mature over time
 *
 * USAGE (GitHub Actions runs this for you):
 *   X_BEARER_TOKEN="token" node scanner.js
 *   Options: --pages=3 (pages per crawl)  --refresh=300 (posts to refresh)
 *   Preview: node scanner.js --mock
 */

const fs = require('fs');
const path = require('path');

// ------------------------- CONFIG -------------------------
const QUERY = '($ANSEM OR "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump") -is:retweet';
const pagesArg = process.argv.find(a => a.startsWith('--pages='));
const refreshArg = process.argv.find(a => a.startsWith('--refresh='));
const PAGES_PER_CRAWL = pagesArg ? Math.max(1, parseInt(pagesArg.split('=')[1], 10) || 3) : 3;
const REFRESH_COUNT = refreshArg ? Math.max(0, parseInt(refreshArg.split('=')[1], 10) || 300) : 300;
const TOP_POSTS = 20;
const TOP_ACCOUNTS = 50;
const COST_PER_READ = 0.005;   // update if X changes pricing
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');
// -----------------------------------------------------------

const MOCK = process.argv.includes('--mock');
const TOKEN = process.env.X_BEARER_TOKEN;
let totalReads = 0;

async function main() {
  const store = loadStore();
  let newTweets = [], users = {};

  if (MOCK) {
    console.log('⚡ Mock mode — generating sample data so you can preview the leaderboard.\n');
    ({ tweets: newTweets, users } = generateMockData());
    for (const t of newTweets) store.tweets[t.id] = t;
    for (const u of Object.values(users)) store.users[u.id] = u;
  } else {
    if (!TOKEN) {
      console.error('❌ No API token found.\n');
      console.error('Run with:  X_BEARER_TOKEN="your-token" node scanner.js');
      console.error('Or preview with fake data:  node scanner.js --mock');
      process.exit(1);
    }

    // Pass 1: biggest posts of the week (X's "Top" ranking)
    console.log('🏆 Crawl 1/2: top posts (relevancy sort)…');
    const top = await scanX('relevancy');

    // Pass 2: freshest posts
    console.log('🕐 Crawl 2/2: newest posts (recency sort)…');
    const fresh = await scanX('recency');

    for (const t of [...top.tweets, ...fresh.tweets]) store.tweets[t.id] = t;
    for (const u of [...Object.values(top.users), ...Object.values(fresh.users)]) store.users[u.id] = u;
    newTweets = [...top.tweets, ...fresh.tweets];

    // Pass 3: refresh view counts on posts we're already tracking,
    // so a post caught at 50 views doesn't stay frozen there.
    const justFetched = new Set(newTweets.map(t => t.id));
    await refreshTracked(store, justFetched);

    const est = (totalReads * COST_PER_READ).toFixed(2);
    console.log(`\n💳 Estimated cost this run: ~$${est} (${totalReads} reads × $${COST_PER_READ}; X dedupes repeat reads of the same post within 24h, so actual is often less)`);
  }

  saveStore(store);
  pruneAndRender(store, newTweets.length);
}

// ===================== X API CRAWL =====================

async function scanX(sortOrder) {
  const tweets = [];
  const users = {};
  let nextToken = null;

  for (let page = 1; page <= PAGES_PER_CRAWL; page++) {
    const url = new URL('https://api.x.com/2/tweets/search/recent');
    url.searchParams.set('query', QUERY);
    url.searchParams.set('max_results', '100');
    url.searchParams.set('sort_order', sortOrder);
    url.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name,public_metrics,profile_image_url');
    if (nextToken) url.searchParams.set('next_token', nextToken);

    console.log(`   page ${page}/${PAGES_PER_CRAWL}…`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      const waitMs = Math.max(reset - Date.now(), 5000);
      console.log(`   ⏳ rate limited — waiting ${Math.ceil(waitMs / 1000)}s…`);
      await new Promise(r => setTimeout(r, waitMs));
      page--; continue;
    }
    if (!res.ok) {
      console.error(`   ❌ API error ${res.status}: ${await res.text()}`);
      break;
    }

    const data = await res.json();
    ingestUsers(data.includes?.users, users);
    for (const t of data.data || []) tweets.push(shapeTweet(t));
    totalReads += (data.data || []).length;

    nextToken = data.meta?.next_token;
    if (!nextToken) break;
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`   → ${tweets.length} posts collected\n`);
  return { tweets, users };
}

// ===================== REFRESH PASS =====================

async function refreshTracked(store, skipIds) {
  const cutoff = Date.now() - 7 * 86400000;
  // Refresh the most promising tracked posts we did NOT just fetch:
  // sorted by current impressions, still inside the 7-day window.
  const candidates = Object.values(store.tweets)
    .filter(t => !skipIds.has(t.id) && new Date(t.created_at).getTime() > cutoff)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, REFRESH_COUNT);

  if (!candidates.length) { console.log('🔄 Refresh: nothing to update yet.'); return; }
  console.log(`🔄 Refresh: updating view counts on ${candidates.length} tracked posts…`);

  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const url = new URL('https://api.x.com/2/tweets');
    url.searchParams.set('ids', batch.map(t => t.id).join(','));
    url.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name,public_metrics,profile_image_url');

    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      const waitMs = Math.max(reset - Date.now(), 5000);
      console.log(`   ⏳ rate limited — waiting ${Math.ceil(waitMs / 1000)}s…`);
      await new Promise(r => setTimeout(r, waitMs));
      i -= 100; continue;
    }
    if (!res.ok) { console.error(`   ❌ refresh error ${res.status}: ${await res.text()}`); break; }

    const data = await res.json();
    ingestUsers(data.includes?.users, store.users);
    for (const t of data.data || []) store.tweets[t.id] = shapeTweet(t);
    totalReads += (data.data || []).length;
    // Posts deleted on X come back in data.errors — drop them from the board
    for (const err of data.errors || []) {
      if (err.resource_id && store.tweets[err.resource_id]) delete store.tweets[err.resource_id];
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log('   → done\n');
}

// ===================== SHARED HELPERS =====================

function shapeTweet(t) {
  const m = t.public_metrics || {};
  return {
    id: t.id,
    author_id: t.author_id,
    text: t.text,
    created_at: t.created_at,
    impressions: m.impression_count || 0,
    likes: m.like_count || 0,
    retweets: m.retweet_count || 0,
    replies: m.reply_count || 0,
  };
}

function ingestUsers(list, into) {
  for (const u of list || []) {
    into[u.id] = {
      id: u.id,
      username: u.username,
      name: u.name,
      followers: u.public_metrics?.followers_count || 0,
      avatar: u.profile_image_url || '',
    };
  }
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { tweets: {}, users: {} }; }
}
function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// ===================== RANK + RENDER =====================

function pruneAndRender(store, newCount) {
  const allTweets = Object.values(store.tweets);
  const allUsers = store.users;

  const topPosts = [...allTweets]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, TOP_POSTS);

  const byAccount = {};
  for (const t of allTweets) {
    const acc = (byAccount[t.author_id] ||= {
      id: t.author_id, impressions: 0, likes: 0, retweets: 0, replies: 0, posts: 0, bestPost: null,
    });
    acc.impressions += t.impressions;
    acc.likes += t.likes;
    acc.retweets += t.retweets;
    acc.replies += t.replies;
    acc.posts += 1;
    if (!acc.bestPost || t.impressions > acc.bestPost.impressions) acc.bestPost = t;
  }
  const topAccounts = Object.values(byAccount)
    .map(a => ({ ...a, user: allUsers[a.id] || { username: 'unknown', name: 'Unknown', followers: 0 } }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, TOP_ACCOUNTS);

  console.log(`📊 ${allTweets.length} total $ANSEM posts tracked (${newCount} new this run)\n`);
  console.log('TOP 10 POSTS BY IMPRESSIONS');
  console.log('─'.repeat(64));
  topPosts.slice(0, 10).forEach((t, i) => {
    const u = allUsers[t.author_id];
    console.log(`${String(i + 1).padStart(2)}. ${fmt(t.impressions).padStart(7)} views  @${u ? u.username : '?'} — "${t.text.slice(0, 50).replace(/\n/g, ' ')}…"`);
  });

  fs.writeFileSync(HTML_FILE, buildHtml(topPosts, topAccounts, allUsers, allTweets.length));
  console.log(`\n✅ Leaderboard written to ${HTML_FILE}`);
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function buildHtml(topPosts, topAccounts, users, totalTracked) {
  const payload = {
    generated: new Date().toISOString(),
    totalTracked,
    posts: topPosts.map(t => ({
      ...t,
      username: users[t.author_id]?.username || 'unknown',
      name: users[t.author_id]?.name || 'Unknown',
    })),
    accounts: topAccounts.map(a => ({
      username: a.user.username,
      name: a.user.name,
      followers: a.user.followers,
      impressions: a.impressions,
      likes: a.likes,
      retweets: a.retweets,
      posts: a.posts,
      bestPostId: a.bestPost?.id,
      bestPostImpressions: a.bestPost?.impressions || 0,
    })),
  };
  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  return template.replace('/*__DATA__*/', 'const DATA = ' + JSON.stringify(payload) + ';');
}

// ===================== MOCK DATA =====================

function generateMockData() {
  const handles = [
    'blknoiz06','solwhaledaily','pumpdotscience','bagworker_ben','memelordSOL',
    'cryptoK8lyn','deepliquidity','ansemarmy','solanalegend','normieonboarder',
    'chartgoblin','wagmiwendy','tickerwatcher','airdropandy','onchainoracle',
    'flipflopfren','degenDiane','bullpenscout','solsurfer_','viralvinny',
  ];
  const templates = [
    'the $ANSEM LP deepening play is actually genius — creator fees recycled into liquidity 📈',
    'just onboarded my roommate to crypto through $ANSEM. first wallet, first swap, first hold',
    '$ANSEM holders eating good: staggered airdrops + hold time bonuses = the anti-jeet mechanism',
    'made an $ANSEM holder dashboard this weekend. community tools szn 🛠️',
    'IRL activation done ✅ 50 $ANSEM stickers at the marina, 3 wallets downloaded on the spot',
  ];
  const tweets = [];
  const users = {};
  let seed = 42;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  handles.forEach((h, i) => {
    const id = `u${1000 + i}`;
    users[id] = {
      id, username: h,
      name: h.replace(/[_\d]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()) || h,
      followers: Math.floor(rand() ** 2 * 400000) + 500, avatar: '',
    };
    const postCount = 1 + Math.floor(rand() * 6);
    for (let p = 0; p < postCount; p++) {
      const reach = Math.floor((rand() ** 2.2) * (users[id].followers * 8 + 50000)) + 800;
      tweets.push({
        id: `t${i}_${p}_${Math.floor(rand() * 1e6)}`,
        author_id: id,
        text: templates[Math.floor(rand() * templates.length)],
        created_at: new Date(Date.now() - rand() * 6.5 * 86400000).toISOString(),
        impressions: reach,
        likes: Math.floor(reach * (0.008 + rand() * 0.03)),
        retweets: Math.floor(reach * (0.001 + rand() * 0.008)),
        replies: Math.floor(reach * (0.0008 + rand() * 0.004)),
      });
    }
  });
  return { tweets, users };
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
 
