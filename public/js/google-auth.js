/* public/js/google-auth.js — Google OAuth (login, registro e vínculo de conta)
   Contrato de DOM:
   - [data-google-auth="login"]  -> botão .google-btn + alerta [data-google-alert]
   - [data-google-auth="register] -> idem + checkbox #terms (obrigatório)
   - [data-google-auth="link"]   -> perfil (requer sessão)
   Backend é a autoridade: LOGIN != CADASTRO ("cadastro" só no fluxo explícito
   da página de cadastro, com intenção gravada no state + aceite dos Termos).
   Fallback: se a página receber ?code&state (GOOGLE_REDIRECT_URI apontando
   para o frontend), o módulo troca o code por POST no endpoint do MODO:
   login → /api/google/login | register → /api/google/register | link → /api/google/link.
*/
'use strict';

const GoogleAuth = (() => {
  const STATE_KEY = 'sventv:google:state';

  function setBtnLoading(btn, loading) {
    if (!btn) return;
    if (window.SvenUI && typeof SvenUI.setBtnLoading === 'function') {
      SvenUI.setBtnLoading(btn, loading);
      return;
    }
    btn.disabled = !!loading;
  }

  function findEl(mode) {
    const root = document.querySelector(`[data-google-auth="${mode}"]`);
    if (!root) return null;
    return {
      root,
      btn: root.querySelector('.google-btn'),
      alert: root.querySelector('[data-google-alert]'),
    };
  }

  function termsChecked() {
    const box = document.getElementById('terms');
    return box ? box.checked : false;
  }

  function showAlert(alertEl, message, type = 'error') {
    if (!alertEl) return;
    alertEl.textContent = message;
    alertEl.className = `form-alert form-alert-${type}`;
    alertEl.hidden = false;
  }

  function hideAlert(alertEl) {
    if (alertEl) alertEl.hidden = true;
  }

  async function requestAuthUrl(endpoint) {
    const res = await fetch(endpoint);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || !data.data || !data.data.authUrl) {
      throw new Error(data.message || 'Google OAuth não configurado.');
    }
    try {
      sessionStorage.setItem(STATE_KEY, data.data.state || '');
    } catch (_) {
      /* storage indisponível: segue sem persistir o state */
    }
    return data.data.authUrl;
  }

  async function exchange(mode, code, state, acceptedTerms) {
    let endpoint = '/api/google/login';
    let body = { code, state };
    if (mode === 'register') {
      endpoint = '/api/google/register';
      body = { code, state, acceptedTerms: true };
    } else if (mode === 'link') {
      endpoint = '/api/google/link';
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Falha na autenticação com o Google.');
    return data;
  }

  async function launch(mode) {
    const el = findEl(mode);
    if (!el) return;

    // Registro exige o aceite explícito dos Termos ANTES de ir ao Google —
    // sem checkbox marcado, o fluxo NÃO inicia (mesma regra que o servidor).
    if (mode === 'register' && !termsChecked()) {
      showAlert(el.alert, 'Aceite os Termos de Uso para criar a conta com o Google.');
      return;
    }

    const endpoint =
      mode === 'link'
        ? '/api/google/link-url'
        : `/api/google/url?intent=${mode}&terms=${mode === 'register' && termsChecked() ? '1' : '0'}`;
    hideAlert(el.alert);
    setBtnLoading(el.btn, true);

    try {
      const authUrl = await requestAuthUrl(endpoint);
      window.location.href = authUrl;
    } catch (err) {
      setBtnLoading(el.btn, false);
      showAlert(el.alert, err.message || 'Erro ao iniciar o login com Google.');
    }
  }

  // Página recebeu ?code&state (redirecionamento do Google para o frontend):
  // troca o code no endpoint do MODO correto e conclui login/cadastro/vínculo.
  async function handlePageParams(mode) {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return false;

    const el = findEl(mode);
    if (el) {
      hideAlert(el.alert);
      setBtnLoading(el.btn, true);
    }

    try {
      const acceptedTerms = mode === 'register' && termsChecked();
      if (mode === 'register' && !acceptedTerms) {
        if (el) setBtnLoading(el.btn, false);
        window.location.replace('/register?error=google&reason=terms');
        return true;
      }
      await exchange(mode, code, state, acceptedTerms);
      window.location.href = mode === 'link' ? '/profile?linked=1' : '/dashboard';
      return true;
    } catch (err) {
      const reason = err && err.message ? `&reason=${encodeURIComponent(String(err.message))}` : '';
      const base = mode === 'register' ? '/register' : mode === 'link' ? '/profile' : '/login';
      window.location.replace(`${base}?error=google${reason}`);
      return true;
    }
  }

  function init() {
    const params = new URLSearchParams(window.location.search);
    const hasCode = params.has('code');
    const modes = ['login', 'register', 'link'].filter(mode => findEl(mode));

    if (hasCode) {
      // Redirecionamento do Google caiu no frontend (?code&state): troca o code
      // na página certa (login → /api/google/login; registro → /api/google/register;
      // perfil → /api/google/link).
      modes.forEach(mode => handlePageParams(mode));
      return;
    }

    // Mensagem de erro vinda do /api/google/callback (ex.: estado expirado).
    if (params.get('error') === 'google') {
      document.querySelectorAll('[data-google-alert]').forEach(el => {
        showAlert(el, 'Não foi possível concluir a autenticação com o Google. Tente novamente.');
      });
      history.replaceState(null, '', window.location.pathname);
    }

    modes.forEach(mode => {
      const el = findEl(mode);
      if (el && el.btn) {
        el.btn.addEventListener('click', () => launch(mode));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init, launch, exchange };
})();