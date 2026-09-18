'use strict';

/**
 * Rotas internas (Vercel Cron) — POST /api/internal/retention/run e
 * POST /api/internal/reminders/run:
 *  - segredo ausente/curto → rotas desligadas (404 genérico, fail-closed);
 *  - segredo errado          → 401 (e NENHUM efeito colateral — job não roda);
 *  - segredo correto         → 200 com as contagens;
 *  - aceita X-Cron-Secret OU Authorization: Bearer (padrão do cron da Vercel);
 *  - o segredo nunca aparece na resposta/logs;
 *  - falha de banco → 500 genérico (sem stack/segredo).
 *
 * Conduzido por um app Express mínimo com o router interno montado em
 * /api/internal (o mesmo wiring de src/routes/index.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const config = require('../src/config/app');
const prisma = require('../src/prisma/client');
const internalRoutes = require('../src/routes/internalRoutes');

const SECRET = 'svento-cron-secret-teste-2026';

function buildApp() {
  const app = express();
  app.use('/api/internal', internalRoutes);
  return app;
}

function request(server, { method = 'POST', path, headers = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const server = buildApp().listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  try {
    await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const withCronConfig = (secret, fn) => {
  const saved = config.cron.secret;
  config.cron.secret = secret;
  return Promise.resolve()
    .then(fn)
    .finally(() => { config.cron.secret = saved; });
};

const withPrismaRetention = (mocks, fn) => {
  const saved = {
    'requestUsage.deleteMany': prisma.requestUsage.deleteMany,
    'auditLog.deleteMany': prisma.auditLog.deleteMany,
  };
  const set = (path, val) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  };
  for (const [path, mock] of Object.entries(mocks || {})) set(path, mock);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [path, orig] of Object.entries(saved)) set(path, orig);
    });
};

test('cron: sem segredo configurado as rotas internas são 404 (fail-closed)', async () => {
  await withCronConfig('', async () => {
    await withServer(async (server) => {
      const res = await request(server, { path: '/api/internal/retention/run', headers: { 'X-Cron-Secret': 'qualquer-coisa' } });
      assert.equal(res.status, 404);
      assert.ok(!res.body.includes('qualquer-coisa'), 'não ecoa o valor enviado');
      assert.ok(!res.body.includes('retention'), 'não revela a rota');
    });
  });
});

test('cron: segredo correto (X-Cron-Secret) executa a retenção e devolve contagens', async () => {
  await withCronConfig(SECRET, async () => {
    await withPrismaRetention(
      {
        'requestUsage.deleteMany': async () => ({ count: 11 }),
        'auditLog.deleteMany': async () => ({ count: 4 }),
      },
      async () => {
        await withServer(async (server) => {
          const res = await request(server, {
            path: '/api/internal/retention/run',
            headers: { 'X-Cron-Secret': SECRET },
          });
          assert.equal(res.status, 200);
          assert.ok(res.body.includes('requestUsageDeleted'), 'contém contagem de usage');
          assert.ok(res.body.includes('\"requestUsageDeleted\":11'), 'contagem request_usage correta');
          assert.ok(res.body.includes('\"auditLogsDeleted\":4'), 'contagem audit_logs correta');
          assert.ok(!res.body.includes(SECRET), 'segredo nunca aparece na resposta');
        });
      }
    );
  });
});

test('cron: segredo correto via Authorization: Bearer (padrão Vercel) executa', async () => {
  await withCronConfig(SECRET, async () => {
    await withPrismaRetention(
      {
        'requestUsage.deleteMany': async () => ({ count: 0 }),
        'auditLog.deleteMany': async () => ({ count: 0 }),
      },
      async () => {
        await withServer(async (server) => {
          const res = await request(server, {
            path: '/api/internal/retention/run',
            headers: { Authorization: `Bearer ${SECRET}` },
          });
          assert.equal(res.status, 200);
        });
      }
    );
  });
});

test('cron: segredo errado → 401, NENHUM efeito colateral (retenção não roda)', async () => {
  let usageCalled = false;
  await withCronConfig(SECRET, async () => {
    await withPrismaRetention(
      {
        'requestUsage.deleteMany': async () => { usageCalled = true; return { count: 99 }; },
        'auditLog.deleteMany': async () => { usageCalled = true; return { count: 99 }; },
      },
      async () => {
        await withServer(async (server) => {
          const res = await request(server, {
            path: '/api/internal/retention/run',
            headers: { 'X-Cron-Secret': 'errado-errado-errado-errado-errado' },
          });
          assert.equal(res.status, 401);
          assert.ok(!res.body.includes('errado'), 'não ecoa o segredo tentado');
          assert.ok(!usageCalled, 'deleteMany nunca é chamado com segredo inválido');
        });
      }
    );
  });
});

test('cron: segredo ausente → 401 genérico', async () => {
  await withCronConfig(SECRET, async () => {
    await withServer(async (server) => {
      const res = await request(server, { path: '/api/internal/retention/run', headers: {} });
      assert.equal(res.status, 401);
    });
  });
});

test('cron: falha de banco → 500 genérico, sem stack nem segredo', async () => {
  await withCronConfig(SECRET, async () => {
    await withPrismaRetention(
      { 'requestUsage.deleteMany': async () => { throw new Error('pg down: senha-x secret'); } },
      async () => {
        await withServer(async (server) => {
          const res = await request(server, {
            path: '/api/internal/retention/run',
            headers: { 'X-Cron-Secret': SECRET },
          });
          assert.equal(res.status, 500);
          assert.ok(!res.body.includes('pg down'), 'não vaza a mensagem de erro técnica');
          assert.ok(!res.body.includes(SECRET), 'segredo nunca aparece na resposta');
          assert.ok(!res.body.includes('secret'), 'não revela o segredo nem em substring');
        });
      }
    );
  });
});

// Middleware isolado (sem HTTP): comparação em tempo constante e fail-closed.
test('cron: requireCronSecret (unidade) — corretos/incorretos/fail-closed', async () => {
  const { requireCronSecret } = internalRoutes;
  const withRes = (fn) => {
    const res = { statusCode: null, sent: false };
    res.status = function (c) { this.statusCode = c; return this; };
    res.json = function () { this.sent = true; return this; };
    fn(res);
  };

  const saved = config.cron.secret;
  try {
    config.cron.secret = SECRET;

    // correto X-Cron-Secret
    let called = 0;
    await new Promise((resolve) => requireCronSecret(
      { get: (h) => (h === 'X-Cron-Secret' ? SECRET : undefined) },
      { status() { return this; }, json() { throw new Error('não deve responder'); } },
      () => { called += 1; resolve(); }
    ));
    assert.equal(called, 1, 'X-Cron-Secret válido chama next');

    // incorreto → 401
    withRes((res) => {
      requireCronSecret(
        { get: () => 'senha-incorreta-x' },
        res,
        () => { throw new Error('não deve passar'); }
      );
      assert.equal(res.statusCode, 401);
    });

    // curto (fail-closed mesmo se valer)
    config.cron.secret = 'curto';
    withRes((res) => {
      requireCronSecret(
        { get: () => 'curto' },
        res,
        () => { throw new Error('não deve passar'); }
      );
      assert.equal(res.statusCode, 404);
    });
  } finally {
    config.cron.secret = saved;
  }
});

// ── POST /api/internal/reminders/run (cron do "Avise-me") ─────

const withPrismaReminders = (mocks, fn) => {
  const saved = {
    'programReminder.findMany': prisma.programReminder.findMany,
  };
  const set = (path, val) => {
    const parts = path.split('.');
    let obj = prisma;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = val;
  };
  for (const [path, mock] of Object.entries(mocks || {})) set(path, mock);
  return Promise.resolve().then(fn).finally(() => {
    for (const [path, orig] of Object.entries(saved)) set(path, orig);
  });
};

test('cron: reminders — segredo ausente/curto → 404 fail-closed (rota desligada)', async () => {
  await withCronConfig('', async () => {
    await withServer(async (server) => {
      const res = await request(server, {
        path: '/api/internal/reminders/run',
        headers: { 'X-Cron-Secret': 'qualquer-coisa' },
      });
      assert.equal(res.status, 404);
      assert.ok(!res.body.includes('reminders'), 'não revela a rota');
    });
  });
});

test('cron: reminders — segredo correto + feature desligada → 200 sem tocar o banco', async () => {
  const prev = config.reminders.enabled;
  config.reminders.enabled = false;
  try {
    await withCronConfig(SECRET, async () => {
      await withServer(async (server) => {
        const res = await request(server, {
          path: '/api/internal/reminders/run',
          headers: { 'X-Cron-Secret': SECRET },
        });
        assert.equal(res.status, 200);
        assert.ok(res.body.includes('Lembretes processados.'), 'mensagem de sucesso');
        assert.ok(res.body.includes('\"enabled\":false'), 'kill switch respeitado');
        assert.ok(!res.body.includes(SECRET), 'segredo nunca aparece na resposta');
      });
    });
  } finally {
    config.reminders.enabled = prev;
  }
});

test('cron: reminders — sem vencidos (findMany vazio) → 200 examined=0', async () => {
  await withCronConfig(SECRET, async () => {
    await withPrismaReminders(
      { 'programReminder.findMany': async () => [] },
      async () => {
        await withServer(async (server) => {
          const res = await request(server, {
            path: '/api/internal/reminders/run',
            headers: { Authorization: `Bearer ${SECRET}` },
          });
          assert.equal(res.status, 200);
          assert.ok(res.body.includes('\"examined\":0'), 'janela varrida sem lembretes');
          assert.ok(!res.body.includes(SECRET), 'segredo nunca aparece na resposta');
        });
      }
    );
  });
});

test('cron: reminders — falha de banco → 500 genérico, sem stack nem segredo', async () => {
  await withCronConfig(SECRET, async () => {
    await withPrismaReminders(
      { 'programReminder.findMany': async () => { throw new Error('pg down: DATABASE_URL=hack'); } },
      async () => {
        await withServer(async (server) => {
          const res = await request(server, {
            path: '/api/internal/reminders/run',
            headers: { 'X-Cron-Secret': SECRET },
          });
          assert.equal(res.status, 500);
          assert.ok(res.body.includes('Falha ao processar lembretes.'), 'genérico');
          assert.ok(!res.body.includes('pg down'), 'não vaza a mensagem técnica');
          assert.ok(!res.body.includes(SECRET), 'segredo nunca aparece');
          assert.ok(!res.body.includes('DATABASE_URL'), 'não vaza config');
        });
      }
    );
  });
});