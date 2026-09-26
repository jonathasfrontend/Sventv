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
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function showAlert(el, message, type = 'error') {
    if (!el) return;
    const icon = type === 'success' ? 'ph-check-circle' : type === 'warning' ? 'ph-warning' : 'ph-x-circle';
    el.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i> ${escapeHtml(message)}`;
    el.dataset.type = type;
    el.hidden = false;

    clearTimeout(showAlert._timers[el.id]);
    showAlert._timers[el.id] = setTimeout(() => { el.hidden = true; }, 6000);
  }
  showAlert._timers = {};

  function setLoading(btn, loading) {
    if (!btn) return;
    if (window.SvenUI) { SvenUI.setBtnLoading(btn, loading); return; }
    btn.disabled = !!loading;
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

    const json = await apiFetch('/api/auth/api-token', { cache: 'no-store' });
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
      showAlert(tokenAlert, 'Token copiado para a área de transferência.', 'success');
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

      showAlert(tokenAlert, 'Token regenerado. Atualize-o em todas as aplicações que o utilizam.', 'warning');
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
  const saveAvatarBtn = $('saveAvatarBtn');
  const removeAvatarBtn = $('removeAvatarBtn');
  const avatarAlert = $('avatarAlert');
  const avatarGoogleHint = $('avatarGoogleHint');
  const avatarGoogleHintText = $('avatarGoogleHintText');

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

  // `source`: 'custom' (URL externa pessoal) | 'google' | 'none'.
  function refreshAvatarUi(source) {
    if (removeAvatarBtn) removeAvatarBtn.hidden = source !== 'custom';
    if (!avatarGoogleHint) return;

    const userData = readUserData();
    const hasGoogle = !!userData.googleId || userData.authProvider === 'google';

    let text;
    if (source === 'google') text = 'Usando a foto do seu Google. Defina uma URL acima para usar um avatar personalizado.';
    else if (source === 'custom') text = hasGoogle
      ? 'Usando o avatar personalizado. Remova para voltar ao Google.'
      : 'Usando o avatar personalizado.';
    else if (hasGoogle) text = 'Sem avatar personalizado. Sua foto do Google aparece por padrão.';
    else text = 'Sem avatar personalizado.';

    if (avatarGoogleHintText) avatarGoogleHintText.textContent = text;
    avatarGoogleHint.hidden = false;
  }

  async function saveAvatar(url) {
    const json = await apiFetch('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ avatar: url }),
    });

    // O servidor devolve o avatar EFETIVO já resolvido (custom OU google) e a
    // fonte; atualiza também o data island para os próximos renders.
    const user = json.data.user;
    const eff = user.avatar || '';
    applyAvatar(eff);
    refreshAvatarUi(user.avatarSource || (eff ? 'custom' : 'none'));

    const island = document.getElementById('__USER_DATA__');
    if (island) {
      try {
        const data = JSON.parse(island.textContent) || {};
        data.avatar = eff;
        data.avatarSource = user.avatarSource || 'none';
        island.textContent = JSON.stringify(data);
      } catch (_) { /* data island corrompido — ignora */ }
    }
  }

  avatarForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const url = avatarUrlInput.value.trim();

    if (!url) {
      showAlert(avatarAlert, 'Informe uma URL HTTPS para o avatar.', 'error');
      return;
    }

    try {
      setLoading(saveAvatarBtn, true);
      await saveAvatar(url);
      avatarUrlInput.value = '';
      showAlert(avatarAlert, 'Avatar atualizado com sucesso.', 'success');
    } catch (err) {
      showAlert(avatarAlert, err.message, 'error');
    } finally {
      setLoading(saveAvatarBtn, false);
    }
  });

  removeAvatarBtn?.addEventListener('click', async () => {
    try {
      setLoading(removeAvatarBtn, true);
      await saveAvatar('');
      showAlert(avatarAlert, 'Avatar removido.', 'success');
    } catch (err) {
      showAlert(avatarAlert, err.message, 'error');
    } finally {
      setLoading(removeAvatarBtn, false);
    }
  });

  refreshAvatarUi(readUserData().avatarSource);

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
      setLoading(saveProfileBtn, false);
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

      showAlert(profileAlert, 'Perfil atualizado com sucesso.', 'success');
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
      setLoading(savePasswordBtn, false);
      return;
    }

    if (newPassword !== confirmNewPassword) {
      const el = $('confirmNewPasswordError');
      if (el) el.textContent = 'As senhas não coincidem.';
      setLoading(savePasswordBtn, false);
      return;
    }

    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword) || newPassword.length < 8) {
      const el = $('newPasswordError');
      if (el) el.textContent = 'Mín. 8 caracteres com maiúscula, minúscula e número.';
      setLoading(savePasswordBtn, false);
      return;
    }

    try {
      setLoading(savePasswordBtn, true);

      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      passwordForm.reset();
      showAlert(passwordAlert, 'Senha alterada com sucesso.', 'success');
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
  // Conta Google — Vincular / Desvincular
  // ════════════════════════════════════════════════════════════

  const googleAccountStatus = $('googleAccountStatus');
  const linkGoogleBtn = $('linkGoogleBtn');
  const unlinkGoogleBtn = $('unlinkGoogleBtn');
  const googleLinkAlert = $('googleLinkAlert');

  function readUserData() {
    const el = document.getElementById('__USER_DATA__');
    if (!el) return {};
    try { return JSON.parse(el.textContent) || {}; } catch (_) { return {}; }
  }

  let googleLinked = !!readUserData().googleId;

  // Conta criada via Google (authProvider='google') NÃO pode desvincular:
  // o servidor bloqueia (UNLINK_BLOCKED) porque ficaria sem método de login.
  const googleOnlyAccount = readUserData().authProvider === 'google';

  function renderGoogleState() {
    if (googleLinked) {
      if (googleAccountStatus) {
        googleAccountStatus.textContent = googleOnlyAccount
          ? 'Conta Google vinculada (login principal desta conta).'
          : 'Conta Google vinculada. Você pode entrar sem senha.';
        googleAccountStatus.className = 'google-account-status google-account-status--linked';
      }
      if (linkGoogleBtn) linkGoogleBtn.hidden = true;
      if (unlinkGoogleBtn) unlinkGoogleBtn.hidden = googleOnlyAccount;
    } else {
      if (googleAccountStatus) {
        googleAccountStatus.textContent = 'Nenhuma conta Google vinculada ainda.';
        googleAccountStatus.className = 'google-account-status';
      }
      if (linkGoogleBtn) linkGoogleBtn.hidden = false;
      if (unlinkGoogleBtn) unlinkGoogleBtn.hidden = true;
    }
  }

  unlinkGoogleBtn?.addEventListener('click', async () => {
    if (!window.confirm('Desvincular sua conta Google? Você poderá voltar a entrar com seu e-mail e senha.')) {
      return;
    }

    try {
      setLoading(unlinkGoogleBtn, true);
      await apiFetch('/api/google/unlink', { method: 'POST', body: '{}' });
      googleLinked = false;
      renderGoogleState();
      showAlert(googleLinkAlert, 'Conta Google desvinculada.', 'success');
    } catch (err) {
      showAlert(googleLinkAlert, err.message, 'error');
    } finally {
      setLoading(unlinkGoogleBtn, false);
    }
  });

  // Feedback vindo do /api/google/callback (vínculo concluído/recusado).
  {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linked') === '1') {
      googleLinked = true;
      renderGoogleState();
      showAlert(googleLinkAlert, 'Conta Google vinculada com sucesso.', 'success');
    } else if (params.get('linked') === '0' || params.get('google') === 'conflict') {
      showAlert(googleLinkAlert, 'Este e-mail do Google já está vinculado a outra conta.', 'error');
    }
    if (params.has('linked') || params.has('google')) {
      history.replaceState(null, '', window.location.pathname);
    }
  }

  renderGoogleState();

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
