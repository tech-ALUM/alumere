// Alumère — spellcheck worker. All the dictionary work happens HERE, off the UI thread.
// Two very different engines, one per language, both fed from public/vendor/typo/:
//   · English  — Typo.js over en_US.aff/.dic (123k forms ≈ 30MB: fine as a hash, and
//                Typo's suggest() is good).
//   · Italian  — a precomputed Bloom filter (it-words.bloom, built by
//                build/build-spell-bloom.mjs): the full it_IT expansion is ~3.1M forms,
//                ~400MB as a Typo hash — as a bitset it's 7MB with a ~1e-4 false-accept
//                rate, invisible for a spellchecker. Elisions ("l'altro") were stripped
//                from the .aff at build time (they overflow the expansion) and are
//                re-applied here: prefix' + known word (prefix list in elisions.json).
//                Suggestions: edit-distance-1 candidates over the .aff TRY alphabet
//                (accents included: perche → perché), REP pairs first, Bloom-checked.
// A word is correct if EITHER language knows it — the projects mix the two freely.
// Messages:
//   in : { type:"check",   id, words:[…] }  → out: { type:"checked", id, unknown:[…] }
//   in : { type:"suggest", id, word }       → out: { type:"suggested", id, word, suggestions:[…] }
// If anything fails to load we post { type:"dead" } and the app turns spellcheck off.
importScripts("vendor/typo/typo.js", "vendor/typo/bloom.js");

// Truncated imperatives/apocopes the hunspell data doesn't carry (po' does, these don't).
const TRUNCATIONS = new Set(["va'", "fa'", "da'", "sta'", "di'", "de'", "ca'"]);

let en = null, itBits = null, elisions = null, itAlphabet = "", itReps = [];

const ready = (async () => {
  const text = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); });
  const bin = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.arrayBuffer(); });
  const [affEn, dicEn, affIt, eliJson, bloomBuf] = await Promise.all([
    text("vendor/typo/en_US.aff"), text("vendor/typo/en_US.dic"),
    text("vendor/typo/it_IT.aff"),
    text("vendor/typo/elisions.json"), bin("vendor/typo/it-words.bloom"),
  ]);
  let t0 = Date.now();
  en = new Typo("en_US", affEn, dicEn, { platform: "any" });
  console.log(`[alumere][spell] en_US ready in ${Date.now() - t0}ms`);
  const dv = new DataView(bloomBuf);
  if (dv.getUint32(0, true) !== 0x46424c41 /* "ALBF" */) throw new Error("it-words.bloom: bad magic");
  if (dv.getUint32(8, true) !== AlumBloom.K) throw new Error("it-words.bloom: K mismatch — rebuild with build-spell-bloom.mjs");
  itBits = new Uint8Array(bloomBuf, 16, dv.getUint32(12, true));
  elisions = new Set(JSON.parse(eliJson).prefixes);
  // Suggestion alphabet = the .aff TRY line, lowercased and deduped (keeps the accents).
  const tryLine = (affIt.match(/^TRY (.+)$/m) || [, ""])[1];
  itAlphabet = [...new Set((tryLine.toLowerCase().match(/[\p{L}]/gu) || []))].join("");
  for (const m of affIt.matchAll(/^REP (\S+) (\S+)\s*$/gm)) itReps.push([m[1], m[2]]);
  // The .aff only carries 4 REP pairs (á→à …). The typo Italians actually make is a
  // missing/wrong accent — generate those candidates first.
  itReps.push(["e", "è"], ["e", "é"], ["è", "é"], ["é", "è"], ["a", "à"], ["i", "ì"], ["o", "ò"], ["u", "ù"], ["q", "qu"], ["cq", "q"], ["q", "cq"]);
  console.log(`[alumere][spell] it_IT bloom ready (${(itBits.length / 1048576).toFixed(1)}MB, ${elisions.size} elisions)`);
})();

function itKnown(word) {
  if (!itBits) return false;
  if (AlumBloom.has(itBits, word)) return true;
  const lower = word.toLowerCase();
  if (lower !== word && AlumBloom.has(itBits, lower)) return true;      // CIAO / Casa at sentence start
  if (TRUNCATIONS.has(lower)) return true;
  const i = word.indexOf("'");
  if (i > 0 && i < word.length - 1) {                                   // elision: dell'acqua, L'Aquila
    const pre = lower.slice(0, i + 1), rest = word.slice(i + 1);
    if (elisions.has(pre) && (AlumBloom.has(itBits, rest) || AlumBloom.has(itBits, rest.toLowerCase()))) return true;
  }
  return false;
}

