#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const TOTAL_TIMEOUT = 10000;
const MAX_CONCURRENT = 8;
const BATCH_DELAY = 80;

function httpRequest(url, method = 'GET', timeout = TOTAL_TIMEOUT) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const proto = url.startsWith('https') ? https : http;
    const req = proto.request(url, {
      method,
      timeout,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        status: res.statusCode, contentType: res.headers['content-type'] || null,
        contentLength: parseInt(res.headers['content-length'] || '0', 10) || null,
        responseTimeMs: Date.now() - startTime, data, error: null,
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, contentType: null, contentLength: null, responseTimeMs: Date.now() - startTime, data: '', error: 'TIMEOUT' }); });
    req.on('error', (err) => resolve({ status: 0, contentType: null, contentLength: null, responseTimeMs: Date.now() - startTime, data: '', error: err.code || 'ERROR' }));
    req.end();
  });
}

async function runConcurrent(tasks, limit) {
  const results = []; let idx = 0;
  async function worker() { while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); } }
  await Promise.all(Array(Math.min(limit, tasks.length)).fill(null).map(() => worker()));
  return results;
}

function validateM3U8(content) {
  if (!content || !content.trim().startsWith('#EXTM3U')) return { valid: false };
  const isMaster = content.includes('#EXT-X-STREAM-INF');
  const isMedia = content.includes('#EXTINF');
  if (isMaster) {
    const variants = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('#EXT-X-STREAM-INF')) {
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith('#')) { variants.push(next); break; }
        }
      }
    }
    return { valid: true, type: 'master', variants };
  } else if (isMedia) {
    const segments = content.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#') && /\.(ts|m4s|mp4)/.test(l));
    return { valid: true, type: 'media', segments };
  }
  return { valid: true, type: 'empty' };
}

async function testM3U8Channel(name, originalUrl, hosts) {
  // Test original
  const origResult = await httpRequest(originalUrl, 'GET');
  if (origResult.status === 200) {
    const manifest = validateM3U8(origResult.data);
    if (manifest.valid) return { found: true, url: originalUrl, identifier: extractId(originalUrl), httpStatus: 200, manifestType: manifest.type };
  }

  // Generate extended candidates
  const candidates = generateExtendedCandidates(name);
  const tested = new Set();
  tested.add(extractId(originalUrl));
  const attempts = [];

  for (const candidate of candidates) {
    if (tested.has(candidate)) continue;
    tested.add(candidate);

    const tasks = [];
    for (const host of hosts) {
      // Standard M3U8 path
      const url1 = `http://${host}/${candidate}/index.m3u8`;
      tasks.push(() => httpRequest(url1, 'GET').then(r => ({ url: url1, host, result: r })));
      // Alternate path patterns
      const url2 = `http://${host}/${candidate}.m3u8`;
      tasks.push(() => httpRequest(url2, 'GET').then(r => ({ url: url2, host, result: r })));
    }

    const results = await runConcurrent(tasks, MAX_CONCURRENT);
    for (const r of results) {
      attempts.push({ identifier: candidate, url: r.url, httpStatus: r.result.status, responseTimeMs: r.result.responseTimeMs, error: r.result.error });
      if (r.result.status === 200) {
        const manifest = validateM3U8(r.result.data);
        if (manifest.valid) {
          return { found: true, url: r.url, identifier: candidate, httpStatus: 200, manifestType: manifest.type, attempts };
        }
      }
    }
    await new Promise(r => setTimeout(r, BATCH_DELAY));
  }

  return { found: false, attempts };
}

