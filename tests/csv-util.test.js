'use strict';

/**
 * Emissão segura de CSV (utils/csv):
 *  - RFC 4180: vírgula, aspas e quebras escapadas;
 *  - ANTI-INJEÇÃO DE FÓRMULA: `=`, `+`, `-`, `@`, tab e CR neutros (prefixo `'`);
 *  - csvLine com CRLF;
 *  - streamCsv grava cabeçalho + linhas (array ou iterável assíncrono),
 *    Content-Disposition sanitizada e encerra o response.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { csvCell, csvLine, streamCsv } = require('../src/utils/csv');

test('csvCell: valores triviais não são alterados', () => {
  assert.equal(csvCell('Canal 1'), 'Canal 1');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('texto').length, 'texto'.length);
});

test('csvCell: vírgula, aspas e quebras são cotadas (RFC 4180)', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('aspas "duplas"'), '"aspas ""duplas"""');
  assert.equal(csvCell('linha\nquebrada'), '"linha\nquebrada"');
  assert.equal(csvCell('carriage\rreturn'), '"carriage\rreturn"');
});

test('csvCell: NUNCA vira fórmula — =, +, -, @, tab e CR são neutralizados', () => {
  assert.equal(csvCell('=2+5'), "'=2+5");
  assert.equal(csvCell('=cmd|' + "' /C calc!A0"), "'=cmd|' /C calc!A0");
  assert.equal(csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(csvCell('+SUM(1,1)'), '"\'+SUM(1,1)"');
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@echo off'), "'@echo off");
  assert.equal(csvCell('\t=cmd()'), "'\t=cmd()");
  assert.equal(csvCell('\r=cmd()'), '"\'\\r=cmd()"'.replace('\\r', '\r'));
  // Neutralização NÃO muta valores seguros com '-' interno
  assert.equal(csvCell('2026-09-17'), '2026-09-17');
});

test('csvLine: une células e fecha com CRLF', () => {
  assert.equal(csvLine(['a', 'b', 'c']), 'a,b,c\r\n');
  assert.equal(csvLine(['x,y', '=evil']), '"x,y",\'=evil\r\n');
  assert.equal(csvLine([]), '\r\n');
});

function spyStreamRes() {
  const chunks = [];
  const res = { chunks, headers: {}, headersSent: false, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.write = (s) => { res.headersSent = true; chunks.push(String(s)); return true; };
  res.end = () => { res.headersSent = true; res.ended = true; };
  return res;
}

test('streamCsv: array de linhas grava cabeçalho + CRLF e encerra o response', async () => {
  const res = spyStreamRes();
  const ok = await streamCsv(
    res,
    { filename: 'relatorio.csv' },
    ['col1', 'col2'],
    [
      ['a', 'b'],
      ['=evil', 'safe'],
    ]
  );
  assert.equal(ok, true);
  assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="relatorio.csv"');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.ended, true);
  assert.equal(res.chunks.length, 3);
  assert.equal(res.chunks[0], 'col1,col2\r\n');
  assert.equal(res.chunks[1], 'a,b\r\n');
  assert.equal(res.chunks[2], "'=evil,safe\r\n");
});

test('streamCsv: iterável assíncrono (páginas) também é consumido linha a linha', async () => {
  async function* pages() {
    yield ['linha1', 'ok'];
    yield ['linha2', 'ok'];
  }
  const res = spyStreamRes();
  await streamCsv(res, {}, ['h1', 'h2'], pages());
  assert.equal(res.chunks.length, 3);
  assert.equal(res.chunks[1], 'linha1,ok\r\n');
  assert.equal(res.chunks[2], 'linha2,ok\r\n');
});

test('streamCsv: filename é sanitizada (nunca injetável via Content-Disposition)', async () => {
  const res = spyStreamRes();
  await streamCsv(res, { filename: 'a"b/..\\evil.csv; charset=x' }, ['h'], [['v']]);
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="ab..evil.csvcharsetx"');
});

test('streamCsv: erro no meio encerra o response e relança', async () => {
  async function* boom() {
    yield ['ok'];
    throw new Error('pg mid-stream');
  }
  const res = spyStreamRes();
  await assert.rejects(() => streamCsv(res, {}, ['h'], boom()), /pg mid-stream/);
  assert.equal(res.ended, true);
});