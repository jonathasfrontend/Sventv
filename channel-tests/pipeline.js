#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ============================================================
// CONFIGURATION
// ============================================================
const BASE_DIR = path.resolve(__dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'config', 'settings.json'), 'utf8'));

const M3U_PATH = path.join(BASE_DIR, 'input', 'SvenTvChannelsBACKUP.m3u');
const RESULTS_PATH = path.join(BASE_DIR, CONFIG.output.results_file);
const REPORT_PATH = path.join(BASE_DIR, CONFIG.output.report_file);
const OUTPUT_DIR = path.join(BASE_DIR, CONFIG.output.directory);

const CONNECT_TIMEOUT = CONFIG.timeouts.connect_ms;
const READ_TIMEOUT = CONFIG.timeouts.read_ms;
const TOTAL_TIMEOUT = CONFIG.timeouts.total_ms;
const MAX_CONCURRENT = CONFIG.concurrency.max_concurrent;
const BATCH_DELAY = CONFIG.concurrency.delay_between_batches_ms;
const MAX_SEGMENTS_TEST = CONFIG.validation.max_segments_to_test;
const MIN_SEGMENTS_OK = CONFIG.validation.min_segments_ok;

// ============================================================
// LOGGING
// ============================================================
const LOG_PATH = path.join(BASE_DIR, 'logs', 'execution.log');
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// ============================================================
// M3U PARSER
// ============================================================
function parseM3U(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const channels = [];
  let currentExtinf = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      currentExtinf = {
        raw: line,
        lineNum: i + 1,
        tvgId: extractAttr(line, 'tvg-id'),
        tvgName: extractAttr(line, 'tvg-name'),
        tvgLogo: extractAttr(line, 'tvg-logo'),
        groupTitle: extractAttr(line, 'group-title'),
        displayName: extractDisplayName(line),
      };
    } else if (line.startsWith('#')) {
      if (line === '#EXTM3U') continue;
      // Commented channel - the next non-comment, non-empty line would be the URL
      // Check if this is a commented EXTINF
      if (line.startsWith('# #EXTINF:') || line.startsWith('#EXTINF:')) {
        const cleaned = line.replace(/^#\s?/, '');
        if (cleaned.startsWith('#EXTINF:')) {
          // Double commented - skip
          continue;
        }
        currentExtinf = {
          raw: cleaned,
          lineNum: i + 1,
          tvgId: extractAttr(cleaned, 'tvg-id'),
          tvgName: extractAttr(cleaned, 'tvg-name'),
          tvgLogo: extractAttr(cleaned, 'tvg-logo'),
          groupTitle: extractAttr(cleaned, 'group-title'),
          displayName: extractDisplayName(cleaned),
          commented: true,
        };
      } else if (line.startsWith('# http') || line.startsWith('#http')) {
        // Commented URL
        const url = line.replace(/^#\s?/, '');
        if (currentExtinf) {
          currentExtinf.commented = true;
          channels.push({
            ...currentExtinf,
            url: url,
            commented: true,
          });
          currentExtinf = null;
        }
      }
    } else if (line.startsWith('http')) {
      if (currentExtinf) {
        channels.push({
          ...currentExtinf,
          url: line,
          commented: currentExtinf.commented || false,
        });
        currentExtinf = null;
      } else {
        // Orphan URL
        channels.push({
          raw: '',
          lineNum: i + 1,
          url: line,
          displayName: guessNameFromUrl(line),
          commented: false,
        });
      }
    }
  }
  return channels;
}

function extractAttr(line, attr) {
  const regex = new RegExp(`${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`, 'i');
  const m = line.match(regex);
  return m ? m[1] : '';
}

function extractDisplayName(line) {
  const m = line.match(/,(.+)$/);
  return m ? m[1].trim() : '';
}

function guessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2];
    return parts[parts.length - 1] || 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

// ============================================================
// CHANNEL CLASSIFIER
// ============================================================
function classifyChannels(channels) {
  const result = {
    active: [],
    commented: [],
    directTs: [],
    m3u8Based: [],
    tokenBased: [],
    externalHost: [],
    all: channels,
  };

  const knownHosts = new Set(CONFIG.base_urls.map(u => {
    try { return new URL(u).hostname; } catch { return u; }
  }));
  knownHosts.add('cdn47.cc');

  for (const ch of channels) {
    if (ch.commented) {
      result.commented.push(ch);
      continue;
    }

    const url = ch.url || '';
    ch.isDirectTs = /\.ts(\?|$)/i.test(url);
    ch.isM3U8 = /\.m3u8(\?|$)/i.test(url);
    ch.hasToken = /[?&]token=/i.test(url);

    try {
      const u = new URL(url);
      ch.host = u.hostname;
      ch.port = u.port;
      ch.isKnownHost = knownHosts.has(ch.host) || knownHosts.has(ch.host + ':' + ch.port);
    } catch {
      ch.host = '';
      ch.isKnownHost = false;
    }

    if (ch.isDirectTs) {
      ch.type = 'DIRECT_TS';
      result.directTs.push(ch);
    } else if (ch.isM3U8) {
      ch.type = 'M3U8';
      result.m3u8Based.push(ch);
      if (ch.hasToken) {
        ch.type = 'M3U8_TOKEN';
        result.tokenBased.push(ch);
      }
    } else {
      ch.type = 'UNKNOWN';
    }

    result.active.push(ch);
  }

  return result;
}

