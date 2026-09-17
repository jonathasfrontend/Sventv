'use strict';
/* E2E smoke: fluxo completo de analytics/playlists contra o banco real.
   Cria usuário de teste, exercita todas as rotas novas e remove o usuário
   (OS CASCADES apagam os dados associados). Promove/revoga role admin
   temporariamente para validar os endpoints administrativos. */

require('dotenv').config();
const app = require('../src/app');
const prisma = require('../src/prisma/client');

const BASE_EMAIL = `e2e_${Date.now()}@sventv-api.com`;
const sessionId = 'e2e-' + Math.random().toString(36).slice(2, 14);

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
};

async function api(origin, path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(origin + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

async function main() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1 ── Registro
    const reg = await api(origin, '/api/auth/register', {
      method: 'POST',
      body: { name: 'E2E User', email: BASE_EMAIL, password: 'Teste@12345' },
    });
    check('register → 201', reg.status === 201, JSON.stringify(reg.json?.data?.user || {}));
    const apiToken = reg.json?.data?.apiToken;
    const sessionToken = reg.json?.data?.sessionToken;
    const userId = reg.json?.data?.user?.id;
    check('tokens presentes', !!(apiToken && sessionToken && userId));

    // 2 ── Playlists
    const pl = await api(origin, '/api/user/playlists', {
      method: 'POST', token: apiToken,
      body: { name: 'Esportes E2E', description: 'teste' },
    });
    check('create playlist → 201', pl.status === 201);
    const playlistId = pl.json?.data?.id;
    check('playlist id retornado', !!playlistId);

    const channels = await api(origin, '/api/channels', { token: apiToken });
    const channel = channels.json?.data?.channels?.[0];
    check('lista de canais pública', !!channel?.id && !('url' in (channel || {})), channel?.name || '');
    if (!channel?.id) throw new Error('sem canal para testar');

    const added = await api(origin, `/api/user/playlists/${playlistId}/channels`, {
      method: 'POST', token: apiToken, body: { channelId: channel.id },
    });
    check('add channel → 201', added.status === 201);

    const dup = await api(origin, `/api/user/playlists/${playlistId}/channels`, {
      method: 'POST', token: apiToken, body: { channelId: channel.id },
    });
    check('duplicado → 409 CHANNEL_ALREADY_SAVED',
      dup.status === 409 && dup.json?.code === 'CHANNEL_ALREADY_SAVED',
      JSON.stringify(dup.json || {}));

    const cwc = await api(origin, '/api/user/playlists/create-with-channel', {
      method: 'POST', token: apiToken,
      body: { name: 'Outra bulk', channelId: channel.id },
    });
    check('create-with-channel duplicado → 409 (regra 1 canal = 1 playlist)',
      cwc.status === 409);

    // 3 ── Eventos de playback (via API token)
    const lc = (body) => api(origin, '/api/playback/events', { method: 'POST', token: apiToken, body });
    const ev = {
      play: await lc({ sessionId, channelId: channel.id, event: 'play', watchDurationMs: 0 }),
      pause: await lc({ sessionId, channelId: channel.id, event: 'pause', watchDurationMs: 30000 }),
      resume: await lc({ sessionId, channelId: channel.id, event: 'resume', watchDurationMs: 30000 }),
    };
    check('event play → 200', ev.play.status === 200);
    check('event pause → 200', ev.pause.status === 200);
    check('event resume → 200', ev.resume.status === 200);

    const hb = await api(origin, '/api/playback/heartbeat', {
      method: 'POST', token: apiToken,
      body: { sessionId, channelId: channel.id, watchDurationMs: 90000 },
    });
    check('heartbeat → 200', hb.status === 200, JSON.stringify(hb.json));

    const stop = await lc({ sessionId, channelId: channel.id, event: 'stop', watchDurationMs: 120000 });
    check('event stop → 200 (finaliza sessão)', stop.status === 200, JSON.stringify(stop.json));

    const stop2 = await lc({ sessionId, channelId: channel.id, event: 'stop', watchDurationMs: 120000 });
    check('stop duplicado → 200 ALREADY_FINALIZED (idempotente)',
      stop2.status === 200 && stop2.json?.data?.code === 'ALREADY_FINALIZED');

    // 4 ── Dashboard / histórico / playlists
    const dash = await api(origin, '/api/dashboard', { token: apiToken });
    check('dashboard → 200', dash.status === 200);
    check('dashboard history tem 1 linha', dash.json?.data?.history?.length === 1,
      JSON.stringify(dash.json?.data?.history || []));
    check('dashboard traz playlists', dash.json?.data?.playlists?.[0]?.id === playlistId);

    const hist = await api(origin, '/api/user/history', { token: apiToken });
    check('history → 200 com 1 item', hist.status === 200 && hist.json?.data?.items?.length === 1,
      JSON.stringify(hist.json?.data || {}));

    const list = await api(origin, `/api/user/playlists/${playlistId}/channels`, { token: apiToken });
    check('list canais da playlist → 1 item', list.json?.data?.items?.length === 1,
      JSON.stringify(list.json?.data?.items || []));

    const st = await api(origin, `/api/user/playlists/status/${channel.id}`, { token: apiToken });
    check('status channel → retorna a playlist', st.json?.data?.playlistId === playlistId);

    const reco = await api(origin, '/api/user/recommendations', { token: apiToken });
    check('recommendations → 200', reco.status === 200, JSON.stringify({ items: reco.json?.data?.items?.length }));

    // 5 ── Admin analytics (promove temporariamente, depois revoga)
    await prisma.user.update({ where: { email: BASE_EMAIL }, data: { role: 'admin' } });
    const analytics = await api(origin, '/api/admin/metrics/analytics?period=today', { token: sessionToken });
    check('admin analytics → 200', analytics.status === 200 && analytics.json?.data?.overview,
      JSON.stringify(analytics.json?.data?.overview || {}));
    check('overview conta a sessão finalizada', analytics.json?.data?.overview?.sessions >= 1);

    await prisma.user.update({ where: { email: BASE_EMAIL }, data: { role: 'user' } });
    const denied = await api(origin, '/api/admin/metrics/analytics?period=today', { token: sessionToken });
    check('admin analytics negado p/ role user → 403', denied.status === 403);

    // 6 ── Cleanup (cascade apaga eventos/sessões/histórico/playlists)
    await prisma.user.delete({ where: { email: BASE_EMAIL } });
    const afterDelete = await api(origin, '/api/user/history', { token: apiToken });
    check('usuário removido (auth falha após delete)', afterDelete.status === 401 || afterDelete.status === 503);
  } finally {
    server.close();
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\nRESULT: ${ok}/${results.length} PASS`);
  process.exit(ok === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E_ERR', err);
  process.exit(2);
});