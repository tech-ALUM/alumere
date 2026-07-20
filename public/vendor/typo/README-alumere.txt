Spellcheck assets (giro 6) — what lives here and where it came from
====================================================================

typo.js            Typo.js hunspell engine (cfinke/Typo.js, master), Modified BSD —
typo-LICENSE.txt   see the license file. Used AS-IS for English; for Italian only its
                   offline expansion feeds the Bloom builder.

en_US.aff/.dic     English dictionary from LibreOffice/dictionaries (master, en/).
en_US-README.txt   SCOWL-based, permissive licenses (see the README).

it_IT.aff/.dic     Italian dictionary from LibreOffice/dictionaries (master, it_IT/),
it_IT-README.txt   by Gianluca Turconi / Davide Prina — GNU GPL 3 (data files, see the
                   README). ⚠ it_IT.aff is NOT pristine: the elision prefix rules
                   (l', dell', ALL', …) are stripped by a one-off preprocessing step,
                   because Typo.js expands prefix×suffix cross-products and the full
                   table overflows V8's Map size limit. The stripped affixes live in
                   elisions.json and the spell worker re-applies them at check time
                   (prefix' + known word) — same accept set, fraction of the memory.

elisions.json      The 142 apostrophe prefixes stripped from it_IT.aff (see above).

it-words.bloom     Bloom filter of the FULL it_IT expansion (~3.1M forms → 9.0MB,
                   K=17, ~1e-5 false accepts — sized for suggest(), which probes ~1k
                   candidates per word). Regenerate after touching it_IT.aff/.dic:
                     docker exec alumere-dev node /app/build/build-spell-bloom.mjs

bloom.js           The shared add/has code (worker + builder). The .bloom file and
                   bloom.js MUST move together: the hash is defined by this code.
