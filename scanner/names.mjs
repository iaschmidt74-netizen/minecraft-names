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

  return {
    '3': { id: '3', size: B ** 3, weight: B ** 3, nameAt: (i) => nameAt(3, i), indexOf: (n) => (n.length === 3 ? fixedIndex(n) : -1) },
    '4': { id: '4', size: fourList.length, weight: fourList.length, nameAt: (i) => fourList[i], indexOf: (n) => fourIdx.get(n) ?? -1 },
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
  if (type === 'w') {
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