// ============================================================
// PATTERN LEARNER (from working channels)
// ============================================================
function learnPatterns(classified) {
  const patterns = {
    separator: { underscore: 0, hyphen: 0, none: 0, dot: 0 },
    suffix: { _HD: 0, HD: 0, _SD: 0, _FHD: 0 },
    acronym: 0,
    inverted: 0,
    directMatch: 0,
    total: 0,
    mappingRules: [],
  };

  for (const ch of classified.m3u8Based) {
    if (!ch.url || ch.commented) continue;
    patterns.total++;

    let identifier = '';
    try {
      const u = new URL(ch.url);
      const parts = u.pathname.split('/').filter(Boolean);
      identifier = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
      identifier = identifier.replace(/\.m3u8$/i, '');
    } catch { continue; }

    const name = (ch.tvgName || ch.displayName || '').toUpperCase().trim();
    if (!name || !identifier) continue;

    patterns.mappingRules.push({
      displayName: name,
      identifier: identifier,
      host: ch.host,
    });

    // Analyze separator
    if (identifier.includes('_')) patterns.separator.underscore++;
    else if (identifier.includes('-')) patterns.separator.hyphen++;
    else if (identifier.includes('.')) patterns.separator.dot++;
    else patterns.separator.none++;

    // Analyze suffix
    if (/_HD$/i.test(identifier)) patterns.suffix._HD++;
    else if (/HD$/i.test(identifier)) patterns.suffix.HD++;
    else if (/_SD$/i.test(identifier)) patterns.suffix._SD++;
    else if (/_FHD$/i.test(identifier)) patterns.suffix._FHD++;

    // Check if identifier is an acronym (all caps, short)
    const words = name.split(/\s+/);
    if (identifier.length <= 5 && words.length > 1) patterns.acronym++;

    // Check if words are inverted
    const nameWords = name.split(/\s+/).filter(w => !['DE','DA','DO','E','&','OF','THE','A','O','EM','NO','NA'].includes(w));
    const idUpper = identifier.toUpperCase().replace(/[_\-\.]/g, ' ');
    const idWords = idUpper.split(/\s+/).filter(w => w.length > 0);
    if (nameWords.length > 1 && idWords.length > 1) {
      if (nameWords[0] !== idWords[0] && nameWords[nameWords.length - 1] === idWords[0]) {
        patterns.inverted++;
      }
    }
  }

  return patterns;
}

// ============================================================
// CANDIDATE GENERATOR
// ============================================================
const STOP_WORDS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'NO', 'NA', 'NOS', 'NAS', 'A', 'O', 'AS', 'OS', 'THE', 'OF', 'AND', 'IN', 'FOR']);

