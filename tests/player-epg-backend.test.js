'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { safeScriptJson } = require('../src/utils/safeScriptJson');
const ChannelController = require('../src/controllers/channelController');

// ── safeScriptJson ───────────────────────────────────────────

test('safeScriptJson escapa < > & — </script> e <!-- nunca quebram o contexto', () => {
  const json = safeScriptJson({ title: '</script><script>alert(1)</script>', body: '<!-- --> &amp;' });

  // O literal JSON final não contém NENHUM caractere formador de tag.
  assert.ok(!json.includes('<'), 'sem <');
  assert.ok(!json.includes('>'), 'sem >');
  assert.ok(json.includes('\\u003c/script\\u003e'), 'fecha-script neutralizado');
  assert.ok(json.includes('\\u0026'), 'ampersand neutralizado');
});

test('safeScriptJson escapa U+2028/U+2029 (quebravam parsers JS antigos)', () => {
  const json = safeScriptJson({ text: 'linha\u2028quebra\u2029fim' });
  assert.ok(!json.includes('\u2028'), 'sem U+2028 literal');
  assert.ok(!json.includes('\u2029'), 'sem U+2029 literal');
});

test('safeScriptJson é round-trip: JSON.parse devolve o objeto original idêntico', () => {
  const original = [
    { title: '</script><script>x</script>', description: '<!-- --> \u2028 \u2029', start: 1, stop: 2 },
    { title: ' \" aspas \' e &', subtitle: '\u2028'.repeat(3) },
  ];
  const parsed = JSON.parse(safeScriptJson(original));
  assert.deepEqual(parsed, original);
});

test('safeScriptJson trata undefined sem lançar (semântica de JSON.stringify)', () => {
  assert.equal(safeScriptJson(undefined), undefined);
});

// ── generatePlayerHTML: embedding do EPG ──────────────────────

const TEMPLATE = `<html><head></head><body>
<script>
const CHANNEL_DATA = {
  id: '{{CHANNEL_ID}}',
  name: '{{CHANNEL_NAME}}',
  url: '{{CHANNEL_URL}}',
  logo: '{{CHANNEL_LOGO}}',
  category: '{{CHANNEL_CATEGORY}}',
  format: '{{CHANNEL_FORMAT}}',
  state: '{{CHANNEL_STATE}}',
  epg: {{CHANNEL_EPG_JSON}}
};
</script>
<script src="/Player/epgBar.js"></script>
<script src="/Player/player.js"></script>
</body></html>`;

const CHANNEL = {
  id: 'chl-a1',
  name: 'Globo HD',
  logo: 'https://cdn.example/logo.png',
  category: 'Aberta',
  format: 'FHD',
};

function makeEpgService(opts = {}) {
  return {
    isEnabled: () => opts.enabled !== false,
    ensureLoaded: () => {
      if (opts.ensureLoadedRejects) return Promise.reject(new Error('upstream fora'));
      return opts.ensureLoadedResolves || Promise.resolve();
    },
    getPlayerWindow: () => {
      if (opts.throwWindow) throw new Error(opts.throwWindow);
      if ('window' in opts) return opts.window;
      return [];
    },
  };
}

const CHANNEL_STATES = { get: async () => 'live' };

function makeController(epgService) {
  const ctl = Object.create(ChannelController.prototype);
  ctl.playerTemplate = TEMPLATE;
  ctl.epgService = epgService;
  ctl.channelStateService = CHANNEL_STATES;
  return ctl;
}

// json exato do array `epg` presente no HTML (segmento seguro).
function extractEpgJson(html) {
  // Capture greedy até o último ']' do array (o template não tem ']' depois).
  const m = html.match(/epg: (\[[\s\S]*\])/);
  assert.ok(m, 'placeholder CHANNEL_EPG_JSON foi substituído');
  return m[1];
}

