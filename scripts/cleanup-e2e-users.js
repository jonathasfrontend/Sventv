/**
 * SvenTV API — Limpeza de usuários de teste E2E órfãos.
 *
 * Remove usuários com e-mail prefixado por "e2e_" que ficaram de
 * execuções abortadas do scripts/e2e-playlists-analytics.js (o script
 * normal já apaga o próprio usuário; só o que sobrou de aborts é tratado
 * aqui). FKs com ON DELETE CASCADE removem sessões/eventos/histórico/
 * playlists associadas.
 *
 * Uso: node scripts/cleanup-e2e-users.js [--dry-run]
 */

'use strict';

require('dotenv').config();

const prisma = require('../src/prisma/client');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  const found = await prisma.user.findMany({
    where: { email: { startsWith: 'e2e_' } },
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!found.length) {
    console.log('Nenhum usuário de teste E2E órfão encontrado.');
    return;
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Encontrados ${found.length} usuário(s) órfão(s) de E2E:`);
  for (const u of found) {
    console.log(`  - ${u.email} (${u.id}) criado em ${u.createdAt.toISOString()}`);
  }

  if (DRY_RUN) {
    console.log('Nada removido (--dry-run).');
    return;
  }

  const ids = found.map((u) => u.id);
  const result = await prisma.user.deleteMany({ where: { id: { in: ids } } });
  console.log(`Removidos ${result.count} usuário(s). Playlists/sessões/eventos/histórico removidos por cascade.`);
})()
  .catch((error) => {
    console.error('Falha na limpeza:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });