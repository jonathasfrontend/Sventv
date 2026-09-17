# 📺 SvenTV API — Plataforma de Streaming de Canais de TV (HLS)

[![Node.js](https://img.shields.io/badge/Node.js-18.x+-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.18+-000000?style=flat&logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-336791?style=flat&logo=postgresql&logoColor=white)](https://supabase.com/)
[![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat&logo=vercel&logoColor=white)](https://vercel.com)
[![License](https://img.shields.io/badge/License-JEPSL-blue.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/Status-Production-success)]()

> **API REST profissional para streaming de canais de TV ao vivo via HLS**, com autenticação JWT baseada em sessão/API/playback, proxy HLS selado (privacidade de origem), rate limiting por contexto, failover automático de fontes, estados de canal, analytics de reprodução, playlists pessoais, recomendações e painel administrativo com Live Control.

---

## 📌 Índice

- [Visão Geral](#-visão-geral)
- [Arquitetura](#-arquitetura)
- [Estrutura do Projeto](#-estrutura-do-projeto)
- [Tecnologias](#️-tecnologias)
- [Dados e Armazenamento](#-dados-e-armazenamento)
- [Autenticação e Sessões](#-autenticação-e-sessões)
- [API REST — Endpoints](#-api-rest--endpoints)
- [Segurança](#-segurança)
- [Streaming: Proxy HLS Selado](#-streaming-proxy-hls-selado)
- [Analytics, Playlists e Recomendações](#-analytics-playlists-e-recomendações)
- [Painel Web e Player](#-painel-web-e-player)
- [Instalação e Configuração](#-instalação-e-configuração)
- [Variáveis de Ambiente](#-variáveis-de-ambiente)
- [Banco de Dados e Migrações](#-banco-de-dados-e-migrações)
- [Testes](#-testes)
- [Deploy na Vercel](#-deploy-na-vercel)
- [Limitações Conhecidas](#-limitações-conhecidas)
- [Documentação Técnica (docs/)](#-documentação-técnica-docs)
- [Avisos Legais](#-avisos-legais)
- [Créditos](#-créditos)

---

## 📍 Visão Geral

A **SvenTV API** é um backend completo para distribuição de conteúdo de TV ao vivo. O sistema processa playlists **M3U/M3U8** (locais ou URLs remotas), mantém o catálogo de canais **em memória** para leitura instantânea e expõe:

- **Endpoints RESTful** para listar, buscar, filtrar e reproduzir canais;
- **Player HTML5 próprio** (HLS.js) embutível via iframe, com marca d'água de sessão, overlay de estado e auto-recuperação de rede;
- **Proxy HTTPS selado** de playlists/segmentos, escondendo a origem upstream do cliente;
- **Guia de Programação (EPG)** — XMLTV em memória (`EPG_URL`), com **todos os canais da M3U** no guia (quem não tem EPG aparece com grade vazia), casado por nome normalizado + alias map, com `now`/`next` por canal e página `/guia`;
- **Autenticação JWT** em 3 camadas (sessão web, API token, playback token de curta duração);
- **Recuperação de senha** por código de 6 dígitos (SHA-256 no banco, TTL, uso único, revoga todas as sessões) e **Termos de Uso versionados** com aceite no registro;
- **Estado distribuído** (Upstash Redis) para rate limiting e concorrência de streams, com **fallback em memória** e kill switch `DISTRIBUTED_STATE_ENABLED`;
- **Failover automático de fontes** (primária ↔ backup) e **estados administrativos de canal** (`live`/`maintenance`/`blocked`) com gating de reprodução;
- **Área pessoal**: dashboard, histórico de reprodução, playlists e recomendações;
- **Painel administrativo**: gestão de usuários, estados de canal, métricas operacionais e de analytics, **Live Control** (espectadores ao vivo por canal), trilha de auditoria;
- **Pronto para serverless** (Vercel), com tolerância a cold start.

### Problemas que resolve

| Problema | Solução |
|---|---|
| Múltiplas listas M3U espalhadas | Unificação e normalização em um catálogo único (parser M3U + deduplicação) |
| Acesso direto ao upstream IPTV | Proxy HLS selado (`?p=` AES-256-GCM) — o navegador nunca vê a URL real |
| Abuso de API / força bruta / hotlink | Rate limiting por contexto + anti-hotlink + bloqueio de conta após tentativas |
| Sem rastreio de operações sensíveis | Trilha de auditoria persistida (`audit_logs`) com `requestId` correlacionado |
| Sem visão da operação | Métricas de proxy/stream em memória + analytics de reprodução (por canal/usuário/categoria) |
| SSRF por URL aberta | Guarda anti-SSRF (DNS→IP + blocklist + re-check de redirects); `?u=` proibido |
| Canais fora do ar / fontes instáveis | Failover automático primária ↔ backup (anti-flapping) + estados `maintenance`/`blocked` |
| Quem está assistindo | Live Control — espectadores ativos por canal (a partir do heartbeat das sessions) |

---

## 🏗 Arquitetura

### Padrão arquitetural

Camadas organizadas em **routes → controllers → services → repositories/models** (Express), com estados distintos entre canais e usuários:

```
[ Cliente / Player / Dashboard ]
        │  HTTP/HTTPS (somente a própria API — nunca o upstream)
        ▼
[ Express API  (Vercel/Node — src/app.js | index.js) ]
  ├─ Middlewares: requestId, removeFingerprint, helmet, cors, globalLimiter,
  │               sanitizeMongo/Xss, securityLogger, X-Frame-Options,
  │               sessão express-session, readiness (DB + M3U)
  ├─ requireSessionAuth / requireApiAuth / requireStreamAccess /
  │   requireSessionOrApi / requireEventAuth / requireRole
  ├─ requireStreamAccess      (API token OU playback token por canal)
  ├─ Proxy HLS selado ?p=     (AES-256-GCM — entrada única para M3U/segmentos)
  ├─ SSRF guard               (DNS→IP, blocklist link-local/privado/loopback,
  │                            re-check de redirects a cada hop)
  └─ Observabilidade: requestId, auditLog, metrics, streamLimiter, rate limit
        │
        ▼
[ Upstream M3U/HTTP ]  (único ponto de saída server-side, nunca exposto)
```

**Estado em memória × persistido:**

- **Canais** → NÃO vivem no banco. São parseados de fontes M3U (local `./SvenTvChannels.m3u` ou URL externa, configurável no construtor de `M3UService`) para um array em memória, via singleton `M3UService.getShared()`.
- **Estados de canal (`live`/`maintenance`/`blocked`)** → **persistidos no PostgreSQL** (tabela `channel_states`; fonte de verdade global entre instâncias) com **cache local curto** (`channelStateService`, read-through com `CHANNEL_STATE_CACHE_TTL_MS`) e hidratação no cold start. Kill switch `CHANNEL_STATE_PERSIST_ENABLED=false` devolve ao modo 100% em memória.
- **Health/failover por fonte** → **em memória** (`channelHealthService`), por lambda — ver Limitações.
- **Rate limiting e concorrência de streams** → **híbridos**: janela atômica no **Upstash Redis** (REST) quando disponível, com **fallback transparente em memória** por lambda. Desligável via `DISTRIBUTED_STATE_ENABLED=false`.
- **Usuários / tokens / uso / auditoria / analytics / playlists / códigos de reset** → PostgreSQL (Supabase) via Prisma.

### Dois entrypoints — por quê

| Arquivo | Uso | Responsabilidade |
|---|---|---|
| **`index.js`** | Desenvolvimento local | `dotenv`, `connectDB()`, `app.listen()`, graceful shutdown, handlers de `uncaughtException`/`unhandledRejection` |
| **`src/app.js`** | Produção / Vercel | Monta todo o wiring Express e **exporta o app** (sem `listen`). É o alvo do `vercel.json`. |

### Cold start (serverless)

Na Vercel não há startup único. Um middleware em `src/app.js` aguarda `ensureDBConnection()` + `sharedM3U.ensureLoaded()` + `channelStates.ensureLoaded()` (hidratação do estado administrativo persistido) a cada instância fria. Na sequência, as promises resolvidas são reutilizadas (`getShared` + `loadPromise`). Páginas HTML recebem `Cache-Control: no-store` para refletir sempre o estado de login no SSR.

### Fluxo de requisição típico

```
Cliente → GET /api/channels?page=1&limit=24
  1. requestId (UUID → X-Request-Id)
  2. helmet / CORS / removeFingerprint / globalLimiter
  3. sanitizeXss + sanitizeMongo + securityLogger
  4. channelRoutes → requireApiAuth (valida JWT API + confere apiToken literal) → apiLimiter
  5. ChannelController.getAllChannels → M3UService.getAllChannels()
  6. toPublicChannels (remoção de url/source) → JSON { success, data }
```

### Fluxo de reprodução (proxy selado)

```
GET /api/channels/:id/stream?token=<playback>
  → player HTML (HLS.js) consome — sempre — a URL do proxy:
GET /api/channels/:id/proxy?token=<playback>
  → GATING de estado antes de qualquer rede: blocked → 403 / maintenance → 503
  → resolve alvo server-side (URL do canal OU blob ?p= selado)
  → assertSafeTarget (anti-SSRF, protocolo http/https)
  → FAILOVER na requisição inicial: tenta fonte ativa (resolveSourceUrls),
    em erro de rede tenta a alternativa (SSRF_BLOCKED nunca dispara failover)
  → busca na origem (maxRedirects:0, redirects revalidados manualmente, até 5 hops)
  ├─ Playlist (.m3u8)  → reescrita: cada URI vira ?token=&p=<blob AES-256-GCM>
  └─ Segmento (.ts/.m4s…) → pipe direto (streaming)
```

---

## 🧱 Estrutura do Projeto

```
api-stream-m3u8/
├── index.js                     # Entrypoint local (dev) — listen + connectDB
├── package.json
├── vercel.json                  # Vercel → build src/app.js, região gru1
├── AGENTS.md                    # Guia operacional para agentes de IA/desenvolvedores
├── .env.example                 # Template de variáveis de ambiente
├── prisma/
│   ├── schema.prisma            # 13 models (users, roles, usage, audit, analytics,
│   │                            #   password_reset_codes, ...)
│   └── migrations/              # Migrações versionadas (init, session_version,
│                                #   audit_logs, analytics_playlists,
│                                #   password_reset_and_terms)
├── docs/                        # Relatórios técnicos e diretrizes (ver seção docs/)
├── tests/                       # Suíte node:test (12 arquivos: auth/senha/reset,
│                                #   EPG, M3U/health/estados, analytics, recomendações)
├── scripts/                     # smoke-health, e2e-playlists-analytics, cleanup e2e
├── views/                       # Templates EJS (SSR)
│   ├── partials/                #   head, navbar, footer, flash
│   └── pages/                   #   index, login, register, forgot-password,
│                                #   reset-password, termos, dashboard, profile,
│                                #   playlists, guia, admin
├── public/                      # Estáticos
│   ├── css/                     #   base, auth, landing, dashboard, profile,
│   │                            #   playlists, guia, admin
│   └── js/                      #   auth, forgot-password, reset-password,
│                                #   dashboard, playlists, profile, guia, admin,
│                                #   realtime (polling)
└── src/
    ├── app.js                   # Wiring Express (produção/Vercel)
    ├── config/                  # app.js (env centralizada), database.js,
    │                            #   epgAliases.js (exceções de matching EPG↔M3U)
    ├── constants/               # (vazio — reservado)
    ├── controllers/             # auth, channel, admin, user, playback, epg
    ├── middlewares/             # auth, webAuth, rateLimiter, streamLimiter,
    │                            #   requestId, security, validate,
    │                            #   errorHandler (+ notFound + requestLogger)
    ├── models/                  # User.js (modelo/agregação de regras de usuário)
    ├── repositories/            # userRepository.js, passwordResetCodeRepository.js
    ├── prisma/                  # client.js (pooler com pgbouncer p/ serverless)
    ├── routes/                  # index, auth, channel, admin, user, playback,
    │                            #   epg, web
    ├── services/                # m3uService, channelHealthService, channelStateService,
    │                            #   authService, emailService, passwordResetService,
    │                            #   streamTokenService, ssrfGuard, auditService,
    │                            #   rateLimitService, redisStore, avatarService,
    │                            #   playbackService, playlistService,
    │                            #   recommendationService, analyticsService,
    │                            #   epgService, bootstrapService
    ├── utils/                   # publicChannel, metrics, analytics, passwordPolicy,
    │                            #   dbState, logger, helpers, supabaseClient
    └── Player/                  # index.html, player.js, player.css, epgBar.js, assets/
```

---

## ⚙️ Tecnologias

### Backend

| Tecnologia | Propósito |
|---|---|
| **Node.js (18+)** | Runtime server-side |
| **Express (4.18)** | Framework HTTP / rotas |
| **Prisma + @supabase/supabase-js** | ORM PostgreSQL (Supabase) + Storage (avatares) |
| **jsonwebtoken / bcryptjs** | JWT (sessão/API/playback) + hash de senha (bcrypt 12 rounds) |
| **helmet / cors / express-rate-limit** | Headers de segurança, CORS e rate limiting |
| **Joi** | Validação de schemas (erros → 422 com `errors[]`) |
| **winston + morgan** | Logs estruturados + logging HTTP |
| **multer** | Upload de avatar (máx. 5 MB) |
| **axios** | Cliente HTTP do proxy HLS e download de M3U remotas |
| **fast-xml-parser** | Parse do XMLTV (`EPG_URL`) no `epgService` |
| **nodemailer** | Envio de e-mails transacionais (código de recuperação de senha via SMTP) |

### Frontend

| Tecnologia | Uso |
|---|---|
| **EJS (SSR)** | Páginas web (landing, login, dashboard, perfil, playlists, admin) |
| **HTML5 / CSS3 / Vanilla JS (ES6+)** | Toda a interface |
| **HLS.js (@latest)** | Player HLS (qualidade adaptativa automática) |
| **Fetch API** | Requisições assíncronas |

### Infraestrutura

| Serviço | Uso |
|---|---|
| **Vercel** | Deploy serverless (`vercel.json` → `src/app.js`) |
| **Supabase (PostgreSQL)** | Banco de dados + Storage |
| **Upstash Redis (REST)** | Estado distribuído para rate limiting e concorrência de streams (opcional; fallback em memória) |
| **HTTP/HTTPS** | Protocolo |

---

## 🗄 Dados e Armazenamento

### 1. Catálogo de canais (em memória)

Fonte: playlists M3U configuradas no construtor de `src/services/m3uService.js` (arquivos locais e/ou URLs externas). O parser:

- Extrai metadados `#EXTINF` (`tvg-id`, `tvg-name`, `tvg-logo`, `group-title`);
- Remove tags de qualidade dos nomes (`cleanName`) e detecta qualidade/formato/codificação;
- Valida URLs (`http`/`https`);
- **Deduplicação por merge** (critério: `cleanName` + `quality`): a 1ª ocorrência vira a fonte **primária** (`url`/`primaryUrl`); ocorrências seguintes com URL distinta preenchem `backupUrl`/`backupSource` (base do **failover automático**);
- Gera **IDs determinísticos** `sha1(nome::fonte)` + índice — estáveis entre reloads, porém previsíveis; **autorização nunca depende deles**.

```jsonc
// Objeto interno do canal (a API pública NUNCA expõe url/source/urls)
{
  "id": "globo_sp_fhd_<sha1>_<idx>",
  "name": "Globo SP [FHD]",
  "cleanName": "Globo SP",
  "originalName": "Globo SP [FHD]",
  "url": "https://upstream-exemplo.com/stream.m3u8",   // interno (alias da primária)
  "primaryUrl": "https://upstream-exemplo.com/stream.m3u8", // fonte 1
  "backupUrl": "https://mirror.com/stream.m3u8",        // fonte 2 (se existir)
  "urls": ["https://upstream-exemplo.com/stream.m3u8", "https://mirror.com/stream.m3u8"], // interno
  "source": "SvenTvChannels.m3u",                      // interno
  "logo": "https://.../logo.png",
  "category": "Abertos",
  "tvgId": "globo-sp",
  "slug": "globo-sp-fhd",
  "quality": "FHD (Full HD)",
  "availability": "Disponível",
  "format": "HLS",
  "encryption": "Padrão",
  "isLive": true,
  "state": "live"                                      // live | maintenance | blocked
}
```

**Sanitização pública:** `src/utils/publicChannel.js` aplica uma whitelist explícita (`id, name, cleanName, originalName, tvgId, logo, category, slug, quality, availability, format, encryption, isLive, state`) em todas as respostas públicas/SSR — garante que a origem upstream (`url`/`primaryUrl`/`backupUrl`/`urls`/`source`) nunca vaze.

### 1.1 Guia de Programação (EPG)

O `epgService` (singleton `getShared()`) baixa o XMLTV definido em `EPG_URL` (segredo, nunca logado/exposto) com cache em memória (`EPG_CACHE_TTL_MS`, padrão 30 min) e **fail-open**: falha de fetch/parse mantém o cache anterior e nunca derruba a API.

- **Matching por nome normalizado + alias map** (`src/config/epgAliases.js`, versionado, 34 entradas): a normalização remove pontuação/símbolos (`REDETV!` → `redetv`) e colapsa espaços; o alias map mapeia canais regionais → nacional e renomeações. O id do XMLTV **nunca** vira o `channelId` interno (previsível/sha1);
- **Todos os canais da M3U entram no guia** — quem tem match EPG mostra a programação; quem não tem aparece com `epgChannelId: null`, `programmes: []` e `displayName` da M3U ("Sem programação no período" é tratado no frontend, nunca como ausência de canal). A grade **nunca esconde** um canal da lista oficial;
- Endpoints: `GET /api/epg` (todos os canais da M3U + `now`/`next`, nulos quando sem match), `GET /api/epg/:channelId` (grade completa de um canal; **404 se sem match**) e `GET /api/admin/epg/unmatched` (relatório de canais EPG sem match → alimenta o alias map);
- Página `/guia` (SSR + JS): **grid EPG profissional** — timeline de horas (sticky) articulada à coluna fixa de canais, células posicionadas por eixo de tempo com cores por categoria, linha do "agora" sincronizada, filtros por categoria/busca (via atributo `hidden` com CSS compatível `.epg-row[hidden]`), modal de detalhes do programa e player por playback token.
- **Kill switch**: `EPG_ENABLED=false` → `/api/epg` devolve lista vazia (`success: true`), `/guia` redireciona a `/dashboard` e o link some do navbar. `EPG_URL` ausente **não** esconde a página — a grade abre vazia ("Sem programação no período") até a fonte ser configurada. O cache é **em memória por lambda** (mesma limitação do catálogo M3U).
- **Player**: a janela do player (`now`−1h→+12h) é fornecida server-side via `epgService.getPlayerWindow` (interseção **sem recorte** de horários — progresso real) e embutida no HTML (`safeScriptJson`) — nunca buscada pelo navegador.

### 2. Postgres (Supabase) — 13 modelos Prisma

| Model / Tabela | Propósito |
|---|---|
| `User` (`users`) | Perfil, credenciais, papéis, `apiToken`, `apiTokenVersion`, **`sessionVersion`**, bloqueio/restrição, **aceite dos Termos (`termsAcceptedAt`/`termsVersion`)**, auditoria básica |
| `Role` / `UserRole` | Papéis (`user`, `admin`) e vínculo N-N |
| `RequestUsage` | Cota por usuário por bucket de 1 minuto (rate limit por plano) |
| `AuditLog` | Trilha de auditoria de operações sensíveis (sem FK — sobrevive à exclusão do usuário) |
| `PasswordResetCode` | Códigos de recuperação de senha — guarda **apenas o SHA-256** (`codeHash`), `expiresAt`, `attempts` e `usedAt` (uso único) |
| `PlaybackSession` | Sessão de reprodução aberta por player (`sessionId` único global) |
| `PlaybackEvent` | Eventos discretos (`play/pause/resume/stop/ended`) |
| `WatchHistory` | Histórico consolidado — 1 linha por `(userId, channelId)` |
| `Playlist` / `PlaylistChannel` | Playlists pessoais com **regra "1 canal = 1 playlist por usuário"** (`UNIQUE(userId, channelId)`) |
| `ChannelMetric` / `UserMetric` | Agregação diária (idempotente) para séries longas |

Todos os snapshots de canal em tabelas novas guardam **apenas metadados públicos** (nome/logo/categoria) — nunca a URL upstream.

---

## 🔐 Autenticação e Sessões

Três tipos de token JWT, com segredos distintos:

| Token | Segredo | Expiração | Uso |
|---|---|---|---|
| **Session** | `JWT_SECRET` | 7 dias (`JWT_SESSION_EXPIRES_IN`) | Páginas web; entregue em **cookie httpOnly** `sessionToken` (`sameSite: Lax`); validado por `requireSessionAuth` e `webAuth.resolveUser` |
| **API** | `JWT_API_SECRET` | 365 dias (`JWT_API_EXPIRES_IN`) | Apps/integrações; `type:'api'`, enviado via `Authorization: Bearer` ou `?token=`; validado por `requireApiAuth`, inclui **conferência literal** com `user.apiToken` |
| **Playback** | `JWT_PLAYBACK_SECRET` (ou derivado de `JWT_API_SECRET`) | ~2h (`PLAYBACK_TOKEN_EXPIRES_IN`) | Player/iframe; claim `ch` vinculado a **um único canal**; emitido por `POST /api/channels/:id/playback` com API token |

### Revogação server-side

- O session token carrega a claim `sv` (`sessionVersion`). **Logout e troca de senha incrementam a versão** (`User.bumpSessionVersion`), invalidando todos os tokens antigos daquele usuário em qualquer dispositivo (checado em `auth.js` → 401 e `webAuth.js` → anônimo/redirect).
- O API token carrega `tv` (`apiTokenVersion`) e é comparado literalmente ao valor salvo — regenerar/bloquear revoga na hora (`/auth/regenerate-token`, bloqueio admin).
- **O frontend nunca guarda `sessionToken` em localStorage** — apenas cookie httpOnly; `extractToken` aceita fallback do cookie somente para a API.

### Fluxo de acesso ao player

1. App autentica com **API token** → `POST /api/channels/:id/playback` → recebe **playback token** (~2h, restrito ao canal).
2. Player abre `/stream` e `/proxy` com o playback token (ou API token, retrocompatível), via `requireStreamAccess`.
3. Playback token usado em outro canal → **403**. O token é revalidado contra `user.apiTokenActive`/`accountRestricted` (bloqueio por inadimplência derruba o stream).

### Política de senha

- **Mínimo de 8 caracteres** (`PASSWORD_MIN_LENGTH`), com 1 minúscula + 1 maiúscula + 1 número;
- **Máximo de 72 bytes UTF-8** (`PASSWORD_MAX_BYTES`) — o bcrypt trunca acima disso, o que faria duas senhas distintas gerarem o mesmo hash. O limite é medido em **bytes** (`Buffer.byteLength`), não caracteres; validado no middleware (422) e replicado no `authService` (defesa em profundidade);
- Hash com **bcrypt 12 rounds** (`BCRYPT_ROUNDS`).

### Recuperação de senha (código de 6 dígitos)

- `POST /api/auth/forgot-password` → gera código de 6 dígitos (`crypto.randomInt`, CSPRNG), persiste **só o SHA-256** e envia por e-mail. Resposta **genérica** (anti-enumeração: e-mail existente e inexistente são idênticos); falha de SMTP não vaza para o cliente;
- `POST /api/auth/reset-password` → valida e-mail + código: **TTL de 15 min**, **máx. 5 tentativas** (incremento atômico condicional), **consumo único atômico** (uma única instrução SQL com CTE: `usedAt IS NULL` + `attempts < max` + `expiresAt > now` no próprio UPDATE — impede corrida de dupla redefinição sem transação explícita, compatível com o pooler do Supabase) e **incremento de `sessionVersion`** na mesma instrução, revogando **todas** as sessões;
- Nenhum auto-login após o reset (redireciona para `/login`); todas as respostas são genéricas ("Código inválido ou expirado").

### Termos de Uso versionados

- Versão centralizada em `TERMS_VERSION` (default `2026-09-16`); página pública `/termos`;
- Registro exige `acceptedTerms === true` (booleano estrito, não aceita `"true"`/`1`) e grava `termsAcceptedAt`/`termsVersion` no usuário; métrica `termsAccepted`.

---

## 📡 API REST — Endpoints

**Base URLs** — Dev: `http://localhost:3000` · Prod: `https://<seu-dominio>.vercel.app`

**Convenções:** respostas `{ success, message, data }`; validação Joi → **422** com `errors[]`; erros de negócio trazem `code` estável (ex.: `CHANNEL_ALREADY_SAVED`) com **409**; erros de segurança nunca expõem IP/URL internos.

### Sistema

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/health` | Público | Health check **mínimo de propósito** (`success/status/message/timestamp`) — sem pid, memória, plataforma ou versão |
| GET | `/api/info` | Público | Metadados da API (versão, autenticação, endpoints) |

### Autenticação

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/api/auth/register` | Público (`registerLimiter`) | Criar conta — retorna `user`, `sessionToken`, `apiToken` e seta cookie |
| POST | `/api/auth/login` | Público (`loginLimiter`) | Login — bloqueio após 5 tentativas por 15 min |
| POST | `/api/auth/logout` | Sessão | Revoga **todas** as sessões (bump `sv`) e limpa cookie |
| GET | `/api/auth/profile` | Sessão | Perfil + API token |
| GET | `/api/auth/api-token` | Sessão | Retorna só o API token (sob demanda, não no HTML) |
| PUT | `/api/auth/profile` | Sessão | Atualiza nome/avatar |
| POST | `/api/auth/avatar` | Sessão | Upload de avatar (arquivo ≤5 MB ou URL) → Supabase Storage |
| POST | `/api/auth/change-password` | Sessão | Troca de senha (revoga outras sessões; reemite a atual) |
| POST | /api/auth/forgot-password | Público (`forgotPasswordLimiter`) | Solicita código de 6 dígitos (anti-enumeração; resposta genérica; SMTP fail-safe) |
| POST | /api/auth/reset-password | Público (`resetPasswordLimiter`) | Redefine a senha com o código (TTL 15 min, 5 tentativas, uso único; revoga TODAS as sessões) |
| POST | `/api/auth/regenerate-token` | Sessão | Revoga e gera novo API token |

### Canais (exigem API token)

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/channels` | API | Lista completa; `?page=&limit=` opcional (cap 500). Sem parâmetros → lista completa (retrocompatível) com **ETag** (responde **304** com `If-None-Match` válido; o valor muda quando a playlist ou um estado de canal muda; `Cache-Control: no-cache`) |
| GET | `/api/channels/stats` | API | Totais por categoria/formato/fonte |
| GET | `/api/channels/categories` | API | Categorias disponíveis |
| GET | `/api/channels/search?q=` | API | Busca por nome, cleanName, categoria ou tvgId |
| GET | `/api/channels/category/:category` | API | Canais da categoria |
| GET | `/api/channels/:id` | API | Detalhe do canal (sem `url`/`source`) |
| POST | `/api/channels/:id/check` | API + admin | Checagem de saúde sob demanda |
| POST | `/api/channels/:id/playback` | API | Emite playback token curto do canal |
| GET | `/api/channels/:id/stream` | API **ou** playback (+ `streamLimiter` + anti-hotlink) | HTML do player (iframe) |
| GET | `/api/channels/:id/proxy` | API **ou** playback (+ `proxyStreamLimiter` + anti-hotlink) | Proxy HLS selado (playlists + segmentos) |
| GET | `/api/channels/statuses` | API + admin | Status de saúde dos canais |
| POST | `/api/channels/reload` | API + admin | Força re-download/reparse das fontes M3U |

### Guia de Programação (EPG)

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/epg` | API | **Todos os canais da M3U** com `now`/`next` (nulos quando sem match EPG); lista vazia se `EPG_ENABLED=false` |
| GET | `/api/epg/grid?from=&to=` | API | **Grade do grid**: programação por canal recortada à janela (epoch ms; padrão "agora − 2h → +25h"; máx. 7 dias; 422 com `errors[]` se inválida) — **inclui canais sem EPG** (células vazias); alimenta `/guia` |
| GET | `/api/epg/:channelId` | API | Grade completa de um canal (**404** se sem match EPG) |

### Área pessoal (session **ou** API)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/dashboard` | Histórico recente + playlists (8) + recomendações em 1 chamada |
| GET | `/api/user/history?limit=&cursor=` | Histórico consolidado (paginação cursor por `lastPlayedAt`) |
| GET | `/api/user/recommendations?limit=` | Recomendações com razões em PT-BR |
| GET/POST | `/api/user/playlists` | Listar / criar playlists |
| GET/PUT/DELETE | `/api/user/playlists/:playlistId` | Detalhe / editar / excluir |
| GET | `/api/user/playlists/:playlistId/channels` | Canais da playlist (metadados públicos) |
| POST | `/api/user/playlists/:playlistId/channels` | Salvar canal (**409** `CHANNEL_ALREADY_SAVED` se já salvo; 422 `PLAYLIST_FULL` se atingiu o limite) |
| DELETE | `/api/user/playlists/:playlistId/channels/:channelId` | Remover canal |
| POST | `/api/user/playlists/create-with-channel` | Criar playlist + salvar canal em transação |
| GET | `/api/user/playlists/status/:channelId` | Playlist que contém o canal (estado do modal) |

### Tendências (Top 10 do catálogo — session **ou** API)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/trending` | Filmes + séries + programações ao vivo em alta em **1 chamada** (alimenta os carrosséis da dashboard) |
| GET | `/api/trending/movies` | Top 10 filmes mais assistidos (apenas metadados públicos) |
| GET | `/api/trending/series` | Top 10 séries mais assistidas (apenas metadados públicos) |
| GET | `/api/trending/channels` | Programações ao vivo mais assistidas no momento |

As rotas de tendências consultam um **catálogo GraphQL externo** (`TRENDING_API_URL`),
com cache em memória (TTL `TRENDING_CACHE_TTL_MS`) e **fail-open**: provedor offline,
desligado (`TRENDING_ENABLED=false`) ou sem resposta → listas vazias com `success: true`
(os carrosséis ficam ocultos no frontend), **nunca 500**. Só saem metadados públicos
(título, imagens, gênero, duração, logo) — nenhuma URL de stream, nenhum IP, e a URL
do provedor nunca aparece nas respostas nem nos logs. Na dashboard a seção é **re-pollada
a cada 30 min** (o cache server-side dura 30 min — o polling de 30s ficaria repetindo o
mesmo snapshot; helper `Realtime` não sobrepõe requisições e pausa em aba oculta).

### Playback (session **ou** API **ou** playback do canal)

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/playback/events` | Ingestão de `play/pause/resume/stop/ended` |
| POST | `/api/playback/heartbeat` | Atualiza sessão (sem linha de evento); 200 `INACTIVE` se expirou |

### Administração (sessão + role `admin`)

Todas as ações de escrita admin passam por um **limiter dedicado** (`adminWriteLimiter`,
60 ops/min por admin autenticado — `RATE_LIMIT_MAX_ADMIN_WRITE`); GETs ficam fora
para não atrapalhar operações legítimas. Respostas de usuários usam a **DTO whitelist**
(`serializeAdminUser`) que **nunca** expõe `password`, `apiToken`, `sessionVersion`, etc.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/admin/users?page=&limit=&search=&status=` | Lista usuários (busca nome/e-mail case-insensitive, filtro de status, cap 500) |
| GET | `/api/admin/users/:userId` | Detalhe de um usuário (modal do painel) — audita `admin.user.view` |
| PUT | `/api/admin/users/:userId/role` | Altera papel (`user`/`admin`). Recusa demover o próprio admin ou o último admin ativo |
| PUT | `/api/admin/users/:userId/block` | Bloqueia/desbloqueia (revoga API tokens + sessões, altera status). Guardas anti-self-lockout e anti-último-admin |
| PUT | `/api/admin/users/:userId/profile` | Atualiza nome/e-mail (whitelist; e-mail duplicado → 409) — audita `admin.user.profile_updated` |
| POST | `/api/admin/users/:userId/password` | Redefine senha (política completa) e revoga **todas** as sessões — audita `admin.user.password_changed` |
| POST | `/api/admin/users/:userId/avatar` | Upload multipart `avatar` (JPG/PNG/WEBP/GIF ≤5MB, validado por **magic bytes**) ou `imageUrl` (com **guarda SSRF**) — audita `admin.user.avatar_updated` |
| DELETE | `/api/admin/users/:userId` | Exclusão permanente, exige `{ "confirm": true }` no corpo (nunca apenas `confirm()` no navegador). Audita `admin.user.deleted`; a trilha sobrevive (audit_logs sem FK) |
| GET | `/api/admin/channels` | Canais com status online/offline/unknown (**sem url/source**) |
| POST | `/api/admin/channels/reload` | Recarrega M3U |
| POST | `/api/admin/channels/:channelId/check` | Checagem individual |
| POST | `/api/admin/channels/check-all` | Checagem em massa |
| PUT | `/api/admin/channels/:channelId/state` | Define estado do canal (`live`/`maintenance`/`blocked`) — audita `admin.channel.state` |
| GET | `/api/admin/metrics` | Métricas operacionais em memória (proxy, streams ativos, latência, **`liveControl`** — espectadores por canal) |
| GET | `/api/admin/metrics/analytics?period=today\|7d\|30d\|90d\|custom` | KPIs de analytics (overview, top canais/categorias/usuários, série por dia) |
| GET | `/api/admin/metrics/history?period=` | Série longa via tabelas agregadas |
| POST | `/api/admin/metrics/aggregate` | Backfill manual da agregação diária (máx. 90 dias) |
| GET | `/api/admin/audit-logs?limit=&page=&action=` | Consulta da trilha de auditoria |
| GET | `/api/admin/epg/unmatched` | Relatório de canais EPG sem match na M3U (contadores + amostras) — audita `admin.epg.unmatched_view` |
| PUT | `/api/admin/channels/bulk-state` | Estado em lote (≤50 itens): `{ items: [{ channelId, state, reason? }] }`. Itens **independentes** (erro num item não derruba o lote); resposta `{ applied, failed, results[] }`. Audita `admin.channel.state` por item + `admin.channel.bulk_state` |
| PUT | `/api/admin/users/bulk` | Ações em lote (≤50 itens): `{ items: [{ userId, action: block\|unblock\|promote\|demote\|delete, reason?, confirm? }] }`. Guardas por item: anti-self-lockout, último admin ativo e `confirm:true` para delete (nunca apenas `confirm()` no navegador). Audita `admin.users.bulk` |
| GET | `/api/admin/export/analytics.csv?period=` | Exporta KPIs por canal + série diária como **CSV seguro** (streaming com cursor, `today\|7d\|30d\|90d\|custom`) — audita `admin.analytics.export_csv` |
| GET | `/api/admin/export/audit-logs.csv?from=&to=` | Exporta a trilha de auditoria (`from`/`to` obrigatórios, `from ≤ to`, máx. **366 dias** → 422; streaming com cursor composto `(createdAt,id)`) — audita `admin.audit_logs.export_csv` |

Os dois fluxos de **lote respeitam as mesmas proteções das rotas individuais** (canal inexistente vira
item-falha com `failReason`; usuário inexistente, auto-bloqueio, último admin e delete sem `confirm`
também viram item-falha — a operação legítima nunca falha por causa de um item inválido no mesmo lote).
Os **CSVs são neutros contra injeção de fórmula** (`src/utils/csv.js`): células iniciando com `=`, `+`,
`-`, `@`, tab ou CR recebem prefixo `'` e a cotação RFC 4180 é aplicada; o `Content-Disposition` é
sanitizado. Streaming entrega linha a linha (memória estável, jamais carrega a tabela inteira).

---

## 🔒 Segurança

Princípio de prioridade do projeto: **Segurança > Privacidade > Correção > Estabilidade > Observabilidade > Performance > Escalabilidade > Conveniência**.

### Camadas implementadas

- **Helmet**: headers de segurança globais; CSP/frameguard desabilitados no `app.js` porque o player é embutível — ver abaixo.
- **CORS**: `ALLOWED_ORIGINS` vírgula-separada; sem a variável → `*`.
- **Sanitização**: `sanitizeMongo` (chaves `$`/`.`) e `sanitizeXss` (escape HTML) globais em `req.body/query/params`, **exceto** em `/stream` e `/proxy` — exceção **intencional** (escapar corromperia `?p=`/`?token=`). Não "consertar".
- **Remove fingerprint**: headers `X-Powered-By` e `Server` removidos.
- **Security logger**: detecta e loga path traversal, SQLi básico, XSS e NoSQL residual.
- **Clickjacking**: `X-Frame-Options: SAMEORIGIN` global **exceto** `/stream`/`/proxy`, que usam CSP `frame-ancestors *` no controller (substitui o antigo `ALLOWALL`).
- **Anti-hotlink**: `/stream` e `/proxy` exigem token válido **ou** referer permitido (sem token + referer fora da origem → 403).
- **Anti-SSRF (`ssrfGuard`)**: antes de qualquer request de saída do proxy, valida protocolo (`http/https`), resolve DNS→IP (mantendo `smartLookup` para IPs literais) e bloqueia loopback, link-local (`169.254.0.0/16` — incluindo `169.254.169.254`), redes privadas, ULA IPv6, multicast e IPv4-mapped. Falha → **403/502 genérico sem vazar IP/URL**.
- **Gating de estado antes do upstream**: canal `blocked` → **403** e `maintenance` → **503** em `/stream`, `/proxy` e ao emitir playback token. Um canal bloqueado **não** consome vaga de stream, **não** dispara health check e **não** abre socket para a origem. `SSRF_BLOCKED` **nunca** dispara failover (segurança primeiro).
- **Playback token**: curto, por canal, segredo próprio — o player nunca usa o API token permanente.
- **Proxy selado**: sub-recursos referenciados por `?p=<iv.tag.ct>` (AES-256-GCM) — tampering detectado e rejeitado; `?u=` legado devolve **400**.
- **Rate limiting por contexto**: global / login / register / api / stream / user / events / **forgot** / **reset** / proxy. Store **híbrida Upstash Redis → memória** (janela atômica distribuída; fallback local nunca vira 429/500 indevido). Cota por plano via upsert em `RequestUsage` (bucket 1 min). `GET /api/channels/:id/proxy` é **excluído** dos buckets global e api (segmentos HLS não consomem cota REST) e tem janela própria (`RATE_LIMIT_PROXY_WINDOW_MS`).
- **Política de senha**: mínimo 8 caracteres (maiúscula + minúscula + número) e **máximo 72 bytes UTF-8** (linha de corte do bcrypt) — validado no middleware e no serviço.
- **Recuperação de senha endurecida**: código CSPRNG de 6 dígitos, **hash SHA-256** no banco, TTL 15 min, 5 tentativas, **uso único transacional** e revogação de todas as sessões; `SMTP_PASS`/host nunca logados.
- **Termos de Uso versionados**: aceite obrigatório no registro (`acceptedTerms === true`) e versão gravada no usuário.
- **Bloqueio de conta**: 5 tentativas de login → 15 min (bcrypt 12 rounds; limiter login keyed por IP+email).
- **Request ID (observabilidade)**: UUID por requisição, header `X-Request-Id` (entrada validada contra log forging), correlacionado em logs/auditoria/erros.
- **Trilha de auditoria**: `auditService` grava (fire-and-forget) login, registro, **aceite dos Termos (`TERMS_ACCEPTED` com versão)**, troca de senha, regeneração/revogação de API token, logout, emissão de playback, operações admin e **todo o ciclo de recuperação de senha** (`PASSWORD_RESET_REQUESTED/CODE_SENT/SEND_FAILED/CODE_INVALID/CODE_EXPIRED/ATTEMPTS_EXCEEDED/CODE_VERIFIED/CODE_INVALIDATED/COMPLETED/FAILED`). Nunca persiste segredos.
- **Métricas leves**: contadores em memória expostos somente a admin — `/api/health` permanece **mínimo**.
- **Liberação de dependências**: `npm audit` → **0 vulnerabilidades**.
- **Retenção de dados**: cleanup probabilístico (~2%) do `RequestUsage` e retenção em cascata de eventos/sessões/agregações de analytics.

### Rate limit padrão (configuráveis via env)

| Contexto | Limite/min (padrão) | Observação |
|---|---|---|
| global | 200 | Aplicado a toda a API; proxy excluído |
| login | 20 | key = `ip_email` (bloqueia brute-force sem derrubar IPs compartilhados) |
| register | 10 | |
| api | 100 (ou cota do plano) | Resposta com `X-Plan-Limit`/`X-Plan-Usage`; por usuário via `RequestUsage` |
| stream | 50 (± plano) | |
| user | 120 | `/api/user/*` e `/dashboard` |
| events | 600 | `/api/playback/*` (heartbeat de 30s não pode ser cortado) |
| proxy | 1200 | `/api/channels/:id/proxy` — freio de abuso, cota alta (janela própria `RATE_LIMIT_PROXY_WINDOW_MS`) |
| forgot | 3 / 15 min | `POST /api/auth/forgot-password`, key = `ip_email` (anti-spam de código) |
| reset | 10 / 15 min | `POST /api/auth/reset-password`, key = `ip` (anti brute-force distribuído) |

> ⚠️ A store é **híbrida**: com **Upstash Redis** configurado (`UPSTASH_REDIS_REST_URL`/`TOKEN`) o limite é **global** entre instâncias; sem ele (ou com o kill switch `DISTRIBUTED_STATE_ENABLED=false`) cai para **memória por instância lambda**. A falha do Redis nunca vira 429/500 indevido — apenas fallback + métrica (`rateLimitRedisFallbacks`).

---

## 🎬 Streaming: Proxy HLS Selado

### Blob selado (`?p=`)

- Cada sub-recurso da playlist HLS (segmentos `.ts`, variantes, `EXT-X-KEY`/`EXT-X-MAP`/`EXT-X-MEDIA`) é reescrito como:
  ```
  ?token=<auth>&p=<iv>.<tag>.<ciphertext>
  ```
- Payload cifrado: `"channelId|url"`; chave derivada via SHA-256 de `<JWT_PLAYBACK_SECRET || JWT_API_SECRET>::stream-seal`.
- O proxy só abre blobs cujo canal confere com a rota (`?p=` de outro canal → **403**).
- **O navegador nunca vê a URL upstream**: nem no manifesto, nem nos segmentos, nem em erros.

### Fluxo

1. `isInitialRequest` (sem `?p=`) → adquire vaga no **streamLimiter** (1 stream simultâneo por usuário, TTL 5 min) e valida o alvo com `assertSafeTarget`.
2. Playlist `.m3u8` → baixada, reescrita 100% para o proxy (`?p=`) e entregue como `application/vnd.apple.mpegurl`.
3. Segmentos/binários → pipe direto (preserva `Content-Type`, `Range`, `Accept-Ranges`).
4. Redirects: `maxRedirects: 0` no axios + re-validação anti-SSRF **a cada hop** (até 5). Timeout de upstream 15s, 1 retry com backoff de 300ms.

### Failover automático de fontes

Quando um canal tem 2+ fontes (mesmo `cleanName + quality` em fontes distintas → `primaryUrl`/`backupUrl`):

- `channelHealthService` mantém health **por fonte**, troca para backup após `HEALTH_FAILOVER_THRESHOLD` falhas consecutivas da fonte ativa (com anti-flapping via `minSwitchMs`) e faz **failback** quando a primária volta;
- Falha de rede na requisição inicial do proxy tenta a fonte ativa e depois a alternativa (`resolveSourceUrls`); **sub-recursos `?p=` são blobs selados na URL exata** — failover só na requisição inicial;
- **`SSRF_BLOCKED` NUNCA dispara failover**; `proxyFailovers` contado quando a fonte usada difere da preferida.
- > Status hoje: a playlist ativa tem **1 fonte** (89 canais, sem duplicatas) → o mecanismo está **disponível e inativo** até existir uma 2ª fonte (coberto por testes com fixtures de 2 fontes).

### Controle de concorrência

`streamLimiter` limita streams HLS simultâneos por usuário (padrão 1; admin/plano configurável), com liberação idempotente em `close`. A vaga é uma **janela atômica no Upstash Redis** (com TTL, `STREAM_SLOT_TTL_MS`) quando disponível, caindo para o `Map` local em memória com fallback (`streamLimiterFallbacks`). Sem Upstash, vale por lambda — mitigação parcial no serverless (ADR-006).

---

## 📊 Analytics, Playlists e Recomendações

Fluxo ponta a ponta:

```
Player (iframe) ── token (playback ~2h | API)
   ▼
POST /api/playback/events | /heartbeat   (requireEventAuth: session|api|playback)
   ▼
playbackService
   ├─ playback_sessions   (sessão ativa; heartbeat só atualiza)
   ├─ playback_events     (eventos discretos: play/pause/resume/stop/ended)
   └─ watch_history       (upsert (userId, channelId) — idempotente na finalização)
   ▼
userController (dashboard)  →  histórico recente + playlists + recomendações
playlistService             →  CRUD com regra "1 canal = 1 playlist por usuário"
analyticsService            →  métricas admin ao vivo + agregação diária + retenção
```

**Princípios**

- Canais continuam fora do banco — sessões/histórico/playlists guardam snapshot de metadados públicos, nunca a URL.
- Watch time acumulado **monotonicamente** (`watchDurationMs`, BIGINT serializado com `bigToNumber`); finalização idempotente (`stop`/`ended` → completed, timeout → abandoned).
- **Regra de negócio**: um canal pertence a no máximo **uma playlist por usuário**, garantida em 3 camadas: `UNIQUE(userId, channelId)` no banco, pré-checagem no serviço e captura de `P2002` na corrida → **409 `CHANNEL_ALREADY_SAVED`** (com nome da playlist). `create-with-channel` roda em transação.
- **Recomendações**: score determinístico por afinidade de categoria (tempo × 2 + frequência × 10 + recência exponencial), excluindo já assistidos/offline/geo-bloqueados/formatos não-HLS, com **razões em PT-BR** e cache **sempre por usuário** (TTL 600s).
- **Agregação diária** idempotente alimenta `channel_metrics`/`user_metrics` (séries longas sem recontar sessões); **retenção probabilística** evita lock global em serverless.

---

## 💻 Painel Web e Player

### Páginas (EJS server-side)

| Rota | Descrição |
|---|---|
| `/` | Landing (CTA para login/registro) |
| `/login`, `/register` | Autenticação (redirect se já logado); o registro exige o aceite dos **Termos de Uso** |
| `/forgot-password`, `/reset-password` | Recuperação de senha: solicita o código por e-mail e redireciona para a página do código + nova senha (e-mail pré-preenchido) |
| `/termos` | Termos de Uso versionados (público) |
| `/dashboard` | Catálogo com filtros/busca, grid/list, seções pessoais em **carrossel horizontal** (recentes, playlists, recomendados) e modal "Salvar na playlist" |
| `/profile` | Perfil, avatar, troca de senha e gestão do API token (revelado sob demanda) |
| `/playlists` | CRUD completo de playlists + player embutido com playback token |
| `/guia` | Guia de programação (EPG) com **todos os canais da M3U** (sem EPG = grade vazia), filtros por categoria/busca, linha do "agora" e player por playback token |
| `/admin` | Painel administrativo (usuários, canais com **estado** e failover, **Live Control**, métricas operacionais, analytics, auditoria) |

### Realtime por polling (`public/js/realtime.js`)

- `Realtime.poll({ name, fn, interval })`: agenda sem sobrepor chamadas em andamento, **pausa em aba oculta** e dispara tick imediato ao voltar.
- Integrado: dashboard (pessoal 30s + **trending 30min**), playlists (30s), admin (30s — métricas/auditoria sempre; canais só na aba aberta; analytics apenas no período `today`).
- Escolha de arquitetura: **polling** (não SSE/WebSocket) — compatível com serverless, sem estado persistente.

### Player (`src/Player/`)

- HLS.js com **qualidade adaptativa automática** (`capLevelToPlayerSize`, startLevel -1, buffers e políticas de retry otimizadas; `manifestLoadingTimeOut: 30s` para tolerar cold start serverless).
- Controles: play/pause, volume, fullscreen, PiP, atalhos de teclado, estatísticas em tempo real (resolução, bitrate, FPS, latência, buffer, frames perdidos), auto-hide, persistência em localStorage.
- **Sem menu de configurações manual** (decisão do dono) — reprodução sempre automática.
- **Marca d'água de sessão** (`WatermarkModule`): sobreposição rotativa nos 4 cantos (45s), derivada da sessão **sem PII** (`SvenTV` / `ID: #XXXXX` / `Session: YYYY`), mais evidente ao pausar, sem interferir em cliques.
- **Overlay de estado**: `CHANNEL_DATA.state` (`live`/`maintenance`/`blocked`) — canais em manutenção/bloqueados **não iniciam HLS** e mostram mensagem específica (sem retry infinito).
- **Barra de EPG embutida** (`.player__epg-bar`): **"Passando agora / Próximo / progresso"** — o EPG chega **server-side dentro do HTML** (`CHANNEL_DATA.epg`, janela agora − 1h → agora + 12h gerada por `epgService.getPlayerWindow`, com horários **originais** sem recorte para o progresso ser correto). **Nenhuma requisição de EPG durante a reprodução**: atualização 100% local (`EPGModule`, `setInterval` 30s) e lógica pura testável em `src/Player/epgBar.js` (`normalizeProgrammes`/`computeView`/`computeProgress`). Fail-open: sem cache, `EPG_ENABLED=false` ou canal sem match → `epg: []` e a barra fica oculta (nunca quebra/restrings o player). O JSON embutido é serializado com `src/utils/safeScriptJson.js` (escapa `<>&` + U+2028/U+2029 → neutraliza `</script>`/`<!--`); conteúdo de EPG é renderizado só via `textContent`.
- **Auto-recuperação**: falhas transitórias (lambda fria/rede) re-iniciam o HLS automaticamente com backoff (máx. 2 tentativas) antes de mostrar erro; erros determinísticos (fonte off-line, 404/403/429) fazem 1 tentativa e param. O botão "Recarregar" virou exceção, não caminho padrão.
- **Detecção de formato** via `CHANNEL_DATA.format` + rota de proxy (não depende mais de `.m3u8` na URL — o proxy é selado).
- **Analytics embutido**: envia eventos (`play/pause/resume/stop/ended`) + heartbeat de 30s com `crypto.randomUUID()`; `stop` no `pagehide` com `fetch keepalive`; reutiliza o token da URL do player (playback).
- O player consome **apenas** a URL do proxy (`/api/channels/:id/proxy`) — nunca o upstream.

---

## 🚀 Instalação e Configuração

### Pré-requisitos

| Software | Mínimo |
|---|---|
| **Node.js** | 18.x+ (recomendado 20+) |
| **npm** | 9.x+ |
| **Supabase** | Projeto PostgreSQL ativo (URL de conexão + service role key) |

### Passo a passo

```bash
# 1. Clone e entre no diretório
git clone https://github.com/Team-SvenTV/api-stream-m3u8.git
cd api-stream-m3u8

# 2. Instale dependências (postinstall roda `prisma generate`)
npm install

# 3. Configure o ambiente
cp .env.example .env    # preencha os valores reais (ver seção abaixo)

# 4. (Opcional) Crie os segredos JWT com segurança
npm run generate:secrets

# 5. Aplique as migrações
npx prisma migrate deploy

# 6. Suba o servidor
npm run dev             # http://localhost:3000 (nodemon)
# ou
npm start               # produção

# 7. Verifique
curl http://localhost:3000/api/health
# {"success":true,"status":"healthy",...}
```

> O arquivo de playlist `SvenTvChannels.m3u` deve existir na raiz (ou a URL externa deve estar configurada no construtor de `M3UService`). Sem ele, o catálogo fica vazio.

### Trabalhando com o banco

```bash
npx prisma generate          # regenera o client (pós-mudança de schema)
npx prisma migrate deploy    # aplica migrações pendentes
npm run prisma:migrate       # atalho equivalente
```

**Pooling Supabase**: na Vercel a `DATABASE_URL` DEVE usar o **transaction pooler** (`:6543`); `src/prisma/client.js` injeta `pgbouncer=true&connection_limit=1` automaticamente ao detectar porta 6543 (ou `VERCEL=1`). A CLI do Prisma usa `DIRECT_URL` (apontar **sempre** para `:5432`) — o transaction pooler não suporta DDL.

---

## 🔧 Variáveis de Ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PORT` | — | `3000` | Porta dev |
| `NODE_ENV` | — | `development` | `development` \| `production` |
| `APP_BASE_URL` | p/ e-mail com link | — | URL pública da aplicação usada nos e-mails transacionais para montar o link de `/reset-password`. Vazia → e-mail **sem link** (só instrução em texto) |
| `DATABASE_URL` | ✅ | — | Postgres. **Dev**: `:5432`; **Vercel**: `:6543` (transaction pooler) |
| `DIRECT_URL` | ✅ | — | Usada **apenas pela CLI Prisma** → `:5432` (nunca `:6543`) |
| `SUPABASE_URL` | p/ avatar | — | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | p/ avatar | — | Service role key (nunca commit) |
| `SUPABASE_BUCKET_AVATARS` | — | `SvenTvAvatars` | Bucket de avatares |
| `JWT_SECRET` | ✅ | fallback dev | Assina session tokens (7d) |
| `JWT_SESSION_EXPIRES_IN` | — | `7d` | TTL da sessão |
| `JWT_API_SECRET` | ✅ | fallback dev | Assina API tokens (365d) |
| `JWT_API_EXPIRES_IN` | — | `365d` | TTL do API token |
| `JWT_PLAYBACK_SECRET` | — | derivado | Assina playback tokens; ausente → SHA-256(`JWT_API_SECRET::playback`) |
| `PLAYBACK_TOKEN_EXPIRES_IN` | — | `2h` | TTL do playback token |
| `ALLOWED_ORIGINS` | — | `*` | CORS (vírgula-separada) |
| `BCRYPT_ROUNDS` | — | `12` | Rounds do hash de senha |
| `PASSWORD_MIN_LENGTH` | — | `8` | Mínimo de caracteres da senha |
| `PASSWORD_MAX_BYTES` | — | `72` | Máximo de **bytes UTF-8** (linha de corte do bcrypt) |
| `MAX_LOGIN_ATTEMPTS` | — | `5` | Tentativas antes do bloqueio |
| `LOCK_TIME_MINUTES` | — | `15` | Duração do bloqueio |
| `SMTP_HOST` | p/ recuperação de senha | — | Host SMTP (ex.: `smtp.gmail.com`); ausente → e-mail de recuperação **não é enviado** (fluxo continua genérico) |
| `SMTP_PORT` | — | `587` | Porta SMTP |
| `SMTP_SECURE` | — | `false` | `true` para TLS implícito (porta 465) |
| `SMTP_USER` | p/ SMTP | — | Usuário SMTP |
| `SMTP_PASS` | p/ SMTP | — | Senha/token SMTP (**nunca** logado/exposto) |
| `EMAIL_FROM` | — | `SMTP_USER` | Remetente (`From`) dos e-mails |
| `PASSWORD_RESET_CODE_TTL_MS` | — | `900000` | Validade do código de recuperação (15 min) |
| `PASSWORD_RESET_MAX_ATTEMPTS` | — | `5` | Tentativas incorretas antes de invalidar o código |
| `PASSWORD_RESET_FORGOT_WINDOW_MS` | — | `900000` | Janela do limiter `forgot` |
| `PASSWORD_RESET_FORGOT_MAX` | — | `3` | Cota do limiter `forgot` por `ip_email` |
| `PASSWORD_RESET_RESET_WINDOW_MS` | — | `900000` | Janela do limiter `reset` |
| `PASSWORD_RESET_RESET_MAX` | — | `10` | Cota do limiter `reset` por IP |
| `TERMS_VERSION` | — | `2026-09-16` | Versão dos Termos de Uso (atualizar ao mudar `/termos`) |
| `RATE_LIMIT_WINDOW_MS` | — | `60000` | Janela do rate limit |
| `RATE_LIMIT_MAX_GLOBAL` | — | `200` | Limite global |
| `RATE_LIMIT_MAX_API` | — | `100` | Limite API |
| `RATE_LIMIT_MAX_LOGIN` | — | `20` | Limite login |
| `RATE_LIMIT_MAX_REGISTER` | — | `10` | Limite registro |
| `RATE_LIMIT_MAX_STREAM` | — | `50` | Limite stream |
| `RATE_LIMIT_MAX_USER` | — | `120` | Limite área pessoal |
| `RATE_LIMIT_MAX_EVENTS` | — | `600` | Limite eventos de playback |
| `RATE_LIMIT_MAX_PROXY` | — | `1200` | Limite do proxy HLS |
| `RATE_LIMIT_PROXY_WINDOW_MS` | — | `60000` | Janela própria do proxy HLS (não disputa a cota REST) |
| `DISTRIBUTED_STATE_ENABLED` | — | `true` | Kill switch do estado distribuído; `false` → rate/stream limiter 100% em memória |
| `UPSTASH_REDIS_REST_URL` | p/ distribuído | — | Endpoint REST do Upstash Redis (rate limit + stream limiter globais) |
| `UPSTASH_REDIS_REST_TOKEN` | p/ distribuído | — | Token REST do Upstash (nunca logado/exposto) |
| `REDIS_AVAILABILITY_CACHE_MS` | — | `30000` | TTL do cache local de disponibilidade do Redis (evita healthcheck por request) |
| `CHANNEL_STATE_CACHE_TTL_MS` | — | `8000` | TTL do cache local do estado administrativo de canal (8s = propagação entre instâncias) |
| `CHANNEL_STATE_PERSIST_ENABLED` | — | `true` | Kill switch da persistência do estado de canal; `false` → 100% em memória (hidratação e escrita no banco desligadas) |
| `STREAM_MAX_ACTIVE` | — | `1` | Streams simultâneos por usuário (global via Redis; por lambda sem Redis) |
| `STREAM_SLOT_TTL_MS` | — | `300000` | TTL da vaga de stream (proteção contra lambda morta) |
| `CACHE_TTL_CHANNELS / CATEGORIES / STATS` | — | `300/600/120` | TTL dos caches de catálogo |
| `CACHE_TTL_RECOMMENDATIONS / DASHBOARD` | — | `600/60` | TTL (cache por usuário) |
| `HEALTH_CHECK_INTERVAL_MS` | — | `60000` | Intervalo do ciclo de health check/failover por fonte |
| `HEALTH_REQUEST_TIMEOUT_MS` | — | `8000` | Timeout de cada verificação de canal |
| `HEALTH_FAILOVER_THRESHOLD` | — | `2` | Falhas consecutivas da fonte ativa para acionar failover |
| `HEALTH_FAILBACK_MIN_MS` | — | `120000` | Tempo mínimo no backup antes de tentar voltar à primária |
| `ANALYTICS_HEARTBEAT_MS` | — | `30000` | Intervalo do heartbeat do player |
| `ANALYTICS_SESSION_EXPIRY_MS` | — | `90000` | Abandono de sessão (3 heartbeats) |
| `ANALYTICS_EVENT_RETENTION_DAYS` | — | `30` | Retenção de eventos brutos |
| `ANALYTICS_SESSION_RETENTION_DAYS` | — | `90` | Retenção de sessões |
| `ANALYTICS_METRIC_RETENTION_DAYS` | — | `400` | Retenção de agregações |
| `ANALYTICS_RETENTION_PROBABILITY` | — | `0.01` | Prob. de cleanup oportunista |
| `ANALYTICS_RECENT_LIMIT / RECO_LIMIT` | — | `10/8` | Limites da dashboard (recentes/recomendações) |
| `ANALYTICS_MAX_PLAYLIST_CHANNELS` | — | `500` | Máx. canais por playlist |
| `EPG_URL` | p/ guia | — | URL do XMLTV (segredo — nunca logar/expor); se ausente, a grade abre vazia até ser configurada |
| `EPG_ENABLED` | — | `true` | Kill switch do EPG (false → guia vazio + `/guia` redireciona) |
| `EPG_CACHE_TTL_MS` | — | `1800000` | TTL do cache do XMLTV (em memória por lambda) |
| `EPG_FETCH_TIMEOUT_MS` | — | `10000` | Timeout do fetch do XMLTV |

> `.env` é gitignored e contém segredos reais — **nunca commitar**. Atualize `.env.example` ao adicionar variáveis.

---

## 🧪 Testes

Suíte **unitária** com `node:test` (`npm test`) — **106 testes**:

```bash
npm test
```

Cobertura atual:
- `tests/analytics-utils.test.js` — `bigToNumber`, `formatWatchDuration`, `dayUtc`, `resolveRange`, `daysBetween`, `sweepPeak`, `hourBucketMax`.
- `tests/recommendation.test.js` — afinidade, scoring determinístico, exclusões, limite, cache por usuário, providers injetáveis.
- `tests/public-channel.test.js` — `toPublicChannel`/`toPublicChannels` (nunca `url`/`source`/`primaryUrl`/`backupUrl`/`urls`) e `channelSnapshot`.
- `tests/m3u-service.test.js` — parser M3U e **merge de duplicatas** em `primaryUrl`/`backupUrl` (failover de fontes).
- `tests/channel-health.test.js` — failover após threshold, failback, anti-flapping, `getStatuses`, `reportResult`, canal sem backup.
- `tests/channel-state.test.js` — estados `live`/`maintenance`/`blocked`, erro 422, truncamento de `reason`, singleton.
- `tests/channel-state-persistence.test.js` — read-through com TTL (hit/miss/refresh), fallback `live` e fail-open com banco fora, `ensureLoaded` idempotente, contrato do `channelStateRepository` (upsert/delete/loadAll/`removeStale`) e write-through do admin (upsert p/ `!= live`, delete p/ `live`, fail-open).
- `tests/epg-service.test.js` — parse XMLTV (`#text` com atributos), horários `now`/`next`, normalização de nome, matching por alias, **grid com todos os canais da M3U** (sem match → `programmes: []`/`epgChannelId: null`), fail-open (cache mantido, sem vazar URL), mensagens seguras de erro e guardas de auth das rotas `/api/epg*`.
- `tests/password-policy.test.js` — política de senha pura + byte-limit UTF-8 (multi-byte) + schemas Joi (`confirmPassword` via `Joi.ref`, `acceptedTerms` estrito, 72 bytes, código `^\d{6}$`).
- `tests/password-reset-service.test.js` — anti-enumeração, hash nunca é o código puro, falha SMTP genérica, tentativas, expiração, teto de 5, **consumo concorrente (count-guard)** e bump de `sessionVersion`.
- `tests/email-service.test.js` — template do e-mail (código presente; sem URL/host quando `APP_BASE_URL` ausente; com CTA quando presente), transporte fake sucesso/falha e `SMTP_NOT_CONFIGURED`.
- `tests/rate-limit-store.test.js` — fallback em memória, janela, decrement/reset e chaves por contexto (`RedisRateLimitStore`).
- `tests/session-invalidation.test.js` — token com `sv` correto, `sv` defasado → 401, token legado e integração reset → revogação de sessão.

Scripts de apoio em `scripts/`:
- `smoke-health.js` — smoke HTTP do `/api/health`.
- `e2e-playlists-analytics.js` — E2E contra banco real (25 cenários: auth, playlists, **duplicata → 409**, analytics admin e retenção; cria e remove usuário de teste).
- `cleanup-e2e-users.js` — limpeza de usuários de teste.

Verificação de sintaxe: `node --check` em arquivos alterados (política do projeto — sem linter).

---

## ☁️ Deploy na Vercel

`vercel.json` (região `gru1`) aponta para **`src/app.js`**:

```json
{
  "version": 2,
  "regions": ["gru1"],
  "builds": [{ "src": "src/app.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "src/app.js" }]
}
```

```bash
npm i -g vercel
vercel login
vercel --prod
```

Configure no painel da Vercel **todas** as variáveis de ambiente (atenção redobrada a `DATABASE_URL` = `:6543`, `JWT_SECRET`, `JWT_API_SECRET`, `JWT_PLAYBACK_SECRET`, `ALLOWED_ORIGINS`, `APP_BASE_URL` e, para rate limiting global, `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`). Não há build — o código é executado direto pelo runtime Node.

> ⚠️ Limitações serverless conhecidas: **sem Upstash Redis** o rate limiting e os contadores de concorrência/métricas valem **por instância lambda**; **com Upstash**, rate limit e concorrência de streams passam a ser globais. O catálogo M3U é baixado por instância fria (cache em memória, TTL).

---

## ⚠️ Limitações Conhecidas

- **Rate limiting / concorrência globais dependem do Upstash Redis** — com `UPSTASH_REDIS_REST_URL`/`TOKEN` configurados, o rate limit e a concorrência de streams são globais entre instâncias; **sem** eles (ou com `DISTRIBUTED_STATE_ENABLED=false`), valem por lambda (fallback em memória). **Métricas** continuam em memória por lambda (ADR-006).
- **Failover e health de fontes em memória (por lambda)** — o health/failover por fonte vale por instância (recalculado em cada lambda). **O estado administrativo (`live`/`maintenance`/`blocked`), ao contrário, é persistido no PostgreSQL** e cacheado por 8s localmente (`CHANNEL_STATE_CACHE_TTL_MS`); mutações sobrevivem a restart/cold start e propagam entre instâncias. A segurança (SSRF/gating) nunca depende de estado persistido (fail-open).
- **Failover disponível, porém inativo** — a playlist atual tem **1 fonte** (89 canais, sem duplicatas). Basta uma 2ª fonte/entrada com o mesmo `cleanName` para ativar a troca primária ↔ backup.
- **Realtime é polling (~30s)** — latência aceitável para dashboard/admin; não serve para chat/notificações push.
- **EPG em memória (por lambda)** — o guia é baixado do `EPG_URL` por instância fria com cache TTL de 30 min; não persiste no banco. Na Vercel, cada lambda tem sua própria cópia. Sem `EPG_URL`, a página `/guia` abre com a grade vazia (o link não desaparece).
- **Rotação de JWT secrets** — precisa de ação manual (`npm run generate:secrets` + atualizar env em todos os lugares). Verificar periodicamente.
- **Retenção programada** — a agregação diária e o expurgo dependem de acesso admin/ingestão; um cron explícito na Vercel é recomendado para períodos sem tráfego.
- **`README` anterior à v2** — este documento foi reescrito; qualquer divergência, o código (`src/`) e o `AGENTS.md` são a fonte da verdade.
- **IDs de canal são previsíveis** (`sha1`) — estáveis entre reloads, porém a autorização nunca depende deles (o blob selado + playback token são as contramedidas).

---

## 📚 Documentação Técnica (docs/)

Relatórios e diretrizes das rodadas de evolução:

| Arquivo | Conteúdo |
|---|---|
| `docs/RELATORIO-AUDITORIA-2026-08-23.md` | Fase 1–3: proxy selado, playback token, sessão revogável, paginação, health mínimo, clickjacking |
| `docs/DIRETRIZES-ARQUITETURA-2026-08-28.md` | Arquitetura-alvo, prioridades, ADRs e plano priorizado |
| `docs/RELATORIO-AUDITORIA-2026-08-28.md` | Auditoria completa + SSRF guard + observabilidade (requestId, audit, métricas, streamLimiter) |
| `docs/RELATORIO-ANALYTICS-PLAYLISTS-2026-09-12.md` | Analytics, histórico, playlists e recomendações (migração + E2E 25/25) |
| `docs/RELATORIO-AUDITORIA-2026-09-13.md` | Bug de playlist, remoção do `/docs`, player sem settings, realtime por polling, carrossel |
| `docs/auditoria-pos-implementacao-2026-09-14.md` | Failover de fontes, estados de canal + gating, Live Control, marca d'água, overlay de estado, recentes=10, realtime de playlists |
| `docs/RELATORIO-CORRECAO-PLAYER-HLS-2026-09-14.md` | Correção do player HLS (detecção proxy/format, auto-recuperação, timeout 30s cold start) |
| `docs/RELATORIO-EPG-GUIA-CANAIS-2026-09-15.md` | EPG + guia: endpoints, matching por nome/alias, página `/guia`, 55/55 testes |
| `docs/RELATORIO-AUDITORIA-IMPLEMENTACAO-2026-09-15.md` | Estado distribuído (Upstash Redis) em rate/stream limiter + fallback em memória + kill switch `DISTRIBUTED_STATE_ENABLED` |
| `docs/RELATORIO-CORRECAO-GUIA-EPG-2026-09-16.md` | Correção do guia: **todos os canais da M3U** na grade, filtros (`[hidden]`), matching por pontuação/aliases (64→81 matches) |
| `docs/RELATORIO-AUDITORIA-IMPLEMENTACAO-2026-09-16.md` | Política de senha, recuperação por código/SMTP, Termos versionados, revogação de sessões, rate limits dedicados, métricas, auditoria e testes |
| `docs/RELATORIO-AUDITORIA-IMPLEMENTACAO-2026-09-16-v2.md` | REV 2: consumo do código de reset em instrução SQL única e atômica (corrida de dupla redefinição), política no nível de serviço, auditorias `TERMS_ACCEPTED`/`CODE_VERIFIED`/`CODE_INVALIDATED`, 113/113 testes |
| `docs/RELATORIO-AUDITORIA-IMPLEMENTACAO-USUARIOS-2026-09-16.md` | Gestão administrativa de usuários (DTO whitelist, anti-self-lockout, último admin, avatar com SSRF guard, rate limit admin-write, frontend cards/filtros/modal), 147/147 testes |
| `docs/RELATORIO-AUDITORIA-PERSISTENCIA-ESTADO-CANAIS-2026-09-16.md` | Estado de canal persistido no Postgres (`channel_states`) + cache TTL read-through, write-through do admin, fail-open, migração aplicada, 166/166 testes |
| `docs/RELATORIO-TRENDING-2026-09-17.md` | Rotas `/api/trending` (Top 10 do catálogo): endpoints, cache por lambda, fail-open, whitelist de metadados, anti-SSRF e carrosséis novos da dashboard |
| `docs/RELATORIO-AUDITORIA-IMPLEMENTACAO-EPG-2026-09-17.md` | Barra de EPG **embutida no player** (agora/próximo/progresso), janela 1h+12h server-side (`getPlayerWindow`), `safeScriptJson`, zero requisição de EPG na reprodução, 214/214 testes |

---

## 🗺 Status e Roadmap

### Implementado

- [x] Parser M3U (local/remoto) com **merge de fontes** (primária ↔ backup) e IDs determinísticos
- [x] Autenticação JWT em 3 camadas (session / API / playback) + sessão revogável
- [x] Proxy HLS selado (`?p=` AES-256-GCM) com guarda anti-SSRF
- [x] Rate limiting por contexto e cota por plano
- [x] Playlists pessoais (regra 1 canal = 1 playlist/usuário)
- [x] Analytics de reprodução + histórico + recomendações
- [x] Observabilidade: requestId, audit_logs, métricas admin
- [x] Failover automático de fontes (health por fonte, anti-flapping) — **disponível, inativo até haver 2ª fonte**
- [x] Estados de canal (`live`/`maintenance`/`blocked`) + gating de reprodução antes do upstream
- [x] Live Control — espectadores ativos por canal no admin
- [x] Painel admin (usuários, canais + estado, métricas, Live Control, analytics, auditoria)
- [x] Dashboard/painel web com realtime (polling) e carrossel
- [x] Guia de Programação (EPG): XMLTV em memória + casamento por nome/alias + página `/guia` (**todos os canais da M3U**; sem EPG = grade vazia)
- [x] Tendências (Top 10): rotas `/api/trending` com GraphQL externo em memória, fail-open e carrosséis na dashboard
- [x] Estado distribuído (Upstash Redis) para rate limiting e concorrência de streams, com fallback em memória e kill switch
- [x] Recuperação de senha por código (SHA-256, TTL, tentativas, uso único, revogação de sessões) + SMTP
- [x] Termos de Uso versionados + política de senha (8–72 bytes UTF-8)
- [x] Player HTML5 (HLS.js) com marca d'água, overlay de estado e auto-recuperação de rede/cold start
- [x] Barra de EPG no player (agora/próximo/progresso) com dados embutidos server-side (`safeScriptJson`, janela 1h+12h) e **zero requisição de EPG durante a reprodução**
- [x] Deploy Vercel + pooling Supabase serverless
- [x] Testes unitários e de integração (`node --test`, 214 passando) + E2E (25)
- [x] Zero vulnerabilidades em `npm audit`

### Pendências / Futuro

- [ ] Ativar o estado distribuído em produção (configurar `UPSTASH_REDIS_REST_URL`/`TOKEN`) — o suporte no código já existe
- [ ] Cron de agregação/retenção na Vercel
- [ ] Rotação periódica automatizada dos JWT secrets
- [ ] Branding/customização do player via valores escalares sanitizados (ADR-005)
- [ ] Particionamento/arquivamento de `playback_events` em volumes altos
- [ ] Adicionar uma 2ª fonte M3U (ou entradas duplicadas) para ativar o failover em produção

---

## ⚠️ Avisos Legais

Esta API é uma ferramenta técnica para servir playlists M3U. O desenvolvedor **não é responsável pelo conteúdo** dos streams hospedados em links externos. Use apenas conteúdo que você tem direito de distribuir; respeite os termos de serviço dos provedores e as leis de copyright do seu país. Uso educacional/pessoal.

---

## 👏 Créditos

- **Autor/Projeto**: Jonathas Enterprises (SvenTV)
- **Colaboradores**: Team SvenTV
- **Bibliotecas principais**: Express, Prisma, HLS.js, Helmet, Joi, jsonwebtoken, bcryptjs, express-rate-limit, axios, winston
- **Fundação**: Supabase (PostgreSQL), Vercel (deploy)

---

**Desenvolvido com ❤️ por [Jonathas](https://github.com/jonathasfrontend)**
