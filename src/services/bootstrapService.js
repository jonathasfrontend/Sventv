'use strict';

const prisma = require('../prisma/client');
const logger = require('../utils/logger');

const ROLE_SEED = [
  { code: 'user', name: 'Usuario', description: 'Acesso padrao da plataforma' },
  { code: 'admin', name: 'Administrador', description: 'Acesso administrativo' },
];

const isSaasSchemaReady = async () => {
  const [row] = await prisma.$queryRaw`
    SELECT
      to_regclass('public.roles')::text AS roles_table,
      to_regclass('public.user_roles')::text AS user_roles_table
  `;

  return Boolean(row?.roles_table && row?.user_roles_table);
};

const bootstrapSaasData = async () => {
  if (!prisma.role) {
    logger.warn('Prisma Client ainda sem modelos SaaS. Rode: npm run prisma:generate');
    return;
  }

  const schemaReady = await isSaasSchemaReady();
  if (!schemaReady) {
    logger.warn('Schema SaaS ainda nao migrado. Rode: npx prisma migrate deploy');
    return;
  }

  for (const role of ROLE_SEED) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: role,
      create: role,
    });
  }

  await prisma.$executeRaw`
    INSERT INTO "user_roles" ("user_id", "role_id")
    SELECT u."id", r."id"
    FROM "users" u
    JOIN "roles" r ON r."code" = u."role"
    ON CONFLICT ("user_id", "role_id") DO NOTHING
  `;

  await prisma.$executeRaw`
    UPDATE "users" u
    SET "role_id" = r."id"
    FROM "roles" r
    WHERE r."code" = u."role"
      AND (u."role_id" IS NULL OR u."role_id" <> r."id")
  `;

  await prisma.$executeRaw`
    UPDATE "users" u
    SET "plan_id" = p."id"
    FROM "plans" p
    WHERE p."code" = u."plan"
      AND (u."plan_id" IS NULL OR u."plan_id" <> p."id")
  `;
};

module.exports = {
  bootstrapSaasData,
};
