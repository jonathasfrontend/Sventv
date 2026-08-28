'use strict';

/**
 * Métricas operacionais leves, em memória (por processo/lambda).
 *
 * NÃO são globais entre instâncias serverless nem substituem o
 * `/api/health` (que permanece propositalmente mínimo). Expostas em
 * endpoint restrito a admin. Métricas de latência são somas/counts para
 * evitar alocação desnecessária.
 */

const counters = {
  proxyRequests: 0,
  proxyPlaylists: 0,
  proxySegments: 0,
  proxyErrors: 0,
  proxySSRFBlocked: 0,
  streamRequests: 0,
  activeStreams: 0,
  activeStreamsPeak: 0,
};

const latency = {
  proxyTotalMs: 0,
  proxyCount: 0,
};

function inc(name, by = 1) {
  if (name in counters) counters[name] += by;
}

function snapActiveStream(delta) {
  counters.activeStreams = Math.max(0, counters.activeStreams + delta);
  if (counters.activeStreams > counters.activeStreamsPeak) {
    counters.activeStreamsPeak = counters.activeStreams;
  }
}

function recordProxyLatency(ms) {
  latency.proxyTotalMs += Math.max(0, ms);
  latency.proxyCount += 1;
}

function snapshot() {
  return {
    counters: { ...counters },
    latency: {
      avgProxyMs: latency.proxyCount > 0
        ? Math.round((latency.proxyTotalMs / latency.proxyCount) * 10) / 10
        : 0,
    },
    reserved: 'em-memoria-por-lambda',
  };
}

module.exports = {
  inc,
  snapActiveStream,
  recordProxyLatency,
  snapshot,
};
