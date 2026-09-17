/**
 * SvenTV API — Mapa de exceções de matching EPG ↔ M3U (aliasMap)
 *
 * Mesmo com o casamento por NOME NORMALIZADO (lowercase, sem acento, sem
 * sufixo de qualidade), alguns canais do provedor XMLTV têm nomes que não
 * batem com os da playlist M3U (numeração própria, abreviações, fusões de
 * marca). Este mapa resolve esses casos manualmente — versionado, sem
 * segredos, sem URL alguma.
 *
 * Formato:  epgChannelId  →  nome EXATO (cleanName) do canal na sua M3U
 *
 *   'premiere': 'Premiere 1',      // o EPG chama o canal de outra forma
 *   'fantastico-extra': 'Globo',   // ex.: variantes regionais
 *
 * O arquivo cresce ITERATIVAMENTE conforme o dono usa o endpoint admin:
 *   GET /api/admin/epg/unmatched  (relatório de canais sem match)
 *
 * ⚠️ A regra de matching NUNCA usa o id do `<channel>` do XMLTV como se
 * fosse o channelId interno (sha1(nome::fonte)+índice) da SvenTV.
 */
module.exports = {
  // ── Canais regionais → correspondente nacional ─────────────────
  'globosp': 'GLOBO',
  'globorj': 'GLOBO',
  'globobrj': 'GLOBO',
  'globomg': 'GLOBO',
  'globoba': 'GLOBO',
  'globodf': 'GLOBO',
  'globogo': 'GLOBO',
  'globoms': 'GLOBO',
  'globoal': 'GLOBO',
  'globoam': 'GLOBO',
  'globors': 'GLOBO',
  'bandsp': 'BAND',
  'bandmg': 'BAND',
  'bandba': 'BAND',
  'bandpa': 'BAND',
  'bandpb': 'BAND',
  'bandpe': 'BAND',
  'recordsp': 'RECORD',
  'recordmt': 'RECORD',
  'recordpb': 'RECORD',
  'recordrn': 'RECORD',
  'recordro': 'RECORD',

  // ── EPG usa nome diferente do M3U ─────────────────────────────
  'sony': 'SONY CHANNEL',
  'musicbox': 'MUSIC BOX BRASIL',
  'primebox': 'PRIME BOX BRASIL',
  'tracebrasil': 'TRACE BRAZUCA',
  'tvnovotempo': 'NOVO TEMPO',
  'agromais': 'AgroMais',
  'arte1': 'ARTE 1',
  'history': 'HISTORY CHANNEL',
  'history2': 'HISTORY CHANNEL 2',
  'terraviva': 'Terra Viva',
  'travelbox': 'TRAVEL BOX BRASIL',
  'warner': 'WARNER TV',
};