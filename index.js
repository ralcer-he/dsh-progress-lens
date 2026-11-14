/**
 * progress-lens — Host half.
 *
 * Read-only progress lens, now **per session** and **low-noise**.
 *
 * Design contract (operator revision, 2026-11-07):
 *  - Per session: every event the Host broadcasts carries its owner (`agent.id`
 *    for agent/*, `session.id` for session/event), so the feed is bucketed by
 *    sessionId and a browser only ever sees its own conversation.
 *  - Low noise: the panel no longer mirrors the reasoning chain line by line.
 *    Reasoning is accumulated silently as *input*; the panel receives a short
 *    digest — what finished, where it is now, what it will do next — at most
 *    once per SUMMARY_INTERVAL_MS, or after a burst of tool calls, or when a
 *    turn ends. Only start / error / turn-end get a plain milestone line.
 *  - Never blocks the agent: the digest call is fire-and-forget and fully
 *    detached (no sessionId, no tools, no tool history).
 *  - Nothing is written into the session log.
 */
export const name = 'dsh-progress-lens';

// webServer is essential (SSE + ask). llm / agentDefaultModel are looked up
// lazily with ctx.get() so a profile without them still serves the panel.
export const inject = ['webServer'];

const STREAM_PATH = '/__progress_lens/stream';
const ASK_PATH = '/__progress_lens/ask';
const MAX_FEED = 60;
const MAX_BODY = 64 * 1024;

/** At most one digest per session in this window. */
const SUMMARY_INTERVAL_MS = 75_000;
/** …or after this many tool calls, whichever comes first. */
const TOOL_BURST = 10;
/** How many sessions to keep buckets for. */
const MAX_SESSIONS = 24;
/** How many raw traces feed one digest. */
const TRACE_KEEP = 60;
/** How often the sweeper checks whether some session is due for a digest. */
const SWEEP_MS = 15_000;

/* ---- "Thoughts out loud" (碎碎念 / 心里话) --------------------------------
 * A second, independent channel. The digest above translates reasoning into a
 * third-person progress report; this one keeps the *person* in it — a
 * hesitation, a small delight, a muttered "this is a pain". It is deliberately
 * sparse: only sentences carrying a subjective signal are kept, they are
 * rewritten (not copied) into one short first-person aside, and at most one
 * aside per MURMUR_INTERVAL_MS may reach the panel. No thoughts, no line.
 */
/** Shortest gap between two asides; the "no idle chatter" floor. */
const MURMUR_INTERVAL_MS = 60_000;
/** How many candidate thoughts feed one rewrite. */
const MURMUR_SEED_KEEP = 20;
/** Cap on pending candidate thoughts per session. */
const MURMUR_MAX_SEED = 40;

const sse = (frame) => `data: ${JSON.stringify(frame)}\n\n`;

