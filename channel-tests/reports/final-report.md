# RELATÓRIO FINAL - AUDITORIA IPTV

**Data:** 2026-08-20
**Arquivo analisado:** SvenTvChannelsBACKUP.m3u
**Tempo total de execução:** ~12s (pipeline + deep test)

---

## RESUMO EXECUTIVO

| Métrica | Valor |
|---------|-------|
| Total de canais no arquivo | 139 |
| Canais ativos (não comentados) | 135 |
| Canais comentados no original | 4 |
| Canais com URL M3U8 | 97 |
| Canais com TS direto (cdn47.cc) | 37 |
| Canais com token | 4 |
| **Canais recuperados (URL funcionando)** | **89** |
| **Canais offline (não recuperados)** | **50** |
| Total de URLs testadas (candidatos) | ~1,800+ |
| Respostas HTTP 200 recebidas | ~90 |
| Manifests M3U8 válidos | ~89 |
| Streams confirmados | 88 |

---

## CLASSIFICAÇÃO DE ESTADO

### ATIVOS - URL Original Funcionando (82 canais)
Estes canais já estavam com URLs funcionando no arquivo original:

| Canal | URL | Host |
|-------|-----|------|
| A&E | http://45.190.28.50/AE_HD/index.m3u8 | 45.190.28.50 |
| AgroMais | http://45.162.64.114/AGROMAIS/index.m3u8 | 45.162.64.114 |
| AgroBrasil TV | http://45.162.64.114/AGRO_CANAL/index.m3u8 | 45.162.64.114 |
| ANIMAL PLANET | http://45.162.64.114/ANIMAL_PLANET/index.m3u8 | 45.162.64.114 |
| ARTE 1 | http://45.162.64.114/ARTE1/index.m3u8 | 45.162.64.114 |
| AXN | http://45.190.28.50/AXN_HD/index.m3u8 | 45.190.28.50 |
| BAND NEWS | http://45.190.28.50/BAND_NEWS_HD/index.m3u8 | 45.190.28.50 |
| BAND | http://45.190.28.50/BAND_HD/index.m3u8 | 45.190.28.50 |
| BAND SPORTS | http://45.190.28.50/BAND_SPORTS_HD/index.m3u8 | 45.190.28.50 |
| Canal do Boi | http://45.162.64.114/CANAL_DO_BOI/index.m3u8 | 45.162.64.114 |
| Canal Rural | http://45.190.28.50/CANAL_RURAL/index.m3u8 | 45.190.28.50 |
| CANCAO NOVA | http://45.190.28.50/CANCAO_NOVA_HD/index.m3u8 | 45.190.28.50 |
| CARTOON NETWORK | http://45.162.64.114/CARTOON_NETWORK/index.m3u8 | 45.162.64.114 |
| CINEMAX | http://45.190.28.50/CINEMAX/index.m3u8 | 45.190.28.50 |
| CNN BRASIL | http://45.162.64.114/CNN_BRASIL/index.m3u8 | 45.162.64.114 |
| CNN Brasil Money | http://45.162.64.114/CNN_BRASIL/index.m3u8 | 45.162.64.114 |
| DISCOVERY CHANNEL | http://45.162.64.114/DISCOVERY_CHANNEL/index.m3u8 | 45.162.64.114 |
| DISCOVERY KIDS | http://45.190.28.50/DISCOVERY_KIDS_HD/index.m3u8 | 45.190.28.50 |
| DISCOVERY SCIENCE | http://45.190.28.50/DISCOVERY_SCIENCE_HD/index.m3u8 | 45.190.28.50 |
| DISCOVERY THEATER | http://45.190.28.50/DISCOVERY_THEATER_HD/index.m3u8 | 45.190.28.50 |
| INVESTIGACAO DISCOVERY | http://45.190.28.50/ID_HD/index.m3u8 | 45.190.28.50 |
| DISCOVERY TURBO | http://45.190.28.50/DISCOVERY_TURBO_HD/index.m3u8 | 45.190.28.50 |
| DISCOVERY WORLD | http://45.190.28.50/DISCOVERY_WORLD_HD/index.m3u8 | 45.190.28.50 |
| ESPN | http://45.190.28.50/ESPN_HD/index.m3u8 | 45.190.28.50 |
| ESPN 2 | http://45.190.28.50/ESPN2/index.m3u8 | 45.190.28.50 |
| ESPN 3 | http://45.190.28.50/ESPN3/index.m3u8 | 45.190.28.50 |
| ESPN 4 | http://45.190.28.50/ESPN4/index.m3u8 | 45.190.28.50 |
| ESPN 5 | http://45.190.28.50/ESPN5/index.m3u8 | 45.190.28.50 |
| FISH TV | http://45.162.64.114/FISH_TV/index.m3u8 | 45.162.64.114 |
| FOX SPORTS 2 | http://45.190.28.50/FOX_SPORTS_2/index.m3u8 | 45.190.28.50 |
| FUTURA | http://45.162.64.114/FUTURA/index.m3u8 | 45.162.64.114 |
| GLOBO | http://45.190.28.50/GLOBO_HD/index.m3u8 | 45.190.28.50 |
| GLOOBINHO | http://177.52.24.163/GLOOBINHO-HD/index.m3u8 | 177.52.24.163 |
| HBO | http://45.190.28.50/HBO/index.m3u8 | 45.190.28.50 |
| HBO 2 | http://45.190.28.50/HBO2/index.m3u8 | 45.190.28.50 |
| HBO FAMILY | http://45.190.28.50/HBO_FAMILY/index.m3u8 | 45.190.28.50 |
| HBO MUNDI | http://45.190.28.50/HBO_MUNDI_HD/index.m3u8 | 45.190.28.50 |
| HBO PLUS | http://45.190.28.50/HBO_PLUS/index.m3u8 | 45.190.28.50 |
| HBO POP | http://45.190.28.50/HBO_POP_HD/index.m3u8 | 45.190.28.50 |
| HBO SIGNATURE | http://45.190.28.50/HBO_SIGNATURE/index.m3u8 | 45.190.28.50 |
| HGTV | http://45.190.28.50/HGTV_HD/index.m3u8 | 45.190.28.50 |
| HISTORY CHANNEL | http://45.190.28.50/HISTORY_HD/index.m3u8 | 45.190.28.50 |
| HISTORY CHANNEL 2 | http://45.190.28.50/H2_HD/index.m3u8 | 45.190.28.50 |
| MEGAPIX | http://177.52.24.163/MEGAPIX-HD/index.m3u8 | 177.52.24.163 |
| MUSIC BOX BRASIL | http://45.190.28.50/MUSIC_BOX_HD/index.m3u8 | 45.190.28.50 |
| PRIME BOX BRASIL | http://45.190.28.50/PRIME_BOX_HD/index.m3u8 | 45.190.28.50 |
| RECORD NEWS | http://45.162.64.114/RECORD_NEWS/index.m3u8 | 45.162.64.114 |
| RECORD | http://45.190.28.50/RECORD/index.m3u8 | 45.190.28.50 |
| REDE VIDA | http://45.190.28.50/REDE_VIDA_HD/index.m3u8 | 45.190.28.50 |
| REDETV! | https://tv01.zas.media:1936/redetvparana/playlist.m3u8 | tv01.zas.media |
| SABOR E ARTE | http://45.190.28.50/SABOR_E_ARTE/index.m3u8 | 45.190.28.50 |
| SBT | http://45.190.28.50/SBT_HD/index.m3u8 | 45.190.28.50 |
| SONY CHANNEL | http://45.190.28.50/SONY_HD/index.m3u8 | 45.190.28.50 |
| SONY MOVIES | http://45.162.64.114/SONY_MOVIES/index.m3u8 | 45.162.64.114 |
| SPACE | http://45.190.28.50/SPACE_HD/index.m3u8 | 45.190.28.50 |
| STUDIO UNIVERSAL | http://177.52.24.163/STUDIO-UNIVERSAL-HD/index.m3u8 | 177.52.24.163 |
| TELECINE ACTION | http://177.52.24.163/TELECINE-ACTION-HD/index.m3u8 | 177.52.24.163 |
| TELECINE CULT | http://177.52.24.163/TELECINE-CULT-HD/index.m3u8 | 177.52.24.163 |
| TELECINE FUN | http://177.52.24.163/TELECINE-FUN-HD/index.m3u8 | 177.52.24.163 |
| TELECINE PIPOCA | http://177.52.24.163/TELECINE-PIPOCA-HD/index.m3u8 | 177.52.24.163 |
| TELECINE PREMIUM | http://177.52.24.163/TELECINE-PREMIUM-HD/index.m3u8 | 177.52.24.163 |
| TELECINE TOUCH | http://177.52.24.163/TELECINE-TOUCH-HD/index.m3u8 | 177.52.24.163 |
| TLC | http://45.190.28.50/TLC_HD/index.m3u8 | 45.190.28.50 |
| TNT SERIES | http://45.190.28.50/TNT_SERIES/index.m3u8 | 45.190.28.50 |
| TNT | http://45.162.64.114/TNT/index.m3u8 | 45.162.64.114 |
| TNT NOVELAS | http://45.162.64.114/TNT_NOVELAS/index.m3u8 | 45.162.64.114 |
| TRACE BRAZUCA | http://45.190.28.50/TRACE_BRAZUCA/index.m3u8 | 45.190.28.50 |
| TRAVEL BOX BRASIL | http://45.162.64.114/TRAVEL_BOX_BRASIL/index.m3u8 | 45.162.64.114 |
| TV CULTURA | http://45.162.64.114/TV_CULTURA/index.m3u8 | 45.162.64.114 |
| GAZETA | http://45.162.64.114/GAZETA/index.m3u8 | 45.162.64.114 |
| Tv Pai Eterno | http://45.162.64.114/TV_PAI_ETERNO/index.m3u8 | 45.162.64.114 |
| TV RA-TIM-BUM | http://45.190.28.50/RATIMBUM/index.m3u8 | 45.190.28.50 |
| WOOHOO | http://45.162.64.114/WOOHOO/index.m3u8 | 45.162.64.114 |
| Adult Swim | http://45.162.64.114/ADULT_SWIM/index.m3u8 | 45.162.64.114 |
| TV Câmara | http://45.190.28.50/TV_CAMARA/index.m3u8 | 45.190.28.50 |
| Terra Viva | http://45.190.28.50/TERRA_VIVA_HD/index.m3u8 | 45.190.28.50 |
| AgroBrasil | http://45.190.28.50/AGROBRASIL/index.m3u8 | 45.190.28.50 |
| TV Pampa | http://45.190.28.50/TV_PAMPA/index.m3u8 | 45.190.28.50 |
| Rede Gospel | http://45.190.28.50/REDE_GOSPEL_HD/index.m3u8 | 45.190.28.50 |
| TV APARECIDA | http://45.190.28.50/TV_APARECIDA_HD/index.m3u8 | 45.190.28.50 |
| TCM | http://45.190.28.50/TCM_HD/index.m3u8 | 45.190.28.50 |
| Rede Super | http://45.190.28.50/REDE_SUPER/index.m3u8 | 45.190.28.50 |
| CAZE TV | http://45.190.28.50/CAZE_TV/index.m3u8 | 45.190.28.50 |
| CNBC Brasil | http://45.190.28.50/CNBC/index.m3u8 | 45.190.28.50 |
| TV DIARIO | http://45.162.64.114/TV_DIARIO/index.m3u8 | 45.162.64.114 |
| NOVO TEMPO | http://45.162.64.114/NOVO_TEMPO/index.m3u8 | 45.162.64.114 |
| TV BRASIL | http://45.190.28.50/TV_BRASIL/index.m3u8 | 45.190.28.50 |

