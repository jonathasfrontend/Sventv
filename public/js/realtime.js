/* public/js/realtime.js — Polling leve para atualização automática.
   Expõe window.Realtime com:
     - Realtime.poll({ name, fn, interval }): agenda `fn` a cada `interval` ms
       sem sobrepor chamadas ainda em andamento; pausa em aba oculta e
       dispara um tick imediato ao voltar a ficar visível. Retorna uma
       função que encerra o polling.
     - Realtime.stop(name): encerra um polling específico.
     - Realtime.stopAll(): encerra todos os pollings registrados. */
'use strict';

(function (global) {
  const timers = new Map();

  function poll({ name, fn, interval }) {
    if (typeof fn !== 'function') return () => {};
    if (timers.has(name)) stop(name);

    let running = false;

    const tick = async () => {
      if (running) return; // nunca sobrepõe uma chamada em andamento
      if (document.hidden) return; // pausa em aba oculta

      running = true;
      try {
        await fn();
      } catch (_) {
        // Erros de rede/token são tratados por cada página; aqui são
        // silenciosos para não poluir o console em ticks automáticos.
      } finally {
        running = false;
      }
    };

    const timer = setInterval(tick, Math.max(5000, Number(interval) || 30000));
    timers.set(name, { timer, tick });

    return () => stop(name);
  }

  function stop(name) {
    const entry = timers.get(name);
    if (!entry) return;
    clearInterval(entry.timer);
    timers.delete(name);
  }

  function stopAll() {
    timers.forEach((_, name) => stop(name));
  }

  // Ao voltar para a aba, atualiza imediatamente em vez de esperar o
  // próximo intervalo.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      timers.forEach((entry) => { entry.tick(); });
    }
  });

  global.Realtime = { poll, stop, stopAll };
})(window);