/* public/js/reminder-notifier.js — Dispatcher "Avise-me" (Notification do navegador).
 *
 * Carregado nas páginas autenticadas que participam dos lembretes (player e
 * /guia). POLÍTICA desta janela: ao contrário do helper Realtime (que pausa
 * em aba oculta), o dispatcher NÃO pausa quando a aba está em segundo plano
 * — o propósito é justamente notificar o usuário mesmo quando ele está em
 * OUTRA aba do navegador. A limitação de background throttling (Chrome
 * clampa timers ~1/min em abas ocultas por >5min) é mitigada por três
 * mecanismos:
 *   1) janela de vencimento (vencido → venceu): notifica entre `leadMs`
 *      antes e `trailMs` depois do início (padrão 60s / 15min);
 *   2) `trail` na listagem do servidor (GET /api/user/reminders?trail=) —
 *      um lembrete recém-começado continua aparecendo para a janela;
 *   3) catch-up imediato ao voltar a aba (visibilitychange/focus).
 *
 * Cross-aba: duas páginas (ex.: guia + iframe do player) conseguem disparar
 * a MESMA notificação. A deduplicação é dupla:
 *   - lease em localStorage por `id` (chave `sventv:rem:notify:<id>` com
 *     TTL curto) — quem pega o lease dispara;
 *   - two-phase server-side: POST /:id/notified marca `notifiedAt` e o
 *     próximo list já vem sem o lembrete (ciclo fechado por quem marcou 1º).
 *
 * Fail-open: sem suporte/permissão de Notification → no-op silencioso (nem
 * busca); fetch/erro → tenta no próximo tick; storage indisponível →
 * sem lease (o two-phase do servidor segue sendo a única barreira).
 *
 * UMD (espelha epgBar/reminderBar): em Node devolve o core puro (testável);
 * no navegador expõe global ReminderNotifier com start/stop/isRunning.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ReminderNotifier = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    intervalMs: 30 * 1000,        // poll do dispatcher
    limit: 50,
    leadMs: 60 * 1000,            // notifica até 60s ANTES do início
    trailMs: 15 * 60 * 1000,      // até 15min DEPOIS (recupera aba throttled/reaberta)
    icon: '/img/favicon.png',
    tagPrefix: 'sventv-reminder-',
    leasePrefix: 'sventv:rem:notify:',
  };

  function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  function toMs(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }

  // ── Core puro (testável sem DOM/rede) ─────────────────────────

  /**
   * Lembrete deve ser notificado AGORA (dentro de [now-trail, now+lead])?
   * `notifiedAt` preenchido (two-phase já fechado) → nunca re-notifica.
   */
  function isDueReminder(reminder, nowMs, leadMs, trailMs) {
    if (!reminder || typeof reminder !== 'object') return false;
    if (reminder.notifiedAt) return false;
    const start = toMs(reminder.startsAt);
    if (start === null) return false;
    const lead = Math.max(0, Number(leadMs) || DEFAULTS.leadMs);
    const trail = Math.max(0, Number(trailMs) || DEFAULTS.trailMs);
    if (start > nowMs + lead) return false;   // ainda longe (pré-aviso não chegou)
    if (start < nowMs - trail) return false;  // janela de recuperação vencida
    return true;
  }

  /**
   * Monta o que `new Notification(title, options)` precisa. O título é o do
   * programa (TEXTO externo do EPG) — passado à Notification API como string
   * simples, nunca HTML. Truncado para não estourar a linha de descrição.
   */
  function buildNotificationPayload(reminder, icon, tagPrefix) {
    const titleRaw = String((reminder && reminder.title) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const fallback = 'Programação está para começar';
    const title = titleRaw ? `${titleRaw} está para começar` : fallback;
    const options = {
      body: 'Está começando agora no SvenTV.',
      tag: (tagPrefix || DEFAULTS.tagPrefix) + String((reminder && reminder.id) || ''),
      icon: icon || DEFAULTS.icon,
    };
    return { title, options, id: String((reminder && reminder.id) || ''), startMs: toMs(reminder && reminder.startsAt) };
  }

  function makeLeaseKey(reminderId, prefix) {
    return (prefix || DEFAULTS.leasePrefix) + String(reminderId);
  }

  // ── Navegador (start/stop) — no-op em Node ───────────────────
  let state = null;

  function storage() {
    try {
      return window && window.localStorage ? window.localStorage : null;
    } catch (_) {
      return null;
    }
  }

  function acquireLease(key, ttlMs) {
    const s = storage();
    const now = Date.now();
    if (!s) return true;
    try {
      const raw = s.getItem(key);
      if (raw) {
        const until = Number(raw);
        if (Number.isFinite(until) && until > now) return false;
      }
      s.setItem(key, String(now + Math.max(0, Number(ttlMs) || 0)));
      return true;
    } catch (_) {
      return true; // storage indisponível → two-phase do servidor decide
    }
  }

  function releaseLease(key) {
    const s = storage();
    if (!s) return;
    try { s.removeItem(key); } catch (_) { /* best-effort */ }
  }

  function requestHeaders(cfg) {
    try {
      const h = typeof cfg.headers === 'function' ? (cfg.headers() || {}) : (cfg.headers || {});
      return Object.assign({}, h);
    } catch (_) {
      return {};
    }
  }

  async function fireNotification(cfg, reminder) {
    const key = makeLeaseKey(reminder.id, cfg.leasePrefix);
    // Lease: evita DUAS abas disparando a mesma notificação quase ao mesmo
    // tempo. TTL curto (50s+1 tick) — em falha de rede o retry chega logo.
    if (!acquireLease(key, 50 * 1000)) return;

    try {
      const payload = buildNotificationPayload(reminder, cfg.icon, cfg.tagPrefix);
      // Aba oculta e `new Notification` são compatíveis: a notificação
      // aparece no centro de notificações do SO/aparelho o usuário esteja
      // em outra aba. `tag` deduplica por lembretes dentro da origem.
      const n = new Notification(payload.title, payload.options);
      n.onclick = () => {
        window.focus();
        if (cfg.clickUrl) window.location.href = cfg.clickUrl;
      };
    } catch (_) {
      releaseLease(key);
      return;
    }

    // Two-phase: confirma o disparo para o servidor fechar o ciclo e o
    // próximo list não re-notificar (nem o cron de e-mail disputar).
    try {
      const res = await fetch(
        '/api/user/reminders/' + encodeURIComponent(reminder.id) + '/notified',
        { method: 'POST', headers: requestHeaders(cfg), credentials: cfg.credentials || 'include' }
      );
      // Sucesso OU autenticação falhou: libera o lease (nada mais a fazer
      // agora). 401 → a próxima página/tab com sessão retoma.
      releaseLease(key);
      if (res.status === 401 || res.status === 403) cfg.authorized = false;
    } catch (_) {
      // Rede falhou: permite retry no próximo tick (release = re-tentar).
      releaseLease(key);
    }
  }

  async function tick() {
    const cfg = state;
    if (!cfg || cfg.running || cfg.authorized === false) return;
    // Sem permissão/suporte → nem busca (economiza rede e quiet).
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    cfg.running = true;
    try {
      const url = '/api/user/reminders?upcoming=1&limit=' + String(cfg.limit) +
        '&trail=' + String(Math.round(cfg.trailMs));
      const res = await fetch(url, { headers: requestHeaders(cfg), credentials: cfg.credentials || 'include' });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) cfg.authorized = false;
        return;
      }
      cfg.authorized = true;
      const json = await res.json();
      const list = (json && Array.isArray(json.data)) ? json.data : [];
      const now = Date.now();
      for (const reminder of list) {
        if (!isDueReminder(reminder, now, cfg.leadMs, cfg.trailMs)) continue;
        await fireNotification(cfg, reminder);
      }
    } catch (_) {
      /* fail-open: tenta no próximo tick */
    } finally {
      cfg.running = false;
    }
  }

  function triggerTick() {
    tick().catch(() => {});
  }

  /**
   * Inicia o dispatcher. Devolve { stop } — mas há UM dispatcher por página;
   * start() substitui o anterior (singleton), então ReminderNotifier.stop()
   * também encerra.
   */
  function start(opts) {
    stop();
    const o = opts || {};
    state = {
      intervalMs: clampNum(o.intervalMs, 5000, 600000, DEFAULTS.intervalMs),
      limit: Math.round(clampNum(o.limit, 10, 200, DEFAULTS.limit)),
      leadMs: clampNum(o.leadMs, 0, 3600000, DEFAULTS.leadMs),
      trailMs: clampNum(o.trailMs, 0, 30 * 60 * 1000, DEFAULTS.trailMs),
      icon: o.icon || DEFAULTS.icon,
      tagPrefix: o.tagPrefix || DEFAULTS.tagPrefix,
      leasePrefix: o.leasePrefix || DEFAULTS.leasePrefix,
      headers: o.headers || null,
      credentials: o.credentials || 'include',
      clickUrl: o.clickUrl || '',
      authorized: true,
      running: false,
      timer: null,
      cleanup: null,
    };

    const onVisible = () => { if (!document.hidden) triggerTick(); };
    const onFocus = () => triggerTick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    state.timer = setInterval(triggerTick, state.intervalMs);
    state.cleanup = () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };

    // Primeira verificação imediata (não espera o intervalo).
    triggerTick();
    return { stop };
  }

  function stop() {
    if (!state) return;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (typeof state.cleanup === 'function') state.cleanup();
    state = null;
  }

  function isRunning() {
    return Boolean(state);
  }

  const api = {
    DEFAULTS,
    isDueReminder,
    buildNotificationPayload,
    makeLeaseKey,
  };
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    api.start = start;
    api.stop = stop;
    api.isRunning = isRunning;
  }
  return api;
});