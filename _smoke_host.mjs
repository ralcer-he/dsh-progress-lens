// Host-half runtime smoke test for the "thoughts out loud" (murmur) channel.
// Verifies the whole chain that --check cannot: signal filter -> sweep trigger
// -> isolatedAsk rewrite -> SSE line, plus the shorter (1-minute) quiet gap.
import { pathToFileURL } from 'node:url';

// ---- capture the sweeper's setInterval callback (the FIRST 15s interval) ----
let sweepCb = null;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  if (ms === 15_000 && sweepCb === null) { sweepCb = fn; return { unref() {} }; }
  return { unref() {} }; // SSE pings etc: never actually run
};
globalThis.clearInterval = () => {};

const listeners = new Map();
const routes = new Map();
let llmReply = '无';
let llmCalls = 0;

const webServer = {
  register(r) { routes.set(r.path, r); return () => {}; },
};
const ctx = {
  webServer,                                     // host accesses it directly
  on(event, fn) { listeners.set(event, fn); return () => {}; },
  effect(fn) { fn(); return () => {}; },          // run immediately
  get(name) {
    if (name === 'webServer') return webServer;
    if (name === 'llm') return {
      stream: async function* () {
        llmCalls++;
        yield { type: 'text-delta', text: llmReply };
      },
    };
    if (name === 'agentDefaultModel') return {
      currentSelection: () => ({ provider: 'p', model: 'm' }),
    };
    return undefined;
  },
};

const mod = await import(pathToFileURL(
  'C:/Users/hp/WorkBuddy/2026-10-25-11-31-58/progress-lens/index.js',
).href);
mod.apply(ctx);

// ---- open one SSE stream --------------------------------------------------
const frames = [];
const res = {
  writeHead() {},
  write(s) { frames.push(s); },
  on() {},
  end() {},
};
await routes.get('/__progress_lens/stream').handler(
  { method: 'GET', url: '/__progress_lens/stream?session=S1' }, res,
);

const lines = () => frames
  .filter((f) => f.startsWith('data: '))
  .map((f) => { try { return JSON.parse(f.slice(6)); } catch { return null; } })
  .filter(Boolean);
const murmurLines = () => lines().filter((f) => f.type === 'line' && f.item?.kind === 'murmur');

// ---- 1. routine reasoning: NO subjective signal -> must stay quiet --------
listeners.get('agent/status')({ agent: { id: 'S1' }, status: 'running' });
listeners.get('agent/assistant-stream')({
  agent: { id: 'S1' },
  frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '先读文件再做对比。' } },
});
sweepCb();
await new Promise((r) => setTimeout(r, 30));
const quiet = murmurLines().length === 0 && llmCalls === 0;

// ---- 2. a subjective thought -> one rewritten aside ----------------------
llmReply = '……算了，反正顺手就改掉吧。';
listeners.get('agent/assistant-stream')({
  agent: { id: 'S1' },
  frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '有点拿不准，还是换个做法吧。' } },
});
sweepCb();
await new Promise((r) => setTimeout(r, 30));
const aside = murmurLines();
const spoke = aside.length === 1 && aside[0].item.text === '……算了，反正顺手就改掉吧。';

// ---- 3. another thought within the quiet gap -> still only one -----------
llmReply = '这次倒是挺顺的。';
listeners.get('agent/assistant-stream')({
  agent: { id: 'S1' },
  frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '居然一下就过了，有点爽。' } },
});
sweepCb();
await new Promise((r) => setTimeout(r, 30));
const gated = murmurLines().length === 1;

// ---- 4. past the shorter (1-minute) gap -> a SECOND aside is allowed -----
const realNow = Date.now;
Date.now = () => realNow() + 70_000;
llmReply = '这次倒是挺顺的，悄悄松了口气。';
listeners.get('agent/assistant-stream')({
  agent: { id: 'S1' },
  frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '居然一下就过了，有点爽。' } },
});
sweepCb();
await new Promise((r) => setTimeout(r, 30));
const chattier = murmurLines().length === 2;

// ---- 5. model judging them unworthy ("无") -> still only two -------------
Date.now = () => realNow() + 200_000;
llmReply = '无';
listeners.get('agent/assistant-stream')({
  agent: { id: 'S1' },
  frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '说不定还有别的坑，有点慌。' } },
});
sweepCb();
await new Promise((r) => setTimeout(r, 30));
Date.now = realNow;
const unworthy = murmurLines().length === 2;

globalThis.setInterval = realSetInterval;

const out = {
  quietOnRoutineReasoning: quiet,
  oneAsideFromSubjectiveThought: spoke,
  quietGapBlocksSecondAside: gated,
  shorterGapAllowsMore: chattier,
  modelCanDeclineWithNo: unworthy,
  llmCalls,
  totalMurmurLines: murmurLines().length,
  sampleAside: aside[0]?.item?.text ?? null,
};
console.log(JSON.stringify(out, null, 2));
if (!(quiet && spoke && gated && chattier && unworthy)) process.exitCode = 1;
