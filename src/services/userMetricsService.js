/**
 * SvenTV API — User Metrics Service
 *
 * Métricas de usuários para o painel administrativo — SEMPRE agregadas,
 * nunca listam usuários individuais (sem e-mail/nome/IP na resposta).
 *
 * Períodos (janelas ROLANTES, não calendário):
 *   week → 7 dias · month → 30 · quarter → 90 · semester → 180
 *
 * Engajamento usa watch_history.lastPlayedAt como proxy de atividade
 * recente (não existe lastLogin como fonte confiável de série). Série
 * diária usa date_trunc no Postgres; buckets sem usuários vêm zerados.
 * Segurança = agregado de audit_logs para os 5 eventos monitorados.
 */

'use strict';

const prisma = require('../prisma/client');
const { DAY_MS, dayUtc, daysBetween } = require('../utils/analytics');

const PERIOD_DAYS = {
  week: 7,
  month: 30,
  quarter: 90,
  semester: 180,
};

const SECURITY_EVENTS = [
  'auth.account_locked',
  'auth.password_reset_attempts_exceeded',
  'admin.user_block',
  'admin.user_unblock',
  'admin.change_user_role',
];

/**
 * Resolve o intervalo [start, end] de um período, seguindo o padrão de
 * resolveRange (utils/analytics): janela rolante (now − N dias) com folga
 * de 1 min à frente para incluir "agora".
 * @param {string|undefined} period
 * @returns {{start: Date, end: Date, days: number} | null}
 */
const resolveUserRange = (period) => {
  const days = PERIOD_DAYS[String(period || '').toLowerCase()];
  if (!days) return null;
  const now = new Date();
  const end = new Date(now.getTime() + 60_000);
  const start = new Date(now.getTime() - days * DAY_MS);
  return { start, end, days };
};

/** Data → 'YYYY-MM-DD' (UTC). Retorna null em datas inválidas. */
const isoDay = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

/**
 * Crescimento: usuários criados na janela atual vs janela anterior de mesma
 * duração. previous = 0 → growthPct = 'novo' (nunca Infinity/NaN).
 */
async function getUserGrowth(range) {
  const span = range.end.getTime() - range.start.getTime();
  const prevStart = new Date(range.start.getTime() - span);
  const [current, previous] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: range.start, lte: range.end } } }),
    prisma.user.count({ where: { createdAt: { gte: prevStart, lt: range.start } } }),
  ]);

  let growthPct;
  if (previous === 0) growthPct = 'novo';
  else growthPct = Math.round(((current - previous) / previous) * 1000) / 10;

  return { current, previous, growthPct };
}

/**
 * Série diária de novos usuários (date_trunc no Postgres). Dias sem
 * registros entram com count 0 — a série vem completa e ordenada.
 */
async function getUserGrowthSeries(range) {
  const rows = await prisma.$queryRaw`
    SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*)::int AS count
    FROM users
    WHERE created_at >= ${range.start} AND created_at <= ${range.end}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  const byDay = new Map();
  for (const row of rows) {
    const key = isoDay(row.day);
    if (key) byDay.set(key, Number(row.count) || 0);
  }

  return daysBetween(dayUtc(range.start), dayUtc(range.end)).map((d) => ({
    date: isoDay(d),
    count: byDay.get(isoDay(d)) || 0,
  }));
}

/** Snapshot atual (sem período): total, ativos, bloqueados, admins e users. */
async function getStatusBreakdown() {
  const [all, active, blocked, admins, users] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'active' } }),
    prisma.user.count({ where: { accountRestricted: true } }),
    prisma.user.count({ where: { role: 'admin' } }),
    prisma.user.count({ where: { role: 'user' } }),
  ]);

  return { all, active, blocked, admins, users };
}

/**
 * Engajamento no período: DISTINCT usuários com lastPlayedAt na janela
 * (proxy de atividade real — não existe lastLogin confiável) + taxa de
 * ativação sobre os criados no período (0 quando não houver base).
 */
async function getEngagementSnapshot(range) {
  const [activeRows, createdInPeriod] = await Promise.all([
    prisma.watchHistory.findMany({
      where: { lastPlayedAt: { gte: range.start, lte: range.end } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    prisma.user.count({ where: { createdAt: { gte: range.start, lte: range.end } } }),
  ]);

  const activeInPeriod = activeRows.length;
  const activationRate =
    createdInPeriod === 0 ? 0 : Math.round((activeInPeriod / createdInPeriod) * 1000) / 10;

  return { activeInPeriod, createdInPeriod, activationRate };
}

/**
 * Contagem de eventos de segurança (audit_logs agregado), normalizada para
 * os 5 eventos monitorados — eventos sem ocorrência entram com count 0.
 */
async function getSecurityEventCounts(range) {
  const rows = await prisma.auditLog.groupBy({
    by: ['action'],
    where: {
      action: { in: SECURITY_EVENTS },
      createdAt: { gte: range.start, lte: range.end },
    },
    _count: { _all: true },
  });

  const counts = new Map(rows.map((r) => [r.action, r._count._all || 0]));
  return SECURITY_EVENTS.map((action) => ({ action, count: counts.get(action) || 0 }));
}

/**
 * Aceite de termos (snapshot): distribuição por termsVersion + total com e
 * sem versão registrada. Apenas versão/count — nada pessoal.
 */
async function getTermsAcceptanceBreakdown() {
  const [rows, withTerms, withoutTerms] = await Promise.all([
    prisma.user.groupBy({
      by: ['termsVersion'],
      where: { termsVersion: { not: null } },
      _count: { termsVersion: true },
    }),
    prisma.user.count({ where: { termsVersion: { not: null } } }),
    prisma.user.count({ where: { termsVersion: null } }),
  ]);

  const breakdown = rows
    .map((r) => ({ version: r.termsVersion, count: r._count.termsVersion }))
    .sort((a, b) => b.count - a.count);

  return { withTerms, withoutTerms, breakdown };
}

/**
 * Orquestra todas as métricas para um período.
 * @param {string} period week|month|quarter|semester
 * @returns {Promise<object|null>} null quando o período é inválido.
 */
async function getOverview(period) {
  const range = resolveUserRange(period);
  if (!range) return null;

  const [growth, series, totals, engagement, security, terms] = await Promise.all([
    getUserGrowth(range),
    getUserGrowthSeries(range),
    getStatusBreakdown(),
    getEngagementSnapshot(range),
    getSecurityEventCounts(range),
    getTermsAcceptanceBreakdown(),
  ]);

  return {
    period: String(period).toLowerCase(),
    range: {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      days: range.days,
    },
    totals,
    growth,
    series,
    engagement,
    security,
    terms,
  };
}

module.exports = {
  PERIOD_DAYS,
  SECURITY_EVENTS,
  resolveUserRange,
  isoDay,
  getUserGrowth,
  getUserGrowthSeries,
  getStatusBreakdown,
  getEngagementSnapshot,
  getSecurityEventCounts,
  getTermsAcceptanceBreakdown,
  getOverview,
};