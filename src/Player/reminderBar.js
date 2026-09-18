/**
 * ReminderBarCore — lógica pura do botão "Avise-me" do player.
 *
 * Separa a construção do payload (e os guardas de exibição) do DOM para ser
 * testável (node:test) e reutilizado no browser (player.js). Nenhum IO aqui.
 *
 * O botão existe apenas sobre o PRÓXIMO programa da barra de EPG (nunca sobre
 * o atual): lembrar de algo que já está no ar não faz sentido. O payload
 * segue o contrato público de criação de lembrete:
 *   { channelId, programTitle, programStart }
 * (programStart pode ser ISO 8601 ou timestamp numérico — o backend aceita
 * ambos; aqui enviamos epoch ms para ser determinístico).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ReminderBarCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000; // alinhado a REMINDERS_MAX_HORIZON_MS

  function toEpochMs(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    }
    return null;
  }

  /**
   * O "Avise-me" só deve ser oferecido para um programa futuro, dentro do
   * horizonte aceito pelo backend (default 24h). Sem programa (ou já no ar,
   * ou além do horizonte) → NÃO sugere.
   */
  function shouldSuggestReminder(programme, nowMs = Date.now(), maxHorizonMs = DEFAULT_HORIZON_MS) {
    if (!programme || typeof programme !== 'object') return false;
    const start = toEpochMs(programme.start);
    if (start === null) return false;
    if (!(start > nowMs)) return false; // já começou (ou começou antes)
    return start - nowMs <= Math.max(60_000, Number(maxHorizonMs) || DEFAULT_HORIZON_MS);
  }

  /**
   * Monta o body do POST /api/user/reminders a partir do programa "próximo".
   * Devolve null quando falta canal/programa ou o início é inválido.
   */
  function buildPayload({ channelId, programme }) {
    if (!channelId || !programme || typeof programme !== 'object') return null;
    const start = toEpochMs(programme.start);
    if (start === null) return null;
    const title = String(programme.title || '').trim().slice(0, 255);
    if (!title) return null;
    return {
      channelId: String(channelId).slice(0, 255),
      programTitle: title,
      programStart: start,
    };
  }

  return {
    toEpochMs,
    shouldSuggestReminder,
    buildPayload,
  };
});