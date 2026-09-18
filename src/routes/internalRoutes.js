/**
 * SvenTV API — Rotas internas (Vercel Cron / jobs agendados)
 *
 * Acessíveis APENAS com o segredo compartilhado (CRON_SECRET). Na Vercel, o
 * cron envia `Authorization: Bearer ${CRON_SECRET}` por padrão; aqui também
 * aceitamos `X-Cron-Secret` (flexível para outros agendadores/curl).
 *
 * Defesas:
 *  - comparação em TEMPO CONSTANTE via timingSafeEqual sobre SHA-256 de ambos
 *    os lados (o hash fixa o tamanho — sem vazamento de comprimento do segredo);
 *  - segredo ausente/curto (< 16 chars) → rotas DESLIGADAS com 404 genérico
 *    (fail-closed: nunca deixa um segredo de teste ser considerado válido);
 *  - nenhuma resposta/log contém o segredo nem detalhes do endpoint interno;
 *  - o contatore de uso (request_usage) por usuário seria poluído por um cron
 *    com IP fixo da Vercel — por isso as rotas aqui passam PELO rate limiter
 *    global, mas o corpo nunca consome cota de API do usuário (não há usuário).
 */

'use strict';

const crypto = require('crypto');
const { Router } = require('express');

const config = require('../config/app');
const { runRetention } = require('../services/retentionService');
const reminderService = require('../services/reminderService');
const logger = require('../utils/logger');

const router = Router();

/**
 * Middleware de validação do segredo interno (cron).
 */
function requireCronSecret(req, res, next) {
  const expected = String(config.cron.secret || '');
  // Fail-closed: sem segredo real configurado, rota não existe.
  if (!expected || expected.length < 16) {
    return res.status(404).json({ success: false, message: 'Rota não encontrada.' });
  }

  let provided = String(req.get('X-Cron-Secret') || '');
  if (!provided) {
    const auth = String(req.get('Authorization') || '');
    if (auth.startsWith('Bearer ')) provided = auth.slice(7).trim();
  }
  if (!provided) {
    return res.status(401).json({ success: false, message: 'Não autorizado.' });
  }

  // Hash dos dois lados fixa o tamanho: timingSafeEqual não vaza comprimento.
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: 'Não autorizado.' });
  }
  next();
}

// ── Jobs ────────────────────────────────────────────────────

// Retenção de dados operacionais: request_usage + audit_logs expirados.
router.post('/retention/run', requireCronSecret, async (req, res) => {
  try {
    const result = await runRetention();
    logger.info('Cron retention executado', result);
    res.status(200).json({ success: true, message: 'Retenção executada.', data: result });
  } catch (error) {
    // Genérico — nunca expõe stack/host/segredo ao chamador do cron.
    logger.error(`Cron retention FALHOU: ${error && error.message}`);
    res.status(500).json({ success: false, message: 'Falha ao executar retenção.' });
  }
});

// Lembretes "Avise-me": envia e-mails transacionais para programas com
// início na próxima janela (SMTP). Segredo ausente/short → 404 (fail-closed);
// falha de SMTP/banco NUNCA expõe detalhe ao chamador. Chamado como MÉTODO do
// serviço (runDueReminders usa `this`) — desestruturar quebraria o binding.
router.post('/reminders/run', requireCronSecret, async (req, res) => {
  try {
    const result = await reminderService.runDueReminders();
    logger.info('[reminderService] cron lembretes executado', result);
    res.status(200).json({ success: true, message: 'Lembretes processados.', data: result });
  } catch (error) {
    // Genérico — nunca expõe stack/host/segredo ao chamador do cron.
    logger.error(`Cron lembretes FALHOU: ${error && error.message}`);
    res.status(500).json({ success: false, message: 'Falha ao processar lembretes.' });
  }
});

module.exports = router;
module.exports.requireCronSecret = requireCronSecret;