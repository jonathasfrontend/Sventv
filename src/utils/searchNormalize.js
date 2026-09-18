/**
 * SvenTV API — Normalização de busca combinada (canais + EPG)
 *
 * Semântica consistente entre o endpoint server-side (GET /api/epg/search)
 * e o filtro client-side do grid (public/js/guide-search.js, que espelha
 * estas funções). Regras:
 *   - texto: lowercase + remoção de acentos + colapsa espaços/símbolos;
 *   - horário no estilo "20h", "20h30" ou "20:30" vira um token de tempo que
 *     NÃO participa da comparação de texto — filtra programações por hora;
 *     "20h" casa QUALQUER minuto da hora; "20h30"/"20:30" casa o minuto exato;
 *   - a comparação de horário acontece no fuso Local do cliente; no servidor
 *     é feito via tzOffsetMinutes (que o cliente envia como `tz`) e sempre
 *     testável com tz=0 (determinístico).
 */

'use strict';

/** Normaliza texto para comparação: minúsculas, sem acentos, sem símbolos. */
function normalizeForSearch(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TIME_TOKEN_RE =
  /(?:^|\s+)(\d{1,2})h(?::?(\d{2}))?(?=\s|$)|(?:^|\s+)(\d{1,2}):(\d{2})(?=\s|$)/;

/**
 * Extrai o token de horário da query.
 * @param {string} query
 * @returns {{time: {h: number, m: number, exact: boolean}|null, text: string}}
 *   `exact=false` (ex.: "20h") → casa qualquer minuto da hora;
 *   `exact=true`  (ex.: "20:30" ou "20h30") → casa o minuto exato.
 *   `text` é a query SEM o token de horário, normalizada.
 */
function splitTimeToken(query) {
  const raw = String(query || '');
  const match = raw.match(TIME_TOKEN_RE);
  if (!match) return { time: null, text: normalizeForSearch(raw) };

  // "20h"/"20h30" usa o grupo 1/2; "20:30" usa o 3/4. O grupo que não casou é
  // undefined — parseInt(undefined) → NaN e Math.max(…, 0) vira NaN. Parse pelo
  // grupo que casou (identificado por match[1]).
  const hour = match[1] !== undefined ? parseInt(match[1], 10) : parseInt(match[3], 10);
  const minuteMatch = match[2] !== undefined ? match[2] : match[4];
  const minute = minuteMatch ? parseInt(minuteMatch, 10) : 0;
  if (hour > 23 || minute > 59) return { time: null, text: normalizeForSearch(raw) };

  return {
    time: { h: hour, m: minute, exact: match[2] !== undefined || match[4] !== undefined },
    text: normalizeForSearch(raw.replace(match[0], ' ')),
  };
}

/** Minutos dentro do dia (0-1439) de um instante ms, em um fuso dado por offset. */
function minuteOfDay(ms, tzOffsetMinutes = 0) {
  const local = Number(ms) + (Number(tzOffsetMinutes) || 0) * 60000;
  const d = new Date(local);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Um programa (com start em ms) casa o token de horário no fuso dado? */
function matchesTimeToken(progStartMs, time, tzOffsetMinutes = 0) {
  if (!time) return true;
  const minutes = minuteOfDay(progStartMs, tzOffsetMinutes);
  const target = time.h * 60;
  if (time.exact) return minutes === target + time.m;
  return minutes >= target && minutes < target + 60;
}

module.exports = {
  normalizeForSearch,
  splitTimeToken,
  minuteOfDay,
  matchesTimeToken,
};