// Scant Minecraft Java-namen via de officiële Mojang-API en houdt bij welke vrijkomen.
// Env:
//   STATE_DIR        map met de status (default ./state)
//   OUT_DIR          map waar de site-data heen gaat (default ./site/data)
//   TIME_BUDGET_MIN  hoe lang deze run mag scannen (default 45)
//   DISCORD_WEBHOOK    optioneel: webhook-URL voor meldingen
//   DISCORD_WEBHOOK_3  optioneel: apart kanaal voor gouden namen: 3 tekens of 4+ sterren (anders DISCORD_WEBHOOK)
//   FAKE_FREE        alleen voor testen: komma-lijst namen die als 'vrij' behandeld worden

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTiers, tierOf, scoreName, stars, isBlocked } from './names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.STATE_DIR || join(ROOT, 'state');
const OUT_DIR = process.env.OUT_DIR || join(ROOT, 'site', 'data');
const BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 45) * 60_000;
const WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const WEBHOOK_3 = process.env.DISCORD_WEBHOOK_3 || WEBHOOK;
const isGold = (e) => e.type === '3' || (e.score ?? 0) >= 4;
const hookFor = (e) => (isGold(e) ? WEBHOOK_3 : WEBHOOK);
const FAKE_FREE = new Set((process.env.FAKE_FREE || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const BULK_ENDPOINTS = [
  'https://api.minecraftservices.com/minecraft/profile/lookup/bulk/byname',
  'https://api.mojang.com/profiles/minecraft',
];
const SINGLE_ENDPOINT = 'https://api.mojang.com/users/profiles/minecraft/';
const MIN_INTERVAL = 400;
const MAX_INTERVAL = 5000;
const MAX_DISCORD_PER_RUN = 25;
const MAX_CLAIMED_KEPT = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- Status ----------
class Bits {
  constructor(size, buf) {
    this.size = size;
    this.a = buf && buf.length === Math.ceil(size / 8) ? new Uint8Array(buf) : new Uint8Array(Math.ceil(size / 8));
  }
  get(i) { return (this.a[i >> 3] >> (i & 7)) & 1; }
  set(i, v) { if (v) this.a[i >> 3] |= 1 << (i & 7); else this.a[i >> 3] &= ~(1 << (i & 7)); }
  count() { let c = 0; for (const b of this.a) { let x = b; while (x) { x &= x - 1; c++; } } return c; }
}

function loadBits(file, size) {
  const p = join(STATE_DIR, file);
  if (!existsSync(p)) return new Bits(size);
  return new Bits(size, gunzipSync(readFileSync(p)));
}

const tiers = loadTiers(join(ROOT, 'data', 'words.txt'));
const statePath = join(STATE_DIR, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
state.cursors ??= {};
state.passes ??= {};
state.intervalMs ??= 600;
state.freed ??= [];   // { name, type, freedAt }
state.claimed ??= []; // { name, type, freedAt, claimedAt }
state.available ??= {}; // name -> { type, since, score }: nooit bezet gezien, niet geblokkeerd
const MAX_AVAILABLE_SHOWN = 1500;
let availDirty = false;

const seen = {}, taken = {};
// Account-ID (UUID) van de eigenaar per bezette naam, voor lijsten 3, 4 en w.
// Hiermee zien we bij een vrijgekomen naam of de eigenaar alleen van naam veranderd is.
const ID_TIERS = new Set(['3', '4', 'w']);
class Ids {
  constructor(size, buf) { this.a = buf && buf.length === size * 16 ? new Uint8Array(buf) : new Uint8Array(size * 16); }
  get(i) { const b = this.a.subarray(i * 16, i * 16 + 16); return b.some((x) => x) ? Buffer.from(b).toString('hex') : null; }
  set(i, hex) { if (hex && /^[0-9a-f]{32}$/.test(hex)) this.a.set(Buffer.from(hex, 'hex'), i * 16); }
}
const ids = {};
for (const t of Object.values(tiers)) {
  // Als de woordenlijst verandert, klopt de oude status niet meer: opnieuw beginnen.
  if (state.sizes?.[t.id] !== undefined && state.sizes[t.id] !== t.size) {
    log(`Grootte van lijst ${t.id} veranderd, status van deze lijst wordt gereset`);
    seen[t.id] = new Bits(t.size); taken[t.id] = new Bits(t.size); state.cursors[t.id] = 0;
  } else {
    seen[t.id] = loadBits(`seen-${t.id}.bin.gz`, t.size);
    taken[t.id] = loadBits(`taken-${t.id}.bin.gz`, t.size);
  }
  state.cursors[t.id] ??= 0;
  state.passes[t.id] ??= 0;
  if (ID_TIERS.has(t.id)) {
    const p = join(STATE_DIR, `ids-${t.id}.bin.gz`);
    ids[t.id] = new Ids(t.size, existsSync(p) && state.sizes?.[t.id] === t.size ? gunzipSync(readFileSync(p)) : null);
  }
}
state.sizes = Object.fromEntries(Object.values(tiers).map((t) => [t.id, t.size]));

// ---------- HTTP met adaptief tempo ----------
let interval = Math.min(Math.max(state.intervalMs, MIN_INTERVAL), MAX_INTERVAL);
let nextAt = 0;
let okStreak = 0;
let endpointTurn = 0;
const stats = { requests: 0, rateLimited: 0, errors: 0, checked: 0 };

async function throttle() {
  const wait = nextAt - Date.now();
  if (wait > 0) await sleep(wait);
  nextAt = Date.now() + interval;
}

function slowDown() {
  stats.rateLimited++;
  okStreak = 0;
  interval = Math.min(MAX_INTERVAL, Math.round(interval * 1.5));
  log(`Rate limit: tempo omlaag naar 1 verzoek per ${interval} ms`);
}

function onOk() {
  if (++okStreak >= 200) { okStreak = 0; interval = Math.max(MIN_INTERVAL, Math.round(interval * 0.95)); }
}

// Geeft de set bezette namen (lowercase) terug, of null bij aanhoudende fouten.
async function bulkLookup(names) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    const url = BULK_ENDPOINTS[endpointTurn++ % BULK_ENDPOINTS.length];
    stats.requests++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'mc-name-scanner' },
        body: JSON.stringify(names),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) { slowDown(); await sleep(20_000); continue; }
      if (!res.ok) { stats.errors++; await sleep(2_000 * (attempt + 1)); continue; }
      const data = await res.json();
      onOk();
      const map = new Map(data.map((p) => [p.name.toLowerCase(), p.id]));
      for (const f of FAKE_FREE) map.delete(f);
      return map;
    } catch (e) {
      stats.errors++;
      await sleep(2_000 * (attempt + 1));
    }
  }
  return null;
}