function generateExtendedCandidates(name) {
  const cands = new Set();
  const upper = name.toUpperCase().trim();
  const words = upper.split(/\s+/).filter(w => w.length > 0 && !['DE','DA','DO','E','&','EM','NO','NA'].includes(w));

  // Basic normalizations
  const withU = words.join('_');
  const noSep = words.join('');
  const withH = words.join('-');
  cands.add(withU); cands.add(noSep); cands.add(withH);

  // With HD suffixes
  for (const base of [withU, noSep, withH]) {
    cands.add(base + '_HD'); cands.add(base + 'HD'); cands.add(base + '-HD');
    cands.add(base + '_SD'); cands.add(base + '_FHD');
    cands.add('HD_' + base); cands.add('HD' + base);
  }

  // Acronyms
  if (words.length > 1) {
    const acr = words.map(w => w[0]).join('');
    cands.add(acr); cands.add(acr + '_HD'); cands.add(acr + 'HD'); cands.add('HD_' + acr);
    if (words.length === 2) {
      cands.add(words[0] + words[1]); cands.add(words[0] + words[1] + '_HD');
      cands.add(words[1] + '_' + words[0]); cands.add(words[1] + words[0]); cands.add(words[1] + words[0] + '_HD');
    }
  }

  // Single words
  for (const w of words) { cands.add(w); cands.add(w + '_HD'); cands.add(w + 'HD'); }

  // Special: & handling
  if (upper.includes('&')) {
    const noAmp = upper.replace(/&/g, '').replace(/\s+/g, '_').replace(/[_]+/g, '_').replace(/^_|_$/g, '');
    const andV = upper.replace(/&/g, 'AND').replace(/\s+/g, '_').replace(/[_]+/g, '_').replace(/^_|_$/g, '');
    const eV = upper.replace(/&/g, 'E').replace(/\s+/g, '_').replace(/[_]+/g, '_').replace(/^_|_$/g, '');
    for (const v of [noAmp, andV, eV]) {
      cands.add(v); cands.add(v + '_HD'); cands.add(v.replace(/_/g, '')); cands.add(v.replace(/_/g, '') + '_HD');
    }
  }

  // Special: ! handling
  if (upper.includes('!')) {
    const noB = upper.replace(/!/g, '').trim();
    cands.add(noB); cands.add(noB.replace(/\s+/g, '_')); cands.add(noB.replace(/\s+/g, ''));
    cands.add(noB.replace(/\s+/g, '_') + '_HD');
  }

  // Special: (IURD) handling
  if (upper.includes('(')) {
    const noP = upper.replace(/\s*\([^)]*\)/g, '').trim();
    cands.add(noP); cands.add(noP.replace(/\s+/g, '_')); cands.add(noP.replace(/\s+/g, ''));
    cands.add(noP.replace(/\s+/g, '_') + '_HD');
    const m = upper.match(/\(([^)]+)\)/);
    if (m) { cands.add(m[1]); cands.add(m[1].replace(/\s+/g, '_')); }
  }

  // Number handling
  const numMatch = upper.match(/(\d+)/);
  if (numMatch) {
    const num = numMatch[1];
    const noNum = upper.replace(/\d+/g, '').trim().replace(/\s+/g, '_').replace(/^_|_$/g, '');
    cands.add(noNum + num); cands.add(noNum + '_' + num); cands.add(noNum + '-' + num);
    if (num.length === 1) { cands.add(noNum + '0' + num); cands.add(noNum + '_0' + num); }
    cands.add(noNum + num + '_HD'); cands.add(noNum + '_' + num + '_HD');
  }

  // Filter
  return [...cands].filter(c => c.length >= 2 && c.length <= 40);
}

function extractId(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const dir = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
    return dir.replace(/\.m3u8$/i, '');
  } catch { return 'UNKNOWN'; }
}

