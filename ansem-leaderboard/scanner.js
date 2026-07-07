#!/usr/bin/env node
/**
 * $ANSEM Leaderboard Scanner
 * ---------------------------------------------------------
 * Scans X (Twitter) for $ANSEM posts, ranks them by impressions,
 * and generates a leaderboard: Top 20 posts + Top 50 accounts.
 *
 * USAGE:
 *   1. Get an X API bearer token (Basic tier or above): https://developer.x.com
 *   2. Run:   X_BEARER_TOKEN="your-token-here" node scanner.js
 *   3. Open the generated leaderboard.html in your browser
 *
 *   No token yet? Preview with fake data:   node scanner.js --mock
 *
 * NOTES:
 *   - Recent search covers the LAST 7 DAYS only (Basic tier limit).
 *   - Re-run it daily: results merge into data.json so your
 *     leaderboard accumulates history over time.
 *   - Impressions come from X's own public_metrics.impression_count.
 */

const fs = require('fs');
const path = require('path');

// ------------------------- CONFIG -------------------------
const QUERY = '($ANSEM OR "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump") -is:retweet';
const MAX_PAGES = 10;          // 100 tweets per page → up to 1,000 tweets per run
const TOP_POSTS = 20;
const TOP_ACCOUNTS = 50;
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');
// -----------------------------------------------------------

const MOCK = process.argv.includes('--mock');
const TOKEN = process.env.X_BEARER_TOKEN;