test('generatePlayerHTML: EPG embutido server-side via safeScriptJson (zero requisições)', async () => {
  const malicious = [
    { start: '2026-09-17T12:00:00.000Z', stop: '2026-09-17T13:00:00.000Z', title: '</script><script>alert(1)</script>', description: '<!-- --> \u2028' },
    { start: '2026-09-17T13:00:00.000Z', stop: '2026-09-17T14:00:00.000Z', title: 'Próximo', description: '' },
  ];
  const ctl = makeController(makeEpgService({ window: malicious }));

  const html = await ctl.generatePlayerHTML(CHANNEL, 'tok123');
  const seg = extractEpgJson(html);

  assert.equal(seg, safeScriptJson(malicious), 'JSON embutido é exatamente a serialização segura');
  assert.ok(!seg.includes('<'), 'nenhum caractere formador de tag dentro do JSON');
  assert.ok(!seg.includes('\u2028'), 'separadores de linha neutralizados');
});

test('generatePlayerHTML: EPG desativado (EPG_ENABLED=false) → epg: []', async () => {
  const ctl = makeController(makeEpgService({ enabled: false, window: [{ title: 'nunca', start: 0, stop: 1 }] }));
  const html = await ctl.generatePlayerHTML(CHANNEL, 'tok');
  assert.equal(extractEpgJson(html), '[]');
});

test('generatePlayerHTML: falha de getPlayerWindow → epg: [] (fail-open, não derruba player)', async () => {
  const ctl = makeController(makeEpgService({ throwWindow: 'boom' }));
  const html = await ctl.generatePlayerHTML(CHANNEL, 'tok');
  assert.equal(extractEpgJson(html), '[]');
});

test('generatePlayerHTML: retorno não-array → epg: []', async () => {
  const ctl = makeController(makeEpgService({ window: 'não-array' }));
  const html = await ctl.generatePlayerHTML(CHANNEL, 'tok');
  assert.equal(extractEpgJson(html), '[]');
});

test('generatePlayerHTML: ensureLoaded rejeitando não propaga (warm fire-and-forget)', async () => {
  const ctl = makeController(makeEpgService({
    ensureLoadedRejects: true,
    window: [{ start: '2026-09-17T12:00:00.000Z', stop: '2026-09-17T13:00:00.000Z', title: 'Cache local vale', description: '' }],
  }));
  const html = await ctl.generatePlayerHTML(CHANNEL, 'tok');
  const seg = extractEpgJson(html);
  assert.equal(seg, safeScriptJson([{ start: '2026-09-17T12:00:00.000Z', stop: '2026-09-17T13:00:00.000Z', title: 'Cache local vale', description: '' }]));
});

test('generatePlayerHTML: sem epgService (chamador enxuto) → epg: [] sem lançar', async () => {
  const ctl = makeController(null);
  const html = await ctl.generatePlayerHTML(CHANNEL, 'tok');
  assert.equal(extractEpgJson(html), '[]');
});

test('generatePlayerHTML: demais placeholders continuam escapados (XSS clássico)', async () => {
  const ctl = makeController(makeEpgService());
  const html = await ctl.generatePlayerHTML({ ...CHANNEL, name: 'Globo \'+" <script>' }, 'tok');
  assert.ok(html.includes('Globo &#039;+&quot; &lt;script&gt;'), 'nome escapado');
  assert.ok(!html.includes('Globo \'+" <script>'), 'nome cru nunca aparece');
  // state/proxy intactos
  assert.ok(html.includes('state: \'live\''), 'state presente');
  assert.ok(html.includes("/api/channels/chl-a1/proxy?token=tok"), 'proxy presente');
});

test('generatePlayerHTML: nunca vaza EPG_URL (host/config do upstream)', async () => {
  const ctl = makeController(makeEpgService({
    window: [{ start: 0, stop: 1, title: 'x', description: '' }],
  }));
  // Logo/CDN são dados do catálogo (público); aqui zerado para provar que
  // NUNCA é inserida URL absoluta de upstream (EPG/M3U) no HTML do player.
  const html = await ctl.generatePlayerHTML({ ...CHANNEL, logo: '' }, 'tok');
  assert.ok(!html.includes('https://'), 'sem URLs absolutas no HTML do player');
  assert.ok(!html.includes('epg.example'), 'sem host interno do EPG');
  assert.ok(html.includes('/api/channels/chl-a1/proxy?token=tok'), 'proxy permanece relativo');
});