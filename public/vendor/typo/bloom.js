// Alumère — tiny Bloom filter over UTF-16 code units, shared VERBATIM by the offline
// builder (build/build-spell-bloom.mjs, run in Node) and the spell worker (browser).
// Why it exists: the Italian dictionary expands to ~3.1M word forms — as a JS hash
// (Typo.js) that's ~400MB of heap, as a Bloom bitset it's ~7.5MB with a ~1e-4
// false-accept rate, invisible in practice for a spellchecker.
// Format of it-words.bloom: "ALBF" + uint32le version + uint32le K + uint32le byteLen + bits.
(function (root) {
  "use strict";
  // 24 bits/word (p ≈ 1e-5, ~9MB for 3.1M forms). Sized for SUGGESTIONS, not just
  // checks: suggest probes ~1k candidates per word, so at 1e-4 roughly one word in
  // twelve got a junk suggestion ("wehàn") — at 1e-5 it's one in a hundred and twenty.
  const K = 17;
  const BITS_PER_WORD = 24;
  function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  // Kirsch–Mitzenmacher: two base hashes simulate K independent ones. h2 is forced odd
  // so successive probes never collapse onto one bit, and BACK to unsigned — `| 1`
  // alone reinterprets the uint as a signed int32, and a negative h2 would send half
  // the probes to negative indexes (which a Uint8Array silently swallows).
  // h1 + i*h2 stays < 2^53 — exact.
  function eachBit(word, mBits, fn) {
    const h1 = fnv(word, 2166136261);
    const h2 = (fnv(word, 40389371) | 1) >>> 0;
    for (let i = 0; i < K; i++) fn((h1 + i * h2) % mBits);
  }
  function add(bytes, word) {
    eachBit(word, bytes.length * 8, (b) => { bytes[b >> 3] |= 1 << (b & 7); });
  }
  function has(bytes, word) {
    let ok = true;
    eachBit(word, bytes.length * 8, (b) => { if (!(bytes[b >> 3] & (1 << (b & 7)))) ok = false; });
    return ok;
  }
  root.AlumBloom = { K, BITS_PER_WORD, add, has };
})(typeof self !== "undefined" ? self : globalThis);