async function main() {
  let tweets, users;

  if (MOCK) {
    console.log('⚡ Mock mode — generating sample data so you can preview the leaderboard.\n');
    ({ tweets, users } = generateMockData());
  } else {
    if (!TOKEN) {
      console.error('❌ No API token found.\n');
      console.error('Run with:  X_BEARER_TOKEN="your-token" node scanner.js');
      console.error('Or preview with fake data:  node scanner.js --mock\n');
      console.error('Get a token at https://developer.x.com (Basic tier includes search).');
      process.exit(1);
    }
    ({ tweets, users } = await scanX());
  }

  // Merge with previous runs so the leaderboard builds history
  const store = loadStore();
  for (const t of tweets) store.tweets[t.id] = t;              // newest metrics win
  for (const u of Object.values(users)) store.users[u.id] = u;
  saveStore(store);

  const allTweets = Object.values(store.tweets);
  const allUsers = store.users;

  // ---- Top 20 posts by impressions ----
  const topPosts = [...allTweets]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, TOP_POSTS);

  // ---- Top 50 accounts by TOTAL impressions across all their $ANSEM posts ----
  const byAccount = {};
  for (const t of allTweets) {
    const acc = (byAccount[t.author_id] ||= {
      id: t.author_id,
      impressions: 0, likes: 0, retweets: 0, replies: 0, posts: 0,
      bestPost: null,
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

  // ---- Console summary ----
  console.log(`📊 ${allTweets.length} total $ANSEM posts tracked (${tweets.length} from this run)\n`);
  console.log('TOP 10 POSTS BY IMPRESSIONS');
  console.log('─'.repeat(64));
  topPosts.slice(0, 10).forEach((t, i) => {
    const u = allUsers[t.author_id];
    console.log(`${String(i + 1).padStart(2)}. ${fmt(t.impressions).padStart(7)} views  @${u ? u.username : '?'} — "${t.text.slice(0, 50).replace(/\n/g, ' ')}…"`);
  });
  console.log('\nTOP 10 ACCOUNTS BY TOTAL IMPRESSIONS');
  console.log('─'.repeat(64));
  topAccounts.slice(0, 10).forEach((a, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${fmt(a.impressions).padStart(7)} views  @${a.user.username}  (${a.posts} posts)`);
  });

  // ---- HTML leaderboard ----
  fs.writeFileSync(HTML_FILE, buildHtml(topPosts, topAccounts, allUsers, allTweets.length));
  console.log(`\n✅ Leaderboard written to ${HTML_FILE}`);
}

// ===================== X API SCANNING =====================

async function scanX() {
  const tweets = [];
  const users = {};
  let nextToken = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL('https://api.x.com/2/tweets/search/recent');
    url.searchParams.set('query', QUERY);
    url.searchParams.set('max_results', '100');
    url.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name,public_metrics,profile_image_url');
    if (nextToken) url.searchParams.set('next_token', nextToken);

    console.log(`🔎 Fetching page ${page}…`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      const waitMs = Math.max(reset - Date.now(), 5000);
      console.log(`⏳ Rate limited — waiting ${Math.ceil(waitMs / 1000)}s…`);
      await new Promise(r => setTimeout(r, waitMs));
      page--; continue;
    }
    if (!res.ok) {
      console.error(`❌ API error ${res.status}: ${await res.text()}`);
      break;
    }

    const data = await res.json();
    for (const u of data.includes?.users || []) {
      users[u.id] = {
        id: u.id,
        username: u.username,
        name: u.name,
        followers: u.public_metrics?.followers_count || 0,
        avatar: u.profile_image_url || '',
      };
    }
    for (const t of data.data || []) {
      const m = t.public_metrics || {};
      tweets.push({
        id: t.id,
        author_id: t.author_id,
        text: t.text,
        created_at: t.created_at,
        impressions: m.impression_count || 0,
        likes: m.like_count || 0,
        retweets: m.retweet_count || 0,
        replies: m.reply_count || 0,
      });
    }

    nextToken = data.meta?.next_token;
    if (!nextToken) break;
    await new Promise(r => setTimeout(r, 1200)); // be gentle with rate limits
  }

  console.log(`\n📥 Pulled ${tweets.length} posts from the last 7 days.\n`);
  return { tweets, users };
}

// ===================== STORAGE =====================

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { tweets: {}, users: {} }; }
}
function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// ===================== MOCK DATA =====================

function generateMockData() {
  const handles = [
    'blknoiz06','solwhaledaily','pumpdotscience','bagworker_ben','memelordSOL',
    'cryptoK8lyn','deepliquidity','ansemarmy','solanalegend','normieonboarder',
    'chartgoblin','wagmiwendy','tickerwatcher','airdropandy','onchainoracle',
    'flipflopfren','degenDiane','bullpenscout','solsurfer_','viralvinny',
    'ct_historian','moonmathmike','liquiditylucy','holdtheline_hank','fomofighter',
    'threadoorTom','clipfarmCarl', 'irl_activator','questmasterQ','netbuyerNate',
    'stackinsats_s','memeticmaggie','tokenomicsTed','breakoutbecky','vibechecker_v',
    'communitycady','shillfree_sam','datadrivendan','pumpfunpaul','solmaxi_mo',
    'newbullnora','greencandlegus','bagholderbill','transparencyTia','staggerstaker',
    'whalewatchwill','entryexitem','ath_annie','floorpricefred','lastcycleleo',
    'orangepillolly','riskonrita','sizematters_s','topsignaltodd','zoomoutzack',
  ];
  const templates = [
    'the $ANSEM LP deepening play is actually genius — creator fees recycled into liquidity means early seller pressure gets absorbed. this is how you build a floor 📈',
    'just onboarded my roommate to crypto through $ANSEM. walked him through his first wallet, first swap, first hold. this is what the airdrop meta should reward',
    '$ANSEM holders eating good: staggered airdrops at higher mcaps + hold time bonuses = the anti-jeet mechanism CT has needed for years',
    'made an $ANSEM holder dashboard this weekend. tracks LP depth, top wallets, and airdrop eligibility. community tools szn 🛠️',
    'IRL activation done ✅ handed out 50 $ANSEM stickers at the marina today, 3 people downloaded a wallet on the spot. normie funnel is real',
    'the transparency on $ANSEM is unmatched — all team/marketing supply moves from the public pump fun wallet. no side wallets. receipts on chain',
    'thread: why $ANSEM is the first memecoin with an actual retention strategy 🧵 (1/9)',
    '$ANSEM net buying pressure loop: creator fees → SOL airdrops → bagworkers post → new eyes → new buys. flywheel is spinning',
    'quests for holders to try new protocols + get rewarded?? $ANSEM is lowkey building the best crypto onboarding funnel of the cycle',
    'my $ANSEM clip hit 200k on tiktok. normies in the comments asking how to buy their first coin. the funnel works',
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
      followers: Math.floor(rand() ** 2 * 400000) + 500,
      avatar: '',
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

// ===================== HELPERS + HTML =====================

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

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
