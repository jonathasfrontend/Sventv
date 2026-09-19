/* global document, window */
'use strict';

(function () {
  const DEFAULT_TEXT = 'Carregando…';

  function setBtnLoading(btn, loading, opts) {
    if (!btn || typeof loading !== 'boolean') return;
    if (loading) {
      if (btn.dataset.svenLoading === 'true') return;
      const text = (opts && opts.text) || DEFAULT_TEXT;
      btn.dataset.svenLoading = 'true';
      btn.dataset.svenOriginalHtml = btn.innerHTML;
      btn.dataset.svenOrigDisabled = btn.disabled ? 'true' : 'false';
      btn.innerHTML = '<span class="btn-spinner btn-sven-loading"><i class="ph ph-circle-notch btn-sven-spin" aria-hidden="true"></i><span>' + text + '</span></span>';
      btn.disabled = true;
      btn.classList.add('is-loading');
      return;
    }
    if (btn.dataset.svenLoading !== 'true') return;
    delete btn.dataset.svenLoading;
    btn.innerHTML = btn.dataset.svenOriginalHtml || '';
    delete btn.dataset.svenOriginalHtml;
    btn.disabled = btn.dataset.svenOrigDisabled === 'true';
    delete btn.dataset.svenOrigDisabled;
    btn.classList.remove('is-loading');
  }

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    if (form.dataset && form.dataset.svenNoLoading === 'true') return;
    const btn = e.submitter || form.querySelector('button[type="submit"], input[type="submit"]');
    if (btn && btn.dataset && btn.dataset.svenLoading !== 'true') {
      setBtnLoading(btn, true);
    }
  }, true);

  window.SvenUI = { setBtnLoading };
})();