function errorText(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  try { return JSON.stringify(e); } catch { return String(e); }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function selection(ctx) {
  const svc = ctx.get('agentDefaultModel');
  try { return svc?.currentSelection?.() || null; } catch { return null; }
}

/**
 * Tool names are the single biggest source of "I don't know what this means".
 * The panel never shows a raw identifier: every tool resolved to what it does
 * in words a person who does not write code can still follow.
 */
const TOOL_LABELS = {
  ops_bash: '在命令行里敲命令',
  bash: '在命令行里敲命令',
  shell: '在命令行里敲命令',
  write: '写文件',
  edit: '改文件',
  read_file: '翻文件看内容',
  read_files: '翻几个文件看内容',
  ops_read_files: '翻几个文件看内容',
  ops_inspect_local_file: '细看一个文件',
  ops_grep: '在文件里搜东西',
  grep: '在文件里搜东西',
  ops_glob: '找文件在哪儿',
  glob: '找文件在哪儿',
  web_search: '上网搜资料',
  web_fetch: '打开网页看内容',
  search: '上网搜资料',
  todo_write: '更新待办清单',
  subagent: '派个小助手去办一件事',
  subagent_fork: '派个小助手接着办',
  job_output: '看后台任务跑到哪了',
  job_kill: '停掉一个后台任务',
  skill: '翻一份操作说明',
  ask_user_question: '回来问你一句',
  unlag_refresh: '让程序重新加载新代码',
  plugin_manager: '装或改一个插件',
};

/** Turn a tool identifier into a plain-language action. */
function humanAction(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const direct = TOOL_LABELS[raw];
  if (direct) return direct;
  // MCP tools arrive as mcp__<server>__<tool>: keep the meaningful tail.
  const tail = raw.includes('__') ? raw.split('__').filter(Boolean).pop() : raw;
  const spoken = String(tail || raw).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spoken ? `用「${spoken}」办点事` : '在干活';
}

/**
 * Error strings are the other place the panel used to leak raw jargon:
 * FS_EDIT_NOT_FOUND, EPERM, ERR_PNPM_EPERM mean nothing to a reader.
 * Map the frequent ones to a sentence; keep the tail out of the panel.
 */
function humanError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const tests = [
    [/EPERM|EACCES|operation not permitted|permission denied/i, '有个文件被别的程序占着，改不动'],
    [/FS_EDIT_NOT_FOUND|old_string was not found|no match/i, '要改的那段文字没对上，得重新找一遍'],
    [/ENOENT|no such file/i, '找不到那个文件了'],
    [/ERR_PNPM|pnpm/i, '装依赖那一步没走通'],
    [/timeout|ETIMEDOUT|timed out/i, '等太久没反应，超时了'],
    [/ECONNREFUSED|ECONNRESET|socket hang up/i, '连接断了'],
    [/JSON|unexpected token/i, '返回的数据格式不对，读不出来'],
    [/rate.?limit|429|quota/i, '请求太频繁，被限流了'],
    [/context|token.{0,6}limit|too long/i, '对话太长，塞不下了'],
    [/syntax|parse|unexpected/i, '代码写错了一处，语法没过'],
  ];
  for (const [re, said] of tests) if (re.test(text)) return said;
  // Nothing recognised: do not dump the raw line, just say it broke.
  return '碰到个没预料的错，正在想办法绕过去';
}

/** Elapsed time as a person would say it, never as a raw mm:ss clock. */
function humanElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return '刚起步';
  const min = Math.floor(total / 60);
  if (min < 60) return `已经干了 ${min} 分钟`;
  const h = Math.floor(min / 60);
  return `已经干了 ${h} 个多小时`;
}

/** One isolated, best-effort LLM call. Returns '' instead of throwing. */
async function isolatedAsk(ctx, system, userText, maxTokens) {
  const llm = ctx.get('llm');
  const sel = selection(ctx);
  if (!llm || !sel || !sel.provider || !sel.model) return '';
  let text = '';
  try {
    for await (const chunk of llm.stream({
      provider: sel.provider,
      model: sel.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      maxTokens,
      // deliberately NO sessionId, NO tools, NO toolHistory, NO purpose:
      // this call is fully detached from the main agent loop.
    })) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta') text += chunk.text || '';
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') break;
    }
  } catch {
    // Best effort: a failed digest must never disturb the main agent.
    return '';
  }
  return text.trim();
}

const DIGEST_SYSTEM = [
  '你在给一个不懂技术的朋友当「解说员」，他正盯着一个跑得很久的任务，',
  '看不懂屏幕上的命令行、文件名和报错，只想知道：你干了啥、现在顺不顺、接下来要干嘛。',
  '',
  '用中文写 2 到 3 句，总共不超过 100 字，像坐在旁边随口说：',
  '第一句：这段时间做成了什么（说人话，比如「把那个会挡住图标的浮层换成了正经的右侧边栏」）。',
  '第二句：现在手头这件事是什么（如果卡住了，直接说卡在哪、要不要他帮忙）。',
  '第三句：接下来大概会做什么（不确定就用「大概」「可能」，别说死）。',
  '',
  '硬性要求：',
  '- 不许出现工具名、函数名、文件名、英文标识符、代码符号、轮次步数（不许写 ops_bash、edit、turn 44、step 27 这种）。',
  '- 不许罗列、不许编号、不许 markdown、不许分点。',
  '- 不许说「根据记录」「综上」「目前正在执行」这类公文腔。',
  '- 不要复述输入给你的痕迹，要把它翻译成结果。',
  '- 拿不准就跳过，宁可少说一句，也不要编。',
].join('\n');

