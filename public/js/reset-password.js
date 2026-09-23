/* public/js/reset-password.js — Redefinir senha com código */
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

function clearErrors() {
  document.querySelectorAll('.form-error').forEach(el => (el.textContent = ''));
  document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
}

function captchaToken() {
  return window.Captcha ? window.Captcha.getToken() : '';
}

function resetCaptcha() {
  if (window.Captcha) window.Captcha.reset();
}

document.querySelectorAll('.toggle-password').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

const form = document.getElementById('resetForm');
if (form) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();

    const btn = document.getElementById('submitBtn');
    const formError = document.getElementById('formError');
    const formSuccess = document.getElementById('formSuccess');
    hideAlert(formError);
    hideAlert(formSuccess);

    const email = document.getElementById('email').value.trim();
    const code = document.getElementById('code').value.trim();
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    let valid = true;
    if (!email) { setFieldError('email', 'emailError', 'E-mail obrigatório'); valid = false; }
    if (!/^\d{6}$/.test(code)) { setFieldError('code', 'codeError', 'Informe o código de 6 dígitos'); valid = false; }
    if (newPassword.length < 8) { setFieldError('newPassword', 'newPasswordError', 'A nova senha deve ter ao menos 8 caracteres'); valid = false; }
    if (confirmPassword !== newPassword) { setFieldError('confirmPassword', 'confirmPasswordError', 'As senhas não coincidem'); valid = false; }
    if (!valid) { setLoading(btn, false); return; }

    setLoading(btn, true);

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, newPassword, confirmPassword, captchaToken: captchaToken() }),
      });
      const data = await res.json();

      if (!res.ok) {
        showAlert(formError, data.message || 'Não foi possível redefinir a senha.');
        resetCaptcha();
        if (data.errors) {
          data.errors.forEach(err => {
            if (err.field === 'email') setFieldError('email', 'emailError', err.message);
            if (err.field === 'code') setFieldError('code', 'codeError', err.message);
            if (err.field === 'newPassword') setFieldError('newPassword', 'newPasswordError', err.message);
            if (err.field === 'confirmPassword') setFieldError('confirmPassword', 'confirmPasswordError', err.message);
          });
        }
        return;
      }

      showAlert(formSuccess, 'Senha redefinida com sucesso. Redirecionando para o login...', 'success');
      form.reset();
      setTimeout(() => (window.location.href = '/login'), 1800);
    } catch (_) {
      showAlert(formError, 'Erro de conexão. Verifique sua internet e tente novamente.');
    } finally {
      setLoading(btn, false);
    }
  });
}