function generateCandidates(name, patterns) {
  const candidates = new Set();
  const upper = name.toUpperCase().trim();
  const words = upper.split(/\s+/).filter(w => w.length > 0);
  const significantWords = words.filter(w => !STOP_WORDS.has(w));

  // Strategy 1: Direct name with underscores
  const withUnderscores = significantWords.join('_');
  addCandidate(candidates, withUnderscores);

  // Strategy 2: Name without separators
  const noSeparators = significantWords.join('');
  addCandidate(candidates, noSeparators);

  // Strategy 3: With hyphens
  const withHyphens = significantWords.join('-');
  addCandidate(candidates, withHyphens);

  // Strategy 4: Common suffixes
  const suffixes = ['_HD', 'HD', '_SD', '_FHD', '_4K', '_LIVE', '_BR', 'BR'];
  for (const base of [withUnderscores, noSeparators]) {
    for (const suffix of suffixes) {
      addCandidate(candidates, base + suffix);
    }
    // Prefix HD
    addCandidate(candidates, 'HD_' + base);
    addCandidate(candidates, 'HD' + base);
  }

  // Strategy 5: Acronym
  if (significantWords.length > 1) {
    const acronym = significantWords.map(w => w[0]).join('');
    addCandidate(candidates, acronym);
    addCandidate(candidates, acronym + '_HD');
    addCandidate(candidates, acronym + 'HD');
    addCandidate(candidates, 'HD_' + acronym);

    // 2-letter acronym
    if (significantWords.length >= 2) {
      addCandidate(candidates, significantWords.slice(0, 2).map(w => w[0]).join(''));
    }
  }

  // Strategy 6: Single significant words
  for (const w of significantWords) {
    addCandidate(candidates, w);
    addCandidate(candidates, w + '_HD');
    addCandidate(candidates, w + 'HD');
  }

  // Strategy 7: Word pairs (adjacent)
  if (significantWords.length > 1) {
    for (let i = 0; i < significantWords.length - 1; i++) {
      const pair = significantWords[i] + '_' + significantWords[i + 1];
      addCandidate(candidates, pair);
      addCandidate(candidates, pair + '_HD');
      addCandidate(candidates, significantWords[i] + significantWords[i + 1]);
      addCandidate(candidates, significantWords[i] + significantWords[i + 1] + '_HD');
    }
  }

  // Strategy 8: Inverted order (first + last swapped)
  if (significantWords.length === 2) {
    const inverted = [significantWords[1], significantWords[0]].join('_');
    addCandidate(candidates, inverted);
    addCandidate(candidates, inverted + '_HD');
    addCandidate(candidates, significantWords[1] + significantWords[0]);
    addCandidate(candidates, significantWords[1] + significantWords[0] + '_HD');
  } else if (significantWords.length === 3) {
    // Try moving last word to front
    const moved = [significantWords[2], ...significantWords.slice(0, 2)].join('_');
    addCandidate(candidates, moved);
    addCandidate(candidates, moved + '_HD');
  }

  // Strategy 9: Handle & specially
  if (upper.includes('&')) {
    const noAmp = upper.replace(/&/g, '').replace(/\s+/g, '_').replace(/[_]+/g, '_').replace(/^_|_$/g, '');
    addCandidate(candidates, noAmp);
    addCandidate(candidates, noAmp + '_HD');

    const andReplaced = upper.replace(/&/g, 'AND').replace(/\s+/g, '_').replace(/[_]+/g, '_').replace(/^_|_$/g, '');
    addCandidate(candidates, andReplaced);
    addCandidate(candidates, andReplaced + '_HD');

    const eReplaced = upper.replace(/&/g, 'E').replace(/\s+/g, '_').replace(/[_]+/g, '_').replace(/^_|_$/g, '');
    addCandidate(candidates, eReplaced);
    addCandidate(candidates, eReplaced + '_HD');

    // No separator versions
    addCandidate(candidates, noAmp.replace(/_/g, ''));
    addCandidate(candidates, andReplaced.replace(/_/g, ''));
    addCandidate(candidates, eReplaced.replace(/_/g, ''));
  }

  // Strategy 10: Handle ! specially
  if (upper.includes('!')) {
    const noBang = upper.replace(/!/g, '').trim();
    addCandidate(candidates, noBang);
    addCandidate(candidates, noBang.replace(/\s+/g, '_'));
    addCandidate(candidates, noBang.replace(/\s+/g, ''));
    addCandidate(candidates, noBang.replace(/\s+/g, '_') + '_HD');
  }

  // Strategy 11: Handle (IURD) style parentheses
  if (upper.includes('(')) {
    const noParens = upper.replace(/\s*\([^)]*\)/g, '').trim();
    addCandidate(candidates, noParens);
    addCandidate(candidates, noParens.replace(/\s+/g, '_'));
    addCandidate(candidates, noParens.replace(/\s+/g, ''));
    addCandidate(candidates, noParens.replace(/\s+/g, '_') + '_HD');

    const m = upper.match(/\(([^)]+)\)/);
    if (m) {
      addCandidate(candidates, m[1]);
      addCandidate(candidates, m[1].replace(/\s+/g, '_'));
      addCandidate(candidates, noParens.replace(/\s+/g, '_') + '_' + m[1]);
    }
  }

  // Strategy 12: Handle numbers (PREMIERE 2, MTV 00S)
  const numMatch = upper.match(/(\d+)/);
  if (numMatch) {
    const num = numMatch[1];
    const noNum = upper.replace(/\d+/g, '').trim().replace(/\s+/g, '_').replace(/^_|_$/g, '');
    addCandidate(candidates, noNum + num);
    addCandidate(candidates, noNum + '_' + num);
    addCandidate(candidates, noNum + '-' + num);
    if (num.length === 1) {
      addCandidate(candidates, noNum + '0' + num);
      addCandidate(candidates, noNum + '_0' + num);
    }
    addCandidate(candidates, noNum + num + '_HD');
    addCandidate(candidates, noNum + '_' + num + '_HD');
  }

  // Strategy 13: Special short names
  if (significantWords.length === 1 && significantWords[0].length <= 3) {
    addCandidate(candidates, significantWords[0]);
    addCandidate(candidates, significantWords[0] + '_HD');
    addCandidate(candidates, significantWords[0] + 'HD');
    addCandidate(candidates, significantWords[0].toLowerCase());
    addCandidate(candidates, significantWords[0].toLowerCase() + '_hd');
  }

  // Priority ordering based on learned patterns
  const sorted = prioritizeCandidates([...candidates], upper, patterns);
  return sorted;
}

function addCandidate(set, candidate) {
  const cleaned = candidate.replace(/[_\-\.]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
  if (cleaned.length >= 2 && cleaned.length <= 40) {
    set.add(cleaned);
  }
}

function prioritizeCandidates(candidates, name, patterns) {
  const scored = candidates.map(c => {
    let score = 0;
    const cUpper = c.toUpperCase();

    // Exact name match (with underscores) gets highest priority
    const nameNormalized = name.replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').replace(/[_]+/g, '_');
    if (cUpper === nameNormalized) score += 100;

    // Bonus for matching known patterns
    if (/_HD$/i.test(cUpper)) score += 15;
    if (/HD$/i.test(cUpper)) score += 10;
    if (cUpper.includes('_')) score += 5;
    if (!cUpper.includes('_') && cUpper.length > 4) score += 3;

    // Penalty for very long or very short
    if (cUpper.length > 25) score -= 10;
    if (cUpper.length < 3) score -= 5;

    // Bonus for common identifiers found in patterns
    for (const rule of patterns.mappingRules) {
      if (cUpper === rule.identifier.toUpperCase()) score += 50;
    }

    return { candidate: cUpper, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.candidate);
}

// ============================================================
// URL BUILDER
// ============================================================
function buildTestUrls(candidate, hosts) {
  const urls = [];
  for (const host of hosts) {
    for (const template of CONFIG.m3u8_endpoints) {
      urls.push(template.replace('{candidate}', candidate).replace('{host}', host));
    }
  }
  return urls;
}

function buildUrl(host, path) {
  if (host.includes('://')) return host + path;
  return 'http://' + host + path;
}

// ============================================================
// HTTP TESTER
// ============================================================
function httpRequest(url, method = 'GET', timeout = TOTAL_TIMEOUT) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const proto = url.startsWith('https') ? https : http;

    const reqOpts = {
      method,
      timeout: timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      },
    };

    const req = proto.request(url, reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          contentType: res.headers['content-type'] || null,
          contentLength: parseInt(res.headers['content-length'] || '0', 10) || null,
          redirectUrl: res.headers.location || null,
          responseTimeMs: Date.now() - startTime,
          data,
          error: null,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        status: 0, headers: {}, contentType: null, contentLength: null,
        redirectUrl: null, responseTimeMs: Date.now() - startTime, data: '',
        error: 'TIMEOUT',
      });
    });

    req.on('error', (err) => {
      resolve({
        status: 0, headers: {}, contentType: null, contentLength: null,
        redirectUrl: null, responseTimeMs: Date.now() - startTime, data: '',
        error: err.code || err.message || 'CONNECTION_ERROR',
      });
    });

    req.end();
  });
}