// Dubbele controle voor een naam die vrij lijkt. true = echt vrij, false = bezet, null = onbekend.
async function confirmFree(name) {
  if (FAKE_FREE.has(name)) return true;
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle();
    stats.requests++;
    try {
      const res = await fetch(SINGLE_ENDPOINT + encodeURIComponent(name), {
        headers: { 'User-Agent': 'mc-name-scanner' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) { slowDown(); await sleep(20_000); continue; }
      if (res.status === 404 || res.status === 204) return true;
      if (res.ok) return false;
      stats.errors++;
    } catch { stats.errors++; }
    await sleep(2_000 * (attempt + 1));
  }
  return null;
}

// ---------- Discord ----------
const TYPE_EN = { '3': '3 chars', '4': '4 chars', 'w': 'Word', 'd': '4 letters' }; // voor Discord
const TYPE_LABEL = { '3': '3 tekens', '4': '4 tekens', 'w': 'Woord', 'd': 'Ontdekt' };
let discordSent = 0;
const pendingDiscord = [];

async function notifyFreed(entry) {
  if (!hookFor(entry)) return;
  if (discordSent >= MAX_DISCORD_PER_RUN) { pendingDiscord.push(entry.name); return; }
  discordSent++;
  const hold = entry.status === 'hold' && !entry.dropped;
  const t = Math.floor((entry.dropAt || 0) / 1000);
  const body = {
    username: 'MC Name Sniper',
    embeds: [{
      title: hold
        ? `⏳ ${entry.name} ${stars(entry.score)} will drop <t:${t}:R>`
        : entry.dropped
          ? `🟢 ${entry.name} ${stars(entry.score)} should be available NOW!`
          : `🟢 ${entry.name} ${stars(entry.score)} just became available!`,
      description: hold
        ? `The owner changed their name to **${entry.newName}**. The old name is reserved for ~${HOLD_DAYS} days.\nExpected drop: <t:${t}:F> (<t:${t}:R>). You will get another message when it drops.`
        : entry.dropped
          ? `The reservation period has ended. Try to claim it right away!`
          : entry.reason === 'deleted' ? 'The old account no longer exists, so the name may be claimable right now.' : undefined,
      url: `https://namemc.com/search?q=${encodeURIComponent(entry.name)}`,
      color: isGold(entry) ? 0xfbbf24 : 0x34d399,
      fields: [
        { name: 'Type', value: TYPE_EN[entry.type] || entry.type, inline: true },
        { name: 'Value', value: `${stars(entry.score)} (${entry.score}/5)`, inline: true },
        { name: 'Claim', value: 'minecraft.net/msaprofile → Change name', inline: true },
      ],
      timestamp: new Date(entry.freedAt).toISOString(),
    }],
  };
  try {
    const res = await fetch(hookFor(entry), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) log(`Discord-melding mislukt: HTTP ${res.status}`);
  } catch (e) { log('Discord-melding mislukt:', e.message); }
  await sleep(1_200);
}

// Beschikbare namen: elke minuut één bericht met alle nieuwe namen van die minuut.
const pendingAvail = [];
let lastDigest = 0;
const DIGEST_EVERY_MS = 60_000;

function queueAvailable(name, a) {
  log(`BESCHIKBAAR: ${name} (${a.score} sterren)`);
  pendingAvail.push(name);
}

async function postDiscord(body, url = WEBHOOK) {
  if (!url) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 429) {
        const wait = Number((await res.json().catch(() => ({}))).retry_after || 2);
        await sleep(Math.ceil(wait * 1000) + 250);
        continue;
      }
      if (!res.ok) log(`Discord-bericht mislukt: HTTP ${res.status}`);
      return;
    } catch (e) { log('Discord-bericht mislukt:', e.message); await sleep(2000); }
  }
}