### CANAIS COM TOKEN (funcionando, mas requerem autenticação) - 3 canais

| Canal | URL | Host | Status |
|-------|-----|------|--------|
| CARTOONITO | https://cdn-sp2.satlabscloud.com.br/BOOMERANG_HD/index.m3u8?token=... | cdn-sp2.satlabscloud.com.br | OK (HTTP 200, M3U8 válido) |
| HBO XTREME | http://200.71.74.18/HBO_EXTREME_HD/index.m3u8?token=... | 200.71.74.18 | OK (HTTP 200, M3U8 válido) |
| WARNER CHANNEL | https://cdn-sp2.satlabscloud.com.br/WARNER/index.m3u8?token=... | cdn-sp2.satlabscloud.com.br | OK (HTTP 200, M3U8 válido) |

### CANAIS RECUPERADOS VIA TESTE EXTENSO - 1 canal

| Canal | Identificador Original | Identificador Encontrado | URL Final | Confiança |
|-------|----------------------|-------------------------|-----------|-----------|
| DISCOVERY HOME & HEALTH | DISCOVERY_HOME_AND_HEALTH_HD (comentado) | DISCOVERY_HD | http://45.190.28.50/DISCOVERY_HD/index.m3u8 | CONFIRMED |

**Nota:** Este canal estava comentado no M3U original. A URL encontrada (`DISCOVERY_HD`) é compartilhada com o canal INVESTIGACAO DISCOVERY, o que indica que ambos apontam para o mesmo stream.

