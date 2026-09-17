'use strict';

/**
 * Emissão SEGURA de CSV (RFC 4180):
 *  - células contendo vírgula, aspas, \n ou \r são delimitadas por aspas
 *    com escape `""`;
 *  - NEUTRALIZAÇÃO DE FÓRMULA (CSV injection): valores que começam com
 *    `=`, `+`, `-`, `@`, tab (0x09) ou CR (0x0D) são prefixados com uma
 *    aspa simples — no Excel/Sheets a célula vira TEXTO, nunca fórmula;
 *  - saída via STREAM por linha (`write`/`end`), compatível com exportações
 *    grandes paginadas por cursor (nenhum array gigante em memória).
 */

const FORMULA_LEADERS = /^[=+\-@\t\r]/;
const NEED_QUOTES = /[",\r\n]/;

/**
 * Escapa um campo para uma célula CSV (RFC 4180 + anti-injeção de fórmula).
 * @param {*} value
 * @returns {string}
 */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Antes de qualquer flag de borda: neutraliza fórmula (nunca vira =-cmd()).
  if (FORMULA_LEADERS.test(s)) s = `'${s}`;
  if (NEED_QUOTES.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serializa uma linha CSV.
 * @param {Array<*>} fields
 * @returns {string} linha terminada em CRLF
 */
function csvLine(fields) {
  return fields.map(csvCell).join(',') + '\r\n';
}

/**
 * Prepara o response para download de texto/CSV (headers rígidos: sem cache,
 * nosniff, charset UTF-8, Content-Disposition com nome fixo do caller).
 */
function writeCsvHead(res, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${String(filename).replace(/[^a-z0-9._-]/gi, '')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/**
 * Streama um CSV inteiro pelo response:
 *   1. grava o cabeçalho;
 *   2. itera `rows` (array OU iterável assíncrono — páginas/cursor) e grava
 *      cada linha em chunks.
 * Em erro no meio do stream, o response é encerrado e o erro re-lançado
 * (o chamador decide log/audit — nunca mais é possível devolver JSON).
 * @param {import('express').Response} res
 * @param {{filename?: string}} options
 * @param {Array<*>} header
 * @param {Array<Array<*>>|AsyncIterable<Array<*>>} rows
 * @returns {Promise<boolean>}
 */
async function streamCsv(res, { filename = 'export.csv' } = {}, header, rows) {
  writeCsvHead(res, filename);
  res.write(csvLine(header));
  try {
    if (Array.isArray(rows)) {
      for (const row of rows) res.write(csvLine(row));
    } else {
      for await (const row of rows) res.write(csvLine(row));
    }
    res.end();
    return true;
  } catch (error) {
    try { res.end(); } catch (e) { /* response já encerrado */ }
    throw error;
  }
}

module.exports = { csvCell, csvLine, streamCsv, writeCsvHead };