async function flushAvailDigest(force = false) {
  if (!pendingAvail.length) return;
  if (!force && Date.now() - lastDigest < DIGEST_EVERY_MS) return;
  lastDigest = Date.now();
  const items = pendingAvail.splice(0)
    .map((n) => ({ name: n, ...state.available[n] }))
    .filter((e) => e.type)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  if (!items.length) return;
  // Goud (3 tekens en 4+ sterren) naar het gouden kanaal, de rest (blauw) naar het gewone kanaal.
  const groups = [
    { items: items.filter((e) => e.type === '3'), color: 0xfbbf24, label: '🟡 3 chars', url: WEBHOOK_3 },
    { items: items.filter((e) => e.type !== '3' && e.score >= 4), color: 0xfbbf24, label: '⭐ Toppers', url: WEBHOOK_3 },
    { items: items.filter((e) => e.type !== '3' && e.score < 4), color: 0x60a5fa, label: '🔵 Others', url: WEBHOOK },
  ].filter((g) => g.items.length && g.url);
  for (const g of groups) {
    // In stukken van max ~3.800 tekens (Discord-limiet 4.096), 1 blok per bericht.
    let cur = [], len = 0;
    const parts = [];
    for (const e of g.items) {
      const line = `\`${e.name}\` ${stars(e.score)} · ${TYPE_EN[e.type] || e.type}`;
      if (len + line.length + 1 > 3800) { parts.push(cur); cur = []; len = 0; }
      cur.push(line); len += line.length + 1;
    }
    if (cur.length) parts.push(cur);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await postDiscord({ username: 'MC Name Sniper', embeds: [{
        title: `${g.label}: ${g.items.length} ${g.items.length === 1 ? 'name' : 'names'} available${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ''}`,
        description: parts[i].join('\n'),
        color: g.color,
        url: 'https://iaschmidt74-netizen.github.io/minecraft-names/',
        ...(last ? { footer: { text: 'Never claimed. Mojang may have blocked some: try them at minecraft.net/msaprofile' }, timestamp: new Date().toISOString() } : {}),
      }] }, g.url);
      await sleep(1_200);
    }
  }
}

async function flushDiscordSummary() {
  if (!WEBHOOK || pendingDiscord.length === 0) return;
  for (let i = 0; i < pendingDiscord.length; i += 150) {
    const list = pendingDiscord.slice(i, i + 150).join(', ');
    await postDiscord({ username: 'MC Name Sniper', content: `🟢 More names just became available: ${list}`.slice(0, 1990) });
    await sleep(1_200);
  }
}