---

## CANAIS NÃO RECUPERADOS

### Canais M3U8 com URL Original Offline e Candidatos Falharam - 6 canais

| Canal | URL Original | Host | Candidatos Testados | Motivo |
|-------|-------------|------|---------------------|--------|
| AMC | http://45.162.64.114/AMCHD/index.m3u8 | 45.162.64.114 | 42 | HTTP 404 em todas as variações |
| BIS | http://45.190.28.50/bis/index.m3u8 | 45.190.28.50 | 48 | HTTP 404 em todas as variações |
| BM&C | http://45.190.28.50/BM&C_HD/index.m3u8 | 45.190.28.50 | 78 | HTTP 404 em todas as variações |
| CANAL BRASIL | http://45.190.28.50/CANAL_BRASIL/index.m3u8 | 45.190.28.50 | 216 | HTTP 404 em todas as variações |
| COMBATE | http://45.190.28.50/COMBATE/index.m3u8 | 45.190.28.50 | 42 | HTTP 404 em todas as variações |
| CURTA! | http://45.190.28.50/CURTA!/index.m3u8 | 45.190.28.50 | 54 | HTTP 404 em todas as variações |

### Canais com TS Direto via cdn47.cc (TODOS OFFLINE) - 37 canais

**O servidor cdn47.cc está completamente indisponível (HTTP 404 em todas as URLs testadas).**

