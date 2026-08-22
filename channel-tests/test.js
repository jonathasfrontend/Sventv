const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const IPS = ['http://45.190.28.50', 'http://45.162.64.114'];
const CONCURRENT_LIMIT = 8;
const REQUEST_TIMEOUT = 6000;

const CHANNELS = [
  'AMC','BIS','BM&C','CANAL BRASIL','Canal Goat 2','Canal Goat',
  'CNN Brasil Money','COMBATE','CURTA!','DISCOVERY HOME & HEALTH',
  'INVESTIGACAO DISCOVERY','DOG TV','E!','FOOD NETWORK','GLOBO NEWS',
  'GLOOB','GNT','HBO XTREME','HISTORY CHANNEL','HISTORY CHANNEL 2',
  'JOVEM PAN NEWS','LIFETIME','MODO VIAGEM','MTV 00S','MTV LIVE',
  'MTV','MULTISHOW','MUSIC BOX BRASIL','NICK JR','NICKELODEON',
  'OFF','PARAMOUNT NETWORK','PREMIERE CLUBES','PREMIERE 2',
  'PREMIERE 3','PREMIERE 4','PREMIERE 5','PREMIERE 6','PREMIERE 7',
  'PRIME BOX BRASIL','SPORTV 3','SPORTV 2','SPORTV','SYFY','TBS',
  'TV RA-TIM-BUM','TV Universal (IURD)','UNIVERSAL CHANNEL','VIVA',
  'DumDum','TV Camara','Xsports','GE TV','CBI','TV LITORAL RN',
  'CNBC Brasil','FILM and ARTS','ONEFOOTBALL 1'
];

function genVars(name) {
  const v = new Set();
  const b = name.trim();
  const add = (s) => { if (s && s.length > 0 && s.length < 50) v.add(s); };
  const addAll = (s) => {
    const u = s.toUpperCase();
    add(s); add(u);
    add(s + '_HD'); add(u + '_HD');
    add(s + '-HD'); add(u + '-HD');
    add(s + 'HD'); add(u + 'HD');
    add('HD_' + s); add('HD_' + u);
    add('HD-' + s); add('HD-' + u);
    add('HD' + s); add('HD' + u);
    add(s + '_SD'); add(u + '_SD');
    add(s + '_LIVE'); add(u + '_LIVE');
    add(s + '_FHD'); add(u + '_FHD');
    add(s + '_4K'); add(u + '_4K');
    add('LIVE_' + s); add('LIVE_' + u);
    add('STREAM_' + s); add('STREAM_' + u);
    add(s + '_STREAM'); add(u + '_STREAM');
    add(s + '_CHANNEL'); add(u + '_CHANNEL');
    add(s + '_BR'); add(u + '_BR');
    add(s + '_BRAZIL'); add(u + '_BRAZIL');
    add(s + '_PT'); add(u + '_PT');
    add(s + '_PTBR'); add(u + '_PTBR');
    add(s + 'BR'); add(u + 'BR');
  };

  const t1 = b;
  const t2 = b.replace(/\s+/g, '_');
  const t3 = b.replace(/\s+/g, '');
  const t4 = b.replace(/-/g, '_').replace(/\s+/g, '_');
  const t5 = b.replace(/[^a-zA-Z0-9]/g, '');
  const t6 = b.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  const t7 = t6.replace(/\s+/g, '_');
  const t8 = t6.replace(/\s+/g, '');

  [t1,t2,t3,t4,t5,t6,t7,t8].forEach(addAll);

  const words = b.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/).filter(w => w.length > 0);

  if (words.length > 1) {
    const joined = words.join('');
    addAll(joined);

    for (let i = 0; i < words.length; i++) {
      addAll(words[i]);
      for (let j = i + 1; j < words.length; j++) {
        addAll(words[i] + '_' + words[j]);
        addAll(words[i] + words[j]);
        addAll(words[j] + '_' + words[i]);
        addAll(words[j] + words[i]);
      }
    }
  }

  if (b.includes('&')) {
    const noAmp = b.replace(/&/g, '').trim();
    const andV = b.replace(/&/g, 'AND').trim();
    const eV = b.replace(/&/g, 'E').trim();
    addAll(noAmp); addAll(andV); addAll(eV);
    addAll(noAmp.replace(/\s+/g, '_'));
    addAll(andV.replace(/\s+/g, '_'));
    addAll(eV.replace(/\s+/g, '_'));
    addAll(noAmp.replace(/\s+/g, ''));
    addAll(andV.replace(/\s+/g, ''));
    addAll(eV.replace(/\s+/g, ''));
  }

  if (b.includes('!')) {
    const noE = b.replace(/!/g, '').trim();
    addAll(noE);
    addAll(noE.replace(/\s+/g, '_'));
    addAll(noE.replace(/\s+/g, ''));
  }

  if (b.includes('(')) {
    const noP = b.replace(/\s*\([^)]*\)/g, '').trim();
    addAll(noP);
    addAll(noP.replace(/\s+/g, '_'));
    addAll(noP.replace(/\s+/g, ''));
    const m = b.match(/\(([^)]+)\)/);
    if (m) { addAll(m[1]); addAll(m[1].replace(/\s+/g, '_')); addAll(m[1].replace(/\s+/g, '')); }
  }

  return [...v];
}

function testUrl(url) {
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.request(url, {
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, url, data }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, url, data: '' }); });
    req.on('error', () => resolve({ status: 0, url, data: '' }));
    req.end();
  });
}

async function runParallel(tasks, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array(Math.min(limit, tasks.length)).fill(null).map(() => worker()));
  return results;
}

async function main() {
  console.log('=== Round 2: Advanced Channel Test ===\n');
  console.log('Channels to test:', CHANNELS.length);
  console.log('IPs:', IPS.join(', '));
  console.log('Timeout:', REQUEST_TIMEOUT + 'ms');
  console.log('Concurrency:', CONCURRENT_LIMIT);
  console.log('');

  const found = [];
  let tested = 0;

  for (const ch of CHANNELS) {
    tested++;
    const vars = genVars(ch);
    process.stdout.write(`[${tested}/${CHANNELS.length}] "${ch}" (${vars.length} vars)... `);

    const tasks = [];
    for (const ip of IPS) {
      for (const v of vars) {
        const url = `${ip}/${v}/index.m3u8`;
        tasks.push(() => testUrl(url));
      }
    }

    const results = await runParallel(tasks, CONCURRENT_LIMIT);
    const ok = results.filter(r => r.status === 200);

    if (ok.length > 0) {
      console.log(`FOUND ${ok.length}! Best: ${ok[0].url}`);
      found.push({ name: ch, url: ok[0].url, allWorking: ok.map(w => w.url), varsCount: vars.length });
    } else {
      console.log('no match');
    }
  }

  console.log('\n=== RESULTS ===');
  console.log(`Found: ${found.length}/${CHANNELS.length}\n`);
  found.forEach(f => console.log(`  ${f.name} -> ${f.url}`));

  const outPath = path.join(__dirname, 'channel-test-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalTested: CHANNELS.length,
    workingCount: found.length,
    workingChannels: found
  }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(console.error);
