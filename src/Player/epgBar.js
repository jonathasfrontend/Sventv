/**
 * EpgBarCore — lógica pura da barra "agora / próximo / progresso" do player.
 *
 * Separa o cálculo do DOM para ser testável (node:test) e reutilizado no
 * browser (player.js). Nenhum IO aqui: PROIBIDO buscar rede — os programas
 * vêm embutidos no HTML (`CHANNEL_DATA.epg`), fornecidos server-side.
 *
 * Convenção de tempo: `start`/`stop` são instantes absolutos em ms (epoch).
 * O backend entrega ISO 8601 UTC (ex.: "2026-09-17T12:00:00.000Z") e o
 * `toMs` converte via Date.parse — comparação consistente independente de
 * timezone do servidor/navegador. O fuso do usuário só aparece na formatação.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EpgBarCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toMs(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    }
    return null;
  }

  function cleanText(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  /**
   * Normaliza a lista bruta embutida: valida datas, remove stop <= start,
   * garante título não vazio e ordena por start ASC (depois stop ASC). Não
   * lança — entrada inválida é descartada sem derrubar o player.
   */
  function normalizeProgrammes(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const start = toMs(item.start);
      const stop = toMs(item.stop);
      if (start === null || stop === null) continue;   // data inválida → ignora
      if (!(stop > start)) continue;                   // duração inválida → ignora
      out.push({
        start,
        stop,
        title: cleanText(item.title) || 'Programação',
        subtitle: cleanText(item.subtitle),
        description: cleanText(item.description),
      });
    }
    out.sort((a, b) => (a.start - b.start) || (a.stop - b.stop));
    return out;
  }

  /**
   * Resolve o programa atual (cobre `now`) e o próximo (primeiro que
   * começa em/ou após `now`, diferente do atual). Sem programa atual →
   * gap ("Sem programação no momento"); sem próximo → dados exauridos.
   */
  function computeView(programmes, nowMs) {
    let current = null;
    for (const p of programmes) {
      if (p.start <= nowMs && nowMs < p.stop) {
        current = p;
        break;
      }
    }
    let next = null;
    for (const p of programmes) {
      if (p.start >= nowMs && p !== current) {
        next = p;
        break;
      }
    }
    return { current, next, hasGap: !current, exhausted: !next };
  }

  /**
   * Progresso do programa atual em % (0–100), clampado. Duração zero ou
   * inválida → 100% (regra do player); fora da faixa → clamp.
   */
  function computeProgress(programme, nowMs) {
    if (!programme) return 0;
    const span = programme.stop - programme.start;
    if (!(span > 0)) return 100; // stop <= start ou duração zero → 100%
    const pct = ((nowMs - programme.start) / span) * 100;
    if (!Number.isFinite(pct)) return 100;
    return Math.max(0, Math.min(100, pct));
  }

  return {
    normalizeProgrammes,
    computeView,
    computeProgress,
    toMs,
    cleanText,
  };
});