| Canal | URL | HTTP Status |
|-------|-----|-------------|
| Canal Goat 2 | http://cdn47.cc:80/ec1328/QO5858/246838.ts | 404 |
| Canal Goat | http://cdn47.cc:80/ec1328/QO5858/246835.ts | 404 |
| DOG TV | http://cdn47.cc:80/ec1328/QO5858/32426.ts | 404 |
| E! | http://cdn47.cc:80/ec1328/QO5858/99.ts | 404 |
| FOOD NETWORK | http://cdn47.cc:80/ec1328/QO5858/101.ts | 404 |
| GNT | http://cdn47.cc:80/ec1328/QO5858/102.ts | 404 |
| LIFETIME | http://cdn47.cc:80/ec1328/QO5858/280.ts | 404 |
| MODO VIAGEM | http://cdn47.cc:80/ec1328/QO5858/103.ts | 404 |
| MTV 00S | http://cdn47.cc:80/ec1328/QO5858/108973.ts | 404 |
| MTV LIVE | http://cdn47.cc:80/ec1328/QO5858/2.ts | 404 |
| MTV | http://cdn47.cc:80/ec1328/QO5858/1.ts | 404 |
| MULTISHOW | http://cdn47.cc:80/ec1328/QO5858/3.ts | 404 |
| NICK JR | http://cdn47.cc:80/ec1328/QO5858/130.ts | 404 |
| NICKELODEON | http://cdn47.cc:80/ec1328/QO5858/131.ts | 404 |
| OFF | http://cdn47.cc:80/ec1328/QO5858/253.ts | 404 |
| PARAMOUNT NETWORK | http://cdn47.cc:80/ec1328/QO5858/296.ts | 404 |
| PREMIERE CLUBES | http://cdn47.cc:80/ec1328/QO5858/524.ts | 404 |
| PREMIERE 2 | http://cdn47.cc:80/ec1328/QO5858/525.ts | 404 |
| PREMIERE 3 | http://cdn47.cc:80/ec1328/QO5858/526.ts | 404 |
| PREMIERE 4 | http://cdn47.cc:80/ec1328/QO5858/527.ts | 404 |
| PREMIERE 5 | http://cdn47.cc:80/ec1328/QO5858/528.ts | 404 |
| PREMIERE 6 | http://cdn47.cc:80/ec1328/QO5858/529.ts | 404 |
| PREMIERE 7 | http://cdn47.cc:80/ec1328/QO5858/530.ts | 404 |
| SPORTV 3 | http://cdn47.cc:80/ec1328/QO5858/554.ts | 404 |
| SPORTV 2 | http://cdn47.cc:80/ec1328/QO5858/553.ts | 404 |
| SPORTV | http://cdn47.cc:80/ec1328/QO5858/555.ts | 404 |
| SYFY | http://cdn47.cc:80/ec1328/QO5858/284.ts | 404 |
| TBS | http://cdn47.cc:80/ec1328/QO5858/285.ts | 404 |
| TV Universal (IURD) | http://cdn47.cc:80/ec1328/QO5858/53286.ts | 404 |
| UNIVERSAL CHANNEL | http://cdn47.cc:80/ec1328/QO5858/290.ts | 404 |
| VIVA | http://cdn47.cc:80/ec1328/QO5858/105.ts | 404 |
| DumDum | http://cdn47.cc:80/ec1328/QO5858/108988.ts | 404 |
| Xsports | http://cdn47.cc:80/ec1328/QO5858/322392.ts | 404 |
| GE TV | http://cdn47.cc:80/ec1328/QO5858/327797.ts | 404 |
| CBI | http://cdn47.cc:80/ec1328/QO5858/330673.ts | 404 |
| TV LITORAL RN | http://cdn47.cc:80/ec1328/QO5858/331647.ts | 404 |
| ONEFOOTBALL 1 | http://cdn47.cc:80/ec1328/QO5858/133537.ts | 404 |