// ============================================================
// M3U8 VALIDATOR
// ============================================================
function validateM3U8(content) {
  if (!content || content.length === 0) {
    return { valid: false, type: null, error: 'EMPTY_RESPONSE' };
  }

  const trimmed = content.trim();

  // Check if it starts with #EXTM3U
  if (!trimmed.startsWith('#EXTM3U')) {
    // Check if it looks like HTML
    if (trimmed.toLowerCase().includes('<html') || trimmed.toLowerCase().includes('<!doctype')) {
      return { valid: false, type: 'HTML', error: 'HTML_RESPONSE' };
    }
    if (trimmed.toLowerCase().includes('{') && trimmed.toLowerCase().includes('}')) {
      return { valid: false, type: 'JSON', error: 'JSON_RESPONSE' };
    }
    return { valid: false, type: null, error: 'NOT_M3U8' };
  }

  const isMaster = trimmed.includes('#EXT-X-STREAM-INF');
  const isMedia = trimmed.includes('#EXTINF');

  if (isMaster) {
    const variants = extractVariants(trimmed);
    return { valid: true, type: 'master', variants, error: null };
  } else if (isMedia) {
    const segments = extractSegments(trimmed);
    return { valid: true, type: 'media', segments, error: null };
  }

  // Has #EXTM3U but no variants or segments
  return { valid: true, type: 'empty', variants: [], segments: [], error: 'NO_SEGMENTS' };
}

function extractVariants(content) {
  const variants = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('#EXT-X-STREAM-INF')) {
      // Next non-empty line should be the URL
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith('#')) {
          variants.push(next);
          break;
        }
      }
    }
  }
  return variants;
}

function extractSegments(content) {
  const segments = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && (trimmed.includes('.ts') || trimmed.includes('.m4s') || trimmed.includes('.mp4'))) {
      segments.push(trimmed);
    }
  }
  return segments;
}

// ============================================================
// STREAM VALIDATOR (Layer 3: Segments)
// ============================================================
async function validateSegments(segmentUrls, baseUrl) {
  const tested = [];
  const toTest = segmentUrls.slice(0, MAX_SEGMENTS_TEST);

  for (const segUrl of toTest) {
    let fullUrl = segUrl;
    if (!segUrl.startsWith('http')) {
      // Resolve relative URL
      try {
        const base = new URL(baseUrl);
        fullUrl = new URL(segUrl, base).href;
      } catch {
        fullUrl = baseUrl.replace(/\/[^/]*$/, '/') + segUrl;
      }
    }

    const result = await httpRequest(fullUrl, 'HEAD', 8000);
    tested.push({
      url: fullUrl,
      status: result.status,
      contentLength: result.contentLength,
      contentType: result.contentType,
      ok: result.status === 200 && (result.contentLength === null || result.contentLength > 0),
    });
  }

  const okCount = tested.filter(t => t.ok).length;
  return { tested, okCount, total: tested.length };
}

// ============================================================
// FULL CHANNEL TESTER
// ============================================================
async function testChannelOriginal(channel) {
  if (!channel.url) {
    return { result: 'NO_URL', httpStatus: 0, manifestValid: false, segmentsValid: false };
  }

  const httpResult = await httpRequest(channel.url, 'GET');

  const record = {
    url: channel.url,
    httpStatus: httpResult.status,
    responseTimeMs: httpResult.responseTimeMs,
    contentType: httpResult.contentType,
    contentLength: httpResult.contentLength,
    error: httpResult.error,
  };

  if (httpResult.status !== 200) {
    return { ...record, result: 'HTTP_ERROR', manifestValid: false, manifestType: null, segmentsValid: false };
  }

  const manifest = validateM3U8(httpResult.data);
  record.manifestValid = manifest.valid;
  record.manifestType = manifest.type;

  if (!manifest.valid) {
    return { ...record, result: 'M3U8_INVALID', segmentsValid: false };
  }

  // Test segments if available
  if (manifest.type === 'media' && manifest.segments.length > 0) {
    const segResult = await validateSegments(manifest.segments, channel.url);
    record.segmentsValid = segResult.okCount >= MIN_SEGMENTS_OK;
    record.segmentsTested = segResult.total;
    record.segmentsOk = segResult.okCount;

    if (record.segmentsValid) {
      return { ...record, result: 'HTTP_OK_STREAM_VALID' };
    } else {
      return { ...record, result: 'HTTP_OK_SEGMENTS_FAILED' };
    }
  } else if (manifest.type === 'master' && manifest.variants.length > 0) {
    // Test first variant
    let variantUrl = manifest.variants[0];
    if (!variantUrl.startsWith('http')) {
      try {
        const base = new URL(channel.url);
        variantUrl = new URL(variantUrl, base).href;
      } catch {}
    }
    const varResult = await httpRequest(variantUrl, 'GET');
    if (varResult.status === 200) {
      const varManifest = validateM3U8(varResult.data);
      if (varManifest.valid && varManifest.type === 'media' && varManifest.segments.length > 0) {
        const segResult = await validateSegments(varManifest.segments, variantUrl);
        record.segmentsValid = segResult.okCount >= MIN_SEGMENTS_OK;
        record.segmentsTested = segResult.total;
        record.segmentsOk = segResult.okCount;
        if (record.segmentsValid) {
          return { ...record, result: 'HTTP_OK_STREAM_VALID' };
        }
      }
    }
    return { ...record, result: 'HTTP_OK_SEGMENTS_FAILED', segmentsValid: false };
  }

  // Master playlist with no variants or media with no segments
  return { ...record, result: 'HTTP_OK_MANIFEST_INVALID' };
}

