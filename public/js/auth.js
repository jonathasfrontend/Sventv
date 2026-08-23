/* public/js/auth.js — Login e Register */
'use strict';

// ── Utilitários ─────────────────────────────────────────────

function saveSession(data) {
  // Sessão web vive APENAS no cookie httpOnly definido pelo servidor.
  // Nada de sessionToken em localStorage nem em cookie acessível ao JS.
  if (data.apiToken) localStorage.setItem('apiToken', data.apiToken);
  if (data.user) localStorage.setItem('user', JSON.stringify(data.user));

  // Higiene: remove resquícios de versões antigas (token em localStorage
  // e cookie duplicado não-httpOnly). O httpOnly do servidor é intocado.
  localStorage.removeItem('sessionToken');
  document.cookie = 'sessionToken=; path=/; max-age=0; SameSite=Lax';
}

function setLoading(btn, loading) {
  const text = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled = loading;
  if (text) text.hidden = loading;
  if (spinner) spinner.hidden = !loading;
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

// ── Toggle Password ─────────────────────────────────────────

document.querySelectorAll('.toggle-password').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target || 'password';
    const input = document.getElementById(targetId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.setAttribute('aria-label', isPassword ? 'Ocultar senha' : 'Mostrar senha');
  });
});

// ── Password Strength (register) ────────────────────────────

const passwordInput = document.getElementById('password');
const strengthFill = document.getElementById('strengthFill');
const strengthLabel = document.getElementById('strengthLabel');

if (passwordInput && strengthFill) {
  passwordInput.addEventListener('input', () => {
    const val = passwordInput.value;
    let score = 0;
    if (val.length >= 8) score++;
    if (/[A-Z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;

    const levels = ['', 'Fraca', 'Razoável', 'Boa', 'Forte'];
    const colors = ['', '#ef4444', '#f59e0b', '#3b82f6', '#22c55e'];
    const widths = ['0%', '25%', '50%', '75%', '100%'];

    strengthFill.style.width = widths[score];
    strengthFill.style.background = colors[score];
    if (strengthLabel) strengthLabel.textContent = score === 0 ? 'Digite uma senha' : levels[score];
  });
}

// ── LOGIN ────────────────────────────────────────────────────

const loginForm = document.getElementById('loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();

    const btn = document.getElementById('submitBtn');
    const formError = document.getElementById('formError');
    hideAlert(formError);

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    // Validação básica
    let valid = true;
    if (!email) { setFieldError('email', 'emailError', 'E-mail obrigatório'); valid = false; }
    if (!password) { setFieldError('password', 'passwordError', 'Senha obrigatória'); valid = false; }
    if (!valid) return;

    setLoading(btn, true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showAlert(formError, data.message || 'Erro ao entrar. Tente novamente.');
        return;
      }

      saveSession(data.data);

      // Redireciona para returnTo ou profile
      const params = new URLSearchParams(window.location.search);
      const returnTo = params.get('returnTo');
      window.location.href = returnTo ? decodeURIComponent(returnTo) : '/profile';
    } catch (err) {
      showAlert(formError, 'Erro de conexão. Verifique sua internet.');
    } finally {
      setLoading(btn, false);
    }
  });
}

// ── REGISTER ─────────────────────────────────────────────────

const registerForm = document.getElementById('registerForm');
if (registerForm) {
  registerForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();

    const btn = document.getElementById('submitBtn');
    const formError = document.getElementById('formError');
    const formSuccess = document.getElementById('formSuccess');
    hideAlert(formError);
    hideAlert(formSuccess);

    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const terms = document.getElementById('terms').checked;

    // Validações
    let valid = true;
    if (!name || name.length < 3) { setFieldError('name', 'nameError', 'Nome deve ter ao menos 3 caracteres'); valid = false; }
    if (!email) { setFieldError('email', 'emailError', 'E-mail obrigatório'); valid = false; }
    if (!password || password.length < 8) { setFieldError('password', 'passwordError', 'Senha deve ter ao menos 8 caracteres'); valid = false; }
    if (password !== confirmPassword) { setFieldError('confirmPassword', 'confirmPasswordError', 'As senhas não coincidem'); valid = false; }
    if (!terms) { setFieldError('terms', 'termsError', 'Aceite os termos para continuar'); valid = false; }
    if (!valid) return;

    setLoading(btn, true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showAlert(formError, data.message || 'Erro ao criar conta. Tente novamente.');
        // Mapear erros de campo
        if (data.errors) {
          data.errors.forEach(err => {
            if (err.field === 'email') setFieldError('email', 'emailError', err.message);
            if (err.field === 'name') setFieldError('name', 'nameError', err.message);
            if (err.field === 'password') setFieldError('password', 'passwordError', err.message);
          });
        }
        return;
      }

      saveSession(data.data);
      showAlert(formSuccess, 'Conta criada! Redirecionando...', 'success');
      setTimeout(() => (window.location.href = '/profile'), 1500);
    } catch (err) {
      showAlert(formError, 'Erro de conexão. Verifique sua internet.');
    } finally {
      setLoading(btn, false);
    }
  });
}