### Canais com Token (offline) - 1 canal

| Canal | URL | HTTP Status | Motivo |
|-------|-----|-------------|--------|
| FILM&ARTS | https://pozidupino.server-russian-db-hertzner-com.lat/... | 521 | Servidor retornou HTTP 521 |

### Canais Comentados no Original (permanecem comentados) - 3 canais

| Canal | URL Original (comentada) | Status |
|-------|-------------------------|--------|
| GLOBO NEWS | http://45.162.64.114/GLOBO_NEWS_HD/index.m3u8 | OFFLINE (não recuperado) |
| SBT+ | http://45.190.28.50/SBT_HD/index.m3u8 | Mesmo URL do SBT ativo |
| JOVEM PAN NEWS | http://45.190.28.50/JOVEM_PAN_HD/index.m3u8 | OFFLINE (não recuperado) |

---

## ANÁLISE DE PADRÕES DESCOBERTOS

### Padrões de Nomenclatura (baseado em canais funcionais)

| Padrão | Ocorrências | Percentual | Exemplo |
|--------|-------------|------------|---------|
| Underscore (_) como separador | 65 | 67% | DISCOVERY_CHANNEL, BAND_NEWS_HD |
| Sem separador | 23 | 24% | AGROMAIS, RATIMBUM |
| Hífen (-) como separador | 9 | 9% | GLOOBINHO-HD, STUDIO-UNIVERSAL-HD |
| Sufixo _HD | 34 | 35% | AXN_HD, BAND_HD, ESPN_HD |
| Sufixo HD (colado) | 3 | 3% | AMCHD |
| Sigla/acrônimo | 9 | 9% | ID_HD, H2_HD, CNBC |
| Nomes contraídos | 4 | 4% | HBO2, ESPN2, RATIMBUM |

### Regras de Transformação Observadas

1. **Espaços → Underscores**: `BAND NEWS` → `BAND_NEWS_HD`
2. **Remoção de caracteres especiais**: `TV RA-TIM-BUM` → `RATIMBUM`
3. **Abreviação agressiva**: `INVESTIGACAO DISCOVERY` → `ID_HD`
4. **Sufixo _HD**: ~35% dos canais utilizam sufixo `_HD`
5. **Hosts específicos**: Canais Telecine usam `177.52.24.163` com hífens, canaisDiscovery usam `45.190.28.50` com underscores