const ANSWER_SYSTEM = [
  '你是一个待命在旁边的人，用户随时会敲一句话过来。',
  '他可能问进度，也可能只是随口聊两句、抱怨一句、问你在不在。',
  '',
  '怎么回：',
  '- 用中文，一到三句，口语，像同事回头搭话，不要客服腔。',
  '- 问进度：直接说现在在干什么、顺不顺、有没有卡住。翻译成人话，',
  '  不许提工具名、文件名、轮次步数。例：「还在改那个侧边栏，快弄完了」「卡在一个文件改不动，我换个法子试试」。',
  '- 问还要多久：不许编数字。说清「卡在哪一步」「剩下几件事」，然后说「不好说准」。',
  '- 闲聊：正常聊，不用硬往工作上拐。',
  '- 不知道、没记录：直接说「这会儿我这边看不到」，别猜、别糊弄、别复述他的问题。',
  '- 不许「根据以上」「综上」「您好」「很高兴为您」这类话。',
].join('\n');

/**
 * Only *subjective* reasoning is worth an aside. Pure execution reasoning
 * ("read X first, then diff Y") never matches, so it never becomes chatter.
 * Bilingual because the reasoning stream is not guaranteed to be Chinese.
 */
const MURMUR_SIGNAL = /(不确定|拿不准|不太|有点|好像|大概|也许|可能|估计|猜|万一|难道|会不会|算了|反正|顺手|干脆|本来|不如|还是|换个|绕|烦|漂亮|挺好|爽|慌|当真|飘|赖|嫌|可惜|幸好|终于|总算|果然|居然|竟然|划不来|没必要|锁死|白费|多此一举|早知道|嗯|哦|哎呀|罢了|得了|悄悄|一点点|别扭|说不清|说不上|琢磨|缓一下|绕死|难为|没劲|得意|有意思|看错|记着|盯着|说不定|要不是|倒是|反而|索性|心情|痒|馋|\bnot sure\b|\bunsure\b|\bmaybe\b|\bprobably\b|\bguess\b|\bwonder\b|\bhmm\b|\bwell\b|\bwait\b|\bactually\b|\bugh\b|\btricky\b|\bannoying\b|\bnice\b|\boh\b|\bah\b|\bcareful\b|\bbetter\b|\binstead\b|\bsimpler\b|\bworks\b|\bhopefully\b|\brisky\b|\bturns out\b|\bi think\b|\bkind of\b)/i;

const MURMUR_SIGNAL_SOFT = /(其实|说真的|老实说|说起来|话说|唔|诶|诶呀|嚯|嗬|害|啧|嘶|额|嗯呐|哦哟|得了吧|行吧|好吧|那就|懒得|不想|巴不得|想了想|回头|顺带|捎带|省得|免得|白搭|合着|敢情|可算|好在|亏得|偏偏|愣是|硬是|差点|几乎|勉强|凑合|差不多|八成|保不齐|没准|指不定|天晓得|鬼知道|谁晓得|拉倒|作罢|也罢|管它呢|随它|爱咋咋|不折腾了|够了|行了|成吧|想当然|可别|何苦|至于嘛|值当|不值当|图啥|犯不着|随口|顺嘴|多嘴|插一句|话说回来|说到底|想来想去|横竖|好歹|总归|终归|说白了|坦白讲|不瞒你说|你别说|还别说|怪不得|怨不得|难怪|合该|活该|赶巧|不巧|偏巧|正巧|得亏|多亏|幸亏|亏了|早知|当初|刚想|正要|还想|本想|原想|本来想|差点就|险些|够呛|不妙|要糟|坏了|糟了|舒坦|痛快|解气|过瘾|不赖|够意思|有意思|有戏|没戏|白忙|白折腾|瞎忙|折腾|磨叽|磨蹭|卡壳|卡住|绕晕|头大|头疼|脑壳疼|上头|烦人|闹心|糟心|堵心|窝火|来气|憋屈|不值|划不来|肉疼|心疼|可惜了|遗憾|美中不足|差口气|差点意思|不够味|将就|得过且过|\balright\b|\bfine\b|\bokay\b|\bhuh\b|\bhey\b|\bmeh\b|\bphew\b|\boops\b|\bwhatever\b|\bhonestly\b|\bfrankly\b|\bsort of\b|\bi guess\b|\bi mean\b|\byou know\b|\balmost\b|\bnearly\b|\bbarely\b|\bgo figure\b|\bwho knows\b|\bnever mind\b|\bwhy not\b|\bwhy bother\b|\bmight as well\b|\bno point\b|\bnot worth\b)/i;

