#!/usr/bin/env node

/**
 * MicroCache Load Test & Performance Validation
 * 
 * Usage:
 *   node src/loadtest.js [options]
 * 
 * Options:
 *   --requests N      Total requests per route (default 100)
 *   --concurrency N   Max concurrent requests (default 10)
 *   --duration S      Test duration in seconds (overrides --requests)
 *   --concertId ID    Concert to test (default 1, or "random" for 1-5 random)
 *   --baseUrl URL     API base URL (default http://localhost:3000)
 */

// ===== PARSE CLI ARGUMENTS =====
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    requests: 100,
    concurrency: 10,
    duration: null,
    concertId: 1,
    concertIdRandom: false,
    baseUrl: 'http://localhost:3000',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--requests') config.requests = parseInt(args[i + 1], 10);
    if (args[i] === '--concurrency') config.concurrency = parseInt(args[i + 1], 10);
    if (args[i] === '--duration') config.duration = parseInt(args[i + 1], 10);
    if (args[i] === '--concertId') {
      const concertIdArg = args[i + 1];
      if (concertIdArg === 'random') {
        config.concertIdRandom = true;
        config.concertId = null;
      } else {
        config.concertId = parseInt(concertIdArg, 10);
        config.concertIdRandom = false;
      }
    }
    if (args[i] === '--baseUrl') config.baseUrl = args[i + 1];
  }

  return config;
}

// ===== GENERATE RANDOM CONCERT ID =====
function getNextConcertId(config) {
  if (config.concertIdRandom) {
    return Math.floor(Math.random() * 5) + 1; // 1 à 5
  }
  return config.concertId;
}

// ===== TIMED FETCH =====
async function timedFetch(url) {
  const start = Date.now();
  try {
    const res = await fetch(url);
    const data = await res.json();
    const latency = Date.now() - start;
    return {
      success: res.ok,
      latency,
      source: data?.meta?.source || 'unknown',
      statusCode: res.status,
    };
  } catch (err) {
    return {
      success: false,
      latency: Date.now() - start,
      error: err.message,
    };
  }
}

// ===== CONCURRENCY POOL =====
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  const running = new Set();

  for (const task of tasks) {
    if (running.size >= concurrency) {
      await Promise.race(running);
    }

    const p = task()
      .then((r) => {
        running.delete(p);
        return r;
      })
      .catch((err) => {
        running.delete(p);
        return { success: false, latency: 0, error: err.message };
      });

    running.add(p);
    results.push(p);
  }

  return Promise.all(results);
}

// ===== STATISTICS =====
function computeStats(results) {
  if (results.length === 0) {
    return {
      count: 0,
      successRate: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p95: 0,
      p99: 0,
      rps: 0,
    };
  }

  const latencies = results
    .filter((r) => r.success)
    .map((r) => r.latency)
    .sort((a, b) => a - b);

  const successCount = results.filter((r) => r.success).length;
  const successRate = (successCount / results.length) * 100;

  const min = latencies[0] || 0;
  const max = latencies[latencies.length - 1] || 0;
  const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const median =
    latencies.length % 2 === 0
      ? (latencies[Math.floor(latencies.length / 2) - 1] +
          latencies[Math.floor(latencies.length / 2)]) /
        2
      : latencies[Math.floor(latencies.length / 2)];

  const p95Idx = Math.ceil((95 / 100) * latencies.length) - 1;
  const p99Idx = Math.ceil((99 / 100) * latencies.length) - 1;
  const p95 = latencies[Math.max(0, p95Idx)];
  const p99 = latencies[Math.max(0, p99Idx)];

  return {
    count: results.length,
    successRate: Math.round(successRate * 100) / 100,
    min: Math.round(min),
    max: Math.round(max),
    mean: Math.round(mean),
    median: Math.round(median),
    p95: Math.round(p95),
    p99: Math.round(p99),
  };
}

// ===== FORMAT UTILS =====
function formatMetric(name, value, unit = '') {
  return `║  ${name.padEnd(25)} ║  ${String(value).padEnd(14)} ${unit}`;
}

