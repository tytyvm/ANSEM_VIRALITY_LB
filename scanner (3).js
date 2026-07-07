/**
 * $ANSEM Daily Top 20 Scanner  (v4)
 * ---------------------------------------------------------
 * DESIGN PRINCIPLE: every number on the board comes from the
 * same moment. The leaderboard is built ONLY from posts
 * fetched during this run — never from stored data — so all
 * view counts are directly comparable and the ranking is
 * internally consistent.
 *
 * WHAT IT DOES each night:
 *   1. Crawls the top $ANSEM posts of the LAST 24 HOURS
 *      (X relevancy sort). Always buys at least 2 pages;
 *      stops early only when a page is overwhelmingly
 *      (80%+) small posts under MIN_VIEWS.
 *   2. Ranks THIS RUN's posts by impressions → Top 20 board.
 *   3. Appends everything to data.json as an ARCHIVE for
 *      future features (all-time board, rank checker).
 *      The archive is never used for ranking.
 *
 * Cost: ~$0.50–1.00/day. No refresh pass.
 * If X replies "credits depleted" (402), the run FAILS LOUDLY
 * (red X in GitHub Actions) instead of publishing a half-
 * empty board.
 *
 * USAGE (GitHub Actions runs this for you):
 *   X_BEARER_TOKEN="token" node scanner.js
 *   Options: --pages=3 (max pages)
 *   Preview: node scanner.js --mock
 */

const fs = require('fs');
const path = require('path');

// ------------------------- CONFIG -------------------------
const QUERY = '($ANSEM OR "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump") -is:retweet';
const CONTRACT = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';
const MIN_VIEWS = 5000;   // early-stop threshold
const MIN_PAGES = 2;      // always buy at least this many pages
const STOP_RATIO = 0.8;   // stop only if 80%+ of a page is under MIN_VIEWS
const pagesArg = process.argv.find(a => a.startsWith('--pages='));
const MAX_PAGES = pagesArg ? Math.max(MIN_PAGES, parseInt(pagesArg.split('=')[1], 10) || 3) : 3;
const TOP_TODAY = 20;
const COST_PER_READ = 0.005;   // update if X changes pricing
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');
// -----------------------------------------------------------

const MOCK = process.argv.includes('--mock');
const TOKEN = process.env.X_BEARER_TOKEN;
let totalReads = 0;

async function main() {
  let tweets = [], users = {};

  if (MOCK) {
    console.log('⚡ Mock mode — generating sample data so you can preview the leaderboard.\n');
    ({ tweets, users } = generateMockData());
  } else {
    if (!TOKEN) {
      console.error('❌ No API token found.\n');
      console.error('Run with:  X_BEARER_TOKEN="your-token" node scanner.js');
      console.error('Or preview with fake data:  node scanner.js --mock');
      process.exit(1);
    }
    console.log(`📅 Scanning: top $ANSEM posts of the last 24 hours…`);
    ({ tweets, users } = await scanLast24h());

    const est = (totalReads * COST_PER_READ).toFixed(2);
    console.log(`💳 Estimated cost this run: ~$${est} (${totalReads} reads × $${COST_PER_READ})\n`);
  }

  // THE BOARD: built only from this run's posts — one consistent snapshot.
  const top = [...tweets]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, TOP_TODAY);

  console.log(`📊 ${tweets.length} posts scanned in this run\n`);
  console.log("TODAY'S TOP 10 BY IMPRESSIONS (last 24h)");
  console.log('─'.repeat(64));
  top.slice(0, 10).forEach((t, i) => {
    const u = users[t.author_id];
    console.log(`${String(i + 1).padStart(2)}. ${fmt(t.impressions).padStart(7)} views  @${u ? u.username : '?'} — "${t.text.slice(0, 50).replace(/\n/g, ' ')}…"`);
  });

  render(top, users);
  archive(tweets, users);
}

// ===================== DAILY CRAWL (last 24h) =====================