/** Keep a sentence readable without scrubbing its voice away. */
function softClean(text) {
  return String(text || '').replace(/\s{2,}/g, ' ').trim();
}

const MURMUR_SYSTEM = [
  '你正在埋头干活，脑子里偶尔会飘过一些跟进度无关的念头：',
  '有点拿不准、有点嫌麻烦、忽然想通了、小小的得意、',
  '拿不准要不要换个做法、或者只是悄悄嘀咕半句。',
  '',
  '把这些念头压成一句自言自语，像人干活时不小心说出声的那半句。',
  '用中文，第一人称，两到三句短话，总共不超过 70 字，可以连着多念叨半句。',
  '',
  '要求：',
  '- 是「心里话」，不是进度汇报：不说做完了什么、不说下一步、不报卡点、不解释方案。',
  '- 像随口嘟囔，可以带一点别扭、黏、或者小小的嘴硬，但别闹、别撒娇过头、别喊名字。',
  '- 不许出现工具名、文件名、路径、英文标识符、轮次步数、报错码。',
  '- 不许「根据」「综上」「首先」「其次」这类条理腔，不许编号、不许 markdown、不许用引号括起来。',
  '- 只写那一句，别解释它是怎么来的，别复述给你的念头。',
  '- 别太沉默：里头哪怕只有一丝犹豫、一点嫌麻烦、半句小得意，也值得咂摸出来小声说一句。',
  '- 只有真的一点可嘀咕的都没有，才只回一个字：无。',
].join('\n');

