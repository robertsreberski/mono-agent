# Third-party notices

## Hound native web research adaptations

Ported/adapted from hound-mcp 13.2.0, published source distribution:
https://files.pythonhosted.org/packages/be/5c/d5b006bdb8a67bbd4e983cb7a1c6ac84f73a3b68c8057ef7fcd4a944df20/hound_mcp-13.2.0.tar.gz

SHA-256: `c6263e5ac09f7079d5a0c78bfe7baea03aa0dbb64c0c4224eef40c9d0cb691bc`.

The native JS modules under `src/agent/tools/local/` adapt Hound's
Python algorithms, not its Python runtime, server, or anti-detection transports.
`extract.js` adapts `trafilatura_extractor.py` title/stage fallback and
`extractor.py` noise removal, using Defuddle/Readability/Turndown instead of
trafilatura/lxml/markdownify. `links.js` adapts `links.py` anchor classification
and fragment deduplication, with Mono's URL safety and output bounds.
`engines.js` adapts the DuckDuckGo request fields and DOM selectors
from `search_metasearch.py`, URL consensus/snippet aggregation and lean ranking
ideas from `search_engines.py` (GitHub owner/repository-only case folding, host
diversity). Fixtures in `local-web-provider.test.js` exercise those ported shapes;
they are synthetic, not recorded proof of public-engine availability.
`search.js` supplies Mono-owned bounded fanout, accounting and cancellation.
`robots.js` adapts the origin-cache idea from `robots.py` but deliberately rejects
its fail-open misses and shielded/coalesced requests; robots-parser 3.0.1 supplies
rule parsing. Hound browser/proxy/TLS impersonation, archive escalation, retry,
BYOK, neural-model and server code are not included or executed.

The reviewed 13.2.0 extraction and link sources are byte-for-byte equivalent
to those at master-fetch revision
`86d1b1329c0eed6133f29e3effe6a40a29f9dcdc` (12.4.1).
Ported tests and fixtures name their source where applicable.

### Hound license

MIT License

Copyright (c) 2026 Bishesh Bhandari

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Vendored ddgs attribution

NOTICE — vendored ddgs metasearch code

The file `src/master_fetch/search_metasearch.py` in this project is derived
from ddgs (https://github.com/deedy5/ddgs), a metasearch library aggregating
diverse web search services. ddgs is distributed under the MIT License
(see below). It has been vendored, stripped to text search only, and adapted
(async-native parallel aggregation with early-return-on-quorum, hound-specific
tuning) for use inside hound-mcp.

Per the MIT terms, the original copyright notice + permission notice are
reproduced here and the ddgs LICENSE is preserved alongside this notice.

ddgs dependencies used transitively at runtime (primp, httpx[http2]/h2,
fake-useragent, lxml) remain separate upstream packages under their own
licenses (primp/httpx/fake-useragent/lxml are MIT/BSD-compatible).

------------------------------------------------------------------------------
MIT License

Copyright (c) 2022 deedy5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
