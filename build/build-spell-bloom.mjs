// Offline builder for public/vendor/typo/it-words.bloom (see bloom.js for the why).
// Expands the full it_IT dictionary through Typo.js (fine offline: ~3s / ~400MB, the
// exact cost we're keeping OUT of the browser) and packs every form into the filter.
// Run it inside the dev container whenever it_IT.aff/.dic change:
//   docker exec alumere-dev node /app/build/build-spell-bloom.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const typoDir = join(here, "..", "public", "vendor", "typo");

// typo.js and bloom.js are plain browser scripts: indirect eval runs them in the
// global scope, where they hang Typo / AlumBloom on globalThis.
(0, eval)(readFileSync(join(typoDir, "typo.js"), "utf8") + "\nglobalThis.Typo = Typo;");
(0, eval)(readFileSync(join(typoDir, "bloom.js"), "utf8"));
const { Typo, AlumBloom } = globalThis;

console.time("expand it_IT");
const it = new Typo("it_IT",
  readFileSync(join(typoDir, "it_IT.aff"), "utf8"),
  readFileSync(join(typoDir, "it_IT.dic"), "utf8"),
  { platform: "any" });
console.timeEnd("expand it_IT");

const words = it.dictionaryTable instanceof Map ? [...it.dictionaryTable.keys()] : Object.keys(it.dictionaryTable);
const n = words.length;
const mBits = Math.ceil((n * AlumBloom.BITS_PER_WORD) / 8) * 8;
const bytes = new Uint8Array(mBits / 8);
console.time("fill bloom");
for (const w of words) AlumBloom.add(bytes, w);
console.timeEnd("fill bloom");

const header = Buffer.alloc(16);
header.write("ALBF", 0, "ascii");
header.writeUInt32LE(1, 4);                 // format version
header.writeUInt32LE(AlumBloom.K, 8);
header.writeUInt32LE(bytes.length, 12);
writeFileSync(join(typoDir, "it-words.bloom"), Buffer.concat([header, Buffer.from(bytes)]));
console.log(`it-words.bloom: ${n} forms → ${(bytes.length / 1048576).toFixed(1)} MB (K=${AlumBloom.K})`);

// sanity: a few knowns must pass, a few typos must fail
for (const w of ["ciao", "perché", "mangiavamo", "Roma"]) console.log("  known?", w, AlumBloom.has(bytes, w));
for (const w of ["sbagliatto", "chidl", "perchè no"]) console.log("  typo? ", w, AlumBloom.has(bytes, w));
