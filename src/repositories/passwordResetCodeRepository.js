/**
 * SvenTV API — Repositório de códigos de recuperação de senha
 *
 * Responsabilidades:
 *  - persistir apenas o SHA-256 do código (nunca o código puro);
 *  - uso único: `consumeAndSetPassword` consome o código E atualiza a senha
 *    do usuário numa ÚNICA instrução SQL atômica (CTE com data-modifying,
 *    sem transação explícita — compatível com o PgBouncer em modo transaction,
 *    usado no Supabase serverless). Os guards `used_at IS NULL`,
 *    `attempts < maxAttempts` e `expires_at > now` estão no WHERE do consumo:
 *    duas redefinições simultâneas com o mesmo código — apenas a primeira vê
 *    a linha bloqueada/válida e consegue consumir (a segunda reavalia após o
 *    lock e retorna 0). Isso elimina a corrida "A valida, B valida, A altera,
 *    B altera de novo" sem comparar contagens depois.
 *  - contador de tentativas com incremento condicional
 *    (`attempts < maxAttempts` na cláusula WHERE): impossível ultrapassar o
 *    teto por concorrência.
 */

'use strict';

const prisma = require('../prisma/client');

const passwordResetCodeRepository = {
  /**
   * Cria um código (já com o codeHash). NUNCA recebe o código puro.
   */
  async create({ userId, codeHash, expiresAt }) {
    return prisma.passwordResetCode.create({
      data: { userId, codeHash, expiresAt },
    });
  },

  /**
   * Apaga códigos NÃO utilizados do usuário. Chamado ao gerar um novo
   * código — assim somente o código mais recente permanece válido
   * (invalidação de pedidos anteriores).
   */
  async deleteUnusedForUser(userId) {
    return prisma.passwordResetCode.deleteMany({
      where: { userId, usedAt: null },
    });
  },

  /**
   * Código mais recente ainda não consumido de um usuário.
   */
  async findActiveForUser(userId) {
    return prisma.passwordResetCode.findFirst({
      where: { userId, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Incremento atômico e condicional do contador de tentativas.
   * Só incrementa enquanto `attempts < maxAttempts` e código não usado.
   * Retorna `null` quando o teto já foi atingido (não incrementa).
   */
  async incrementAttemptIfAllowed({ codeId, maxAttempts }) {
    const r = await prisma.passwordResetCode.updateMany({
      where: { id: codeId, usedAt: null, attempts: { lt: maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (r.count === 0) return null;

    return prisma.passwordResetCode.findUnique({ where: { id: codeId } });
  },

  /**
   * Invalida um código (marca como usado sem consumir a senha).
   * Usado quando o teto de tentativas é atingido.
   */
  async invalidate(codeId) {
    return prisma.passwordResetCode.updateMany({
      where: { id: codeId, usedAt: null },
      data: { usedAt: new Date() },
    });
  },

  /**
   * Consumo atômico: revalida na própria instrução que a senha só muda se o
   * código estiver não consumido, dentro do teto de tentativas e não expirado.
   * Uma única instrução SQL (CTE data-modifying) impede a corrida em que duas
   * redefinições com o mesmo código validariam e ambas redefiniriam a senha —
   * o `session_version` só é incrementado junto com a mudança de senha.
   *
   * Sem transação interativa ($transaction async) de propósito: em ambientes
   * serverless com o Supabase transaction pooler (:6543) o modo de transação
   * não suporta "interactive transactions in multi-statement", portanto a
   * atomicidade é garantida por uma única instrução.
   *
   * @param {{ codeId: string, userId: string, passwordHash: string, maxAttempts?: number }} params
   * @returns {Promise<{ consumed: number, user: object|null }>}
   *   consumed 1 = sucesso; 0 = código já consumido/alheio/expirado/teto
   *   atingido (incluindo concorrência).
   */
  async consumeAndSetPassword({ codeId, userId, passwordHash, maxAttempts = 5 }) {
    const attemptLimit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 5;

    const affected = await prisma.$executeRaw`
      WITH consumed AS (
        UPDATE "password_reset_codes"
        SET "used_at" = NOW()
        WHERE "id" = ${codeId}::uuid
          AND "user_id" = ${userId}::uuid
          AND "used_at" IS NULL
          AND "attempts" < ${attemptLimit}
          AND "expires_at" > NOW()
        RETURNING "user_id"
      )
      UPDATE "users"
      SET "password" = ${passwordHash},
          "session_version" = "users"."session_version" + 1,
          "updated_at" = NOW()
      WHERE "id" IN (SELECT "user_id" FROM consumed)
    `;

    if (Number(affected) !== 1) {
      return { consumed: 0, user: null };
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, sessionVersion: true },
    });

    return { consumed: 1, user };
  },
};

module.exports = passwordResetCodeRepository;