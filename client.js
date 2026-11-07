/**
 * progress-lens — Client half.
 *
 * Registered as a tab type on the right sidebar owned by dsh-better-sidebar,
 * which is the Host's real right column: it squeezes the conversation instead
 * of floating over it, it has its own close control, and each tab instance is
 * bound to one session (`scope.sessionId`), so the panel never mixes two
 * conversations.
 *
 * The panel shows a digest, not a transcript: the host half buckets events per
 * session and only emits a short "what finished / where it is / what is next"
 * line every ~75s, on a burst of tool calls, or at the end of a turn.
 */
window.__ModuleLoader__.load({
  id: 'dsh-progress-lens',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'progress-lens';
    const STREAM_PATH = '/__progress_lens/stream';
    const ASK_PATH = '/__progress_lens/ask';
    const TAB_ID = 'progress-lens:panel';

    const zh = {
      'meta.title': '进度透镜',
      'meta.description': '在右侧栏看当前对话干到哪了，随时搭句话，不打断运行。',
      title: '进度',
      empty: '暂时还没动静。这边说一下，那边就会隔一会儿跟你讲一句进展；也可以直接在这儿问，或者随便聊两句。',
      placeholder: '问一句，或者随便聊两句',
      send: '说',
      asking: '我想想…',
      waiting: '等着',
      working: '在干活',
      idle: '闲着',
      disconnected: '断线了，正在重连…',
      error: '出问题了',
      digest: '进展',
      progress: '动态',
      question: '你',
      answer: '这边',
      justStarted: '刚起步',
      minutes: '已经干了 {n} 分钟',
      hours: '已经干了 {n} 个多小时',
    };

    const en = {
      'meta.title': 'Progress Lens',
      'meta.description': 'See where this conversation is, and chat about it in the right sidebar without interrupting the run.',
      title: 'Progress',
      empty: 'Quiet so far. A short note shows up here every so often while it works, and you can ask or just chat any time.',
      placeholder: 'Ask something, or just chat',
      send: 'Say',
      asking: 'thinking…',
      waiting: 'waiting',
      working: 'working',
      idle: 'idle',
      disconnected: 'Disconnected, reconnecting…',
      error: 'went wrong',
      digest: 'progress',
      progress: 'update',
      question: 'you',
      answer: 'lens',
      justStarted: 'just started',
      minutes: 'going for {n} min',
      hours: 'going for {n}h+',
    };

    const CSS = `
.pl-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.55;
}
.pl-status {
  flex: none;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
}
.pl-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
  flex: none;
}
.pl-dot[data-running="true"] { background: var(--dsw-alias-state-success-primary); }
.pl-meta { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.pl-error { color: var(--dsw-alias-state-error-primary); }
.pl-feed {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pl-item { display: flex; flex-direction: column; gap: 2px; }
.pl-kind {
  font-size: 10px;
  color: var(--dsw-alias-label-caption);
  letter-spacing: .02em;
}
.pl-text { white-space: pre-wrap; word-break: break-word; }

/* Reads like a chat, not like a log: your words sit right, the lens answers
   left, and the periodic summary is just quiet body text with a rule. */
.pl-item[data-kind="question"] { align-items: flex-end; }
.pl-item[data-kind="question"] .pl-kind { display: none; }
.pl-item[data-kind="question"] .pl-text {
  max-width: 88%;
  padding: 5px 9px;
  border-radius: 10px 10px 2px 10px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.pl-item[data-kind="answer"] .pl-kind { display: none; }
.pl-item[data-kind="answer"] .pl-text {
  max-width: 92%;
  padding: 6px 10px;
  border-radius: 10px 10px 10px 2px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.pl-item[data-kind="digest"] { padding-top: 4px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.pl-item[data-kind="digest"] .pl-text { color: var(--dsw-alias-label-secondary); }
.pl-item[data-kind="progress"] .pl-kind, .pl-item[data-kind="progress"] .pl-text {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.pl-item[data-kind="error"] .pl-text { color: var(--dsw-alias-state-error-primary); }
.pl-empty { color: var(--dsw-alias-label-tertiary); }
.pl-ask {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.pl-ask input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.pl-ask button {
  flex: none;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.pl-ask button[disabled] { opacity: .5; cursor: default; }
/* Header icon: same hover frame as the host's own header buttons
   (.an3WzG_crumb:hover / .an3WzG_viewsMore[aria-expanded=true] both use
   --dsw-alias-interactive-bg-hover), plus a persistent lit state while the
   right column is open so open/closed read apart at a glance. */
.pl-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background .12s ease, color .12s ease;
}
.pl-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pl-trigger:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.pl-trigger[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.pl-trigger[data-active="true"] svg { color: var(--dsw-alias-brand-primary); }
`;


    /** One mount per session; the tab keeps its own connection. */
    function ProgressBody(props) {
      const { scope, ctx } = props;
      const sessionId = scope && scope.sessionId ? String(scope.sessionId) : '';

      const t = React.useMemo(() => {
        const lookup = (key, params) => {
          if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') {
            try {
              const bound = ctx.locale.bind(NS);
              if (typeof bound === 'function') {
                const out = bound(key, params);
                if (out && out !== key) return out;
              }
            } catch { /* fall through to the inline dictionary */ }
          }
          const table = (ctx && ctx.locale && ctx.locale.getLocale && ctx.locale.getLocale()?.id === 'en') ? en : zh;
          let text = table[key] ?? zh[key] ?? key;
          if (params) for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
          return text;
        };
        return lookup;
      }, [ctx]);

      const [status, setStatus] = React.useState(null);
      const [feed, setFeed] = React.useState([]);
      const [connected, setConnected] = React.useState(false);
      const [asking, setAsking] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const listRef = React.useRef(null);
      const feedRef = React.useRef([]);

      React.useEffect(() => {
        feedRef.current = feed;
      }, [feed]);

      // One SSE connection bound to THIS session only.
      React.useEffect(() => {
        if (!sessionId) return undefined;
        let source = null;
        let closed = false;
        let retry = null;

        const open = () => {
          if (closed) return;
          try {
            source = new EventSource(`${STREAM_PATH}?session=${encodeURIComponent(sessionId)}`);
          } catch {
            return;
          }
          source.onopen = () => setConnected(true);
          source.onerror = () => {
            setConnected(false);
            try { source.close(); } catch { /* ignore */ }
            source = null;
            if (!closed) retry = setTimeout(open, 3000);
          };
          source.onmessage = (ev) => {
            let frame = null;
            try { frame = JSON.parse(ev.data); } catch { return; }
            if (!frame || !frame.type) return;
            if (frame.type === 'snapshot') {
              if (frame.status && frame.status.sessionId === sessionId) setStatus(frame.status);
              if (Array.isArray(frame.feed)) setFeed(frame.feed);
              return;
            }
            if (frame.type === 'status') {
              if (frame.status && frame.status.sessionId === sessionId) setStatus(frame.status);
              return;
            }
            if (frame.type === 'line' && frame.item) {
              setFeed((prev) => {
                const next = prev.concat([frame.item]);
                return next.length > 60 ? next.slice(-60) : next;
              });
            }
          };
        };

        open();
        return () => {
          closed = true;
          if (retry) clearTimeout(retry);
          if (source) { try { source.close(); } catch { /* ignore */ } }
          setConnected(false);
        };
      }, [sessionId]);

      // Keep the newest item in view.
      React.useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [feed]);

      const submit = React.useCallback(async () => {
        const question = draft.trim();
        if (!question || asking) return;
        setDraft('');
        setAsking(true);
        try {
          // Hand the model the conversation in plain Chinese labels; raw kinds
          // like "digest:" make it answer like a log parser instead of a person.
          const who = { question: '他说的', answer: '你说的', digest: '你之前报的进展', progress: '动态', error: '出错' };
          const context = feedRef.current.slice(-12).map((x) => `${who[x.kind] || ''}${who[x.kind] ? '：' : ''}${x.text}`);
          await fetch(ASK_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, question, context }),
          });
        } catch { /* the answer arrives over SSE */ }
        setAsking(false);
      }, [draft, asking, sessionId]);

      const running = status ? status.running === true : false;
      const elapsed = status ? (running ? Date.now() - (status.startedAt || Date.now()) : status.elapsedMs || 0) : 0;

      // No "turn 44 · step 27". Nobody reads that. Just how long, and what.
      const meta = [];
      if (status) {
        const secs = Math.floor((elapsed || 0) / 1000);
        if (running || secs > 0) {
          meta.push(secs < 60
            ? t('justStarted')
            : (secs < 3600
              ? t('minutes', { n: Math.floor(secs / 60) })
              : t('hours', { n: Math.floor(secs / 3600) })));
        }
        if (status.action) meta.push(status.action);
      }

      return h('div', { className: 'pl-tab' },
        h('div', { className: 'pl-status' },
          h('span', { className: 'pl-dot', 'data-running': String(running) }),
          h('span', null, running ? t('working') : t('idle')),
          running ? null : h('span', { className: 'pl-meta' }, t('waiting')),
          meta.length ? h('span', { className: 'pl-meta' }, meta.join(' · ')) : null,
          status && status.error ? h('span', { className: 'pl-error' }, status.error) : null,
          !connected && sessionId ? h('span', { className: 'pl-meta' }, t('disconnected')) : null,
        ),
        h('div', { className: 'pl-feed', ref: listRef },
          feed.length === 0
            ? h('div', { className: 'pl-empty' }, t('empty'))
            : feed.map((item) => h('div', { key: item.id, className: 'pl-item', 'data-kind': item.kind },
                h('span', { className: 'pl-kind' }, t(item.kind) || item.kind),
                h('span', { className: 'pl-text' }, item.text),
              )),
        ),
        h('form', {
          className: 'pl-ask',
          onSubmit: (e) => { e.preventDefault(); submit(); },
        },
          h('input', {
            value: draft,
            placeholder: t('placeholder'),
            onChange: (e) => setDraft(e.target.value),
            disabled: !sessionId,
          }),
          h('button', { type: 'submit', disabled: asking || !draft.trim() },
            asking ? t('asking') : t('send')),
        ),
      );
    }

    const Icon = (size) => h('svg', {
      width: size || 14,
      height: size || 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
    },
      h('path', {
        d: 'M1.5 11h2.4l1.6-6 2.2 9 2-7.5 1.5 4.5h3.3',
        stroke: 'currentColor',
        strokeWidth: '1.4',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    );

    return {
      // Hard dependencies only: `slots` and `locale` are always present. The
      // sidebar and layout services are optional, so they are awaited per use
      // through ctx.inject instead — a missing one must not block the whole
      // bundle from applying (that would also drop the header trigger).
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const el = document.createElement('style');
          el.setAttribute('data-progress-lens', '');
          el.textContent = CSS;
          document.head.appendChild(el);
          return () => { el.remove(); };
        }, 'progress-lens: styles');

        ctx.effect(() => {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            try { return ctx.locale.register(NS, { zh, en }); } catch { /* dictionary is optional */ }
          }
          return () => {};
        }, 'progress-lens: dictionaries');

        // The tab type itself. dsh-better-sidebar owns the right column, so the
        // body squeezes the conversation, is closable, and is per session.
        //
        // `ctx.inject` waits for the service instead of polling for it: the
        // callback runs once betterSidebar is provided, and its disposer takes
        // the registration back down if the sidebar goes away again.
        ctx.inject(['betterSidebar'], (sidebarCtx) => {
          sidebarCtx.effect(() => {
            const sidebar = sidebarCtx.get('betterSidebar');
            if (!sidebar || typeof sidebar.registerTab !== 'function') return () => {};

            const lookup = (key) => {
              try {
                const bound = sidebarCtx.locale.bind(NS);
                const out = typeof bound === 'function' ? bound(key) : key;
                return out && out !== key ? out : (zh[key] ?? key);
              } catch { return zh[key] ?? key; }
            };

            try {
              return sidebar.registerTab({
                id: TAB_ID,
                title: () => lookup('title'),
                description: () => lookup('meta.description'),
                icon: Icon,
                order: 60,
                single: true,
                component: ProgressBody,
              });
            } catch (error) {
              // One generation may outlive the next registration attempt.
              if (!String(error && error.message).includes('already registered')
                && typeof console !== 'undefined') {
                console.warn('[progress-lens] tab registration failed', error);
              }
              return () => {};
            }
          }, 'progress-lens: sidebar tab');
        });

        // Belt and braces: the sidebar may be provided before or after this
        // bundle applies depending on load order. A short poll covers the case
        // where the ctx.inject callback never fires; the duplicate id is
        // swallowed by the catch above, so the two paths cannot collide.
        ctx.effect(() => {
          let disposed = false;
          let release = null;
          let done = false;
          let timer = null;

          const lookup = (key) => {
            try {
              const bound = ctx.locale.bind(NS);
              const out = typeof bound === 'function' ? bound(key) : key;
              return out && out !== key ? out : (zh[key] ?? key);
            } catch { return zh[key] ?? key; }
          };

          const stop = () => {
            done = true;
            if (timer) { clearInterval(timer); timer = null; }
          };

          const attempt = () => {
            timer = null;
            if (disposed || done) return;
            const sidebar = ctx.get('betterSidebar');
            if (!sidebar || typeof sidebar.registerTab !== 'function') return;
            try {
              release = sidebar.registerTab({
                id: TAB_ID,
                title: () => lookup('title'),
                description: () => lookup('meta.description'),
                icon: Icon,
                order: 60,
                single: true,
                component: ProgressBody,
              });
            } catch (error) {
              // Already registered through the ctx.inject path — stop polling.
              if (String(error && error.message).includes('already registered')) { stop(); return; }
              if (typeof console !== 'undefined') console.warn('[progress-lens] tab registration failed', error);
            }
            if (typeof release === 'function') stop();
          };

          attempt();
          if (!done) timer = setInterval(attempt, 500);
          const giveUp = setTimeout(stop, 30000);

          return () => {
            disposed = true;
            if (timer) clearInterval(timer);
            clearTimeout(giveUp);
            if (typeof release === 'function') release();
            release = null;
          };
        }, 'progress-lens: sidebar tab fallback');

        // A header icon opens the tab on demand: the operator clicks it, the
        // right column expands (squeezing the conversation) and the tab focuses.
        // A second click collapses the column, so the icon is a real toggle and
        // its lit state (data-active) tells open from closed at a glance.
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'progress-lens-open',
          order: 60,
          inject: () => ({}),
        }, (props) => {
          const sessionId = props && (props.sessionId || (props.scope && props.scope.sessionId));

          // The right column's real state lives in the host layout store, which
          // exposes no subscriber to plugins; the sidebarRight face answers it
          // synchronously, so poll that getter and only setState on a change.
          const readOpen = () => {
            try {
              const right = ctx.get('sidebarRight');
              if (right && typeof right.isExpanded === 'function') return right.isExpanded() === true;
            } catch { /* fall through */ }
            return false;
          };
          const [isOpen, setOpen] = React.useState(readOpen);
          React.useEffect(() => {
            setOpen(readOpen());
            const timer = setInterval(() => {
              const next = readOpen();
              setOpen((prev) => (prev === next ? prev : next));
            }, 1000);
            return () => clearInterval(timer);
          }, []);

          const toggle = () => {
            const next = !readOpen();
            try {
              const sidebar = ctx.get('betterSidebar');
              const layout = ctx.get('layout');
              if (next) {
                if (sidebar && typeof sidebar.openTab === 'function' && sessionId) {
                  sidebar.openTab({ type: TAB_ID, title: t_title(ctx) }, { sessionId });
                }
                if (layout && typeof layout.openRightbar === 'function') layout.openRightbar(true, false);
              } else {
                // Collapse through the host's own controller: it flips the
                // column's `expanded` and re-syncs presentation, so the open tab
                // does not immediately re-expand the column the way a bare
                // closeRightbar() would. Falls back to layout when the face or
                // its on-screen surface is missing.
                const right = ctx.get('sidebarRight');
                if (right && typeof right.toggleExpanded === 'function'
                  && typeof right.isExpanded === 'function' && right.isExpanded() === true) {
                  right.toggleExpanded();
                } else if (layout && typeof layout.closeRightbar === 'function') {
                  layout.closeRightbar();
                }
              }
            } catch { /* toggling is best effort */ }
            setOpen(next);
          };

          return h('button', {
            type: 'button',
            className: 'pl-trigger',
            title: t_title(ctx),
            'aria-label': t_title(ctx),
            'aria-expanded': isOpen ? 'true' : 'false',
            'data-active': isOpen ? 'true' : 'false',
            onClick: toggle,
          }, Icon(14));
        })), 'progress-lens: header trigger');
      },
    };

    function t_title(ctx) {
      try {
        const bound = ctx.locale.bind(NS);
        const out = typeof bound === 'function' ? bound('title') : 'progress';
        return out && out !== 'title' ? out : (zh.title || 'progress');
      } catch { return zh.title || 'progress'; }
    }
  },
});
