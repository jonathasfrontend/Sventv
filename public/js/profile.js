/**
 * SvenTV — Página de Perfil
 *
 * Autenticação: cookie httpOnly de sessão (enviado automaticamente em
 * fetch same-origin). O API token NUNCA vem injetado no HTML: é buscado
 * sob demanda em GET /api/auth/api-token somente quando o usuário clica
 * em "Mostrar".
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // ── Helper de fetch autenticado (cookie httpOnly) ─────────────
  // Fallback legado: sessões antigas podem ter token no localStorage.
  const legacyToken = localStorage.getItem('sessionToken');

  async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };

    if (legacyToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${legacyToken}`;
    }
    if (options.body && typeof options.body === 'string') {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    let json = {};

    try { json = await res.json(); } catch (_) { /* corpo vazio */ }

    if (!res.ok || json.success === false) {
      throw new Error(json.message || `Erro ${res.status}`);
    }

    return json;
  }

  // ── Alertas ───────────────────────────────────────────────────
  function showAlert(el, message, type) {
    if (!el) return;
    el.textContent = message;
    el.dataset.type = type;
    el.hidden = false;

    clearTimeout(showAlert._timers[el.id]);
    showAlert._timers[el.id] = setTimeout(() => { el.hidden = true; }, 6000);
  }
  showAlert._timers = {};

  function setLoading(btn, loading) {
    if (!btn) return;
    const text = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.btn-spinner');
    btn.disabled = loading;
    if (spinner) spinner.hidden = !loading;
    if (text && loading) {
      if (!btn._originalText) btn._originalText = text.textContent;
      text.textContent = 'Aguarde...';
    } else if (text && btn._originalText) {
      text.textContent = btn._originalText;
    }
  }

  // ════════════════════════════════════════════════════════════
  // API Token — Mostrar / Ocultar / Copiar / Regenerar
  // ════════════════════════════════════════════════════════════

  const MASK = '••••••••••••••••••••••••••••••••';
  const tokenValue = $('tokenValue');
  const toggleTokenBtn = $('toggleTokenBtn');
  const copyTokenBtn = $('copyTokenBtn');
  const regenTokenBtn = $('regenTokenBtn');
  const tokenAlert = $('tokenAlert');

  let cachedApiToken = null; // buscado sob demanda, nunca renderizado pelo servidor
  let tokenVisible = false;

  async function ensureApiToken() {
    if (cachedApiToken) return cachedApiToken;

    const json = await apiFetch('/api/auth/api-token');
    cachedApiToken = json.data.apiToken;

    return cachedApiToken;
  }

  toggleTokenBtn?.addEventListener('click', async () => {
    try {
      if (tokenVisible) {
        tokenValue.textContent = MASK;
        tokenVisible = false;
        toggleTokenBtn.title = 'Mostrar token';
        return;
      }

      setLoading(toggleTokenBtn, true);
      await ensureApiToken();

      tokenValue.textContent = cachedApiToken;
      tokenVisible = true;
      toggleTokenBtn.title = 'Ocultar token';
    } catch (err) {
      showAlert(tokenAlert, err.message, 'error');
    } finally {
      setLoading(toggleTokenBtn, false);
    }
  });

  copyTokenBtn?.addEventListener('click', async () => {
    try {
      setLoading(copyTokenBtn, true);
      await ensureApiToken();
      await navigator.clipboard.writeText(cachedApiToken);
      showAlert(tokenAlert, '✓ Token copiado para a área de transferência.', 'success');
    } catch (err) {
      showAlert(tokenAlert, err.message || 'Não foi possível copiar.', 'error');
    } finally {
      setLoading(copyTokenBtn, false);
    }
  });

  regenTokenBtn?.addEventListener('click', async () => {
    if (!window.confirm('Regenerar o API token invalida imediatamente o atual. Todos os clientes que usam o token antigo vao parar de funcionar. Continuar?')) {
      return;
    }

    try {
      setLoading(regenTokenBtn, true);
      const json = await apiFetch('/api/auth/regenerate-token', { method: 'POST', body: '{}' });

      cachedApiToken = json.data.apiToken;
      tokenValue.textContent = cachedApiToken;
      tokenVisible = true;

      showAlert(tokenAlert, '⚠️ Token regenerado. Atualize-o em todas as aplicações que o utilizam.', 'warning');
    } catch (err) {
      showAlert(tokenAlert, err.message, 'error');
    } finally {
      setLoading(regenTokenBtn, false);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Editar Perfil — Avatar e Nome
  // ════════════════════════════════════════════════════════════

  const avatarForm = $('avatarForm');
  const avatarUrlInput = $('avatarUrl');
  const avatarFileInput = $('avatarFile');
  const saveAvatarBtn = $('saveAvatarBtn');
  const avatarAlert = $('avatarAlert');

  function applyAvatar(url) {
    for (const imgId of ['profileAvatarImg', 'avatarPreviewImg']) {
      const img = $(imgId);
      if (!img) continue;
      if (url) {
        img.src = url;
        img.hidden = false;
      } else {
        img.hidden = true;
      }
    }

    for (const spanId of ['profileAvatarInitial', 'avatarPreviewInitial']) {
      const span = $(spanId);
      if (span) span.hidden = Boolean(url);
    }
  }

  avatarForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const file = avatarFileInput?.files?.[0];

    if (!file && !avatarUrlInput.value.trim()) {
      showAlert(avatarAlert, 'Informe uma URL ou selecione um arquivo.', 'error');
      return;
    }

    try {
      setLoading(saveAvatarBtn, true);

      let json;

      if (file) {
        const formData = new FormData();
        formData.append('avatar', file);
        json = await apiFetch('/api/auth/avatar', { method: 'POST', body: formData });
      } else {
        json = await apiFetch('/api/auth/avatar', {
          method: 'POST',
          body: JSON.stringify({ imageUrl: avatarUrlInput.value.trim() }),
        });
      }

      applyAvatar(json.data.avatar);
      avatarUrlInput.value = '';
      avatarFileInput.value = '';

      showAlert(avatarAlert, '✓ Avatar atualizado com sucesso.', 'success');
    } catch (err) {
      showAlert(avatarAlert, err.message, 'error');
    } finally {
      setLoading(saveAvatarBtn, false);
    }
  });

  const profileForm = $('profileForm');
  const profileNameInput = $('profileName');
  const saveProfileBtn = $('saveProfileBtn');
  const profileAlert = $('profileAlert');

  profileForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = profileNameInput.value.trim();
    const nameError = $('nameError');

    if (nameError) nameError.textContent = '';

    if (name.length < 2 || name.length > 80) {
      if (nameError) nameError.textContent = 'Nome deve ter entre 2 e 80 caracteres.';
      return;
    }

    try {
      setLoading(saveProfileBtn, true);

      const json = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });

      const newName = json.data.user.name;

      const nameDisplay = $('profileNameDisplay');
      if (nameDisplay) nameDisplay.textContent = newName;

      showAlert(profileAlert, '✓ Perfil atualizado com sucesso.', 'success');
    } catch (err) {
      showAlert(profileAlert, err.message, 'error');
    } finally {
      setLoading(saveProfileBtn, false);
    }
  });

  // ════════════════════════════════════════════════════════════
  // Alterar Senha
  // ════════════════════════════════════════════════════════════

  const passwordForm = $('passwordForm');
  const savePasswordBtn = $('savePasswordBtn');
  const passwordAlert = $('passwordAlert');

  passwordForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const currentPassword = $('currentPassword').value;
    const newPassword = $('newPassword').value;
    const confirmNewPassword = $('confirmNewPassword').value;

    for (const id of ['currentPasswordError', 'newPasswordError', 'confirmNewPasswordError']) {
      const el = $(id);
      if (el) el.textContent = '';
    }

    if (!currentPassword) {
      const el = $('currentPasswordError');
      if (el) el.textContent = 'Informe a senha atual.';
      return;
    }

    if (newPassword !== confirmNewPassword) {
      const el = $('confirmNewPasswordError');
      if (el) el.textContent = 'As senhas não coincidem.';
      return;
    }

    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword) || newPassword.length < 8) {
      const el = $('newPasswordError');
      if (el) el.textContent = 'Mín. 8 caracteres com maiúscula, minúscula e número.';
      return;
    }

    try {
      setLoading(savePasswordBtn, true);

      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      passwordForm.reset();
      showAlert(passwordAlert, '✓ Senha alterada com sucesso.', 'success');
    } catch (err) {
      showAlert(passwordAlert, err.message, 'error');
    } finally {
      setLoading(savePasswordBtn, false);
    }
  });

  // Botões de visibilidade de senha
  document.querySelectorAll('.toggle-password').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);

      if (!input) return;

      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // ════════════════════════════════════════════════════════════
  // Zona de Perigo
  // ════════════════════════════════════════════════════════════

  const deleteAccountBtn = $('deleteAccountBtn');

  deleteAccountBtn?.addEventListener('click', () => {
    window.alert('A exclusão de conta ainda não está disponível. Entre em contato com o suporte.');
  });

  // ════════════════════════════════════════════════════════════
  // Navegação lateral (scroll suave + item ativo)
  // ════════════════════════════════════════════════════════════

  document.querySelectorAll('.profile-nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.profile-nav-link').forEach((l) => l.classList.remove('active'));
      link.classList.add('active');

      const target = document.querySelector(link.getAttribute('href'));

      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
})();