export function apply(ctx) {
  /** res -> sessionId (null = 尚未声明，推全量为空) */
  const connections = new Map();
  /** sessionId -> bucket */
  const buckets = new Map();
  let sweepTimer = null;

  const newBucket = (sessionId) => ({
    sessionId,
    status: {
      sessionId,
      running: false,
      startedAt: 0,
      elapsedMs: 0,
      turn: 0,
      step: 0,
      action: '',
      error: '',
    },
    feed: [],
    seq: 0,
    /** reasoning text accumulated for the NEXT digest — never pushed as-is */
    trace: [],
    lastSummaryAt: 0,
    toolCount: 0,
    summarizing: false,
    /** independent "thoughts out loud" channel */
    murmurSeed: [],
    lastMurmurAt: 0,
    murmuring: false,
    touchedAt: Date.now(),
  });

  const bucket = (sessionId) => {
    const key = String(sessionId || '');
    if (!key) return null;
    let b = buckets.get(key);
    if (b === undefined) {
      b = newBucket(key);
      buckets.set(key, b);
      if (buckets.size > MAX_SESSIONS) {
        // Drop the least recently touched bucket.
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [k, v] of buckets) {
          if (v.touchedAt < oldestAt) { oldestAt = v.touchedAt; oldestKey = k; }
        }
        if (oldestKey !== null && oldestKey !== key) {
          buckets.delete(oldestKey);
          for (const [res, sid] of connections) if (sid === oldestKey) connections.delete(res);
        }
      }
    }
    b.touchedAt = Date.now();
    return b;
  };

  /** Send one frame to every browser watching this session. */
  const write = (sessionId, frame) => {
    const payload = sse(frame);
    const key = String(sessionId || '');
    for (const [res, sid] of connections) {
      if (sid !== null && sid !== key) continue;
      try { res.write(payload); } catch { connections.delete(res); }
    }
  };

  const line = (sessionId, kind, text, extra) => {
    const b = bucket(sessionId);
    if (b === null) return;
    if (text === undefined || text === null) return;
    const clean = String(text).trim();
    if (!clean) return;
    const item = { id: ++b.seq, kind, text: clean.slice(0, 400), time: Date.now() };
    if (extra) Object.assign(item, extra);
    b.feed.push(item);
    if (b.feed.length > MAX_FEED) b.feed = b.feed.slice(-MAX_FEED);
    b.touchedAt = Date.now();
    write(sessionId, { type: 'line', item });
  };

  const setStatus = (sessionId, patch) => {
    const b = bucket(sessionId);
    if (b === null) return;
    b.status = { ...b.status, ...patch };
    b.touchedAt = Date.now();
    write(sessionId, { type: 'status', status: b.status });
  };

  /**
   * Keep raw traces only as digest input. This is the whole point of the
   * low-noise revision: reasoning never reaches the panel verbatim.
   */
  const trace = (sessionId, text) => {
    const b = bucket(sessionId);
    if (b === null) return;
    // Strip the shapes the model drowns readers in: identifiers, paths, hashes.
    const clean = String(text || '')
      .replace(/[A-Za-z]:[\/][^\s，。；）)]+/g, '某个文件')
      .replace(/\/[\w.-]+(?:\/[\w.-]+){1,}/g, '某个路径')
      .replace(/[0-9a-f]{8,}/g, '一串编号')
      // Only code-looking tokens go: snake_case, camelCase, dotted/file names.
      .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m) => (/[A-Za-z]_|[a-z][A-Z]|\.(js|mjs|ts|json|yml|yaml|py|md)$/.test(m) ? '' : m))
      .replace(/[（(]\s*[）)]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!clean) return;
    b.trace.push(clean.slice(0, 200));
    if (b.trace.length > TRACE_KEEP) b.trace = b.trace.slice(-TRACE_KEEP);
  };

  const emitDigest = (sessionId, why) => {
    const b = bucket(sessionId);
    if (b === null || b.summarizing) return;
    const now = Date.now();
    if (b.trace.length === 0 && why !== 'turn-end') return;
    if (now - b.lastSummaryAt < SUMMARY_INTERVAL_MS && why === 'interval') return;
    b.summarizing = true;
    b.lastSummaryAt = now;
    b.toolCount = 0;
    const logs = b.trace.slice(-TRACE_KEEP);
    const head = [
      b.status.running ? `状态：还在跑，${humanElapsed(Date.now() - (b.status.startedAt || Date.now()))}` : '状态：这一段刚停下',
      b.status.action ? `手上这件事：${b.status.action}` : '',
      b.status.error ? `遇到的问题：${b.status.error}` : '',
    ].filter(Boolean).join('；');
    // Fire-and-forget: never await the model inside an event listener.
    isolatedAsk(ctx, DIGEST_SYSTEM, `${head}\n\n执行痕迹：\n${logs.join('\n')}`.slice(0, 3000), 220)
      .then((out) => {
        if (out) line(sessionId, 'digest', out.slice(0, 320), { why });
      })
      .catch(() => {})
      .finally(() => { b.summarizing = false; });
  };

  /**
   * Collect a candidate thought. Sentences without a subjective signal are
   * dropped here — this is the "no idle chatter" filter, and it is why the
   * aside channel stays quiet during routine execution reasoning.
   */
  const murmurSeed = (sessionId, text) => {
    const b = bucket(sessionId);
    if (b === null) return;
    const clean = softClean(text);
    if (!clean || clean.length < 2) return;
    if (!MURMUR_SIGNAL.test(clean) && !MURMUR_SIGNAL_SOFT.test(clean)) return;
    if (b.murmurSeed.includes(clean)) return;
    b.murmurSeed.push(clean.slice(0, 160));
    if (b.murmurSeed.length > MURMUR_MAX_SEED) {
      b.murmurSeed = b.murmurSeed.slice(-MURMUR_MAX_SEED);
    }
    b.touchedAt = Date.now();
  };

  /** Rewrite the collected thoughts into ONE short first-person aside. */
  const emitMurmur = (sessionId) => {
    const b = bucket(sessionId);
    if (b === null || b.murmuring) return;
    if (b.murmurSeed.length === 0) return;            // no thoughts → no line
    if (Date.now() - b.lastMurmurAt < MURMUR_INTERVAL_MS) return;
    b.murmuring = true;
    b.lastMurmurAt = Date.now();
    const seeds = b.murmurSeed.slice(-MURMUR_SEED_KEEP);
    b.murmurSeed = [];
    isolatedAsk(ctx, MURMUR_SYSTEM, seeds.join('\n').slice(0, 2600), 200)
      .then((out) => {
        const clean = String(out || '').trim();
        if (!clean || clean === '无' || clean.length < 2) {
          // Empty = the call failed, so keep the seeds for a later retry;
          // "无" = the model judged them unworthy, so let them go quietly.
          if (!clean) b.murmurSeed.push(...seeds);
          return;
        }
        line(sessionId, 'murmur', clean.replace(/^无[，。,]?\s*/, '').slice(0, 120));
      })
      .catch(() => { b.murmurSeed.push(...seeds); })
      .finally(() => { b.murmuring = false; });
  };

  ctx.effect(() => {
    const disposers = [];
    const on = (event, listener) => disposers.push(ctx.on(event, listener, { global: true }));

    // ---- agent lifecycle: agent.id IS the session id -------------------------
    on('agent/status', ({ agent, status: st }) => {
      const sid = agent?.id;
      if (!sid) return;
      const b = bucket(sid);
      if (st === 'running' && !b.status.running) {
        b.trace = [];
        setStatus(sid, { running: true, startedAt: Date.now(), elapsedMs: 0, action: '', error: '' });
        b.lastSummaryAt = Date.now(); // 计时从开跑算，别一开就跑一次
        line(sid, 'progress', '开始干活了');
      } else if (st === 'idle' && b.status.running) {
        setStatus(sid, {
          running: false,
          elapsedMs: Date.now() - (b.status.startedAt || Date.now()),
          action: '空闲',
        });
        line(sid, 'progress', '这一段跑完了');
        emitDigest(sid, 'turn-end');
      }
    });

    on('agent/error', ({ agent, error }) => {
      const sid = agent?.id;
      if (!sid) return;
      const raw = errorText(error).slice(0, 400);
      const said = humanError(raw);
      setStatus(sid, { error: said, errorRaw: raw });
      line(sid, 'error', said);
      trace(sid, `出了个问题：${said}`);
    });

    // ---- reasoning / text: silently accumulated for the digest ---------------
    on('agent/assistant-stream', ({ agent, frame }) => {
      const sid = agent?.id;
      if (!sid || !frame) return;
      if (frame.type === 'start') { return; }
      if (frame.type === 'end') { return; }
      const ch = frame.chunk;
      if (!ch || !ch.type) return;
      if (ch.type === 'reasoning-delta' || ch.type === 'text-delta') {
        const t = ch.text || '';
        if (!t) return;
        // Buffer, then cut into sentence-ish traces so the digest has signal.
        const b = bucket(sid);
        if (b === null) return;
        b.pending = (b.pending || '') + t;
        if (b.pending.length > 400 || /[。！？!?\n]/.test(t)) {
          trace(sid, b.pending);
          // The same sentence is also offered to the "thoughts out loud"
          // channel; its own filter decides whether it is worth keeping.
          murmurSeed(sid, b.pending);
          emitMurmur(sid);
          b.pending = '';
        }
      } else if (ch.type === 'tool-call-delta' && ch.name) {
        // No feed line for every tool: only the status strip changes, and the
        // name is translated — the panel never shows a raw identifier.
        setStatus(sid, { action: humanAction(ch.name) });
      }
    });

    // ---- durable milestones: only the ones worth a line ----------------------
    on('session/event', (session, event) => {
      const sid = session?.id;
      if (!sid || !event || !event.type) return;
      const d = event.data || {};
      switch (event.type) {
        case 'step/start':
          setStatus(sid, { turn: d.turn ?? 0, step: d.step ?? 0 });
          return;
        case 'tool/result':
          if (d.error) {
            const raw = errorText(d.error.reason || d.error.code || d.error).slice(0, 400);
            const said = humanError(raw);
            setStatus(sid, { error: said, errorRaw: raw });
            line(sid, 'error', said);
            trace(sid, `出了个问题：${said}`);
          }
          return;
        case 'tool/call': {
          const b = bucket(sid);
          if (b === null) return;
          b.toolCount += 1;
          trace(sid, `用「${d.name ? humanAction(d.name) : '工具'}」做了点什么`);
          if (b.toolCount >= TOOL_BURST) emitDigest(sid, 'tool-burst');
          return;
        }
        case 'turn/start':
          trace(sid, '开始新一轮');
          return;
        case 'turn/end':
          setStatus(sid, { action: '这一轮完了' });
          emitDigest(sid, 'turn-end');
          return;
        case 'todo/write': {
          const todos = Array.isArray(d.todos) ? d.todos : [];
          const done = todos.filter((t) => t && (t.status === 'completed' || t.status === 'done')).length;
          if (todos.length) {
            setStatus(sid, { action: `清单上还有 ${todos.length - done} 件事没做完` });
            trace(sid, `清单上还有 ${todos.length - done} 件事没做完`);
          }
          return;
        }
        default:
          return;
      }
    });

    on('workflow/phase', (info, title) => {
      const sid = info?.sessionId || info?.agent?.id || info?.id;
      if (!sid || !title) return;
      trace(sid, `阶段：${title}`);
      setStatus(sid, { action: `阶段：${title}` });
    });

    // ---- sweep: sessions that went quiet still get their digest -------------
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, b] of buckets) {
        // Channel 1: the plain-language progress digest (unchanged rules).
        if (!b.summarizing
          && (b.status.running || b.feed.length > 0)
          && now - b.lastSummaryAt >= SUMMARY_INTERVAL_MS
          && b.trace.length > 0) {
          emitDigest(sid, 'interval');
        }
        // Channel 2: a thought-out-loud aside, only when thoughts were
        // actually collected and the quiet gap has passed.
        if (!b.murmuring
          && b.murmurSeed.length > 0
          && now - b.lastMurmurAt >= MURMUR_INTERVAL_MS) {
          emitMurmur(sid);
        }
      }
    }, SWEEP_MS);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

    // ---- SSE: snapshot on connect, then only this session's lines -----------
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: STREAM_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        let sid = null;
        try {
          const url = new URL(req.url || STREAM_PATH, 'http://127.0.0.1');
          sid = url.searchParams.get('session') || null;
        } catch { sid = null; }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });
        res.write(': connected\n\n');
        connections.set(res, sid);

        if (sid !== null) {
          const b = bucket(sid);
          res.write(sse({ type: 'snapshot', status: b.status, feed: b.feed }));
        } else {
          res.write(sse({ type: 'snapshot', status: null, feed: [] }));
        }

        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
        if (typeof ping.unref === 'function') ping.unref();
        res.on('close', () => { clearInterval(ping); connections.delete(res); });
      },
    }));

    // ---- Optional free-form question (isolated LLM call, per session) --------
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ASK_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let answer = '';
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const sid = String(body.session || '').trim();
          const question = String(body.question || '').trim().slice(0, 2000);
          if (question) {
            const b = sid ? bucket(sid) : null;
            const context = Array.isArray(body.context)
              ? body.context.slice(-12).map((x) => String(x).slice(0, 200))
              : (b !== null ? b.feed.slice(-12).map((x) => `${x.kind}: ${x.text}`) : []);
            if (sid) line(sid, 'question', question);
            const head = b !== null
              ? [
                b.status.running
                  ? `状态：还在跑，${humanElapsed(Date.now() - (b.status.startedAt || Date.now()))}`
                  : '状态：现在空闲',
                b.status.action ? `手上这件事：${b.status.action}` : '',
                b.status.error ? `遇到的问题：${b.status.error}` : '',
              ].filter(Boolean).join('；')
              : '';
            answer = await isolatedAsk(
              ctx,
              ANSWER_SYSTEM,
              `${head ? `${head}\n`
                : '状态：我这边没有这条对话的进度记录。'}\n最近聊过的：\n${context.map((x) => `- ${x}`).join('\n')}\n\n他刚说的：${question}`,
              300,
            );
            if (sid) line(sid, 'answer', answer || '（这次没拿到回答）');
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, answer }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: errorText(e) }));
        }
      },
    }));

    return () => {
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      for (const d of disposers) { try { d(); } catch { /* ignore */ } }
      for (const res of connections.keys()) { try { res.end(); } catch { /* ignore */ } }
      connections.clear();
      buckets.clear();
    };
  }, 'progress-lens: host feed');
}