// ============================================================
// CONCURRENT EXECUTOR
// ============================================================
async function runConcurrent(tasks, maxConcurrent) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(maxConcurrent, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ============================================================
// GENERATE OUTPUT M3U FILES
// ============================================================
function generateOutputM3U(channels, recoveredMap, outputPath, offlineMode) {
  let output = '#EXTM3U\n\n';

  for (const ch of channels) {
    if (ch.commented) continue; // Skip originally commented

    const recovered = recoveredMap.get(ch.displayName);
    const extinf = ch.raw;

    if (offlineMode) {
      // Offline file: channels not recovered, commented out
      if (!recovered) {
        output += `${extinf}\n`;
        output += `#${ch.url}\n\n`;
      }
    } else {
      // Recovered file: channels with valid URLs
      if (recovered) {
        output += `${extinf}\n`;
        output += `${recovered.url}\n\n`;
      }
    }
  }

  fs.writeFileSync(outputPath, output, 'utf8');
  log(`Written: ${outputPath}`);
}

function generateFullM3U(channels, recoveredMap, outputPath) {
  let output = '#EXTM3U\n\n';

  for (const ch of channels) {
    if (ch.committed) continue;
    const recovered = recoveredMap.get(ch.displayName);
    const extinf = ch.raw;

    if (recovered) {
      output += `${extinf}\n`;
      output += `${recovered.url}\n\n`;
    } else if (ch.url) {
      output += `${extinf}\n`;
      output += `${ch.url}\n\n`;
    }
  }

  fs.writeFileSync(outputPath, output, 'utf8');
}

// ============================================================
// REPORT GENERATOR
// ============================================================
function generateReport(classified, patternLearn, testResults, recoveredMap, startTime) {
  const elapsed = Date.now() - startTime;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);

  const totalChannels = classified.active.length;
  const commentedCount = classified.commented.length;
  const m3u8Count = classified.m3u8Based.length;
  const directTsCount = classified.directTs.length;
  const recoveredCount = recoveredMap.size;
  const testedCount = testResults.length;
  const totalUrlsTested = testResults.reduce((sum, r) => sum + (r.candidatesTested || 0), 0);

  const http200Count = testResults.filter(r => r.bestHttpStatus === 200).length;
  const manifestValidCount = testResults.filter(r => r.bestManifestValid).length;
  const streamValidCount = testResults.filter(r => r.result === 'FOUND').length;

  const notFoundResults = testResults.filter(r => r.result === 'NOT_FOUND');
  const foundResults = testResults.filter(r => r.result === 'FOUND');
  const httpErrorResults = testResults.filter(r => r.result === 'HTTP_ERROR');
  const manifestInvalidResults = testResults.filter(r => r.result === 'M3U8_INVALID');

  let md = `# RELATÓRIO FINAL - AUDITORIA IPTV\n\n`;
  md += `**Data:** ${new Date().toISOString().split('T')[0]}\n`;
  md += `**Arquivo:** SvenTvChannelsBACKUP.m3u\n`;
  md += `**Tempo total:** ${mins}m ${secs}s\n\n`;

  md += `## RESUMO EXECUTIVO\n\n`;
  md += `| Métrica | Valor |\n`;
  md += `|---------|-------|\n`;
  md += `| Total de canais no arquivo | ${totalChannels + commentedCount} |\n`;
  md += `| Canais ativos (não comentados) | ${totalChannels} |\n`;
  md += `| Canais comentados | ${commentedCount} |\n`;
  md += `| Canais com URL M3U8 | ${m3u8Count} |\n`;
  md += `| Canais com TS direto (cdn47) | ${directTsCount} |\n`;
  md += `| Canais testados (candidatos) | ${testedCount} |\n`;
  md += `| Total de URLs testadas | ${totalUrlsTested} |\n`;
  md += `| Respostas HTTP 200 | ${http200Count} |\n`;
  md += `| Manifests M3U8 válidos | ${manifestValidCount} |\n`;
  md += `| **Canais recuperados** | **${recoveredCount}** |\n`;
  md += `| Canais não recuperados | ${testedCount - recoveredCount} |\n\n`;

  // Pattern analysis
  md += `## PADRÕES DESCOBERTOS\n\n`;
  md += `| Padrão | Ocorrências | % |\n`;
  md += `|--------|-------------|---|\n`;
  const totalP = patternLearn.total || 1;
  md += `| Separador underscore (_) | ${patternLearn.separator.underscore} | ${((patternLearn.separator.underscore / totalP) * 100).toFixed(0)}% |\n`;
  md += `| Separador hífen (-) | ${patternLearn.separator.hyphen} | ${((patternLearn.separator.hyphen / totalP) * 100).toFixed(0)}% |\n`;
  md += `| Sem separador | ${patternLearn.separator.none} | ${((patternLearn.separator.none / totalP) * 100).toFixed(0)}% |\n`;
  md += `| Sufixo _HD | ${patternLearn.suffix._HD} | ${((patternLearn.suffix._HD / totalP) * 100).toFixed(0)}% |\n`;
  md += `| Sufixo HD (colado) | ${patternLearn.suffix.HD} | ${((patternLearn.suffix.HD / totalP) * 100).toFixed(0)}% |\n`;
  md += `| Sigla/acrônimo | ${patternLearn.acronym} | ${((patternLearn.acronym / totalP) * 100).toFixed(0)}% |\n`;
  md += `| Ordem invertida | ${patternLearn.inverted} | ${((patternLearn.inverted / totalP) * 100).toFixed(0)}% |\n\n`;

  // Recovered channels
  md += `## CANAIS RECUPERADOS\n\n`;
  if (foundResults.length === 0) {
    md += `_Nenhum canal foi recuperado nesta execução._\n\n`;
  } else {
    md += `| Canal | Identificador | URL | HTTP | Manifest | Segmentos | Confiança |\n`;
    md += `|-------|--------------|-----|------|----------|-----------|-----------|\n`;
    for (const r of foundResults) {
      const conf = r.segmentsValid ? 'CONFIRMED' : 'PROBABLE';
      md += `| ${r.channelName} | ${r.foundIdentifier} | ${r.bestUrl} | ${r.bestHttpStatus} | VÁLIDO | ${r.segmentsOk}/${r.segmentsTested} | ${conf} |\n`;
    }
    md += `\n`;
  }

  // Not recovered channels
  md += `## CANAIS NÃO RECUPERADOS\n\n`;
  if (notFoundResults.length === 0 && manifestInvalidResults.length === 0) {
    md += `_Todos os canais testados foram recuperados._\n\n`;
  } else {
    md += `| Canal | Candidatos Testados | Tipo | Motivo Predominante |\n`;
    md += `|-------|---------------------|------|---------------------|\n`;
    for (const r of [...notFoundResults, ...manifestInvalidResults]) {
      md += `| ${r.channelName} | ${r.candidatesTested} | ${r.channelType} | ${r.result} |\n`;
    }
    md += `\n`;
  }

  // Channels not testable (direct TS)
  md += `## CANAIS COM TS DIRETO (cdn47.cc) - NÃO TESTÁVEIS VIA M3U8\n\n`;
  md += `| Canal | URL | Status |\n`;
  md += `|-------|-----|--------|\n`;
  for (const ch of classified.directTs) {
    const status = recoveredMap.has(ch.displayName) ? 'RECUPERADO' : 'ATUAL';
    md += `| ${ch.displayName} | ${ch.url} | ${status} |\n`;
  }
  md += `\n`;

  // Token-based channels
  if (classified.tokenBased.length > 0) {
    md += `## CANAIS COM TOKEN (requerem autenticação)\n\n`;
    md += `| Canal | Host | Status |\n`;
    md += `|-------|------|--------|\n`;
    for (const ch of classified.tokenBased) {
      md += `| ${ch.displayName} | ${ch.host} | NÃO TESTÁVEL (token) |\n`;
    }
    md += `\n`;
  }

  // Commented channels
  md += `## CANAIS COMENTADOS NO ORIGINAL\n\n`;
  md += `| Canal | URL Original |\n`;
  md += `|-------|-------------|\n`;
  for (const ch of classified.commented) {
    md += `| ${ch.displayName} | ${ch.url || 'N/A'} |\n`;
  }
  md += `\n`;

  // Detailed channel reports
  md += `## DETALHES POR CANAL (TESTADOS)\n\n`;
  for (const r of testResults) {
    md += `### ${r.channelName}\n`;
    md += `- **URL original:** ${r.originalUrl || 'N/A'}\n`;
    md += `- **Tipo:** ${r.channelType}\n`;
    md += `- **Host original:** ${r.originalHost || 'N/A'}\n`;
    md += `- **Resultado:** ${r.result}\n`;
    md += `- **Candidatos testados:** ${r.candidatesTested}\n`;
    md += `- **Melhor URL encontrada:** ${r.bestUrl || 'Nenhuma'}\n`;
    md += `- **HTTP status:** ${r.bestHttpStatus || 'N/A'}\n`;
    md += `- **Manifest válido:** ${r.bestManifestValid ? 'SIM' : 'NÃO'}\n`;
    md += `- **Segmentos válidos:** ${r.segmentsValid ? `${r.segmentsOk}/${r.segmentsTested}` : 'NÃO'}\n`;
    if (r.attempts && r.attempts.length > 0) {
      md += `- **Tentativas:**\n`;
      for (const a of r.attempts.slice(0, 10)) {
        md += `  - ${a.identifier} → ${a.httpStatus || a.error || 'N/A'} (${a.responseTimeMs}ms)\n`;
      }
      if (r.attempts.length > 10) {
        md += `  - ... e mais ${r.attempts.length - 10} tentativas\n`;
      }
    }
    md += `\n`;
  }

  md += `---\n`;
  md += `_Relatório gerado automaticamente pelo sistema de auditoria IPTV_\n`;

  return md;
}