// The tokenizer sends words as typed. Normalise the typographic apostrophe and give a
// trailing quote-vs-apocope its two readings before calling the word wrong.
function known(word) {
  const w = word.replace(/’/g, "'");
  const variants = [w];
  if (w.endsWith("'")) variants.push(w.slice(0, -1));
  return variants.some((v) => v && (en.check(v) || itKnown(v)));
}

// Italian suggest: REP replacements + every edit-distance-1 candidate, kept if the
// Bloom filter knows it. Order = REP, transposes, deletes, substitutions, inserts —
// roughly "most likely typo first". Cheap: ~1k candidates × 13 bit probes.
function itSuggest(word) {
  const w = word.toLowerCase().replace(/’/g, "'");
  const out = [], seen = new Set([w]);
  // No early cap: candidates are cheap (a Bloom probe each) and the cap was starving
  // the later op classes — "Qesto" filled up on substitutions before ever generating
  // the right fix ("Questo", an insertion). Rank first, cut later.
  const push = (c) => { if (!seen.has(c) && itKnown(c)) { seen.add(c); out.push(c); } };
  for (const [a, b] of itReps) {
    for (let i = w.indexOf(a); i >= 0; i = w.indexOf(a, i + 1)) push(w.slice(0, i) + b + w.slice(i + a.length));
  }
  for (let i = 0; i < w.length - 1; i++) push(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
  for (let i = 0; i < w.length; i++) push(w.slice(0, i) + w.slice(i + 1));
  for (let i = 0; i < w.length; i++) for (const c of itAlphabet) if (c !== w[i]) push(w.slice(0, i) + c + w.slice(i + 1));
  for (let i = 0; i <= w.length; i++) for (const c of itAlphabet) push(w.slice(0, i) + c + w.slice(i));
  return out.slice(0, 12);
}

// "Most plausible fix first": an adjacent transposition (wehn → when) beats a
// substitution (perche → perché) beats a deletion/insertion (wehn → wen). The merged
// list is stable-sorted by this class, so each language's own ranking survives inside
// a class.
const deaccent = (s) => s.normalize("NFD").replace(/\p{M}/gu, "");
function editClass(orig, cand) {
  const a = orig.toLowerCase(), b = cand.toLowerCase();
  if (a === b) return 0;
  if (deaccent(a) === deaccent(b)) return 0;   // accent-only fix (perche → perché): top tier
  if (a.length === b.length) {
    const diffs = [];
    for (let i = 0; i < a.length && diffs.length < 3; i++) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1
        && a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]]) return 0;  // transpose
    if (diffs.length === 1) return 1;                                            // substitution
    return 4;
  }
  if (Math.abs(a.length - b.length) === 1) return 2;                             // del/ins
  return 4;
}
// A candidate one REP rule away (qesto → questo, acqua patterns, accents) outranks a
// generic substitution: REP pairs encode the mistakes people actually make.
function isSingleRep(orig, cand) {
  const a = orig.toLowerCase(), b = cand.toLowerCase();
  for (const [x, y] of itReps) {
    for (let i = a.indexOf(x); i >= 0; i = a.indexOf(x, i + 1)) {
      if (a.slice(0, i) + y + a.slice(i + x.length) === b) return true;
    }
  }
  return false;
}
function suggestionRank(orig, cand) {
  const r = editClass(orig, cand);
  return r > 0.5 && isSingleRep(orig, cand) ? 0.5 : r;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try { await ready; }
  catch (err) {
    console.warn("[alumere][spell] init failed:", err.message || err);
    self.postMessage({ type: "dead", error: String((err && err.message) || err) });
    return;
  }
  if (m.type === "check") {
    const unknown = [];
    for (const w of m.words || []) if (!known(w)) unknown.push(w);
    self.postMessage({ type: "checked", id: m.id, unknown });
  } else if (m.type === "suggest") {
    const w = String(m.word || "").replace(/’/g, "'");
    // Interleave the two languages' candidates so both get top slots, then dedupe.
    const fromEn = en.suggest(w, 5), fromIt = itSuggest(w);
    const seen = new Set(), suggestions = [];
    for (let i = 0; i < Math.max(fromEn.length, fromIt.length); i++) {
      for (const s of [fromEn[i], fromIt[i]]) {
        if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); suggestions.push(s); }
      }
    }
    suggestions.sort((a, b) => suggestionRank(w, a) - suggestionRank(w, b));   // stable: in-class order survives
    self.postMessage({ type: "suggested", id: m.id, word: m.word, suggestions: suggestions.slice(0, 6) });
  }
};