async function main() {
  const M3U_PATH = path.resolve(__dirname, 'input', 'SvenTvChannelsBACKUP.m3u');
  const content = fs.readFileSync(M3U_PATH, 'utf8');

  // Parse all channels
  const lines = content.split(/\r?\n/);
  const channels = [];
  let curExtinf = null;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#EXTINF:')) {
      curExtinf = { raw: t, displayName: (t.match(/,(.+)$/) || [])[1] || '', tvgName: (t.match(/tvg-name="([^"]*)"/) || [])[1] || '' };
    } else if (t.startsWith('#')) {
      if (t.startsWith('# http') || t.startsWith('#http')) {
        if (curExtinf) { channels.push({ ...curExtinf, url: t.replace(/^#\s?/, ''), commented: true }); curExtinf = null; }
      } else if (t.startsWith('# #EXTINF:')) {
        curExtinf = { raw: t.replace(/^#\s?/, ''), displayName: (t.replace(/^#\s?/, '').match(/,(.+)$/) || [])[1] || '', tvgName: (t.replace(/^#\s?/, '').match(/tvg-name="([^"]*)"/) || [])[1] || '', commented: true };
      }
    } else if (t.startsWith('http')) {
      if (curExtinf) { channels.push({ ...curExtinf, url: t, commented: curExtinf.commented || false }); curExtinf = null; }
    }
  }

  const hosts = ['45.190.28.50', '45.162.64.114', '177.52.24.163'];

  // === PART 1: Test direct TS streams ===
  console.log('=== TESTING DIRECT TS STREAMS ===\n');
  const directTs = channels.filter(ch => !ch.commented && /\.ts(\?|$)/i.test(ch.url));
  console.log(`Found ${directTs.length} direct TS channels\n`);

  const tsResults = [];
  for (const ch of directTs) {
    const result = await httpRequest(ch.url, 'HEAD', 8000);
    const status = result.status === 200 ? 'ONLINE' : (result.status === 0 ? 'ERROR' : `HTTP_${result.status}`);
    console.log(`[${status}] ${ch.displayName}: ${ch.url} (HTTP ${result.status}, ${result.responseTimeMs}ms, type=${result.contentType}, len=${result.contentLength})`);
    tsResults.push({ name: ch.displayName, url: ch.url, status: result.status, contentType: result.contentType, contentLength: result.contentLength, responseTimeMs: result.responseTimeMs, error: result.error });
  }

  // === PART 2: Extended M3U8 candidate testing for failed channels ===
  console.log('\n=== EXTENDED M3U8 CANDIDATE TESTING ===\n');
  const failedChannels = [
    { name: 'AMC', url: 'http://45.162.64.114/AMCHD/index.m3u8' },
    { name: 'BIS', url: 'http://45.190.28.50/bis/index.m3u8' },
    { name: 'BM&C', url: 'http://45.190.28.50/BM&C_HD/index.m3u8' },
    { name: 'CANAL BRASIL', url: 'http://45.190.28.50/CANAL_BRASIL/index.m3u8' },
    { name: 'COMBATE', url: 'http://45.190.28.50/COMBATE/index.m3u8' },
    { name: 'CURTA!', url: 'http://45.190.28.50/CURTA!/index.m3u8' },
    { name: 'GLOOB', url: 'http://45.162.64.114/GLOOB_HD/index.m3u8' },
    // Also test DISCOVERY HOME & HEALTH (commented out)
    { name: 'DISCOVERY HOME & HEALTH', url: 'http://45.190.28.50/DISCOVERY_HOME_AND_HEALTH_HD/index.m3u8' },
  ];

  const m3u8Results = [];
  for (const ch of failedChannels) {
    process.stdout.write(`Testing "${ch.name}"... `);
    const result = await testM3U8Channel(ch.name, ch.url, hosts);
    if (result.found) {
      console.log(`FOUND! ${result.url} (HTTP ${result.httpStatus}, manifest=${result.manifestType})`);
    } else {
      console.log(`NOT FOUND (${result.attempts.length} URLs tested)`);
    }
    m3u8Results.push({ name: ch.name, originalUrl: ch.url, ...result });
  }

  // === PART 3: Test token-based channels ===
  console.log('\n=== TESTING TOKEN-BASED CHANNELS ===\n');
  const tokenChannels = channels.filter(ch => !ch.commented && /[?&]token=/i.test(ch.url));
  for (const ch of tokenChannels) {
    const result = await httpRequest(ch.url, 'GET', 10000);
    const manifest = result.status === 200 ? validateM3U8(result.data) : null;
    console.log(`[${result.status === 200 ? 'OK' : 'FAIL'}] ${ch.displayName}: HTTP ${result.status}, manifest=${manifest?.valid || false}`);
  }

  // Save all results
  const allResults = {
    timestamp: new Date().toISOString(),
    directTs: tsResults,
    extendedM3U8: m3u8Results,
    tokenChannels: tokenChannels.map(ch => ({ name: ch.displayName, url: ch.url })),
  };
  fs.writeFileSync(path.resolve(__dirname, 'results', 'deep-test-results.json'), JSON.stringify(allResults, null, 2));
  console.log('\nResults saved to results/deep-test-results.json');
}

main().catch(console.error);
