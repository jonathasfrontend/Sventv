/**
 * SvenTV API — Utilitários de Analytics
 *
 * Helpers compartilhados pelos serviços de analytics: parsing de
 * períodos, janelas de datas (UTC), serialização de BigInt (Prisma usa
 * BIGINT para watch time — JSON não serializa BigInt nativamente) e
 * cálculo de pico de concorrência (varredura de intervalos).
 */

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Converte BigInt de Prisma para Number (seguro dentro de MAX_SAFE_INTEGER). */
const bigToNumber = (v) => {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v) || 0;
  return 0;
};

/** Converte ms totais em "8h 42min" (rótulo amigável). */
const formatWatchDuration = (ms) => {
  const totalMin = Math.max(0, Math.round(bigToNumber(ms) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
};

/** Data no início do dia UTC. */
const dayUtc = (d = new Date()) => {
  const dt = new Date(d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
};

/** Converte uma data numérica (epoch ms) em Date OU retorna string parsável. */
const toDate = (v) => {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    const parsed = new Date(String(v));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return new Date(n);
};

/**
 * Resolve o intervalo [start, end] para um período.
 * Períodos suportados: today | 7d | 30d | 90d | custom (requer from/to).
 * @param {{period?: string, from?: string, to?: string}} q
 * @returns {{start: Date, end: Date} | null}
 */
const resolveRange = (q = {}) => {
  const now = new Date();
  const end = new Date(now.getTime() + 60_000); // folga: inclui "agora"
  const period = String(q.period || 'today').toLowerCase();

  if (period === 'custom') {
    const from = toDate(q.from);
    const to = toDate(q.to);
    if (!from || !to) return null;
    return { start: from, end: to };
  }

  let days = 0;
  if (period === '7d') days = 7;
  else if (period === '30d') days = 30;
  else if (period === '90d') days = 90;
  else if (period !== 'today') return null;

  const start = new Date(now.getTime() - days * DAY_MS);
  if (period === 'today') start.setUTCHours(0, 0, 0, 0);
  return { start, end };
};

/** Lista dos dias (início UTC) dentro do intervalo [start, end]. */
const daysBetween = (start, end) => {
  const days = [];
  let cursor = dayUtc(start);
  const last = dayUtc(end);
  while (cursor.getTime() <= last.getTime()) {
    days.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return days;
};

/**
 * Pico de intervalos sobrepostos (streams simultâneos).
 * Recebe [{ start: Date, end: Date }] e faz varredura O(n log n).
 * @param {{start: Date, end: Date}[]} intervals
 */
const sweepPeak = (intervals) => {
  if (!Array.isArray(intervals) || intervals.length === 0) return 0;
  const events = [];
  for (const it of intervals) {
    const s = new Date(it.start).getTime();
    const e = it.end ? new Date(it.end).getTime() : s + 1;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) continue;
    events.push([s, 1], [e, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let peak = 0;
  let current = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
};

/** Agrupa sessões [start,end] por dia (para pico diário aproximado por hora). */
const hourBucketMax = (sessions) => {
  const byDay = new Map();
  for (const [ts] of sessions) {
    const d = dayUtc(new Date(ts)).toISOString();
    if (!byDay.has(d)) byDay.set(d, new Map());
    const hourKey = new Date(Math.floor(new Date(ts).getTime() / HOUR_MS) * HOUR_MS).toISOString();
    const bucket = byDay.get(d);
    bucket.set(hourKey, (bucket.get(hourKey) || 0) + 1);
  }
  const out = {};
  for (const [day, buckets] of byDay) {
    out[day] = Math.max(0, ...buckets.values());
  }
  return out;
};

module.exports = {
  DAY_MS,
  HOUR_MS,
  bigToNumber,
  formatWatchDuration,
  dayUtc,
  toDate,
  resolveRange,
  daysBetween,
  sweepPeak,
  hourBucketMax,
};