// ============================================================
// MAIN PIPELINE
// ============================================================
async function main() {
  const startTime = Date.now();
  log('=== INÍCIO DA AUDITORIA IPTV ===');

  // Step 1: Parse M3U
  log('Passo 1: Parseando arquivo M3U...');
  const channels = parseM3U(M3U_PATH);
  log(`  Total de entradas: ${channels.length}`);

  // Step 2: Classify
  log('Passo 2: Classificando canais...');
  const classified = classifyChannels(channels);
  log(`  Ativos: ${classified.active.length}`);
  log(`  Comentados: ${classified.commented.length}`);
  log(`  M3U8-based: ${classified.m3u8Based.length}`);
  log(`  TS direto: ${classified.directTs.length}`);
  log(`  Com token: ${classified.tokenBased.length}`);

  // Step 3: Learn patterns
  log('Passo 3: Analisando padrões dos canais funcionais...');
  const patterns = learnPatterns(classified);
  log(`  Total de canais de referência: ${patterns.total}`);
  log(`  Padrão separator: _=${patterns.separator.underscore} -=${patterns.separator.hyphen} none=${patterns.separator.none}`);
  log(`  Sufixo _HD: ${patterns.suffix._HD}`);
  log(`  Siglas: ${patterns.acronym}`);
  log(`  Ordem invertida: ${patterns.inverted}`);

  // Step 4: Load cache if available
  let cache = {};
  if (CONFIG.cache.enabled && fs.existsSync(RESULTS_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
      log(`  Cache carregado: ${Object.keys(cache.channels || {}).length} canais`);
    } catch { cache = { channels: {} }; }
  } else {
    cache = { channels: {} };
  }

  // Step 5: Determine which channels need testing
  const hosts = CONFIG.base_urls.map(u => {
    try { return new URL(u).hostname; } catch { return u; }
  });

  // Only test channels that use M3U8 on known hosts (not cdn47 direct TS)
  const channelsToTest = classified.m3u8Based.filter(ch => {
    if (ch.commented) return false;
    if (ch.hasToken) return false; // Skip token-based
    return true;
  });

  log(`\nPasso 4: Canais para testar: ${channelsToTest.length}`);

  // Step 6: Test each channel
  const testResults = [];
  const recoveredMap = new Map();

  let channelIdx = 0;
  for (const channel of channelsToTest) {
    channelIdx++;
    const name = channel.displayName || channel.tvgName || 'UNKNOWN';
    log(`\n[${channelIdx}/${channelsToTest.length}] "${name}"`);

    // Check cache
    const cacheKey = name;
    if (cache.channels[cacheKey] && cache.channels[cacheKey].result === 'FOUND') {
      log(`  CACHE HIT: ${cache.channels[cacheKey].url}`);
      recoveredMap.set(name, {
        url: cache.channels[cacheKey].url,
        identifier: cache.channels[cacheKey].identifier,
      });
      testResults.push({
        channelName: name,
        channelType: channel.type,
        originalUrl: channel.url,
        originalHost: channel.host,
        result: 'FOUND',
        foundIdentifier: cache.channels[cacheKey].identifier,
        bestUrl: cache.channels[cacheKey].url,
        bestHttpStatus: 200,
        bestManifestValid: true,
        segmentsValid: true,
        segmentsOk: 1,
        segmentsTested: 1,
        candidatesTested: 0,
        attempts: [],
      });
      continue;
    }

    // Test original URL first
    log(`  URL original: ${channel.url}`);
    const originalResult = await testChannelOriginal(channel);

    if (originalResult.result === 'HTTP_OK_STREAM_VALID') {
      log(`  ✓ ORIGINAL FUNCIONA! (${originalResult.httpStatus}, manifest válido, segmentos OK)`);
      recoveredMap.set(name, {
        url: channel.url,
        identifier: extractIdentifierFromUrl(channel.url),
      });
      testResults.push({
        channelName: name,
        channelType: channel.type,
        originalUrl: channel.url,
        originalHost: channel.host,
        result: 'FOUND',
        foundIdentifier: extractIdentifierFromUrl(channel.url),
        bestUrl: channel.url,
        bestHttpStatus: originalResult.httpStatus,
        bestManifestValid: true,
        segmentsValid: true,
        segmentsOk: originalResult.segmentsOk || 1,
        segmentsTested: originalResult.segmentsTested || 1,
        candidatesTested: 1,
        attempts: [{ identifier: 'ORIGINAL', url: channel.url, httpStatus: originalResult.httpStatus, responseTimeMs: originalResult.responseTimeMs }],
      });
      cache.channels[cacheKey] = { result: 'FOUND', url: channel.url, identifier: extractIdentifierFromUrl(channel.url) };
      continue;
    }

    log(`  Original: ${originalResult.result} (HTTP ${originalResult.httpStatus || 'N/A'})`);

    // Generate candidates
    const candidates = generateCandidates(name, patterns);
    log(`  Candidatos gerados: ${candidates.length}`);

    // Build all test URLs
    const testUrls = [];
    const testedIdentifiers = new Set();
    testedIdentifiers.add(extractIdentifierFromUrl(channel.url));

    for (const candidate of candidates) {
      if (testedIdentifiers.has(candidate)) continue;
      testedIdentifiers.add(candidate);

      for (const host of hosts) {
        const url = `http://${host}/${candidate}/index.m3u8`;
        testUrls.push({ identifier: candidate, url, host });
      }
    }

    log(`  URLs para testar: ${testUrls.length}`);

    // Test URLs in batches
    let found = false;
    let foundResult = null;
    const attempts = [];
    let testedCount = 0;

    for (let batchStart = 0; batchStart < testUrls.length; batchStart += MAX_CONCURRENT) {
      if (found) break;

      const batch = testUrls.slice(batchStart, batchStart + MAX_CONCURRENT);
      const tasks = batch.map(tu => async () => {
        const httpResult = await httpRequest(tu.url, 'GET');
        return { ...tu, httpResult };
      });

      const batchResults = await runConcurrent(tasks, MAX_CONCURRENT);
      testedCount += batchResults.length;

      for (const br of batchResults) {
        if (found) break;

        const attempt = {
          identifier: br.identifier,
          url: br.url,
          host: br.host,
          httpStatus: br.httpResult.status,
          responseTimeMs: br.httpResult.responseTimeMs,
          error: br.httpResult.error,
        };

        if (br.httpResult.status === 200) {
          const manifest = validateM3U8(br.httpResult.data);
          attempt.manifestValid = manifest.valid;
          attempt.manifestType = manifest.type;

          if (manifest.valid && (manifest.type === 'media' || manifest.type === 'master')) {
            // Test segments
            let segmentsToTest = [];
            if (manifest.type === 'media') {
              segmentsToTest = manifest.segments;
            } else if (manifest.type === 'master' && manifest.variants.length > 0) {
              let variantUrl = manifest.variants[0];
              if (!variantUrl.startsWith('http')) {
                try { variantUrl = new URL(variantUrl, new URL(br.url)).href; } catch {}
              }
              const varResult = await httpRequest(variantUrl, 'GET');
              if (varResult.status === 200) {
                const varManifest = validateM3U8(varResult.data);
                if (varManifest.valid) segmentsToTest = varManifest.segments;
              }
            }

            if (segmentsToTest.length > 0) {
              const segResult = await validateSegments(segmentsToTest, br.url);
              attempt.segmentsTested = segResult.total;
              attempt.segmentsOk = segResult.okCount;

              if (segResult.okCount >= MIN_SEGMENTS_OK) {
                log(`  ✓ FOUND: ${br.identifier} → ${br.url} (HTTP 200, manifest OK, ${segResult.okCount}/${segResult.total} segments OK)`);
                found = true;
                foundResult = {
                  identifier: br.identifier,
                  url: br.url,
                  httpStatus: 200,
                  manifestValid: true,
                  manifestType: manifest.type,
                  segmentsValid: true,
                  segmentsOk: segResult.okCount,
                  segmentsTested: segResult.total,
                };
              }
            }
          }
        }

        attempts.push(attempt);
      }

      if (!found && batchStart + MAX_CONCURRENT < testUrls.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }

    if (found) {
      recoveredMap.set(name, { url: foundResult.url, identifier: foundResult.identifier });
      cache.channels[cacheKey] = { result: 'FOUND', url: foundResult.url, identifier: foundResult.identifier };
      testResults.push({
        channelName: name,
        channelType: channel.type,
        originalUrl: channel.url,
        originalHost: channel.host,
        result: 'FOUND',
        foundIdentifier: foundResult.identifier,
        bestUrl: foundResult.url,
        bestHttpStatus: foundResult.httpStatus,
        bestManifestValid: true,
        segmentsValid: true,
        segmentsOk: foundResult.segmentsOk,
        segmentsTested: foundResult.segmentsTested,
        candidatesTested: testedCount,
        attempts,
      });
    } else {
      log(`  ✗ NOT_FOUND (${testedCount} URLs testadas)`);
      cache.channels[cacheKey] = { result: 'NOT_FOUND', candidatesTested: testedCount };
      testResults.push({
        channelName: name,
        channelType: channel.type,
        originalUrl: channel.url,
        originalHost: channel.host,
        result: 'NOT_FOUND',
        foundIdentifier: null,
        bestUrl: null,
        bestHttpStatus: attempts.find(a => a.manifestValid)?.httpStatus || null,
        bestManifestValid: attempts.some(a => a.manifestValid),
        segmentsValid: false,
        segmentsOk: 0,
        segmentsTested: 0,
        candidatesTested: testedCount,
        attempts,
      });
    }
  }

  // Step 7: Save results
  log('\nPasso 5: Salvando resultados...');
  const resultsData = {
    lastRun: new Date().toISOString(),
    totalChannels: channels.length,
    activeChannels: classified.active.length,
    commentedChannels: classified.commented.length,
    testedChannels: testResults.length,
    recoveredChannels: recoveredMap.size,
    channels: cache.channels,
  };
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(resultsData, null, 2), 'utf8');
  log(`  Resultados salvos: ${RESULTS_PATH}`);

  // Step 8: Generate output M3U files
  log('Passo 6: Gerando arquivos M3U de output...');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  generateOutputM3U(classified.all, recoveredMap, path.join(OUTPUT_DIR, 'SvenTvChannels_RECOVERED.m3u'), false);
  generateOutputM3U(classified.all, recoveredMap, path.join(OUTPUT_DIR, 'SvenTvChannels_OFFLINE.m3u'), true);

  // Step 9: Generate report
  log('Passo 7: Gerando relatório...');
  const report = generateReport(classified, patterns, testResults, recoveredMap, startTime);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, 'utf8');
  log(`  Relatório salvo: ${REPORT_PATH}`);

  // Summary
  const elapsed = Date.now() - startTime;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);

  log(`\n=== RESUMO FINAL ===`);
  log(`Tempo total: ${mins}m ${secs}s`);
  log(`Canais testados: ${testResults.length}`);
  log(`Canais recuperados: ${recoveredMap.size}`);
  log(`Canais não recuperados: ${testResults.length - recoveredMap.size}`);

  if (recoveredMap.size > 0) {
    log(`\nCANAIS RECUPERADOS:`);
    for (const [name, data] of recoveredMap) {
      log(`  ${name} → ${data.identifier} (${data.url})`);
    }
  }

  console.log('\n=== PIPELINE CONCLUÍDO ===');
}

function extractIdentifierFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const dir = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
    return dir.replace(/\.m3u8$/i, '');
  } catch { return 'UNKNOWN'; }
}

// ============================================================
// RUN
// ============================================================
main().catch(err => {
  log(`ERRO FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
