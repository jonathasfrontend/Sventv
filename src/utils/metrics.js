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
  proxyFailovers: 0,
  streamBlocked: 0,
  channelStateChanges: 0,
  streamRequests: 0,
  activeStreams: 0,
  activeStreamsPeak: 0,
  // Estado distribuído (Upstash Redis) e fallbacks
  redisErrors: 0,
  rateLimitRedisFallbacks: 0,
  streamLimiterFallbacks: 0,
  channelStateFallbacks: 0,
  channelStateCacheHits: 0,
  channelStateCacheMisses: 0,
  channelStatePersistenceFailures: 0,
  // Persistência do failover (channel_health)
  channelHealthPersistenceFailures: 0,
  // Alertas operacionais (admin)
  alertsSent: 0,
  alertsFailed: 0,
  alertsDebounced: 0,
  // Analytics
  eventsIngested: 0,
  sessionsStarted: 0,
  heartbeatsIngested: 0,
  sessionsFinalized: 0,
  playlistOps: 0,
  recommendationHits: 0,
  recommendationMisses: 0,
  retentionRuns: 0,
  retainedEventsDeleted: 0,
  retainedSessionsDeleted: 0,
  retentionRequestUsageDeleted: 0,
  retentionAuditLogsDeleted: 0,
  // Recuperação de senha
  passwordResetRequested: 0,
  passwordResetSuccessful: 0,
  passwordResetFailed: 0,
  passwordResetExpired: 0,
  passwordResetRateLimited: 0,
  passwordResetSmtpFailures: 0,
  passwordResetAttemptsExceeded: 0,
  termsAccepted: 0,
  // Trending (Top 10 — catálogo externo de metadados)
  trendingFetches: 0,
  trendingFetchFailures: 0,
};

const latency = {
  proxyTotalMs: 0,
  proxyCount: 0,
  eventIngestTotalMs: 0,
  eventIngestCount: 0,
  recommendationTotalMs: 0,
  recommendationCount: 0,
  trendingTotalMs: 0,
  trendingCount: 0,
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

function recordEventIngestLatency(ms) {
  latency.eventIngestTotalMs += Math.max(0, ms);
  latency.eventIngestCount += 1;
}

function recordRecommendationLatency(ms) {
  latency.recommendationTotalMs += Math.max(0, ms);
  latency.recommendationCount += 1;
}

function recordTrendingLatency(ms) {
  latency.trendingTotalMs += Math.max(0, ms);
  latency.trendingCount += 1;
}

function snapshot() {
  return {
    counters: { ...counters },
    latency: {
      avgProxyMs: latency.proxyCount > 0
        ? Math.round((latency.proxyTotalMs / latency.proxyCount) * 10) / 10
        : 0,
      avgEventIngestMs: latency.eventIngestCount > 0
        ? Math.round((latency.eventIngestTotalMs / latency.eventIngestCount) * 10) / 10
        : 0,
      avgRecommendationMs: latency.recommendationCount > 0
        ? Math.round((latency.recommendationTotalMs / latency.recommendationCount) * 10) / 10
        : 0,
      avgTrendingMs: latency.trendingCount > 0
        ? Math.round((latency.trendingTotalMs / latency.trendingCount) * 10) / 10
        : 0,
    },
    reserved: 'em-memoria-por-lambda',
  };
}

module.exports = {
  inc,
  snapActiveStream,
  recordProxyLatency,
  recordEventIngestLatency,
  recordRecommendationLatency,
  recordTrendingLatency,
  snapshot,
};
