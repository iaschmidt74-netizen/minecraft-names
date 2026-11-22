import { readFileSync } from 'node:fs';

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

  return {
    '3': { id: '3', size: B ** 3, weight: 6.6, nameAt: (i) => nameAt(3, i), indexOf: (n) => (n.length === 3 ? fixedIndex(n) : -1) },
    'w': { id: 'w', size: words.length, weight: 1, nameAt: (i) => words[i], indexOf: (n) => wordIdx.get(n) ?? -1 },
  };
}

export function tierOf(tiers, name) {
  for (const t of Object.values(tiers)) {
    if (t.indexOf(name) >= 0) return t;
  }
  return null;
}
