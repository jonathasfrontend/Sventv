/* public/js/guide-search.js — Busca combinada do Guia (UMD)
   Espelha a semântica do servidor (src/utils/searchNormalize.js): texto sem
   acentos/caixa + token de horário ("20h", "20h30", "20:30") resolvido no
   RELÓGIO LOCAL do navegador.

   API (UMD — testável via require()):
     - normalizeForSearch(str)              → texto normalizado
     - splitTimeToken(query)                → { time, text }
     - minuteOfDayLocal(ms)                 → minutos do dia no fuso local
     - matchesTimeLocal(ms, time)           → programa no horário?
     - matchesGuideRow(query, row, nowTs)   → canal+programas casam a query?
     - searchAll(query, { channels, programmes, nowTs, tzMs })
         → { channels, programmes } agrupados (para o painel "buscar tudo")

   NUNCA monta HTML/segredos aqui — só lógica pura. O guia.js renderiza. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GuideSearch = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalizeForSearch(str) {
    return String(str == null ? '' : str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' e ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var TIME_TOKEN_RE =
    /(?:^|\s+)(\d{1,2})h(?::?(\d{2}))?(?=\s|$)|(?:^|\s+)(\d{1,2}):(\d{2})(?=\s|$)/;

  function splitTimeToken(query) {
    var raw = String(query == null ? '' : query);
    var match = raw.match(TIME_TOKEN_RE);
    if (!match) return { time: null, text: normalizeForSearch(raw) };

    // "20h"/"20h30" usa o grupo 1/2; "20:30" usa o 3/4. O grupo que não casou
    // é undefined — parseInt(undefined) → NaN e Math.max(…, 0) vira NaN. Parse
    // pelo grupo que casou (identificado por match[1]).
    var hour = match[1] !== undefined ? parseInt(match[1], 10) : parseInt(match[3], 10);
    var minuteMatch = match[2] !== undefined ? match[2] : match[4];
    var minute = minuteMatch ? parseInt(minuteMatch, 10) : 0;
    if (hour > 23 || minute > 59) return { time: null, text: normalizeForSearch(raw) };

    return {
      time: { h: hour, m: minute, exact: match[2] !== undefined || match[4] !== undefined },
      text: normalizeForSearch(raw.replace(match[0], ' ')),
    };
  }

  function minuteOfDayLocal(ms) {
    var d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return -1;
    return d.getHours() * 60 + d.getMinutes();
  }

  function matchesTimeLocal(ms, time) {
    if (!time) return true;
    var minutes = minuteOfDayLocal(ms);
    var target = time.h * 60;
    if (time.exact) return minutes === target + time.m;
    return minutes >= target && minutes < target + 60;
  }

  function textHits(hay, text) {
    if (!text) return true;
    return normalizeForSearch(hay).indexOf(text) !== -1;
  }

  /* Canal + programação casam a query? (filtro do grid — client-side). */
  function matchesGuideRow(query, row, nowTs) {
    if (!query) return true;
    var parsed = splitTimeToken(query);
    var text = parsed.text;
    var time = parsed.time;

    var progs = (row && row.programmes) || [];
    var anyProg = progs.some(function (p) {
      var start = new Date(p.start).getTime();
      if (!Number.isFinite(start)) return false;
      if (time && !matchesTimeLocal(start, time)) return false;
      return textHits(
        [p.title, p.subtitle, p.description, (p.categories || []).join(' ')].filter(Boolean).join(' '),
        text
      );
    });
    if (anyProg) return true;

    if (text) {
      return textHits([row.cleanName, row.name, row.category].filter(Boolean).join(' '), text);
    }
    // Query só de horário ("20h"): casa se algum programa da linha cair na hora.
    return progs.some(function (p) {
      var start = new Date(p.start).getTime();
      return Number.isFinite(start) && matchesTimeLocal(start, time);
    });
  }

  /* Busca agrupada sobre dados já carregados (painel "buscar em todos").
     `programmes`: lista plana [{ start, stop, title, subtitle, description,
     categories, channelId, channelName, channelLogo, channelCategory }]. */
  function searchAll(query, ctx) {
    ctx = ctx || {};
    var parsed = splitTimeToken(query);
    var text = parsed.text;
    var time = parsed.time;

    var channels = (ctx.channels || []).filter(function (ch) {
      if (text) {
        return textHits([ch.cleanName, ch.name, ch.category].filter(Boolean).join(' '), text);
      }
      return false;
    });

    var out = [];
    var seen = Object.create(null);
    (ctx.programmes || []).forEach(function (p) {
      var start = new Date((p.start != null ? p.start : p.startTs)).getTime();
      if (!Number.isFinite(start)) return;
      if (time && !matchesTimeLocal(start, time)) return;
      if (text) {
        var hay = [p.title, p.subtitle, p.description, (p.categories || []).join(' ')].filter(Boolean).join(' ');
        if (!textHits(hay, text)) return;
      }
      var key = p.channelId + '|' + p.start + '|' + p.title;
      if (seen[key]) return;
      seen[key] = true;
      out.push(p);
    });
    out.sort(function (a, b) {
      return new Date(a.start).getTime() - new Date(b.start).getTime();
    });

    return { channels: channels, programmes: out };
  }

  return {
    normalizeForSearch: normalizeForSearch,
    splitTimeToken: splitTimeToken,
    minuteOfDayLocal: minuteOfDayLocal,
    matchesTimeLocal: matchesTimeLocal,
    matchesGuideRow: matchesGuideRow,
    searchAll: searchAll,
  };
});