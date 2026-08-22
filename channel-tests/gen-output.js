#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const M3U_PATH = path.resolve(BASE, 'input', 'SvenTvChannelsBACKUP.m3u');
const RESULTS_PATH = path.resolve(BASE, 'results', 'results.json');
const DEEP_PATH = path.resolve(BASE, 'results', 'deep-test-results.json');
const OUTPUT_DIR = path.resolve(BASE, 'output');

const content = fs.readFileSync(M3U_PATH, 'utf8');
const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
let deepResults = {};
try { deepResults = JSON.parse(fs.readFileSync(DEEP_PATH, 'utf8')); } catch(e) {}

// cdn47.cc offline URLs
const offlineCdn47 = new Set();
if (deepResults.directTs) {
  for (const ts of deepResults.directTs) {
    if (ts.status !== 200) offlineCdn47.add(ts.url);
  }
}

// Deep recovered
const deepRecovered = {};
if (deepResults.extendedM3U8) {
  for (const r of deepResults.extendedM3U8) {
    if (r.found) deepRecovered[r.name] = r;
  }
}

// Parse M3U properly
const lines = content.split(/\r?\n/);
const channelPairs = [];
let pendingExtinf = null;
let pendingCommented = false;

function extractName(extinf) {
  const m = extinf.match(/,(.+)$/);
  return m ? m[1].trim() : '';
}

for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (!t || t === '#EXTM3U') continue;

  if (t.startsWith('#EXTINF:') && !t.startsWith('# #EXTINF:')) {
    pendingExtinf = t;
    pendingCommented = false;
    continue;
  }
  if (t.startsWith('# #EXTINF:')) {
    pendingExtinf = t.replace(/^#\s?/, '');
    pendingCommented = true;
    continue;
  }
  if ((t.startsWith('# http') || t.startsWith('#http')) && pendingExtinf) {
    channelPairs.push({ extinf: pendingExtinf, url: t.replace(/^#\s?/, ''), name: extractName(pendingExtinf), commented: true });
    pendingExtinf = null;
    continue;
  }
  if (t.startsWith('http') && pendingExtinf) {
    channelPairs.push({ extinf: pendingExtinf, url: t, name: extractName(pendingExtinf), commented: pendingCommented });
    pendingExtinf = null;
    continue;
  }
}

// Group by channel name: prefer active URLs over commented
const channelMap = new Map();
for (const pair of channelPairs) {
  const key = pair.name || pair.url;
  if (!channelMap.has(key)) channelMap.set(key, { active: null, commented: [] });
  const ch = channelMap.get(key);
  if (!pair.commented) ch.active = pair;
  else ch.commented.push(pair);
}

// Classify
const recovered = [];
const offline = [];

for (const [name, ch] of channelMap) {
  const chResult = results.channels[name];
  const isDeepRecovered = deepRecovered[name];

  if (isDeepRecovered) {
    const entry = ch.active || ch.commented[0];
    recovered.push({ extinf: entry.extinf, url: deepRecovered[name].url, name });
  } else if (ch.active) {
    const isCdnOff = offlineCdn47.has(ch.active.url);
    if (isCdnOff) {
      offline.push(ch.active);
    } else if (chResult && chResult.result === 'FOUND') {
      recovered.push(ch.active);
    } else if (chResult && chResult.result === 'NOT_FOUND') {
      offline.push(ch.active);
    } else {
      recovered.push(ch.active);
    }
  } else {
    if (chResult && chResult.result === 'FOUND') {
      const entry = ch.commented[0];
      recovered.push({ extinf: entry.extinf, url: chResult.url, name });
    } else {
      for (const c of ch.commented) offline.push(c);
    }
  }
}

// Write files
let recM3U = '#EXTM3U\n\n';
for (const e of recovered) recM3U += e.extinf + '\n' + e.url + '\n\n';

let offM3U = '#EXTM3U\n\n';
for (const e of offline) offM3U += e.extinf + '\n#' + e.url + '\n\n';

fs.writeFileSync(path.join(OUTPUT_DIR, 'SvenTvChannels_RECOVERED.m3u'), recM3U, 'utf8');
fs.writeFileSync(path.join(OUTPUT_DIR, 'SvenTvChannels_OFFLINE.m3u'), offM3U, 'utf8');

console.log('RECOVERED: ' + recovered.length);
console.log('OFFLINE: ' + offline.length);

// Verify: read back and count channels
const recContent = fs.readFileSync(path.join(OUTPUT_DIR, 'SvenTvChannels_RECOVERED.m3u'), 'utf8');
const recCount = (recContent.match(/#EXTINF:/g) || []).length;
const offContent = fs.readFileSync(path.join(OUTPUT_DIR, 'SvenTvChannels_OFFLINE.m3u'), 'utf8');
const offCount = (offContent.match(/#EXTINF:/g) || []).length;
console.log('Verified RECOVERED EXTINF count: ' + recCount);
console.log('Verified OFFLINE EXTINF count: ' + offCount);
console.log('Total: ' + (recCount + offCount));