// ---------- Logica ----------
const freedMap = new Map(state.freed.map((f) => [f.name, f]));

// "Hot list": namen die we zelf zagen veranderen (vrijgekomen of geclaimd).
// 'heet': de top 300 met de meeste wisselingen + alle nu vrije namen, elke minuut gecheckt.
const LEVELS = [
  { id: 'heet', size: 300, everyMs: 60_000, last: 0 },
];
const HOT_MAX_CHECKED = LEVELS.reduce((a, l) => a + l.size, 0);
const HOT_MAX_KEPT = 2000;
const HOT_KEEP_DAYS = 60;
state.hot ??= {}; // name -> { type, changes, last }

function bump(name, type, now) {
  const h = state.hot[name] || { type, changes: 0, last: 0 };
  h.changes++;
  h.last = now;
  state.hot[name] = h;
}

// Geeft de namen voor de hete lijst terug. Vrije namen staan er altijd in.
function hotLevels() {
  const ranked = Object.entries(state.hot)
    .sort((a, b) => b[1].changes - a[1].changes || b[1].last - a[1].last)
    .map(([n]) => n)
    .filter((n) => !freedMap.has(n));
  return { heet: [...freedMap.keys(), ...ranked.slice(0, LEVELS[0].size)] };
}

function markClaimed(name, now) {
  const f = freedMap.get(name);
  if (!f) return;
  freedMap.delete(name);
  state.claimed.unshift({ name, type: f.type, freedAt: f.freedAt, claimedAt: now, score: f.score });
  liveDirty = true;
  log(`Weer geclaimd: ${name}`);
}

// Bij een naamswijziging blijft de oude naam ~37 dagen gereserveerd voor de oude eigenaar.
const HOLD_DAYS = 37;

// Huidige naam van een account-ID: string = bestaat nog (nieuwe naam), false = account weg, null = onbekend.
async function currentNameOf(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    stats.requests++;
    try {
      const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, {
        headers: { 'User-Agent': 'mc-name-scanner' }, signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) { slowDown(); await sleep(20_000); continue; }
      if (res.status === 204 || res.status === 404) return false;
      if (res.ok) return (await res.json()).name || null;
    } catch {}
    await sleep(2_000 * (attempt + 1));
  }
  return null;
}

async function markFreed(tier, name, prevId) {
  const ok = await confirmFree(name);
  if (ok !== true) return false; // toch bezet of onzeker: niets veranderen
  const now = Date.now();
  const entry = { name, type: tier.id, freedAt: now, score: scoreName(name, tier.id), status: 'free' };
  if (prevId) {
    const cur = await currentNameOf(prevId);
    if (typeof cur === 'string') {
      entry.status = 'hold';
      entry.newName = cur;
      entry.dropAt = now + HOLD_DAYS * 86_400_000;
    } else if (cur === false) {
      entry.reason = 'deleted';
    }
  }
  freedMap.set(name, entry);
  log(`VRIJGEKOMEN: ${name} (${TYPE_LABEL[tier.id]})${entry.status === 'hold' ? `, verwacht beschikbaar ${new Date(entry.dropAt).toISOString().slice(0, 10)} (nieuwe naam eigenaar: ${entry.newName})` : ''}`);
  liveDirty = true;
  await notifyFreed(entry);
  await publishLive();
  return true;
}

// entries: [{ tier, idx, name }] (max 10)
async function processEntries(entries) {
  const takenNow = await bulkLookup(entries.map((e) => e.name));
  if (!takenNow) return false;
  const now = Date.now();
  for (const { tier, idx, name } of entries) {
    const wasSeen = seen[tier.id].get(idx), wasTaken = taken[tier.id].get(idx);
    if (takenNow.has(name)) {
      ids[tier.id]?.set(idx, takenNow.get(name));
      if (wasSeen && !wasTaken) bump(name, tier.id, now); // vrij -> bezet
      if (state.available[name]) { delete state.available[name]; availDirty = true; log(`Beschikbare naam geclaimd: ${name}`); }
      if (freedMap.has(name)) markClaimed(name, now);
      taken[tier.id].set(idx, 1);
    } else if (wasSeen && wasTaken) {
      if (await markFreed(tier, name, ids[tier.id]?.get(idx))) { taken[tier.id].set(idx, 0); bump(name, tier.id, now); }
    } else {
      taken[tier.id].set(idx, 0);
      if (!state.available[name] && !freedMap.has(name) && !isBlocked(name)) {
        const a = { type: tier.id, since: now, score: scoreName(name, tier.id) };
        state.available[name] = a;
        availDirty = true;
        queueAvailable(name, a);
      }
    }
    seen[tier.id].set(idx, 1);
  }
  stats.checked += entries.length;
  return true;
}

