# 📺 SvenTV API - Sistema de Streaming de Canais de TV

[![Node.js](https://img.shields.io/badge/Node.js-18.x+-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.18+-000000?style=flat&logo=express&logoColor=white)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-JEPSL-blue.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/Status-Production-success)](https://github.com/Team-SvenTV/api-stream-m3u8)

> **API REST profissional para streaming de canais de TV brasileiros ao vivo via protocolo HLS (HTTP Live Streaming)**

Sistema robusto e escalável desenvolvido para servir milhares de canais de televisão em tempo real, com suporte a múltiplos formatos de stream, player integrado, sistema de busca avançado e monitoramento em tempo real.

---

## 📌 Visão Geral

### O Que É

A **SvenTV API** é uma solução backend completa para distribuição de conteúdo de streaming de TV ao vivo. O sistema processa arquivos M3U (playlists de canais IPTV), organiza os canais por categorias, oferece endpoints RESTful para acesso aos dados e disponibiliza um player HTML5 customizado para reprodução em navegadores e aplicativos.

### Problema Que Resolve

- **Centralização de Conteúdo**: Unifica múltiplas fontes de streaming M3U em uma única API
- **Organização de Canais**: Categoriza automaticamente milhares de canais de TV brasileiros
- **Reprodução Universal**: Player compatível com todos os navegadores modernos via HLS.js
- **Performance**: Sistema otimizado para servir milhares de requisições simultâneas
- **Integração Simples**: Endpoints RESTful fáceis de consumir por aplicações frontend

### Público-Alvo

- **Desenvolvedores**: Integração em aplicações web, mobile e smart TVs
- **Empresas de Streaming**: Infraestrutura backend para plataformas IPTV
- **Portais de Entretenimento**: Incorporação de TV ao vivo em sites
- **Desenvolvedores de Apps**: Backend pronto para aplicativos de streaming

### Diferenciais Técnicos

- ✅ **Arquitetura MVC Profissional**: Separação clara de responsabilidades
- ✅ **Parser M3U Inteligente**: Extração automática de metadados e validação
- ✅ **Player Avançado**: HLS.js com suporte a low latency, PiP, estatísticas em tempo real
- ✅ **Sistema de Cache**: Otimização de performance com carregamento único
- ✅ **API RESTful Completa**: Endpoints documentados e padronizados
- ✅ **Segurança Implementada**: Helmet.js, CORS configurado, sanitização de dados
- ✅ **Monitoramento**: Health checks, estatísticas e logs detalhados
- ✅ **Deploy Simplificado**: Configuração para Vercel incluída

---

## 🏗 Arquitetura

### Padrão Arquitetural

O sistema segue o padrão **MVC (Model-View-Controller)** adaptado para APIs REST:

```
┌─────────────────────────────────────────────────────────────┐
│                    Cliente (Frontend)                       │
│  (Navegador, App Mobile, Smart TV, Aplicação Web)           │
└──────────────────────────────┬──────────────────────────────┘
                     HTTP/HTTPS Requests
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express.js Server                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Middlewares (Camada 1)                  │   │
│  │  • Helmet (Segurança HTTP headers)                  │   │
│  │  • CORS (Cross-Origin)                              │   │
│  │  • Morgan (Logging HTTP)                            │   │
│  │  • Body Parser (JSON/URL Encoded)                   │   │
│  │  • Auth: requireSessionAuth, requireApiAuth          │   │
│  │  • Rate Limiting: loginLimiter, apiLimiter, etc.     │   │
│  │  • Validation: express-validator schemas             │   │
│  └──────────────────────────────────────────────────────┘   │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Routes (Camada 2)                       │   │
│  │  • /api/auth/* → AuthRoutes                          │   │
│  │  • /api/channels/* → ChannelRoutes                   │   │
│  │  • /api/admin/* → AdminRoutes                        │   │
│  │  • /api/health, /api/info → HealthCheck              │   │
│  │  • / → WebRoutes (pages)                             │   │
│  └──────────────────────────────────────────────────────┘   │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Controllers (Camada 3)                     │   │
│  │  • ChannelController                                │   │
│  │    - getAllChannels(), getChannelById()              │   │
│  │    - searchChannels(), getChannelsByCategory()      │   │
│  │    - getChannelStream() → HTML Player               │   │
│  │    - getCategories(), getStats()                    │   │
│  │    - checkChannelHealth(), reloadChannels()         │   │
│  │  • AuthController                                   │   │
│  │    - register(), login(), logout()                  │   │
│  │    - getProfile(), updateProfile()                  │   │
│  │    - uploadAvatar(), changePassword()               │   │
│  │    - regenerateToken()                              │   │
│  │  • AdminController                                  │   │
│  │    - listUsers(), changeUserRole(), setUserBlock()  │   │
│  │    - listChannels(), reloadChannels()               │   │
│  │    - checkChannelHealth(), checkAllChannelsHealth() │   │
│  └──────────────────────────────────────────────────────┘   │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │             Services (Camada 4)                      │   │
│  │  • M3UService                                       │   │
│  │    - Parse de arquivos M3U                          │   │
│  │    - Extração de metadados (EXTINF)                 │   │
│  │    - Filtros, buscas, cache in-memory               │   │
│  │  • ChannelHealthService                             │   │
│  │    - Verificação de saúde dos streams               │   │
│  │    - Monitoramento contínuo (online/offline)        │   │
│  └──────────────────────────────────────────────────────┘   │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          File System (Camada 5)                      │   │
│  │  • SvenTvChannels.m3u (Arquivo principal)            │   │
│  │  • Leitura síncrona na inicialização                 │   │
│  │  • Cache em memória durante execução                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Error Handlers (Camada 6)                    │   │
│  │  • notFound() → 404 Handler                          │   │
│  │  • errorHandler() → Tratamento centralizado          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Response (JSON/HTML)                     │
└─────────────────────────────────────────────────────────────┘
```

### Fluxo de Dados

#### 1. Inicialização do Sistema

```
Servidor Iniciado
    ↓
M3UService Constructor
    ↓
loadChannels()
    ↓
Leitura do arquivo SvenTvChannels.m3u
    ↓
Parse linha a linha (parseM3U)
    ↓
Extração de metadados (EXTINF)
    ↓
Validação de URLs
    ↓
Remoção de duplicatas
    ↓
Armazenamento em array in-memory
    ↓
Sistema Pronto (channels[] populado)
```

#### 2. Requisição HTTP

```
Cliente faz GET /api/channels
    ↓
Middlewares de segurança (Helmet, CORS)
    ↓
Request Logger registra requisição
    ↓
Router identifica rota
    ↓
ChannelController.getAllChannels()
    ↓
M3UService.getAllChannels() retorna cache
    ↓
Formatação da resposta JSON
    ↓
Response com status 200 + dados
```

#### 3. Streaming de Canal

```
Cliente acessa /api/channels/{id}/stream
    ↓
ChannelController.getChannelStream()
    ↓
M3UService.getChannelById(id)
    ↓
Validação de existência do canal
    ↓
Carregamento do template Player HTML
    ↓
Substituição de placeholders {{CHANNEL_NAME}}, {{CHANNEL_URL}}
    ↓
Sanitização XSS (escapeHtml)
    ↓
Response HTML com player HLS.js
    ↓
Cliente renderiza player e inicia stream
```

### Comunicação Entre Módulos

- **Controllers ↔ Services**: Controllers delegam lógica de negócio aos Services
- **Services ↔ File System**: Services leem e processam arquivos M3U
- **Routes ↔ Controllers**: Routes mapeiam URLs para métodos dos Controllers
- **Middlewares → Routes**: Chain de middlewares processa requisições antes das rotas
- **Error Handlers ← Controllers**: Erros propagam até handlers centralizados

---

## 🧱 Estrutura do Projeto

```
api-stream-m3u8/
├── index.js
├── package.json                
├── vercel.json                 
├── .env.example                
├── .gitignore                
│
├── SvenTvChannels.m3u         
├── SvenTvChannelsAlterado.m3u 
├── backup.m3u                  
│
├── public/                     
│   ├── index.html              
│   ├── css/
│   │   ├── style.css           
│   │   ├── docs.css            
│   │   └── admin.css           
│   ├── img/                    
│   └── js/
│       ├── script.js           
│       ├── dashboard.js        
│       └── admin.js            
│
├── views/
│   ├── layouts/
│   │   └── main.ejs
│   ├── partials/
│   │   ├── head.ejs
│   │   ├── navbar.ejs
│   │   ├── footer.ejs
│   │   └── flash.ejs
│   └── pages/
│       ├── dashboard.ejs
│       ├── login.ejs
│       ├── register.ejs
│       ├── profile.ejs
│       ├── admin.ejs
│       └── docs.ejs
│
├── supabase/
│   └── migrations/
│       └── 001_create_users.sql
│
└── src/                        
    │
    ├── controllers/            
    │   ├── channelController.js
    │   └── adminController.js  
    │
    ├── services/               
    │   ├── m3uService.js       
    │   └── channelHealthService.js
    │
    ├── routes/                 
    │   ├── index.js            
    │   ├── channelRoutes.js    
    │   ├── authRoutes.js       
    │   ├── adminRoutes.js      
    │   ├── webRoutes.js        
    │   └── guia.js             
    │
    ├── middleware/             
    │   ├── errorHandler.js     
    │   └── validation.js       
    │
    ├── prisma/
    │   └── client.js           
    │
    ├── utils/                  
    │   └── helpers.js
    │
    └── Player/                 
        ├── index.html 
        ├── player.css
        ├── player.js           
        └── assets/
            └── icons/          
```

### Responsabilidade de Cada Módulo

| Módulo | Responsabilidade |
|--------|------------------|
| **index.js** | Inicialização do servidor, configuração de middlewares globais, registro de rotas |
| **controllers/** | Receber requisições HTTP, validar entrada, chamar services, formatar respostas JSON/HTML |
| **services/** | Lógica de negócio (M3UService, ChannelHealthService), parse de M3U, cache, health checks |
| **routes/** | Mapeamento de URLs: auth, channels, admin, web pages, TV guide |
| **middleware/** | Interceptação de requisições: auth (session/API token), validação, tratamento de erros, rate limiting |
| **prisma/** | Cliente Prisma para persistência de usuários no Supabase (PostgreSQL) |
| **views/** | Templates EJS: dashboard, admin, docs, login, register, profile |
| **utils/** | Funções auxiliares reutilizáveis (escapeHtml, validação, formatação) |
| **Player/** | Interface de reprodução: HLS.js, controles customizados, StallMonitor, estatísticas |
| **public/** | Frontend estático: dashboard.js, admin.js, CSS (style, docs, admin) |

---

## ⚙ Tecnologias Utilizadas

### Backend

| Tecnologia | Versão | Propósito |
|------------|--------|-----------|
| **Node.js** | 18.x+ | Runtime JavaScript server-side |
| **Express.js** | 4.18.2 | Framework web minimalista e flexível |
| **Helmet** | 7.0.0 | Segurança HTTP headers (XSS, CSP, etc.) |
| **CORS** | 2.8.5 | Controle de acesso cross-origin |
| **Morgan** | 1.10.0 | Logger HTTP para desenvolvimento |
| **Axios** | 1.12.2 | Cliente HTTP para requisições externas |

### Frontend

| Tecnologia | Versão | Propósito |
|------------|--------|-----------|
| **HTML5** | - | Estrutura da interface web e player |
| **CSS3** | - | Estilização responsiva e animações |
| **Vanilla JavaScript** | ES6+ | Lógica frontend sem frameworks |
| **HLS.js** | @latest | Player HLS para navegadores |
| **Fetch API** | - | Requisições HTTP assíncronas |

### Ferramentas de Desenvolvimento

| Ferramenta | Versão | Propósito |
|------------|--------|-----------|
| **Nodemon** | 3.0.1 | Auto-reload durante desenvolvimento |
| **Git** | - | Controle de versão |
| **npm** | - | Gerenciador de pacotes |

### Infraestrutura e Deploy

| Serviço | Propósito |
|---------|-----------|
| **Vercel** | Plataforma de deploy serverless (configuração pronta) |
| **Node.js Runtime** | Ambiente de execução (compatível com qualquer provedor) |
| **HTTP/HTTPS** | Protocolo de comunicação |

### Formatos e Protocolos

| Formato/Protocolo | Uso |
|-------------------|-----|
| **M3U/M3U8** | Playlists de canais IPTV |
| **HLS (HTTP Live Streaming)** | Protocolo de streaming adaptativo |
| **MPEG-TS** | Formato de transporte de vídeo |
| **JSON** | Formato de resposta da API REST |

---

## 🗄 Dados e Armazenamento

### Modelo de Dados

Os dados de canais continuam vindo de arquivos M3U e são mantidos em memória para leitura rápida.
Já os dados de autenticação e perfil de usuário são persistidos no Supabase (Postgres).

### Migração de Usuários para Supabase

O schema SQL completo da tabela de usuários foi adicionado em `supabase/migrations/001_create_users.sql`.
Esse script mantém os mesmos campos funcionais do modelo de usuário da API (nome, e-mail, senha, avatar, api token, status, papel, tentativas de login, bloqueio e auditoria).

#### Estrutura de Canal (JSON)

```json
{
  "id": "globo_sp_fhd_12345",
  "name": "Globo SP [FHD]",
  "cleanName": "Globo SP",
  "originalName": "Globo SP [FHD]",
  "url": "https://example.com/stream.m3u8",
  "logo": "https://example.com/logo.png",
  "category": "Abertos",
  "tvgId": "globo-sp",
  "slug": "globo-sp-fhd",
  "quality": "FHD (Full HD)",
  "availability": "Disponível",
  "format": "HLS",
  "encryption": "Padrão",
  "isLive": true,
  "source": "SvenTvChannels.m3u"
}
```

#### Campos e Descrições

| Campo | Tipo | Descrição | Exemplo |
|-------|------|-----------|---------|
| `id` | String | Identificador único gerado automaticamente | `"canal_123_4567"` |
| `name` | String | Nome completo do canal (com tags de qualidade) | `"ESPN [FHD]"` |
| `cleanName` | String | Nome sem tags de qualidade (para busca) | `"ESPN"` |
| `originalName` | String | Nome original do arquivo M3U | `"ESPN Brasil [FHD]"` |
| `url` | String | URL do stream HLS/TS | `"https://..."` |
| `logo` | String | URL do logo do canal | `"https://.../logo.png"` |
| `category` | String | Categoria do canal | `"Esportes"` |
| `tvgId` | String | ID TVG do EPG (guia eletrônico) | `"espn-br"` |
| `slug` | String | Slug amigável para URL | `"espn-fhd"` |
| `quality` | String | Qualidade do vídeo | `"FHD (Full HD)"` |
| `availability` | String | Status de disponibilidade | `"Disponível"` |
| `format` | String | Formato do stream | `"HLS"` / `"MPEG-TS"` |
| `encryption` | String | Tipo de codificação | `"H.265/HEVC"` |
| `isLive` | Boolean | Indica se é transmissão ao vivo | `true` |
| `source` | String | Arquivo de origem | `"SvenTvChannels.m3u"` |

### Estratégia de Armazenamento

#### Cache In-Memory

```javascript
class M3UService {
  constructor() {
    this.channels = [];  // Array em memória
    this.loadChannels(); // Carregamento na inicialização
  }
}
```

**Vantagens:**
- ✅ Acesso instantâneo (O(1) para busca por ID com Map)
- ✅ Sem latência de banco para consulta de canais
- ✅ Simplicidade de implementação
- ✅ Performance otimizada para leitura

**Desvantagens:**
- ⚠️ Dados perdidos ao reiniciar servidor (não é problema, pois M3U é recarregado)
- ⚠️ Limitação de memória RAM (suporta milhares de canais)

#### Persistência em Arquivo

Os dados originais estão em **SvenTvChannels.m3u**, um arquivo de texto no formato M3U Extended:

```
#EXTM3U
#EXTINF:-1 tvg-id="globo-sp" tvg-name="Globo SP" tvg-logo="https://..." group-title="Abertos",Globo SP [FHD]
https://example.com/globo-sp/stream.m3u8
#EXTINF:-1 tvg-id="espn-br" tvg-name="ESPN Brasil" tvg-logo="https://..." group-title="Esportes",ESPN [FHD]
https://example.com/espn/stream.m3u8
```

### Algoritmo de Remoção de Duplicatas

```javascript
removeDuplicates() {
  const seen = new Set();
  const uniqueChannels = [];
  
  this.channels.forEach(channel => {
    const key = `${channel.cleanName || channel.name}_${channel.quality}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueChannels.push(channel);
    }
  });
  
  this.channels = uniqueChannels;
}
```

**Critério de duplicação**: Nome limpo + Qualidade (case-insensitive)

---

## 🔌 API REST - Documentação de Endpoints

### Base URL

- **Desenvolvimento**: `http://localhost:3000`
- **Produção**: `https://seu-dominio.vercel.app`

### Autenticação

A API usa autenticação JWT com dois tipos de token:

- **Session Token**: Para rotas web (login no navegador). Expira em 7 dias.
- **API Token**: Prefixo `stv_`, para endpoints de canais. Expira em 365 dias.

```
Authorization: Bearer <token_aqui>
```

- Rotas de **canais** exigem API Token no header.
- Rotas de **admin** exigem sessão de admin autenticada.
- Rotas de **auth** (register, login) são públicas.

---

### 📋 Endpoints Disponíveis

#### 1️⃣ **GET** `/`

**Descrição**: Página inicial — informações gerais da API

---

### 🔐 Autenticação (Auth)

#### 2️⃣ **POST** `/api/auth/register`

**Descrição**: Criar nova conta de usuário

**Body** (JSON): `name`, `email`, `password` (mín. 8 chars)

**Resposta** (201): Retorna `sessionToken`, `apiToken` e dados do usuário.

---

#### 3️⃣ **POST** `/api/auth/login`

**Descrição**: Autenticar usuário

**Body** (JSON): `email`, `password`

**Bloqueio**: Após 5 tentativas incorretas, conta bloqueada por 15 minutos.

---

#### 4️⃣ **POST** `/api/auth/logout`

**Descrição**: Encerrar sessão (requer sessionToken)

---

#### 5️⃣ **GET** `/api/auth/profile`

**Descrição**: Buscar perfil do usuário autenticado (requer sessionToken)

---

#### 6️⃣ **PUT** `/api/auth/profile`

**Descrição**: Atualizar dados do perfil (requer sessionToken)

**Body** (JSON): `name` (opcional), `avatar` (opcional, URL)

---

#### 7️⃣ **POST** `/api/auth/avatar`

**Descrição**: Upload de avatar — multipart/form-data, máx. 5 MB (requer sessionToken)

---

#### 8️⃣ **POST** `/api/auth/change-password`

**Descrição**: Alterar senha (requer sessionToken)

**Body** (JSON): `currentPassword`, `newPassword`, `confirmNewPassword`

---

#### 9️⃣ **POST** `/api/auth/regenerate-token`

**Descrição**: Revogar API token atual e gerar um novo (requer sessionToken)

---

### 📺 Canais (Channels)

#### 🔟 **GET** `/api/channels`

**Descrição**: Listar canais com filtros e paginação (requer apiToken)

**Query**: `search`, `category`, `page`, `limit` (máx. 200)

---

#### 1️⃣1️⃣ **GET** `/api/channels/stats`

**Descrição**: Estatísticas gerais — total, categorias, formatos (requer apiToken)

---

#### 1️⃣2️⃣ **GET** `/api/channels/statuses`

**Descrição**: Status de saúde dos canais — admin only (requer apiToken + papel admin)

---

#### 1️⃣3️⃣ **GET** `/api/channels/categories`

**Descrição**: Lista de categorias disponíveis (requer apiToken)

---

#### 1️⃣4️⃣ **GET** `/api/channels/search?q=termo`

**Descrição**: Buscar canais por nome, cleanName, categoria ou tvgId (requer apiToken)

---

#### 1️⃣5️⃣ **GET** `/api/channels/category/:category`

**Descrição**: Canais de uma categoria específica (requer apiToken)

---

#### 1️⃣6️⃣ **GET** `/api/channels/:id`

**Descrição**: Informações detalhadas de um canal (requer apiToken)

---

#### 1️⃣7️⃣ **POST** `/api/channels/:id/check`

**Descrição**: Verificar saúde do stream — admin only (requer apiToken + papel admin)

---

#### 1️⃣8️⃣ **GET** `/api/channels/:id/stream`

**Descrição**: Abrir player HTML5 com stream HLS do canal (requer apiToken, plano Basic/Premium)

---

#### 1️⃣9️⃣ **POST** `/api/channels/reload`

**Descrição**: Recarregar canais do arquivo M3U — admin only (requer apiToken + papel admin)

---

### 👑 Administração (Admin)

> Todas as rotas admin exigem **sessão de admin autenticada**.

#### 2️⃣0️⃣ **GET** `/api/admin/users`

**Descrição**: Listar todos os usuários com paginação

---

#### 2️⃣1️⃣ **PUT** `/api/admin/users/:userId/role`

**Descrição**: Alterar papel de um usuário (ex: `admin`, `basic`, `premium`)

**Body** (JSON): `role`

---

#### 2️⃣2️⃣ **PUT** `/api/admin/users/:userId/block`

**Descrição**: Bloquear ou desbloquear uma conta

**Body** (JSON): `blocked` (boolean), `reason` (opcional)

---

#### 2️⃣3️⃣ **GET** `/api/admin/channels`

**Descrição**: Listar todos os canais com status de saúde (online/offline/unknown)

---

#### 2️⃣4️⃣ **POST** `/api/admin/channels/reload`

**Descrição**: Recarregar canais do arquivo M3U

---

#### 2️⃣5️⃣ **POST** `/api/admin/channels/:channelId/check`

**Descrição**: Verificar saúde de um canal específico

---

#### 2️⃣6️⃣ **POST** `/api/admin/channels/check-all`

**Descrição**: Verificar saúde de todos os canais (recomendado aguardar)

---

### ⚙ Sistema

#### 2️⃣7️⃣ **GET** `/api/health`

**Descrição**: Health check do servidor (monitoramento, público)

**Resposta** (200 OK):
```json
{
  "success": true,
  "status": "healthy",
  "message": "SvenTV API está funcionando corretamente",
  "version": "2.0.0",
  "uptime": 19392,
  "system": { "nodeVersion": "v22.x", "platform": "win32" },
  "environment": "production"
}
```

---

### 🚫 Tratamento de Erros

#### Erro 404 - Rota Não Encontrada

```json
{
  "success": false,
  "message": "Rota não encontrada: GET /api/invalid-route",
  "suggestion": "Verifique a documentação da API em /api/info"
}
```

#### Erro 500 - Erro Interno

```json
{
  "success": false,
  "message": "Erro interno do servidor",
  "error": "Descrição do erro"
}
```

**Em desenvolvimento**, o campo `stack` é incluído:

```json
{
  "success": false,
  "message": "Erro interno do servidor",
  "error": "Cannot read property 'name' of undefined",
  "stack": "Error: ...\n    at ChannelController.getChannelById ..."
}
```

---

## 🤖 Funcionalidades do Sistema

### 1. **Parser M3U Inteligente**

O sistema processa arquivos M3U Extended com extração automática de metadados:

**Entrada (M3U)**:
```
#EXTINF:-1 tvg-id="globo-sp" tvg-name="Globo SP" tvg-logo="https://logo.png" group-title="Abertos",Globo SP [FHD]
https://stream.example.com/globo-sp.m3u8
```

**Saída (JSON)**:
```json
{
  "id": "globo_sp_fhd_1_2345",
  "name": "Globo SP [FHD]",
  "cleanName": "Globo SP",
  "tvgId": "globo-sp",
  "logo": "https://logo.png",
  "category": "Abertos",
  "quality": "FHD (Full HD)",
  "url": "https://stream.example.com/globo-sp.m3u8",
  "format": "HLS"
}
```

**Processamento**:
- Extração de `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`
- Detecção automática de qualidade (`[FHD]`, `[HD]`, `[SD]`, `[4K]`)
- Limpeza de nomes (remoção de tags)
- Validação de URLs
- Geração de IDs únicos
- Criação de slugs amigáveis

---

### 2. **Sistema de Busca Avançado**

#### Busca por Nome

```javascript
// Endpoint: GET /api/channels/search?q=globo
searchChannels(searchTerm) {
  const term = searchTerm.toLowerCase();
  return this.channels.filter(channel =>
    channel.name.toLowerCase().includes(term) ||
    channel.cleanName.toLowerCase().includes(term) ||
    channel.category.toLowerCase().includes(term) ||
    channel.tvgId.toLowerCase().includes(term)
  );
}
```

**Características**:
- Case-insensitive
- Busca em múltiplos campos (`name`, `cleanName`, `category`, `tvgId`)
- Busca parcial (substring)
- Performance O(n) - adequado para milhares de canais

---

### 3. **Filtros por Categoria e Qualidade**

#### Por Categoria

```javascript
// Endpoint: GET /api/channels/category/Esportes
getChannelsByCategory(category) {
  return this.channels.filter(channel => 
    channel.category && 
    channel.category.toLowerCase().includes(category.toLowerCase())
  );
}
```

#### Por Formato

```javascript
// Interno (pode ser exposto em endpoint futuro)
getChannelsByFormat(format) {
  return this.channels.filter(channel =>
    channel.format && channel.format.toLowerCase() === format.toLowerCase()
  );
}
```

---

### 4. **Player HTML5 Avançado**

Características do player customizado:

#### Recursos Principais

- ✅ **HLS.js Integration**: Reprodução de streams HLS em todos os navegadores
- ✅ **Adaptive Bitrate**: Troca automática de qualidade baseada na velocidade de conexão
- ✅ **Low Latency Mode**: Modo de baixa latência para transmissões ao vivo
- ✅ **Manual Quality Selection**: Seleção manual de qualidade de vídeo
- ✅ **Picture-in-Picture**: Reprodução em janela flutuante
- ✅ **Fullscreen API**: Tela cheia nativa
- ✅ **Volume Control**: Controle de volume com slider
- ✅ **Keyboard Shortcuts**: Atalhos de teclado (Space, F, M, etc.)
- ✅ **Real-time Statistics**: Overlay com estatísticas de streaming
- ✅ **Auto-hide Controls**: Controles se escondem automaticamente
- ✅ **localStorage Persistence**: Salva preferências do usuário

#### Estatísticas em Tempo Real

O player exibe informações técnicas:

- **Resolução**: 1920x1080
- **Bitrate**: 4.5 Mbps
- **Qualidade**: FHD (Auto)
- **FPS**: 29.97
- **Latência ao Vivo**: 2.3s
- **Tamanho do Buffer**: 12.4s
- **Frames Perdidos**: 0/15678
- **Tempo Reproduzido**: 00:15:23

#### Configuração HLS.js

```javascript
const hlsConfig = {
  enableWorker: true,
  lowLatencyMode: true,
  backBufferLength: 90,
  maxBufferLength: 120,
  maxMaxBufferLength: 180,
  startLevel: -1,
  capLevelToPlayerSize: true,
  maxBufferSize: 50 * 1000 * 1000,
  fragLoadPolicy: { maxRetry: 4, timeout: 15000 },
  manifestLoadPolicy: { maxRetry: 4, timeout: 8000 }
};
```

---

### 5. **Remoção Automática de Duplicatas**

```javascript
removeDuplicates() {
  const seen = new Set();
  const uniqueChannels = [];
  
  this.channels.forEach(channel => {
    const key = `${channel.cleanName || channel.name}_${channel.quality}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueChannels.push(channel);
    }
  });
  
  this.channels = uniqueChannels;
}
```

**Critério**: Nome limpo + Qualidade (evita "Globo SP [FHD]" e "Globo SP [HD]" duplicados)

---

### 6. **Validação de URLs**

```javascript
isValidUrl(url) {
  try {
    const urlObj = new URL(url);
    return ['http:', 'https:'].includes(urlObj.protocol);
  } catch {
    return false;
  }
}
```

Garante que apenas URLs válidas sejam adicionadas ao sistema.

---

### 7. **Detecção Automática de Formato**

```javascript
detectFormat(url) {
  if (url.includes('.m3u8')) return 'HLS';
  if (url.includes('.ts')) return 'MPEG-TS';
  if (url.includes('.mp4')) return 'MP4';
  if (url.includes('.flv')) return 'FLV';
  return 'Desconhecido';
}
```

---

### 8. **Sanitização XSS**

```javascript
escapeHtml(text) {
  if (typeof text !== 'string') return '';
  
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  
  return text.replace(/[&<>"']/g, m => map[m]);
}
```

Previne ataques XSS ao gerar HTML do player.

---

### 9. **Health Check e Monitoramento**

```javascript
// Endpoint: GET /api/health
{
  "status": "healthy",
  "uptime": 19392,           // segundos
  "memory": {
    "used": 45.67,           // MB
    "total": 89.23
  },
  "system": {
    "nodeVersion": "v18.17.0",
    "platform": "linux",
    "arch": "x64"
  }
}
```

**Uso**: Integração com ferramentas de monitoramento (Uptime Kuma, Pingdom, Datadog)

---

### 10. **Reload Dinâmico de Canais**

```javascript
// Endpoint: POST /api/channels/reload
reloadChannels() {
  this.channels = [];
  this.loadChannels();
}
```

Permite atualizar a lista de canais sem reiniciar o servidor.

---

## 🧠 Lógica de Negócio

### Regras Principais

#### 1. Carregamento de Canais

**Fluxo**:
1. Servidor inicia → `M3UService` constructor
2. `loadChannels()` lê arquivo `SvenTvChannels.m3u`
3. `parseM3U()` processa linha a linha
4. Para cada `#EXTINF:`, extrai metadados
5. Valida URL do stream
6. Gera ID único e slug
7. Detecta qualidade, formato e codificação
8. Adiciona ao array `this.channels`
9. Remove duplicatas
10. Sistema pronto para servir requisições

**Tempo de Inicialização**: ~500ms para 3.000 canais

---

#### 2. Validações

##### URL Válida

```javascript
isValidUrl(url) {
  try {
    const urlObj = new URL(url);
    return ['http:', 'https:'].includes(urlObj.protocol);
  } catch {
    return false;
  }
}
```

##### Canal Existe

```javascript
getChannelById(id) {
  return this.channels.find(channel => channel.id === id) || null;
}
```

Se retornar `null`, controller responde com `404 Not Found`.

---

#### 3. Processamento de Busca

```javascript
searchChannels(searchTerm) {
  const term = searchTerm.toLowerCase();
  return this.channels.filter(channel =>
    channel.name.toLowerCase().includes(term) ||
    (channel.cleanName && channel.cleanName.toLowerCase().includes(term)) ||
    (channel.category && channel.category.toLowerCase().includes(term)) ||
    (channel.tvgId && channel.tvgId.toLowerCase().includes(term))
  );
}
```

**Complexidade**: O(n) onde n = número total de canais

**Otimização futura**: Implementar índice invertido ou Elasticsearch para buscas em grandes volumes

---

#### 4. Agregação de Estatísticas

```javascript
getStats() {
  const categories = {};
  const formats = {};
  const sources = {};
  
  this.channels.forEach(channel => {
    // Contagem por categoria
    if (channel.category) {
      categories[channel.category] = (categories[channel.category] || 0) + 1;
    }
    
    // Contagem por formato
    if (channel.format) {
      formats[channel.format] = (formats[channel.format] || 0) + 1;
    }
    
    // Contagem por fonte
    if (channel.source) {
      sources[channel.source] = (sources[channel.source] || 0) + 1;
    }
  });

  return {
    totalChannels: this.channels.length,
    categories: Object.keys(categories).length,
    categoriesBreakdown: categories,
    formatsBreakdown: formats,
    sourcesBreakdown: sources,
    lastUpdated: new Date().toISOString()
  };
}
```

**Complexidade**: O(n)

---

#### 5. Geração de ID Único

```javascript
generateChannelId(name, index = 0) {
  const baseId = name.toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\w\-_]/g, '')
    .substring(0, 45);
  
  return `${baseId}_${index}_${Date.now().toString().slice(-4)}`;
}
```

**Exemplo**: `"Globo SP [FHD]"` → `"globo_sp_fhd_0_2345"`

**Garantia de Unicidade**: Nome normalizado + Index + Timestamp

---

### Tratamento de Erros

#### Nível de Service

```javascript
try {
  const m3uContent = fs.readFileSync(filePath, 'utf-8');
  this.parseM3U(m3uContent, fileName);
} catch (error) {
  console.error(`❌ Erro ao carregar ${fileName}:`, error.message);
}
```

#### Nível de Controller

```javascript
try {
  const channels = this.m3uService.getAllChannels();
  res.status(200).json({ success: true, data: channels });
} catch (error) {
  console.error('Erro ao buscar canais:', error);
  res.status(500).json({
    success: false,
    message: 'Erro interno do servidor',
    error: error.message
  });
}
```

#### Middleware Centralizado

```javascript
const errorHandler = (err, req, res, next) => {
  console.error('❌ Erro capturado:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl
  });

  // Erro de arquivo não encontrado
  if (err.code === 'ENOENT') {
    return res.status(404).json({
      success: false,
      message: 'Arquivo não encontrado'
    });
  }

  // Erro padrão
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Erro interno do servidor'
  });
};
```

---

## 🚀 Instalação

### Pré-requisitos

| Software | Versão Mínima | Instalação |
|----------|---------------|------------|
| **Node.js** | 18.x ou superior | [nodejs.org](https://nodejs.org/) |
| **npm** | 9.x ou superior | Incluído com Node.js |
| **Git** | Qualquer versão | [git-scm.com](https://git-scm.com/) |

### Verificar Versões

```bash
node --version   # Deve retornar v18.x.x ou superior
npm --version    # Deve retornar 9.x.x ou superior
```

---

### Passo a Passo

#### 1️⃣ Clonar o Repositório

```bash
git clone https://github.com/Team-SvenTV/api-stream-m3u8.git
cd api-stream-m3u8
```

#### 2️⃣ Instalar Dependências

```bash
npm install
```

**Pacotes instalados**:
- express@4.18.2
- cors@2.8.5
- helmet@7.0.0
- morgan@1.10.0
- axios@1.12.2
- nodemon@3.0.1 (devDependencies)

#### 3️⃣ Configurar Variáveis de Ambiente (Opcional)

Crie um arquivo `.env` na raiz do projeto:

```bash
# .env
PORT=3000
NODE_ENV=development
```

**Nota**: O sistema funciona com valores padrão se `.env` não existir.

#### 4️⃣ Adicionar Arquivo M3U

Certifique-se de que o arquivo **`SvenTvChannels.m3u`** está na raiz do projeto.

```
api-stream-m3u8/
├── SvenTvChannels.m3u  ← Arquivo necessário
├── index.js
├── package.json
└── ...
```

**⚠️ Importante**: Sem este arquivo, o sistema não terá canais para servir.

#### 5️⃣ Iniciar o Servidor

**Modo Desenvolvimento** (com auto-reload):

```bash
npm run dev
```

**Modo Produção**:

```bash
npm start
```

#### 6️⃣ Verificar Funcionamento

Abra o navegador e acesse:

- **Interface Web**: [http://localhost:3000](http://localhost:3000)
- **Documentação da API**: [http://localhost:3000/api/info](http://localhost:3000/api/info)
- **Health Check**: [http://localhost:3000/api/health](http://localhost:3000/api/health)
- **Lista de Canais**: [http://localhost:3000/api/channels](http://localhost:3000/api/channels)

---

### Configuração CORS

#### Permitir Domínios Específicos (Produção)

Edite `index.js`:

```javascript
app.use(cors({
  origin: [
    'https://seusite.com.br',
    'https://app.seusite.com.br'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
```

#### Permitir Todos os Domínios (Desenvolvimento)

```javascript
app.use(cors({
  origin: '*',  // ⚠️ Inseguro em produção
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
```

---

### Configuração de Limites

#### Aumentar Limite de Payload

```javascript
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
```

---

## 🧪 Testes

<!-- TODO: Implementar suite de testes automatizados -->

### Status Atual

⚠️ **Não há testes automatizados implementados no momento.**

### Testes Manuais

#### 1. Health Check

```bash
curl http://localhost:3000/api/health
```

**Resposta esperada**: Status 200 com JSON contendo `"status": "healthy"`

#### 2. Listar Canais

```bash
curl http://localhost:3000/api/channels
```

**Resposta esperada**: Status 200 com array de canais

#### 3. Buscar Canal

```bash
curl http://localhost:3000/api/channels/search?q=globo
```

**Resposta esperada**: Status 200 com canais filtrados

#### 4. Player Funcional

Abra no navegador:
```
http://localhost:3000/api/channels/{id}/stream
```

**Comportamento esperado**: Player carrega e reproduz stream

---

### Estratégia de Testes (Futura Implementação)

#### Ferramentas Recomendadas

| Ferramenta | Propósito |
|------------|-----------|
| **Jest** | Framework de testes unitários |
| **Supertest** | Testes de API HTTP |
| **nock** | Mock de requisições HTTP externas |
| **nyc** | Cobertura de código |

#### Estrutura Proposta

```
tests/
├── unit/
│   ├── services/
│   │   └── m3uService.test.js
│   ├── controllers/
│   │   └── channelController.test.js
│   └── utils/
│       └── helpers.test.js
├── integration/
│   ├── api/
│   │   ├── channels.test.js
│   │   ├── health.test.js
│   │   └── search.test.js
└── e2e/
    └── player.test.js
```

#### Exemplo de Teste (Jest)

```javascript
// tests/unit/services/m3uService.test.js
const M3UService = require('../../../src/services/m3uService');

describe('M3UService', () => {
  let service;

  beforeEach(() => {
    service = new M3UService();
  });

  test('should load channels on initialization', () => {
    expect(service.getAllChannels()).toBeInstanceOf(Array);
    expect(service.getAllChannels().length).toBeGreaterThan(0);
  });

  test('should find channel by ID', () => {
    const channels = service.getAllChannels();
    const firstChannel = channels[0];
    const found = service.getChannelById(firstChannel.id);
    
    expect(found).toEqual(firstChannel);
  });

  test('should return null for invalid ID', () => {
    const found = service.getChannelById('invalid-id-12345');
    expect(found).toBeNull();
  });

  test('should search channels by name', () => {
    const results = service.searchChannels('globo');
    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name.toLowerCase()).toContain('globo');
  });
});
```

#### Executar Testes (Futuro)

```bash
npm test                  # Roda todos os testes
npm test -- --coverage    # Cobertura de código
npm test -- --watch       # Modo watch
```

---

## 🔒 Segurança

### Proteções Implementadas

#### 1. Helmet.js

Protege contra vulnerabilidades comuns:

```javascript
app.use(helmet({
  contentSecurityPolicy: false,  // Desabilitado para permitir iframe
  frameguard: false              // Permite embed em iframes
}));
```

**Headers adicionados**:
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=15552000`
- `X-Download-Options: noopen`

#### 2. CORS Configurado

```javascript
app.use(cors({
  origin: ['*'],  // ⚠️ Configure domínios específicos em produção
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));
```

#### 3. Sanitização XSS

Todas as entradas do usuário são sanitizadas antes de serem incluídas em HTML:

```javascript
escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
```

**Uso**:
```javascript
.replace(/\{\{CHANNEL_NAME\}\}/g, this.escapeHtml(channel.name))
```

#### 4. Validação de URLs

Apenas URLs HTTP/HTTPS válidas são aceitas:

```javascript
isValidUrl(url) {
  try {
    const urlObj = new URL(url);
    return ['http:', 'https:'].includes(urlObj.protocol);
  } catch {
    return false;
  }
}
```

#### 5. Limites de Payload

```javascript
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
```

Previne ataques de DoS via payloads gigantes.

#### 6. Tratamento de Erros Seguro

Em produção, stack traces não são expostos:

```javascript
res.status(500).json({
  success: false,
  message: 'Erro interno do servidor',
  ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
});
```

---

### Vulnerabilidades Conhecidas

<!-- TODO: Implementar autenticação JWT -->
<!-- TODO: Implementar rate limiting -->
<!-- TODO: Configurar CSP adequado -->

#### ⚠️ Falta de Autenticação

**Status**: Não implementado

**Risco**: Qualquer pessoa pode acessar todos os endpoints

**Recomendação**: Implementar JWT ou API Key para endpoints críticos

```javascript
// Exemplo de implementação futura
const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ message: 'Token não fornecido' });
  
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: 'Token inválido' });
    req.user = decoded;
    next();
  });
};

// Proteger endpoint
router.post('/channels/reload', authMiddleware, channelController.reloadChannels);
```

#### ⚠️ Falta de Rate Limiting

**Status**: Não implementado

**Risco**: API vulnerável a ataques de força bruta e DDoS

**Recomendação**: Implementar `express-rate-limit`

```javascript
// Exemplo de implementação futura
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,                 // Limite de 100 requisições por IP
  message: 'Muitas requisições deste IP, tente novamente em 15 minutos'
});

app.use('/api/', limiter);
```

#### ⚠️ Content Security Policy Desabilitado

**Status**: Desabilitado para permitir iframe

**Risco**: Vulnerabilidade a ataques XSS e injeção de conteúdo

**Recomendação**: Configurar CSP adequado

```javascript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"]
    }
  }
}));
```

---

### Boas Práticas Aplicadas

✅ **Tratamento centralizado de erros**  
✅ **Logs detalhados para auditoria**  
✅ **Validação de entrada de dados**  
✅ **Sanitização de saídas HTML**  
✅ **HTTPS recomendado em produção**  
✅ **Graceful shutdown implementado**  
✅ **Limites de payload configurados**  

---

## 📦 Deploy

### Estratégia de Deploy

#### Vercel (Serverless) - **Recomendado**

O projeto já possui configuração para Vercel.

**Arquivo**: `vercel.json`

```json
{
  "version": 2,
  "builds": [
    {
      "src": "./src/index.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/src/index.js"
    }
  ]
}
```

⚠️ **Correção Necessária**: O arquivo aponta para `./src/index.js`, mas o arquivo correto é `./index.js` na raiz.

**Correção**:

```json
{
  "version": 2,
  "builds": [
    {
      "src": "./index.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/index.js"
    },
    {
      "handle": "filesystem"
    },
    {
      "src": "/(.*)",
      "status": 404,
      "dest": "404.html"
    }
  ]
}
```

#### Passo a Passo - Vercel

1. **Instalar Vercel CLI**:

```bash
npm install -g vercel
```

2. **Login**:

```bash
vercel login
```

3. **Deploy**:

```bash
vercel
```

4. **Deploy para Produção**:

```bash
vercel --prod
```

**URL Gerada**: `https://api-stream-m3u8-seuprojeto.vercel.app`

---

### Build

**Não há processo de build** - o código é executado diretamente pelo Node.js.

```bash
npm start  # Inicia o servidor
```

---

### Ambientes

| Ambiente | Branch | URL | NODE_ENV |
|----------|--------|-----|----------|
| **Desenvolvimento** | `feature/*` | `http://localhost:3000` | `development` |
| **Staging** | `develop` | `https://staging.sventv.app` | `staging` |
| **Produção** | `main` | `https://api.sventv.app` | `production` |

---

### Variáveis de Ambiente em Produção

Configure no painel da Vercel:

| Variável | Valor |
|----------|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (automático na Vercel) |

---

## 📞 Contato / Suporte

### Equipe SvenTV

- **Organização**: [Team SvenTV](https://github.com/Team-SvenTV)
- **Repositório**: [api-stream-m3u8](https://github.com/Team-SvenTV/api-stream-m3u8)

### Reportar Bugs

Abra uma issue no GitHub:

[https://github.com/Team-SvenTV/api-stream-m3u8/issues](https://github.com/Team-SvenTV/api-stream-m3u8/issues)

**Template de Issue**:

```markdown
**Descrição do Bug**
Breve descrição do problema

**Como Reproduzir**
1. Passo 1
2. Passo 2
3. Erro observado

**Comportamento Esperado**
O que deveria acontecer

**Screenshots**
Se aplicável, adicione screenshots

**Ambiente**
- OS: [Windows 11]
- Node.js: [v18.17.0]
- Navegador: [Chrome 120]
```

### Solicitar Funcionalidades

Abra uma issue com o label `enhancement`:

```markdown
**Funcionalidade Desejada**
Descrição clara da funcionalidade

**Justificativa**
Por que essa funcionalidade é útil

**Solução Proposta**
Como você imagina que isso funcionaria

**Alternativas Consideradas**
Outras abordagens que você pensou
```

---

## 🎓 Documentação Adicional

### Recursos Externos

| Recurso | Link |
|---------|------|
| **HLS.js Documentation** | [https://github.com/video-dev/hls.js](https://github.com/video-dev/hls.js) |
| **Express.js Guide** | [https://expressjs.com/](https://expressjs.com/) |
| **M3U Format Spec** | [https://en.wikipedia.org/wiki/M3U](https://en.wikipedia.org/wiki/M3U) |
| **Helmet.js Docs** | [https://helmetjs.github.io/](https://helmetjs.github.io/) |
| **Vercel Deployment** | [https://vercel.com/docs](https://vercel.com/docs) |

---

## 🏆 Créditos

- **Autor**: Team SvenTV
- **Colaboradores**: SvenTV Team
- **Bibliotecas de Terceiros**: Express, HLS.js, Helmet, CORS, Morgan, Axios

---

## 📊 Status do Projeto

| Métrica | Status |
|---------|--------|
| **Versão** | 1.0.0 |
| **Status** | ✅ Em Produção |
| **Última Atualização** | Fevereiro 2026 |
| **Canais Suportados** | 3.000+ |
| **Uptime (30 dias)** | 99.8% |
| **Issues Abertas** | [Ver no GitHub](https://github.com/Team-SvenTV/api-stream-m3u8/issues) |

---

## 🗺 Roadmap

### ✅ Implementado

- [x] Parser M3U completo
- [x] API REST com todos os endpoints
- [x] Player HLS.js avançado
- [x] Sistema de busca e filtros
- [x] Tratamento de erros centralizado
- [x] Health check e monitoramento
- [x] Deploy na Vercel
- [x] Documentação completa

### 🚧 Em Desenvolvimento

- [x] Autenticação JWT
- [x] Rate limiting
- [x] Paginação de resultados
- [ ] Cache Redis para performance

### 🔮 Planejado

- [ ] Guia de programação (EPG)
- [ ] Sistema de favoritos
- [ ] Histórico de visualização
- [ ] Recomendações de canais
- [ ] Admin dashboard
- [ ] Analytics e métricas
- [ ] Suporte a múltiplos idiomas
- [ ] App móvel (React Native)

---

## ⚠️ Avisos Legais

### Responsabilidade de Conteúdo

⚠️ **IMPORTANTE**: Esta API é uma ferramenta técnica para servir playlists M3U. O desenvolvedor **NÃO é responsável pelo conteúdo** dos streams hospedados nos links externos.

### Direitos Autorais

- Os streams de vídeo pertencem aos respectivos detentores de direitos
- Use apenas conteúdo que você tem direito de distribuir
- Respeite as leis de copyright do seu país

### Uso Responsável

- Esta ferramenta é destinada a **uso educacional e pessoal**
- Não utilize para pirataria ou distribuição ilegal de conteúdo
- Respeite os termos de serviço dos provedores de streaming

---

## 📝 Notas de Versão

### v1.0.0 (22 de Fevereiro de 2026)

#### Funcionalidades

- ✅ API REST completa com 11 endpoints
- ✅ Parser M3U inteligente com extração de metadados
- ✅ Player HTML5 com HLS.js e low latency
- ✅ Sistema de busca fuzzy
- ✅ Filtros por categoria e qualidade
- ✅ Estatísticas em tempo real
- ✅ Health check e monitoramento
- ✅ Interface web de demonstração
- ✅ Suporte a +3.000 canais

#### Correções

- 🐛 Correção de duplicatas na lista de canais
- 🐛 Sanitização XSS no player
- 🐛 Validação de URLs antes de adicionar canais

#### Melhorias

- ⚡ Performance otimizada com cache in-memory
- ⚡ Inicialização rápida (<500ms)
- ⚡ Logs estruturados e coloridos
- ⚡ Graceful shutdown implementado

---

## 📝 Changelog Recente

### v2.x — Sessão de Melhorias

#### Autenticação e Segurança
- Sistema completo de autenticação JWT (Session Token + API Token)
- Rotas protegidas: canais (apiToken), admin (session+role), web (session)
- Middleware de validação com express-validator
- Rate limiting por rota (login: 20/min, register: 10/min, channels: 100/min)
- Bloqueio de conta após 5 tentativas de login incorretas
- Upload de avatar com multer (máx. 5 MB)

#### Administração
- Painel admin com gerenciamento de usuários (listar, alterar papel, bloquear/desbloquear)
- Gerenciamento de canais: listagem com status de saúde, verificação individual e em massa
- Reload do M3U a partir do painel admin

#### Player e Streaming
- Otimização do player HLS.js: configuração com propriedades válidas apenas
- StallMonitor: detecção automática de travamentos com recuperação para live edge
- Fallback de qualidade em caso de underrun de buffer
- CDN HLS.js atualizado para `@latest`

#### Dashboard
- Paginação server-side com carregamento assíncrono do dataset completo
- Visualização grid/list persistida em localStorage
- Filtros e busca com carregamento otimizado

#### Player (Admin)
- Kanal list com status de saúde (online/offline/unknown)
- Verificação de stream individual e em massa
- Reload de canais M3U a partir do painel

---

**Desenvolvido com ❤️ por [Jonathas](https://github.com/jonathasfrontend)**

---
