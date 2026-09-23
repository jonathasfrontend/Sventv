/* public/js/captcha.js — reCAPTCHA v2 (widget explícito)
   Espera um contêiner: <div id="captchaWrap" data-site-key="..."></div>.
   Expõe window.Captcha = { getToken(), reset(), render(el) }.
   Sem contêiner/site key no HTML, nada é carregado (backend segue fail-open).

   Robustez:
   - Tenta o script oficial primeiro; em falha de rede (script bloqueado,
     rede sem acesso a www.google.com) cai para https://www.recaptcha.net
     (CDN oficial alternativa). Sem isso, ambientes corporativos/regiões que
     bloqueiam www.google.com nunca renderizam o widget.
   - Erros de carregamento/renderização são LOGADOS no console com a causa,
     nunca engolidos em silêncio — facilita encontrar key inválida / domínio
     não autorizado no Console do reCAPTCHA.
*/
'use strict';

const Captcha = (() => {
  let widgetId = null;
  let token = '';
  let ready = false;

  const SCRIPT_URLS = [
    'https://www.google.com/recaptcha/api.js?render=explicit',
    'https://www.recaptcha.net/recaptcha/api.js?render=explicit',
  ];

  function loadScript(sourceIndex = 0) {
    return new Promise((resolve, reject) => {
      if (window.grecaptcha && ready) return resolve();
      if (sourceIndex >= SCRIPT_URLS.length) {
        return reject(new Error('reCAPTCHA indisponível (todas as fontes falharam).'));
      }
      const s = document.createElement('script');
      s.src = SCRIPT_URLS[sourceIndex];
      s.async = true;
      s.onload = () => { ready = true; resolve(); };
      s.onerror = () => {
        console.warn(`[Captcha] Falha ao carregar o script (${SCRIPT_URLS[sourceIndex]}). Tentando fonte alternativa...`);
        loadScript(sourceIndex + 1).then(resolve, reject);
      };
      document.head.appendChild(s);
    });
  }

  async function render(el) {
    if (!el || !el.dataset.siteKey) return;
    const t = setTimeout(() => {
      console.warn('[Captcha] O widget reCAPTCHA não foi renderizado dentro de 8s. Verifique: (1) acesso à rede no google.com/recaptcha.net; (2) se a site key pertence a este domínio (Console do reCAPTCHA); (3) se a key é do tipo checkbox (v2), não invisible/v3.');
    }, 8000);
    try {
      await loadScript();
      widgetId = window.grecaptcha.render(el, {
        sitekey: el.dataset.siteKey,
        size: 'normal',
        callback: (t) => { token = t; },
        'expired-callback': () => { token = ''; },
        'error-callback': () => {
          token = '';
          console.warn('[Captcha] O reCAPTCHA reportou erro ao renderizar. Key inválida ou domínio não autorizado para a site key.');
        },
      });
      clearTimeout(t);
    } catch (err) {
      clearTimeout(t);
      // widget indisponível: o backend permanece fail-open e o usuário
      // ainda consegue prosseguir caso não haja CAPTCHA_SECRET_KEY.
      console.warn('[Captcha] Não foi possível renderizar o reCAPTCHA:', err && err.message ? err.message : err);
    }
  }

  function getToken() {
    return token;
  }

  function reset() {
    token = '';
    if (widgetId !== null && window.grecaptcha) {
      try { window.grecaptcha.reset(widgetId); } catch (_) { /* widget ausente */ }
    }
  }

  function init() {
    const el = document.getElementById('captchaWrap');
    if (el) render(el);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { getToken, reset, render };
})();

window.Captcha = Captcha;