async function scanLast24h() {
  const tweets = [];
  const users = {};
  let nextToken = null;
  const start = new Date(Date.now() - 24 * 3600000).toISOString();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL('https://api.x.com/2/tweets/search/recent');
    url.searchParams.set('query', QUERY);
    url.searchParams.set('max_results', '100');
    url.searchParams.set('sort_order', 'relevancy');
    url.searchParams.set('start_time', start);
    url.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name,public_metrics,profile_image_url');
    if (nextToken) url.searchParams.set('next_token', nextToken);

    console.log(`   page ${page}/${MAX_PAGES}…`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

    if (res.status === 402) failCreditsDepleted();
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
    for (const u of data.includes?.users || []) {
      users[u.id] = {
        id: u.id,
        username: u.username,
        name: u.name,
        followers: u.public_metrics?.followers_count || 0,
      };
    }
    const pageTweets = (data.data || []).map(shapeTweet);
    tweets.push(...pageTweets);
    totalReads += pageTweets.length;

    // EARLY STOP — but never before MIN_PAGES, and only when a page is
    // overwhelmingly small posts. Relevancy order isn't impressions order,
    // so we deliberately over-buy a little to protect coverage.
    if (page >= MIN_PAGES && pageTweets.length > 0) {
      const below = pageTweets.filter(t => t.impressions < MIN_VIEWS).length;
      if (below / pageTweets.length >= STOP_RATIO) {
        console.log(`   ✋ early stop: ${below}/${pageTweets.length} posts on this page are under ${fmt(MIN_VIEWS)} views — not buying the next page`);
        break;
      }
    }

    nextToken = data.meta?.next_token;
    if (!nextToken) break;
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`   → ${tweets.length} posts collected\n`);
  return { tweets, users };
}

function failCreditsDepleted() {
  console.error('\n' + '═'.repeat(60));
  console.error('❌ X API CREDITS DEPLETED — the scan cannot continue.');
  console.error('   Top up credits at developer.x.com, then re-run this');
  console.error('   workflow. Nothing was published from this partial run.');
  console.error('═'.repeat(60) + '\n');
  process.exit(1);
}

// ===================== HELPERS =====================

function cleanText(text) {
  // X's API returns token tags as raw "solana:<contract>" strings — swap back to the cashtag
  return text
    .replace(/solana:[1-9A-HJ-NP-Za-km-z]{32,44}/g, () => '$ANSEM')
    .replace(new RegExp(CONTRACT, 'g'), () => '$ANSEM');
}

function shapeTweet(t) {
  const m = t.public_metrics || {};
  return {
    id: t.id,
    author_id: t.author_id,
    text: cleanText(t.text),
    created_at: t.created_at,
    impressions: m.impression_count || 0,
    likes: m.like_count || 0,
    retweets: m.retweet_count || 0,
    replies: m.reply_count || 0,
  };
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// ===================== RENDER (this run only) =====================

function render(topPosts, users) {
  const payload = {
    generated: new Date().toISOString(),
    today: topPosts.map(t => ({
      ...t,
      username: users[t.author_id]?.username || 'unknown',
      name: users[t.author_id]?.name || 'Unknown',
    })),
  };
  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  fs.writeFileSync(HTML_FILE, template.replace('/*__DATA__*/', 'const DATA = ' + JSON.stringify(payload) + ';'));
  console.log(`\n✅ Leaderboard written to ${HTML_FILE}`);
}

// ===================== ARCHIVE (never used for ranking) =====================

function archive(tweets, users) {
  let store;
  try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { store = { tweets: {}, users: {} }; }
  if (!store.tweets) store = { tweets: {}, users: {} };

  for (const t of tweets) {
    store.tweets[t.id] = { ...t, scanned_at: new Date().toISOString() };
  }
  for (const u of Object.values(users)) store.users[u.id] = u;

  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  console.log(`🗄️  Archived ${tweets.length} posts to data.json (${Object.keys(store.tweets).length} total) — archive only, never ranked.`);
}

// ===================== MOCK DATA =====================

function generateMockData() {
  const handles = [
    'blknoiz06','solwhaledaily','pumpdotscience','bagworker_ben','memelordSOL',
    'cryptoK8lyn','deepliquidity','ansemarmy','solanalegend','normieonboarder',
    'chartgoblin','wagmiwendy','tickerwatcher','airdropandy','onchainoracle',
    'flipflopfren','degenDiane','bullpenscout','solsurfer_','viralvinny',
    'ct_historian','moonmathmike','liquiditylucy','fomofighter','threadoorTom',
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
      followers: Math.floor(rand() ** 2 * 400000) + 500,
    };
    const postCount = 1 + Math.floor(rand() * 3);
    for (let p = 0; p < postCount; p++) {
      const reach = Math.floor((rand() ** 2.2) * (users[id].followers * 8 + 50000)) + 800;
      tweets.push({
        id: `t${i}_${p}_${Math.floor(rand() * 1e6)}`,
        author_id: id,
        text: templates[Math.floor(rand() * templates.length)],
        created_at: new Date(Date.now() - rand() * 22 * 3600000).toISOString(),
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
