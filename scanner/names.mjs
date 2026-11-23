import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CONSONANTS = [...'bcdfghjklmnpqrstvwxyz'];
const VOWELS4 = [...'aeiou'];
function readList(path, re) {
  try {
    return readFileSync(path, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter((w) => re.test(w));
  } catch { return []; }
}

export const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_';
const B = CHARS.length; // 37

function nameAt(len, i) {
  let s = '';
  for (let k = 0; k < len; k++) {
    s = CHARS[i % B] + s;
    i = Math.floor(i / B);
  }
  return s;
}

function fixedIndex(name) {
  let i = 0;
  for (const ch of name) {
    const v = CHARS.indexOf(ch);
    if (v < 0) return -1;
    i = i * B + v;
  }
  return i;
}

export function loadTiers(wordsPath) {
  const words = readFileSync(wordsPath, 'utf8')
    .split('\n').map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z0-9_]{5,16}$/.test(w));
  const wordIdx = new Map(words.map((w, i) => [w, i]));

  // Waardevolle 4-tekens namen: echte 4-letterwoorden + uitspreekbare medeklinker-klinker-medeklinker-klinker
  const four = new Set(readList(join(dirname(wordsPath), "words4.txt"), /^[a-z]{4}$/));
  for (const a of CONSONANTS) for (const b of VOWELS4) for (const c of CONSONANTS) for (const d of VOWELS4) four.add(a + b + c + d);
  const fourList = [...four].sort();
  const fourIdx = new Map(fourList.map((w, i) => [w, i]));

  // Ontdekt-lijst, zonder namen die al in een andere lijst zitten
  const disc = discoveryNames().filter((n) => !fourIdx.has(n));
  const discIdx = new Map(disc.map((w, i) => [w, i]));
  // Krijgt 25% van het tempo: gewicht = 1/3 van de som van de andere lijsten.
  const otherWeight = B ** 3 + fourList.length + words.length;
  const discTier = { id: 'd', size: disc.length, weight: otherWeight / 3, nameAt: (i) => disc[i], indexOf: (n) => discIdx.get(n) ?? -1 };

  return {
    '3': { id: '3', size: B ** 3, weight: B ** 3, nameAt: (i) => nameAt(3, i), indexOf: (n) => (n.length === 3 ? fixedIndex(n) : -1) },
    '4': { id: '4', size: fourList.length, weight: fourList.length, nameAt: (i) => fourList[i], indexOf: (n) => fourIdx.get(n) ?? -1 },
    'd': discTier,
    'w': { id: 'w', size: words.length, weight: words.length, nameAt: (i) => words[i], indexOf: (n) => wordIdx.get(n) ?? -1 },
  };
}

export function tierOf(tiers, name) {
  for (const t of Object.values(tiers)) {
    if (t.indexOf(name) >= 0) return t;
  }
  return null;
}

// ---------- Kwaliteitsscore (1–5 sterren, halve stappen) ----------
let shortWords = null;
function loadShortWords() {
  if (shortWords) return shortWords;
  const p = new URL('../data/short-words.txt', import.meta.url);
  try {
    shortWords = new Set(readFileSync(p, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean));
  } catch {
    shortWords = new Set();
  }
  return shortWords;
}

let words4 = null;
function loadWords4() {
  if (!words4) words4 = new Set(readList(new URL('../data/words4.txt', import.meta.url), /^[a-z]{4}$/));
  return words4;
}

const VOWELS = new Set('aeiouy');
const isLetter = (c) => c >= 'a' && c <= 'z';

export function scoreName(name, type) {
  const n = name.toLowerCase();
  let s;
  if (type === 'd') {
    // 4 letters: hoe uitspreekbaar / stoer ziet hij eruit?
    const v = [...n].map((c) => 'aeiouy'.includes(c));
    const vowels = v.filter(Boolean).length;
    s = 1.5;
    if (vowels >= 1) s += 1;
    if (vowels === 2 && v[0] !== v[1] && v[1] !== v[2] && v[2] !== v[3]) s += 1; // cvcv of vcvc
    if (!/[^aeiouy]{3}/.test(n)) s += 0.5; // geen 3 medeklinkers achter elkaar
    if (n[0] === n[2] && n[1] === n[3] || n[0] === n[3] && n[1] === n[2]) s += 0.5; // abab of abba
    if (/[xzk]$/.test(n)) s += 0.5; // stoer einde
  } else if (type === 'w') {
    s = 4.5 - 0.5 * Math.max(0, n.length - 5);
    s = Math.max(1.5, s);
  } else if (type === '4') {
    s = 3;
    if (loadWords4().has(n)) s += 1.5;
    if (/^[^aeiou][aeiou][^aeiou][aeiou]$/.test(n)) s += 0.5;
    if (/[qxz]/.test(n)) s -= 0.5;
  } else {
    s = 3;
    const chars = [...n];
    if (chars.every(isLetter)) s += 0.5;
    if (/[0-9]/.test(n)) s -= 1;
    if (n.includes('_')) s -= 1;
    if (n.length === 3 && chars.every(isLetter)
      && !VOWELS.has(chars[0]) && VOWELS.has(chars[1]) && !VOWELS.has(chars[2])) s += 0.5;
    if (loadShortWords().has(n)) s += 1;
    if (new Set(chars).size === 1) s += 0.5;
  }
  return Math.min(5, Math.max(1, Math.round(s * 2) / 2));
}

export function stars(score) {
  const full = Math.floor(score);
  return '★'.repeat(full) + (score % 1 ? '½' : '') + '☆'.repeat(5 - Math.ceil(score));
}

// ---------- Ontdekt: alle namen van 4 letters (a-z) ----------
// Bedoeld om namen te vinden die nog nooit geclaimd zijn. De waardevolle 4-tekens namen
// (lijst '4') worden apart en vaker gecheckt en zitten hier niet nog eens in.
export function discoveryNames() {
  const L = "abcdefghijklmnopqrstuvwxyz";
  const out = [];
  for (const a of L) for (const b of L) for (const c of L) for (const d of L) out.push(a + b + c + d);
  return out;
}

// Namen die Mojang (vrijwel zeker) blokkeert: niet tonen als 'beschikbaar'.
const BLOCK = ['fuck', 'fuc', 'fck', 'fvk', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'penis', 'pussy', 'porn', 'sex', 'cum', 'jizz', 'dildo', 'boner', 'tit', 'whore', 'slut', 'hussy', 'nig', 'negro', 'fag', 'kyke', 'kike', 'jap', 'spic', 'spick', 'kkk', 'nazi', 'hitler', 'rape', 'anal', 'arse', 'semen', 'sperm', 'pubic', 'pubes', 'nooky', 'minge', 'hymen', 'grope', 'injun', 'suicide', 'drugs', 'pikey', 'sodom', 'voyeur', 'beastal', 'booby', 'diddy', 'clite', 'nude', 'sucking'];
export function isBlocked(name) {
  const n = name.toLowerCase();
  return BLOCK.some((b) => n.includes(b));
}
