// Scant Minecraft Java-namen via de officiële Mojang-API en houdt bij welke vrijkomen.
// Env:
//   STATE_DIR        map met de status (default ./state)
//   OUT_DIR          map waar de site-data heen gaat (default ./site/data)
//   TIME_BUDGET_MIN  hoe lang deze run mag scannen (default 45)
//   DISCORD_WEBHOOK  optioneel: webhook-URL voor meldingen
//   FAKE_FREE        alleen voor testen: komma-lijst namen die als 'vrij' behandeld worden

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTiers, tierOf } from './names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.STATE_DIR || join(ROOT, 'state');
const OUT_DIR = process.env.OUT_DIR || join(ROOT, 'site', 'data');
const BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 45) * 60_000;
const WEBHOOK = process.env.DISCORD_WEBHOOK || '';
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

const seen = {}, taken = {};
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
      const set = new Set(data.map((p) => p.name.toLowerCase()));
      for (const f of FAKE_FREE) set.delete(f);
      return set;
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
const TYPE_LABEL = { '3': '3 tekens', '4': '4 tekens', 'w': 'Woord' };
let discordSent = 0;
const pendingDiscord = [];

async function notifyFreed(entry) {
  if (!WEBHOOK) return;
  if (discordSent >= MAX_DISCORD_PER_RUN) { pendingDiscord.push(entry.name); return; }
  discordSent++;
  const body = {
    username: 'MC Name Sniper',
    embeds: [{
      title: `🟢 ${entry.name} is vrijgekomen!`,
      url: `https://namemc.com/search?q=${encodeURIComponent(entry.name)}`,
      color: 0x34d399,
      fields: [
        { name: 'Soort', value: TYPE_LABEL[entry.type] || entry.type, inline: true },
        { name: 'Claimen', value: 'Minecraft Launcher → Profiel → Naam wijzigen', inline: true },
      ],
      timestamp: new Date(entry.freedAt).toISOString(),
    }],
  };
  try {
    const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) log(`Discord-melding mislukt: HTTP ${res.status}`);
  } catch (e) { log('Discord-melding mislukt:', e.message); }
  await sleep(1_200);
}

async function flushDiscordSummary() {
  if (!WEBHOOK || pendingDiscord.length === 0) return;
  const list = pendingDiscord.slice(0, 60).join(', ');
  await fetch(WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'MC Name Sniper', content: `🟢 Nog ${pendingDiscord.length} namen vrijgekomen: ${list}` }),
  }).catch(() => {});
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
  state.claimed.unshift({ name, type: f.type, freedAt: f.freedAt, claimedAt: now });
  log(`Weer geclaimd: ${name}`);
}

async function markFreed(tier, name) {
  const ok = await confirmFree(name);
  if (ok !== true) return false; // toch bezet of onzeker: niets veranderen
  const entry = { name, type: tier.id, freedAt: Date.now() };
  freedMap.set(name, entry);
  log(`VRIJGEKOMEN: ${name} (${TYPE_LABEL[tier.id]})`);
  await notifyFreed(entry);
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
      if (wasSeen && !wasTaken) bump(name, tier.id, now); // vrij -> bezet
      if (freedMap.has(name)) markClaimed(name, now);
      taken[tier.id].set(idx, 1);
    } else if (wasSeen && wasTaken) {
      if (await markFreed(tier, name)) { taken[tier.id].set(idx, 0); bump(name, tier.id, now); }
    } else {
      taken[tier.id].set(idx, 0);
    }
    seen[tier.id].set(idx, 1);
  }
  stats.checked += entries.length;
  return true;
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
    if (++chunks % 500 === 0) log(`${stats.checked} namen gecheckt, tempo ${interval} ms, hot ${Object.keys(state.hot).length}, cursors ${JSON.stringify(state.cursors)}`);
  }
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
  }
  state.freed = [...freedMap.values()].sort((a, b) => b.freedAt - a.freedAt);
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
  writeFileSync(join(OUT_DIR, 'freed.json'), JSON.stringify({ freed: state.freed, claimed: state.claimed }));
  writeFileSync(join(OUT_DIR, 'status.json'), JSON.stringify(status));
}

const deadline = Date.now() + BUDGET_MS;
log(`Start. Budget ${BUDGET_MS / 60000} min, ${freedMap.size} vrije namen bekend, cursors ${JSON.stringify(state.cursors)}`);
await scanTiers(deadline);
await flushDiscordSummary();
save();
log(`Klaar. ${stats.checked} namen gecheckt in ${stats.requests} verzoeken, ${stats.rateLimited}x rate limit, ${stats.errors} fouten. Vrij: ${freedMap.size}`);
