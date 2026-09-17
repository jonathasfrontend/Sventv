'use strict';

/**
 * Serializa dados para uso DENTRO de um elemento <script> no HTML.
 *
 * EPG e qualquer dado externo (XMLTV) podem conter strings inesperadas
 * (`</script>`, `<!--`, U+2028/U+2029, caracteres de controle). Colocar
 * JSON desta forma num contexto de script sem limpeza permitiria quebrar
 * o contexto JS/HTML (script injection). Esta função neutraliza isso
 * substituindo `<`, `>` e `&` por escapes Unicode (o valor final, após
 * parse no navegador, é idêntico ao original) e os separadores de linha
 * U+2028/U+2029 que eram legais em JSON mas quebram parsers JS antigos.
 *
 * Uso:
 *   <script>const DATA = {{...safeScriptJson(dados)}};</script>
 *
 * NUNCA passe o retorno por escapeHtml (corromperia o JSON).
 */
function safeScriptJson(value) {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') return json; // undefined → undefined (sem lançar)
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = { safeScriptJson };