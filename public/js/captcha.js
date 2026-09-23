/* public/js/captcha.js — reCAPTCHA v2 (widget explícito)
   Espera um contêiner: <div id="captchaWrap" data-site-key="..."></div>.
   Expõe window.Captcha = { getToken(), reset(), render(el) }.
   Sem contêiner/site key no HTML, nada é carregado (backend segue fail-open).
*/
'use strict';

const Captcha = (() => {
  let widgetId = null;
  let token = '';
  let ready = false;

  const SCRIPT_URL = 'https://www.google.com/recaptcha/api.js?render=explicit';

  function loadScript() {
    return new Promise((resolve, reject) => {
      if (window.grecaptcha && ready) return resolve();
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.async = true;
      s.onload = () => { ready = true; resolve(); };
      s.onerror = () => reject(new Error('Falha ao carregar o reCAPTCHA.'));
      document.head.appendChild(s);
    });
  }

  async function render(el) {
    if (!el || !el.dataset.siteKey) return;
    try {
      await loadScript();
      widgetId = window.grecaptcha.render(el, {
        sitekey: el.dataset.siteKey,
        callback: (t) => { token = t; },
        'expired-callback': () => { token = ''; },
        'error-callback': () => { token = ''; },
      });
    } catch (_) {
      // widget indisponível: o backend permanece fail-open e o usuário
      // ainda consegue prosseguir caso não haja CAPTCHA_SECRET_KEY.
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