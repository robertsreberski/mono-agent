# Third-party notices

## Mono-agent harness compaction kit

`src/compaction-kit/` contains the reachable
compaction, message conversion, usage arithmetic and session-context helpers
adapted from the published `@earendil-works/pi-agent-core` 0.99.2 distribution
(`dist/harness/compaction/{compaction,utils}.js`, `messages.js`,
`session/context.js`, `types.js`, and `utils/usage.js`).
Source: https://github.com/earendil-works/pi (packages/agent).
The helpers retain the old estimator and cut/summary behavior; the general
harness, Chord Context, telemetry and agent loop are not vendored.

MIT License

Copyright (c) 2025 Mario Zechner

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
