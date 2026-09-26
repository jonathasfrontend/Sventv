/**
 * SvenTV API - Configurações Centralizadas da Aplicação
 *
 * Agrupa todas as configurações que dependem de variáveis de ambiente,
 * provendo valores padrão seguros e validação básica.
 */

'use strict';

require('dotenv').config();

const config = {
  // ---- Servidor ----
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // URL pública da aplicação (usada em e-mails transacionais para montar
  // links de recuperação). Se vazia, o e-mail é enviado SEM link (apenas
  // instrução de texto) — nunca inventa domínio.
  app: {
    baseUrl: process.env.APP_BASE_URL || '',
    // Fuso padrão para exibição de horários em e-mails transacionais.
    timeZone: process.env.APP_TIMEZONE || 'America/Sao_Paulo',
  },

  // ---- Banco de Dados (Postgres via Prisma) ----
  db: {
    databaseUrl: process.env.DATABASE_URL || '',
  },

  // ---- JWT - Sessão (token de login do painel/site) ----
  jwt: {
    secret: process.env.JWT_SECRET || 'fallback_dev_secret_mude_em_producao',
    expiresIn: process.env.JWT_SESSION_EXPIRES_IN || '7d',
  },

  // ---- JWT - API Token (token individual de acesso à API) ----
  jwtApi: {
    secret: process.env.JWT_API_SECRET || 'fallback_api_secret_mude_em_producao',
    expiresIn: process.env.JWT_API_EXPIRES_IN || '365d',
  },

  // ---- JWT - Playback (token curto por canal, usado pelo player) ----
  // O segredo é derivado de JWT_PLAYBACK_SECRET ou de jwtApi.secret dentro
  // de streamTokenService; aqui fica apenas o TTL.
  jwtPlayback: {
    expiresIn: process.env.PLAYBACK_TOKEN_EXPIRES_IN || '2h',
    expiresInSeconds: (() => {
      const raw = (process.env.PLAYBACK_TOKEN_EXPIRES_IN || '2h').trim().toLowerCase();
      const m = raw.match(/^(\d+)\s*(s|sec|seconds|m|min|minutes|h|hours|d|days)?$/);
      if (!m) return 7200;
      const n = parseInt(m[1], 10);
      const unit = m[2] ? m[2][0] : 's';
      const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit] || 1;
      return Math.max(30, n * mult);
    })(),
  },

  // ---- Segurança ----
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS, 10) || 5,
    lockTimeMinutes: parseInt(process.env.LOCK_TIME_MINUTES, 10) || 15,
    // Mínimo de caracteres da senha (mantido da política existente: 8).
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH, 10) || 8,
    // Limite de BYTES da senha (bcrypt trunca em 72 bytes — o que excede é
    // silenciosamente ignorado pelo hash; aceitar além disso criaria duas
    // senhas distintas hasheadas como iguais). Medido em Utf8, não caracteres.
    passwordMaxBytes: parseInt(process.env.PASSWORD_MAX_BYTES, 10) || 72,
  },

  // ---- SMTP (e-mails transacionais) ----
  // Credenciais lidas do ambiente. Quando SMTP_HOST não estiver configurado
  // o serviço de e-mail fica "desligado" (loga warn e segue genérico) —
  // NUNCA quebra o fluxo nem revela o motivo fora do log interno.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || '',
    enabled: Boolean(process.env.SMTP_HOST),
  },

  // ---- Recuperação de senha ----
  passwordReset: {
    // Validade do código (15 min por padrão).
    codeTtlMs: parseInt(process.env.PASSWORD_RESET_CODE_TTL_MS, 10) || 900_000,
    // Máximo de tentativas incorretas antes de invalidar o código.
    maxAttempts: parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS, 10) || 5,
    // Rate limit do pedido (forgot): 3 por e-mail+IP a cada 15 min.
    forgotWindowMs: parseInt(process.env.PASSWORD_RESET_FORGOT_WINDOW_MS, 10) || 900_000,
    forgotMax: parseInt(process.env.PASSWORD_RESET_FORGOT_MAX, 10) || 3,
    // Rate limit do reset (anti brute-force distribuído): 10 por IP a cada 15 min.
    resetWindowMs: parseInt(process.env.PASSWORD_RESET_RESET_WINDOW_MS, 10) || 900_000,
    resetMax: parseInt(process.env.PASSWORD_RESET_RESET_MAX, 10) || 10,
  },

  // ---- Termos de Uso ----
  // Versão CENTRALIZADA — nunca espalhar "v1"/datas por dezenas de arquivos.
  // Deve ser versionada sempre que o conteúdo de /termos mudar.
  terms: {
    version: process.env.TERMS_VERSION || '2026-09-16',
  },

  // ---- Rate Limiting ----
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
    global: parseInt(process.env.RATE_LIMIT_MAX_GLOBAL, 10) || 200,
    api: parseInt(process.env.RATE_LIMIT_MAX_API, 10) || 100,
    login: parseInt(process.env.RATE_LIMIT_MAX_LOGIN, 10) || 20,
    stream: parseInt(process.env.RATE_LIMIT_MAX_STREAM, 10) || 50,
    register: parseInt(process.env.RATE_LIMIT_MAX_REGISTER, 10) || 10,
    user: parseInt(process.env.RATE_LIMIT_MAX_USER, 10) || 120,
    events: parseInt(process.env.RATE_LIMIT_MAX_EVENTS, 10) || 600,
    proxy: parseInt(process.env.RATE_LIMIT_MAX_PROXY, 10) || 1200,
    // Janela própria para segmentos do proxy de stream: HLS é rápido e
    // numeroso — não deve disputar a janela da API/global.
    proxyWindowMs: parseInt(process.env.RATE_LIMIT_PROXY_WINDOW_MS, 10) || 60_000,
    // Ações administrativas de escrita (role/block/profile/password/avatar/
    // delete). Cota por admin, janela de 15 min — barra script/abuso sem
    // atrapalhar operações legítimas (leitura/GETs ficam fora).
    adminWriteMax: parseInt(process.env.RATE_LIMIT_MAX_ADMIN_WRITE, 10) || 60,
    adminWriteWindowMs: parseInt(process.env.RATE_LIMIT_ADMIN_WRITE_WINDOW_MS, 10) || 900_000,
  },

  // ---- Estado distribuído (Upstash Redis) ----
  // Hot paths (rate limiter + stream limiter) usam Upstash Redis REST.
  // Ações administrativas (channel state) usam PostgreSQL. O kill switch
  // DISTRIBUTED_STATE_ENABLED=false devolve a aplicação ao comportamento
  // 100% em memória (rollback lógico sem novo deploy).
  redis: {
    distributedEnabled: process.env.DISTRIBUTED_STATE_ENABLED !== 'false',
    // TTL do cache local de disponibilidade do Redis (30s) — evita um
    // healthcheck de rede por requisição. Falha é cacheada p/ fallback rápido.
    availabilityCacheMs: parseInt(process.env.REDIS_AVAILABILITY_CACHE_MS, 10) || 30_000,
    // TTL das vagas de stream (proteção contra lambda morta sem release).
    slotTtlMs: parseInt(process.env.STREAM_SLOT_TTL_MS, 10) || 300_000,
  },

  // ---- Channel State (Postgres + cache curto) ----
  channelState: {
    // Kill switch: CHANNEL_STATE_PERSIST_ENABLED=false devolve o serviço ao
    // comportamento 100% em memória (sem hidratar/persistir) — rollback
    // lógico instantâneo sem novo deploy.
    persistEnabled: process.env.CHANNEL_STATE_PERSIST_ENABLED !== 'false',
    // TTL do cache local do estado administrativo de canal. Mudanças feitas
    // em outra instância levam até ~este valor para propagar quando a
    // instância local possuir cache. Padrão 8s = compromisso latência/consistência.
    cacheTtlMs: parseInt(process.env.CHANNEL_STATE_CACHE_TTL_MS, 10) || 8_000,
  },

  // ---- WAF / IP Access Control (blocklist persistente de IPs) ----
  // Bloqueio administrativo por IP (registro E login), independente do
  // bloqueio de conta. Fonte de verdade = Postgres (ip_blocklist) com cache
  // local curto por lambda (reusa o padrão do channelStateService) e falha
  // tolerante: banco fora → mantém o último estado em memória (fail-open,
  // a autenticação continua sendo a barreira primária).
  ipAccess: {
    // Kill switch: IP_ACCESS_ENABLED=false desliga a blocklist de IPs sem
    // novo deploy (o WAF_BLOCKED_IPS por env continua valendo).
    enabled: process.env.IP_ACCESS_ENABLED !== 'false',
    // TTL do cache local das respostas de bloqueio (ms). Um IP bloqueado/
    // desbloqueado por outro admin propaga em até ~este valor na instância
    // com cache. Padrão 10s = compromisso propagação/custo de query.
    cacheTtlMs: parseInt(process.env.IP_ACCESS_CACHE_TTL_MS, 10) || 10_000,
    // Retenção: dias para APAGAR registros de ip_blocklist JÁ desbloqueados
    // (0 = desativado; o histórico vivo em audit_logs nunca é apagado aqui).
    retentionDays: parseInt(process.env.IP_BLOCKLIST_RETENTION_DAYS, 10) || 0,
  },

  // ---- Trending (Top 10 — catálogo metadados, em memória, por lambda) ----
  // Consulta um catálogo externo de metadados (GraphQL do provedor) para a
  // dashboard: filmes/séries mais assistidos e programações ao vivo em alta.
  // Segue o mesmo princípio do EPG: a URL é configurável (padrão fornecido),
  // NUNCA é logada e o cache é em memória com TTL + fail-open (falha mantém
  // o cache anterior; nunca derruba a aplicação). TRENDING_ENABLED=false
  // desliga a feature sem novo deploy.
  trending: {
    apiUrl:
      process.env.TRENDING_API_URL ||
      'https://metadatadb.lab.smartcontent.clarobrasil.mobi/graphql',
    // Kill switch: false → rotas devolvem listas vazias.
    enabled: process.env.TRENDING_ENABLED !== 'false',
    // TTL do cache em memória (30 min por padrão — o ranking muda pouco).
    cacheTtlMs: parseInt(process.env.TRENDING_CACHE_TTL_MS, 10) || 1_800_000,
    // Timeout do fetch do GraphQL.
    fetchTimeoutMs: parseInt(process.env.TRENDING_FETCH_TIMEOUT_MS, 10) || 10_000,
  },

  // ---- EPG (Guia de Canais — XMLTV em memória, por lambda) ----
  // EPG_URL é segredo operacional: NUNCA é logado nem exposto em qualquer
  // resposta (mesmo princípio da origem M3U). O cache é em memória com TTL;
  // falha de fetch/timeout mantém o cache anterior (fail-open) e nunca
  // derruba a aplicação nem vira erro para o cliente.
  epg: {
    url: process.env.EPG_URL || '',
    // Kill switch: EPG_ENABLED=false desliga rotas/página sem novo deploy.
    enabled: process.env.EPG_ENABLED !== 'false',
    // TTL do cache em memória (30 min por padrão — a grade muda pouco).
    cacheTtlMs: parseInt(process.env.EPG_CACHE_TTL_MS, 10) || 1_800_000,
    // Timeout do fetch do XML.
    fetchTimeoutMs: parseInt(process.env.EPG_FETCH_TIMEOUT_MS, 10) || 10_000,
  },

  // ---- Cache ----
  cache: {
    ttlChannels: parseInt(process.env.CACHE_TTL_CHANNELS, 10) || 300,
    ttlCategories: parseInt(process.env.CACHE_TTL_CATEGORIES, 10) || 600,
    ttlStats: parseInt(process.env.CACHE_TTL_STATS, 10) || 120,
    // Recomendações: cache é SEMPRE por usuário (chave userId) — nunca
    // compartilhado entre usuários. Vive por lambda (em memória).
    ttlRecommendations: parseInt(process.env.CACHE_TTL_RECOMMENDATIONS, 10) || 600,
    ttlDashboard: parseInt(process.env.CACHE_TTL_DASHBOARD, 10) || 60,
  },

  // ---- Analytics & Playback Sessions ----
  analytics: {
    // Intervalo do heartbeat do player (client-side) — 30s.
    heartbeatIntervalMs: parseInt(process.env.ANALYTICS_HEARTBEAT_MS, 10) || 30_000,
    // Sessão sem heartbeat por mais que isso é considerada abandonada.
    // Default 3× heartbeat = 90s.
    sessionExpiryMs: parseInt(process.env.ANALYTICS_SESSION_EXPIRY_MS, 10) || 90_000,
    // Retenção de dados brutos:
    //  - eventos brutos (transições)   → 30 dias
    //  - sessões de reprodução          → 90 dias
    //  - agregações diárias             → 400 dias
    eventRetentionDays: parseInt(process.env.ANALYTICS_EVENT_RETENTION_DAYS, 10) || 30,
    sessionRetentionDays: parseInt(process.env.ANALYTICS_SESSION_RETENTION_DAYS, 10) || 90,
    metricRetentionDays: parseInt(process.env.ANALYTICS_METRIC_RETENTION_DAYS, 10) || 400,
    // Probabilidade de disparo de limpeza oportunista por ingestão (%).
    // Um job agendado pode também chamar retentionService.runRetention().
    retentionProbability: parseFloat(process.env.ANALYTICS_RETENTION_PROBABILITY, 10) || 0.01,
    // Limites de ingestão de recomendações/histórico na dashboard.
    recentHistoryLimit: parseInt(process.env.ANALYTICS_RECENT_LIMIT, 10) || 10,
    recommendationsLimit: parseInt(process.env.ANALYTICS_RECO_LIMIT, 10) || 8,
    maxChannelsPerPlaylist: parseInt(process.env.ANALYTICS_MAX_PLAYLIST_CHANNELS, 10) || 500,
  },

  // ---- Health / Failover de canais ----
  // O estado é em memória (por lambda). Estes knobs ajustam a cadência dos
  // checks e as regras de troca de fonte primária ↔ backup.
  health: {
    // Intervalo entre ciclos de verificação (ms).
    checkIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 60_000,
    // Timeout de cada request de verificação (ms).
    requestTimeoutMs: parseInt(process.env.HEALTH_REQUEST_TIMEOUT_MS, 10) || 8_000,
    // Falhas consecutivas da fonte ativa para acionar failover.
    failoverThreshold: parseInt(process.env.HEALTH_FAILOVER_THRESHOLD, 10) || 2,
    // Tempo mínimo (ms) na fonte backup antes de tentar voltar à primária.
    failbackMinMs: parseInt(process.env.HEALTH_FAILBACK_MIN_MS, 10) || 120_000,
    // Persistência do failover (tabela channel_health, via
    // channelHealthRepository): a fonte de verdade é o ciclo automático em
    // memória; a tabela guarda APENAS o activeSource na última TRANSIÇÃO
    // (0 escritas em checks sem troca) para sobreviver a cold start.
    // Kill switch: CHANNEL_HEALTH_PERSIST_ENABLED=false → 100% em memória.
    persistEnabled: process.env.CHANNEL_HEALTH_PERSIST_ENABLED !== 'false',
  },

  // ---- Retenção de dados operacionais ----
  // A limpeza é disparada via cron (POST /api/internal/retention/run) ou
  // manualmente pelo admin (POST /api/admin/retention/run). 0 desativa a
  // limpeza para aquele tipo sem remover as variáveis de ambiente.
  retention: {
    // request_usage: buckets de rate limit por usuário (granularidade fina).
    requestUsageDays: parseInt(process.env.REQUEST_USAGE_RETENTION_DAYS, 10) || 30,
    // audit_logs: trilha de auditoria (obrigação legal/compliance).
    auditLogDays: parseInt(process.env.AUDIT_LOG_RETENTION_DAYS, 10) || 90,
  },

  // ---- Avise-me (lembretes de programação) ----
  // O usuário pede para ser notificado quando um programa DO EPG começar. Dois
  // canais de entrega independentes, sem duplicar (o flag `notifiedAt` fecha o
  // ciclo de quem marcar primeiro):
  //   1) frontend — browser Notification API via dispatcher compartilhado
  //      (public/js/reminder-notifier.js): polling a cada ~30s MESMO com a aba
  //      em segundo plano, notifica na janela [agora−trail, agora+lead]
  //      (padrão 15min de recuperação + 60s de pré-aviso); as janelas são
  //      configuradas no cliente, o servidor aceita ?trail= (clamp 0..30min);
  //   2) servidor — cron de e-mail (POST /api/internal/reminders/run, a cada
  //      5 min na Vercel) envia SMTP para lembretes com startsAt dentro de
  //      `dueWindowMs`. O serviço NUNCA envia push com a página fechada,
  //      exceto o e-mail agendado (limitação documentada).
  // Kill switch: REMINDERS_ENABLED=false → rotas respondem 400 FEATURE_DISABLED
  // e o botão some no frontend.
  reminders: {
    // Kill switch: false → feature desligada sem novo deploy.
    enabled: process.env.REMINDERS_ENABLED !== 'false',
    // Limite de lembretes ativos por usuário.
    maxPerUser: parseInt(process.env.REMINDERS_MAX_PER_USER, 10) || 50,
    // Horizonte máximo à frente aceito (padrão 24h) — o e-mail é agendado
    // pelo cron; horizontes longos criariam estado morto no banco.
    maxHorizonMs: parseInt(process.env.REMINDERS_MAX_HORIZON_MS, 10) || 24 * 60 * 60 * 1000,
    // Janela do cron de e-mail: lembretes com início em [agora, agora+janela].
    dueWindowMs: parseInt(process.env.REMINDERS_DUE_WINDOW_MS, 10) || 300_000,
    // Lote máximo por execução do cron (proteção contra picos de SMTP).
    batchLimit: parseInt(process.env.REMINDERS_BATCH_LIMIT, 10) || 50,
    // Canal de e-mail (SMTP) do cron. A Vercel Hobby NÃO agenda o run
    // (1 cron/dia dedicado à retenção) → em produção vale setar `false`:
    // o Avise-me passa a usar SÓ a Notification do navegador. Dev/testa
    // mantêm `true` para o `npm run reminders:run` seguir funcionando.
    emailEnabled: process.env.REMINDERS_EMAIL_ENABLED !== 'false',
    // Vida do marcador de estado do botão "Avise-me" no Redis (Upstash,
    // mesmo store de rate/stream limiter): o marker guarda
    // (userId, channelId, startsAt) e some `stateKeepAfterMs` após o início —
    // tempo suficiente para o "próximo programa" da EPG já ter trocado.
    stateKeepAfterMs: parseInt(process.env.REMINDERS_STATE_KEEP_AFTER_MS, 10) || 4 * 60 * 60 * 1000,
  },

  // ---- Jobs internos (Vercel Cron / endpoints internos) ----
  // Segredo compartilhado enviado pelo cron da Vercel (header X-Cron-Secret
  // ou Authorization: Bearer). NUNCA é logado nem exposto em respostas.
  // Vazio → rotas internas desligadas (fail-closed, 404 genérico).
  cron: {
    secret: process.env.CRON_SECRET || '',
  },

  // ---- Alertas operacionais (admin) ----
  // Eventos de infra (failover/failback de canal, falha de SMTP, queda do
  // Redis com fallback) E de usuário (registro, bloqueio por tentativas,
  // teto de reset, promoção a admin, exclusão de conta, rate limit de
  // registro) notificam o admin via e-mail e/ou webhook. Fire-and-forget:
  // falha de envio NUNCA derruba o fluxo principal. O cooldown é por evento
  // e por lambda (limitação documentada — serverless não tem timer único).
  // Regra de eventKey (alertService): sistema=genérica; usuário=por id;
  // ação admin única=id+timestamp; rate limit=genérica. Payloads SÓ com
  // ids/nomes/e-mails — nunca senha/token/segredo. Apresentação por evento
  // em EVENT_META no alertService (título/emoji/cor/categoria → e-mail HTML
  // com design + embed rico do Discord). A URL do webhook é SEGREDO:
  // nunca logar/expor.
  alerts: {
    enabled: process.env.ALERTS_ENABLED !== 'false',
    adminEmail: process.env.ADMIN_ALERT_EMAIL || '',
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    // Distância mínima entre duas notificações do MESMO evento (ms).
    cooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS, 10) || 1_800_000,
  },

  // ---- CORS ----
  cors: {
    origins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : ['*'],
  },
};

module.exports = config;
