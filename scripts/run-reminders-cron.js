/**
 * SvenTV API — dispara o cron de e-mail do "Avise-me" em localhost.
 *
 * O Vercel Cron não roda em dev: o envio acontece apenas quando alguém chama
 * POST /api/internal/reminders/run (a cada 5 min na Vercel). Este script faz
 * essa chamada contra o servidor LOCAL — para testar o envio basta:
 *
 *   1) npm run dev (com CRON_SECRET + SMTP no .env)
 *   2) ativar um "Avise-me" para um programa que começa em <5 min
 *   3) npm run reminders:run
 *
 * Segurança: a base é fixa em loopback (127.0.0.1) — impossível disparar
 * contra produção/acesso externo por engano.
 */

'use strict';

require('dotenv').config();

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;

async function main() {
  const secret = String(process.env.CRON_SECRET || '');
  if (!secret || secret.length < 16) {
    console.error('CRON_SECRET ausente ou curto (<16) no .env — rota interna fica fail-closed (404).');
    process.exit(3);
  }

  console.log(`=> POST ${BASE}/api/internal/reminders/run`);
  let res;
  try {
    res = await fetch(`${BASE}/api/internal/reminders/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
    });
  } catch (err) {
    // Timeout/ECONNREFUSED etc — o servidor local está no ar?
    console.error(`Falha de rede contra ${BASE}: ${err && err.message}`);
    console.error('Dica: rode `npm run dev` antes e confira /api/health.');
    process.exit(1);
  }

  const json = await res.json().catch(() => null);
  console.log(`HTTP ${res.status}`);
  if (json) console.log(JSON.stringify(json, null, 2));
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`Falha: ${err && err.message}`);
  process.exit(1);
});