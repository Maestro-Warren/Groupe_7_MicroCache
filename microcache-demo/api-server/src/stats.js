/**
 * Module singleton de collecte des métriques en temps réel
 * Accumule les stats de cache vs DB pour la démo
 */

const state = {
  // Compteurs globaux
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheErrors: 0,

  // Latences cumulées (derniers 100 éléments, FIFO)
  latencyCache: [],
  latencyNocache: [],

  // Statut du serveur cache
  cacheServerUp: false,

  // Timestamp de démarrage
  startedAt: Date.now(),
};

/**
 * Calcule le percentile d'un tableau de nombres
 * p = 95 pour le 95e percentile, etc.
 */
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Enregistre un hit cache
 */
function recordCacheHit(latencyMs) {
  state.totalRequests++;
  state.cacheHits++;
  state.cacheServerUp = true;

  // Ajouter la latence (max 100 éléments, FIFO)
  state.latencyCache.push(latencyMs);
  if (state.latencyCache.length > 100) {
    state.latencyCache.shift();
  }
}

/**
 * Enregistre un miss cache (requête DB après miss)
 */
function recordCacheMiss(dbLatencyMs) {
  state.totalRequests++;
  state.cacheMisses++;
  state.cacheServerUp = true;

  // Ajouter la latence (max 100 éléments, FIFO)
  state.latencyCache.push(dbLatencyMs);
  if (state.latencyCache.length > 100) {
    state.latencyCache.shift();
  }
}

/**
 * Enregistre une erreur du cache (serveur injoignable)
 */
function recordCacheError() {
  state.totalRequests++;
  state.cacheErrors++;
  state.cacheServerUp = false;
}

/**
 * Enregistre une requête nocache (DB directe)
 */
function recordNocacheRequest(latencyMs) {
  // Ajouter la latence (max 100 éléments, FIFO)
  state.latencyNocache.push(latencyMs);
  if (state.latencyNocache.length > 100) {
    state.latencyNocache.shift();
  }
}

/**
 * Retourne un snapshot complet des métriques (objet pur, pas de références)
 */
function getSnapshot() {
  const avgLatencyCache = state.latencyCache.length > 0
    ? Math.round(state.latencyCache.reduce((a, b) => a + b, 0) / state.latencyCache.length)
    : 0;

  const avgLatencyNocache = state.latencyNocache.length > 0
    ? Math.round(state.latencyNocache.reduce((a, b) => a + b, 0) / state.latencyNocache.length)
    : 0;

  const hitRate = state.totalRequests > 0
    ? Math.round((state.cacheHits / state.totalRequests) * 1000) / 10
    : 0;

  const speedupFactor = avgLatencyCache > 0 && avgLatencyNocache > 0
    ? Math.round((avgLatencyNocache / avgLatencyCache) * 10) / 10
    : 0;

  const p95LatencyCache = percentile(state.latencyCache, 95);
  const p95LatencyNocache = percentile(state.latencyNocache, 95);

  const uptimeSeconds = Math.round((Date.now() - state.startedAt) / 1000);

  return {
    totalRequests: state.totalRequests,
    cacheHits: state.cacheHits,
    cacheMisses: state.cacheMisses,
    cacheErrors: state.cacheErrors,
    cacheServerUp: state.cacheServerUp,
    hitRate,
    avgLatencyCache,
    avgLatencyNocache,
    p95LatencyCache,
    p95LatencyNocache,
    speedupFactor,
    uptimeSeconds,
    timestamp: Date.now(),
  };
}

module.exports = {
  recordCacheHit,
  recordCacheMiss,
  recordCacheError,
  recordNocacheRequest,
  getSnapshot,
};