### Distribuição por Host

| Host | Canais Ativos | Status |
|------|--------------|--------|
| 45.190.28.50 | ~55 | ONLINE |
| 45.162.64.114 | ~35 | ONLINE |
| 177.52.24.163 | ~10 | ONLINE |
| cdn47.cc:80 | 37 | **OFFLINE (todos)** |
| cdn-sp2.satlabscloud.com.br | 3 | ONLINE (com token) |
| tv01.zas.media:1936 | 1 | ONLINE |
| 200.71.74.18 | 1 | ONLINE (com token) |
| pozidupino.server-russian-db-hertzner-com.lat | 1 | OFFLINE (521) |

---

## CANAIS PRIORITÁRIOS - STATUS

| Canal | Status | Ação |
|-------|--------|------|
| AMC | OFFLINE | Não recuperado (42 candidatos testados) |
| BIS | OFFLINE | Não recuperado (48 candidatos testados) |
| BM&C | OFFLINE | Não recuperado (78 candidatos testados) |
| CANAL BRASIL | OFFLINE | Não recuperado (216 candidatos testados) |
| COMBATE | OFFLINE | Não recuperado (42 candidatos testados) |
| CURTA! | OFFLINE | Não recuperado (54 candidatos testados) |
| DISCOVERY HOME & HEALTH | **RECUPERADO** | `DISCOVERY_HD` (compartilhado com ID) |
| DOG TV | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| E! | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| FOOD NETWORK | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| GLOOB | OFFLINE | Não recuperado (42 candidatos testados) |
| GNT | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| LIFETIME | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| MODO VIAGEM | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| MTV 00S | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| MTV LIVE | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| MTV | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| MULTISHOW | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| NICK JR | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| NICKELODEON | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| OFF | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PARAMOUNT NETWORK | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PREMIERE CLUBES | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PREMIERE 2 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PREMIERE 3 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PREMIERE 4 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PREMIERE 5 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PREMIERE 6 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| PREMIERE 7 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| SPORTV | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| SPORTV 2 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| SPORTV 3 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| SYFY | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| TBS | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| TV Universal (IURD) | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| UNIVERSAL CHANNEL | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| VIVA | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| DumDum | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| Xsports | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| GE TV | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| CBI | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| TV LITORAL RN | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| ONEFOOTBALL 1 | OFFLINE (cdn47) | Servidor cdn47.cc indisponível |
| FILM&ARTS | OFFLINE | Servidor retornou HTTP 521 |

---

## RECOMENDAÇÕES

1. **cdn47.cc**: O servidor de streaming cdn47.cc está completamente indisponível (HTTP 404 em todas as 37 URLs .ts). Recomenda-se re-testar em 24-48h para verificar se é uma indisponibilidade temporária.

2. **Canais sem recover** (AMC, BIS, BM&C, CANAL BRASIL, COMBATE, CURTA!, GLOOB): Após centenas de candidatos testados sistematicamente, nenhum identificador alternativo foi encontrado. Provavelmente estes canais foram removidos dos servidores.

3. **FILM&ARTS**: Servidor `pozidupino.server-russian-db-hertzner-com.lat` retornou HTTP 521 (servidor offline). Pode ser indisponibilidade temporária.

4. **DISCOVERY HOME & HEALTH**: Recuperado com identificador `DISCOVERY_HD`, que é compartilhado com INVESTIGACAO DISCOVERY. Ambos os canais apontam para o mesmo stream.

5. **Canais com token** (CARTOONITO, HBO XTREME, WARNER CHANNEL): Funcionando normalmente com autenticação via token na URL.

---

## ARQUIVOS GERADOS

| Arquivo | Descrição |
|---------|-----------|
| `output/SvenTvChannels_RECOVERED.m3u` | 89 canais com URLs funcionando |
| `output/SvenTvChannels_OFFLINE.m3u` | 50 canais offline (comentados) |
| `results/results.json` | Cache de resultados JSON |
| `results/deep-test-results.json` | Resultados dos testes profundos |
| `reports/final-report.md` | Este relatório |
| `logs/execution.log` | Log de execução do pipeline |

---

_Relatório gerado automaticamente pelo sistema de auditoria IPTV - 2026-08-20_
