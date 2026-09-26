/* public/js/forgot-password.js — Solicitar código de recuperação */
'use strict';

function setLoading(btn, loading) {
  if (window.SvenUI) { SvenUI.setBtnLoading(btn, loading); return; }
  btn.disabled = !!loading;
}

function showAlert(el, message, type = 'error') {
  el.textContent = message;
  el.className = `form-alert form-alert-${type}`;
  el.hidden = false;
}

function hideAlert(el) {
  el.hidden = true;
  el.textContent = '';
}

function setFieldError(inputId, errorId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (input) input.classList.toggle('input-error', !!message);
  if (error) error.textContent = message || '';
}

const form = document.getElementById('forgotForm');
if (form) {
  form.addEventListener('submit', async e => {
    e.preventDefault();

    const btn = document.getElementById('submitBtn');
    const formError = document.getElementById('formError');
    const formSuccess = document.getElementById('formSuccess');
    const email = document.getElementById('email').value.trim();
    hideAlert(formError);
    hideAlert(formSuccess);
    setFieldError('email', 'emailError', '');

    if (!email) {
      setFieldError('email', 'emailError', 'Informe seu e-mail');
      setLoading(btn, false);
      return;
    }

    setLoading(btn, true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Mensagem genérica (anti-enumeração) — a mesma para qualquer caso.
        showAlert(formError, data.message || 'Não foi possível concluir a solicitação.');
        return;
      }

      // Sempre a MESMA mensagem de sucesso, exista a conta ou não.
      showAlert(formSuccess, 'Se o e-mail estiver cadastrado, você receberá o código em instantes. Redirecionando para informar o código...', 'success');
      form.reset();
      setTimeout(() => {
        window.location.href = `/reset-password?email=${encodeURIComponent(email)}`;
      }, 1600);
    } catch (_) {
      showAlert(formError, 'Erro de conexão. Verifique sua internet e tente novamente.');
    } finally {
      setLoading(btn, false);
    }
  });
}