// Gereserveerde namen waarvan de datum voorbij is: melden dat ze nu vrij moeten zijn.
async function checkDrops() {
  const now = Date.now();
  for (const e of freedMap.values()) {
    if (e.status !== 'hold' || e.dropped || now < e.dropAt) continue;
    e.dropped = true;
    e.status = 'free';
    e.droppedAt = now;
    liveDirty = true;
    log(`GERESERVEERDE NAAM VRIJ: ${e.name}`);
    await notifyFreed(e);
  }
}

async function checkHot(level) {
  level.last = Date.now();
  const entries = [];
  for (const name of hotLevels()[level.id]) {
    const tier = tierOf(tiers, name);
    if (tier) entries.push({ tier, idx: tier.indexOf(name), name });
  }
  for (let k = 0; k < entries.length; k += 10) await processEntries(entries.slice(k, k + 10));
  stats.hotChecks = (stats.hotChecks || 0) + 1;
}

// Lijsten afwisselend doorlopen volgens hun gewicht, met tussendoor de hot list.
async function scanTiers(deadline) {
  let chunks = 0;
  const done = Object.fromEntries(Object.keys(tiers).map((k) => [k, 0]));
  while (Date.now() < deadline) {
    for (const level of LEVELS) if (Date.now() - level.last >= level.everyMs) await checkHot(level);
    await checkDrops();
    const t = Object.values(tiers).reduce((best, x) => (done[x.id] / x.weight < done[best.id] / best.weight ? x : best));
    const start = state.cursors[t.id];
    const entries = [];
    for (let i = start; i < Math.min(start + 10, t.size); i++) entries.push({ tier: t, idx: i, name: t.nameAt(i) });
    const ok = await processEntries(entries);
    done[t.id]++;
    if (!ok) continue; // later opnieuw
    let next = start + entries.length;
    if (next >= t.size) { next = 0; state.passes[t.id]++; log(`Ronde ${t.id} klaar (#${state.passes[t.id]})`); }
    state.cursors[t.id] = next;
    if ((liveDirty && Date.now() - lastLive > 20_000) || (availDirty && Date.now() - lastLive > 300_000)) { liveDirty = true; await publishLive(); }
    await flushAvailDigest();
    if (++chunks % 500 === 0) log(`${stats.checked} namen gecheckt, tempo ${interval} ms, hot ${Object.keys(state.hot).length}, cursors ${JSON.stringify(state.cursors)}`);
  }
}

// ---------- Live-lijst op GitHub (branch 'live') ----------
// Zodra er iets verandert, wordt freed.json direct naar de branch 'live' gestuurd,
// zodat de website het binnen een paar minuten toont (niet pas aan het eind van de run).
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPOSITORY || '';
const LIVE_BRANCH = process.env.LIVE_BRANCH || 'live';
let liveSha = null, liveReady = false, liveDirty = false, lastLive = 0;

function gh(path, opts = {}) {
  return fetch('https://api.github.com/' + path, {
    ...opts,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mc-name-scanner' },
    signal: AbortSignal.timeout(20_000),
  });
}

function freedPayload() {
  const freed = [...freedMap.values()].sort((a, b) => b.freedAt - a.freedAt);
  for (const e of [...freed, ...state.claimed]) e.score ??= scoreName(e.name, e.type);
  const available = Object.entries(state.available)
    .map(([name, a]) => ({ name, ...a }))
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || b.since - a.since)
    .slice(0, MAX_AVAILABLE_SHOWN);
  return { updatedAt: Date.now(), freed, claimed: state.claimed.slice(0, MAX_CLAIMED_KEPT), available, availableTotal: Object.keys(state.available).length };
}