function padRight(str, len) {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function getProgress(mode, startTime, duration, completedCount, totalCount) {
  if (mode === 'duration') {
    const elapsed = (Date.now() - startTime) / 1000;
    return Math.min(100, Math.round((elapsed / duration) * 100));
  }
  return Math.round((completedCount / totalCount) * 100);
}

function formatTimeRemaining(mode, startTime, duration) {
  if (mode !== 'duration') return '';
  const elapsed = (Date.now() - startTime) / 1000;
  const remaining = Math.max(0, duration - elapsed);
  return ` — ${Math.round(remaining)}s restantes`;
}

function progressBar(current, total, avgLatency) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((percent / 100) * 20);
  const empty = 20 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${String(percent).padStart(3)}% — ${Math.round(avgLatency)}ms avg`;
}

// ===== MAIN TEST =====
async function main() {
  const config = parseArgs();

  console.log('\n✓ Configuration chargée');
  console.log(`  - Base URL: ${config.baseUrl}`);
  console.log(`  - Concert: ${config.concertIdRandom ? 'aléatoire (1-5)' : `#${config.concertId}`}`);
  console.log(`  - Concurrence: ${config.concurrency}`);

  if (config.duration) {
    console.log(`  - Mode: durée ${config.duration}s`);
  } else {
    console.log(`  - Mode: ${config.requests} requêtes par route`);
  }

  // Déterminer le nombre de requêtes
  let totalRequests = config.requests;
  let testMode = 'requests';

  if (config.duration) {
    testMode = 'duration';
    totalRequests = Math.ceil((config.duration * 1000) / 50); // Estimation basée sur 50ms/requête
  }

  console.log(`\n⏱  Démarrage du test…\n`);

  const startTime = Date.now();
  const allResultsCache = [];
  const allResultsNocache = [];

  let requestsDone = 0;
  let startTimeDuration = Date.now();
  let completedNocache = 0;
  let completedCache = 0;

  // ===== TEST LOOP =====
  while (true) {
    // Vérifier si limite atteinte
    if (testMode === 'requests' && requestsDone >= config.requests) break;
    if (testMode === 'duration' && Date.now() - startTimeDuration >= config.duration * 1000) break;

    // Créer les tâches pour ce batch
    const batchSize = Math.min(config.concurrency, totalRequests - requestsDone);
    const tasks = [];

    for (let i = 0; i < batchSize; i++) {
      // Requête cache
      tasks.push(async () => {
        const cId = getNextConcertId(config);
        const res = await timedFetch(
          `${config.baseUrl}/api/tickets?concertId=${cId}`
        );
        allResultsCache.push(res);
        completedCache++;
        return res;
      });

      // Requête sans cache
      tasks.push(async () => {
        const cId = getNextConcertId(config);
        const res = await timedFetch(
          `${config.baseUrl}/api/tickets/nocache?concertId=${cId}`
        );
        allResultsNocache.push(res);
        completedNocache++;
        return res;
      });
    }

    // Exécuter le batch
    await runWithConcurrency(tasks, config.concurrency * 2);

    requestsDone += batchSize;

    // Afficher la progression
    const statsCache = computeStats(allResultsCache);
    const statsNocache = computeStats(allResultsNocache);

    const pctCache = getProgress(testMode, startTimeDuration, config.duration, completedCache, totalRequests);
    const pctNocache = getProgress(testMode, startTimeDuration, config.duration, completedNocache, totalRequests);

    const barCache = '█'.repeat(Math.round((pctCache / 100) * 20)) + '░'.repeat(20 - Math.round((pctCache / 100) * 20));
    const barNocache = '█'.repeat(Math.round((pctNocache / 100) * 20)) + '░'.repeat(20 - Math.round((pctNocache / 100) * 20));

    const timeRemaining = formatTimeRemaining(testMode, startTimeDuration, config.duration);

    process.stdout.write(
      `\rSans cache  [${barNocache}] ${String(pctNocache).padStart(3)}% — ${Math.round(statsNocache.mean)}ms avg${timeRemaining}\n` +
      `Avec cache  [${barCache}] ${String(pctCache).padStart(3)}% — ${Math.round(statsCache.mean)}ms avg${timeRemaining}\x1b[1A`
    );
  }

  const totalTime = (Date.now() - startTime) / 1000;

  // ===== COMPUTE FINAL STATS =====
  const statsCache = computeStats(allResultsCache);
  const statsNocache = computeStats(allResultsNocache);

  const cacheHitsCount = allResultsCache.filter((r) => r.source === 'cache').length;
  const cacheHitRate =
    allResultsCache.length > 0 ? Math.round((cacheHitsCount / allResultsCache.length) * 100) : 0;

  const rpsNocache = Math.round((statsNocache.count / totalTime) * 100) / 100;
  const rpsCache = Math.round((statsCache.count / totalTime) * 100) / 100;

  const speedupFactor =
    statsCache.mean > 0 ? Math.round((statsNocache.mean / statsCache.mean) * 100) / 100 : 0;

  // ===== CONCERT NAME =====
  const concerts = {
    1: 'Burna Boy @ Bercy',
    2: 'Davido @ Accor Arena',
    3: 'Tiwa Savage @ Zénith',
    4: 'WizKid @ Stade de France',
    5: 'Aya Nakamura @ Accor Arena',
  };
  const concertLabel = config.concertIdRandom ? 'aléatoire (1-5)' : `#${config.concertId}`;
  const concertName = config.concertIdRandom ? 'plusieurs concerts' : (concerts[config.concertId] || `Concert #${config.concertId}`);

  // ===== PRINT REPORT =====
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           MicroCache — Rapport de performance                  ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  Concert testé  : ${concertLabel} — ${concertName.padEnd(45)} ║`);
  console.log(`║  Requêtes/route : ${String(statsCache.count).padEnd(53)} ║`);
  console.log(
    `║  Concurrence    : ${String(config.concurrency).padEnd(53)} ║`
  );
  console.log(
    `║  Durée totale   : ${String(totalTime.toFixed(1) + 's').padEnd(53)} ║`
  );
  console.log('╠══════════════════════════╦════════════════════════════════════╣');
  console.log('║  Métrique                ║  Sans cache    ║  Avec MicroCache   ║');
  console.log('╠══════════════════════════╬════════════════╬════════════════════╣');

  console.log(
    `║  Latence moyenne         ║    ${String(statsNocache.mean + ' ms').padEnd(10)} ║      ${String(statsCache.mean + ' ms').padEnd(14)} ║`
  );
  console.log(
    `║  Latence médiane         ║    ${String(statsNocache.median + ' ms').padEnd(10)} ║      ${String(statsCache.median + ' ms').padEnd(14)} ║`
  );
  console.log(
    `║  P95                     ║   ${String(statsNocache.p95 + ' ms').padEnd(11)} ║      ${String(statsCache.p95 + ' ms').padEnd(14)} ║`
  );
  console.log(
    `║  P99                     ║   ${String(statsNocache.p99 + ' ms').padEnd(11)} ║      ${String(statsCache.p99 + ' ms').padEnd(14)} ║`
  );
  console.log(
    `║  Min                     ║    ${String(statsNocache.min + ' ms').padEnd(10)} ║      ${String(statsCache.min + ' ms').padEnd(14)} ║`
  );
  console.log(
    `║  Max                     ║    ${String(statsNocache.max + ' ms').padEnd(10)} ║      ${String(statsCache.max + ' ms').padEnd(14)} ║`
  );
  console.log(
    `║  Req/sec                 ║    ${String(rpsNocache).padEnd(10)} ║      ${String(rpsCache).padEnd(14)} ║`
  );
  console.log(
    `║  Taux de succès          ║  ${String(statsNocache.successRate + '%').padEnd(11)} ║     ${String(statsCache.successRate + '%').padEnd(15)} ║`
  );
  console.log(
    `║  Cache hit rate          ║    —           ║     ${String(cacheHitRate + '%').padEnd(14)} ║`
  );
  console.log('╠══════════════════════════╬════════════════╬════════════════════╣');

  const speedupText = speedupFactor > 1 ? `×${speedupFactor} plus rapide` : 'N/A';
  console.log(
    `║  🚀 GAIN DE VITESSE      ║       ${speedupText.padEnd(32)} ║`
  );

  console.log('╚══════════════════════════╩═══════════════════════════════════╝\n');

  // ===== PRODUCTION ESTIMATE =====
  const simultaneousUsers = 1000;
  const nocacheEstimate = statsNocache.mean * simultaneousUsers;
  const cacheEstimate = statsCache.mean * simultaneousUsers;

  console.log('📊 Estimation production (1000 utilisateurs simultanés):');
  console.log(`  → Sans cache  : ~${Math.round(nocacheEstimate / 1000)}s de latence cumulée/sec (⚠ surcharge)`);
  console.log(`  → Avec cache  : ~${Math.round(cacheEstimate / 1000)}s de latence cumulée/sec (✓ optimal)\n`);

  // ===== VALIDATION CRITERIA =====
  const SPEEDUP_THRESHOLD = 7;
  console.log('✓ Critères de validation:');
  console.log(
    `  ${speedupFactor >= SPEEDUP_THRESHOLD ? '✅' : '❌'} Gain de vitesse ≥ ×${SPEEDUP_THRESHOLD} (actuellement: ×${speedupFactor})`
  );
  console.log(`  ${cacheHitRate >= 80 ? '✅' : '❌'} Cache hit rate ≥ 80% (actuellement: ${cacheHitRate}%)`);
  console.log(
    `  ${statsNocache.successRate === 100 ? '✅' : '❌'} Succès sans cache = 100% (actuellement: ${statsNocache.successRate}%)`
  );
  console.log(
    `  ${statsCache.successRate === 100 ? '✅' : '❌'} Succès avec cache = 100% (actuellement: ${statsCache.successRate}%)\n`
  );

  // Exit code
  const passed =
    speedupFactor >= SPEEDUP_THRESHOLD &&
    cacheHitRate >= 80 &&
    statsNocache.successRate === 100 &&
    statsCache.successRate === 100;

  if (passed) {
    console.log(' TOUS LES CRITÈRES VALIDÉS \n');
    process.exit(0);
  } else {
    console.log('⚠️  Certains critères ne sont pas atteints.\n');
    process.exit(1);
  }
}

// ===== ERROR HANDLING =====
process.on('unhandledRejection', (err) => {
  console.error('\n❌ Erreur non gérée:', err.message);
  process.exit(1);
});

// ===== RUN =====
main().catch((err) => {
  console.error('\n❌ Erreur:', err.message);
  process.exit(1);
});

// ===== EXPORTS (for reuse) =====
module.exports = {
  timedFetch,
  runWithConcurrency,
  computeStats,
};