async function ensureLive() {
  if (liveReady) return true;
  let r = await gh(`repos/${GH_REPO}/git/ref/heads/${LIVE_BRANCH}`);
  if (r.status === 404) {
    const main = await (await gh(`repos/${GH_REPO}/git/ref/heads/main`)).json();
    r = await gh(`repos/${GH_REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${LIVE_BRANCH}`, sha: main.object.sha }) });
    if (!r.ok) { log(`Branch live aanmaken mislukt: HTTP ${r.status}`); return false; }
  }
  const f = await gh(`repos/${GH_REPO}/contents/freed.json?ref=${LIVE_BRANCH}`);
  liveSha = f.ok ? (await f.json()).sha : null;
  liveReady = true;
  return true;
}

async function publishLive() {
  if (!GH_TOKEN || !GH_REPO || !liveDirty) return;
  lastLive = Date.now();
  try {
    if (!(await ensureLive())) return;
    const body = { message: 'Live update', branch: LIVE_BRANCH, content: Buffer.from(JSON.stringify(freedPayload())).toString('base64') };
    if (liveSha) body.sha = liveSha;
    const r = await gh(`repos/${GH_REPO}/contents/freed.json`, { method: 'PUT', body: JSON.stringify(body) });
    if (r.ok) { liveSha = (await r.json()).content.sha; liveDirty = false; availDirty = false; log('Live-lijst bijgewerkt'); }
    else { log(`Live-lijst bijwerken mislukt: HTTP ${r.status}`); liveReady = false; }
  } catch (e) { log('Live-lijst bijwerken mislukt:', e.message); liveReady = false; }
}

function pruneHot() {
  const cutoff = Date.now() - HOT_KEEP_DAYS * 86_400_000;
  const kept = Object.entries(state.hot)
    .filter(([, h]) => h.last >= cutoff)
    .sort((a, b) => b[1].changes - a[1].changes || b[1].last - a[1].last)
    .slice(0, HOT_MAX_KEPT);
  state.hot = Object.fromEntries(kept);
}

function save() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  for (const t of Object.values(tiers)) {
    writeFileSync(join(STATE_DIR, `seen-${t.id}.bin.gz`), gzipSync(seen[t.id].a));
    writeFileSync(join(STATE_DIR, `taken-${t.id}.bin.gz`), gzipSync(taken[t.id].a));
    if (ids[t.id]) writeFileSync(join(STATE_DIR, `ids-${t.id}.bin.gz`), gzipSync(ids[t.id].a));
  }
  state.freed = [...freedMap.values()].sort((a, b) => b.freedAt - a.freedAt);
  for (const e of [...state.freed, ...state.claimed]) e.score ??= scoreName(e.name, e.type);
  state.claimed = state.claimed.slice(0, MAX_CLAIMED_KEPT);
  pruneHot();
  state.intervalMs = interval;
  state.lastRun = Date.now();
  writeFileSync(statePath, JSON.stringify(state));

  const status = {
    lastScan: state.lastRun,
    discord: Boolean(WEBHOOK),
    intervalMs: interval,
    run: stats,
    available: Object.keys(state.available).length,
    hot: (() => { const h = hotLevels(); return { size: h.heet.length, heetSec: LEVELS[0].everyMs / 1000 }; })(),
    tiers: Object.fromEntries(Object.values(tiers).map((t) => [t.id, {
      size: t.size,
      cursor: state.cursors[t.id],
      pass: state.passes[t.id],
      progress: state.cursors[t.id] / t.size,
      seen: seen[t.id].count(),
      taken: taken[t.id].count(),
    }])),
  };
  writeFileSync(join(OUT_DIR, 'freed.json'), JSON.stringify(freedPayload()));
  writeFileSync(join(OUT_DIR, 'status.json'), JSON.stringify(status));
}

const deadline = Date.now() + BUDGET_MS;
log(`Start. Budget ${BUDGET_MS / 60000} min, ${freedMap.size} vrije namen bekend, cursors ${JSON.stringify(state.cursors)}`);
await scanTiers(deadline);
await flushDiscordSummary();
await flushAvailDigest(true);
if (availDirty) liveDirty = true;
await publishLive();
save();
log(`Klaar. ${stats.checked} namen gecheckt in ${stats.requests} verzoeken, ${stats.rateLimited}x rate limit, ${stats.errors} fouten. Vrij: ${freedMap.size}`);
