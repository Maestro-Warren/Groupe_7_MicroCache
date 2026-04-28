const { MicroCacheClient } = require('./cacheClient');

/**
 * Suite de tests pour MicroCacheClient
 * Lance avec : node src/cacheClient.test.js
 */

let testsPassed = 0;
let testsFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`[FAIL] ${name}`);
    console.log(`       Raison: ${err.message}`);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function main() {
  console.log('=== TESTS MicroCacheClient ===\n');

  // Test 1 : Connexion réussie (si MicroCache tourne)
  await test('Connexion établie', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();
      assert(cache.isConnected, 'Socket devrait être connectée');
      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 2 : SET puis GET retourne la bonne valeur
  await test('SET puis GET retourne la valeur', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();
      const setOk = await cache.set('test:key', 'hello', 30);
      assert(setOk === true, 'SET devrait retourner true');

      const value = await cache.get('test:key');
      assert(value === 'hello', `GET devrait retourner 'hello', reçu: ${value}`);

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 3 : GET sur clé inexistante retourne null
  await test('GET clé inexistante retourne null', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();
      const value = await cache.get('inexistant:key:' + Date.now());
      assert(value === null, `GET inexistant devrait retourner null, reçu: ${value}`);

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 4 : Compteurs stats corrects
  await test('Compteurs stats corrects après 3 opérations', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();

      // Stats initiales
      assert(cache.stats.totalCommands === 0, 'Stats initiales doivent être à 0');

      // SET (1 commande)
      await cache.set('stat:test1', 'value1', 30);
      assert(cache.stats.totalCommands === 1, 'totalCommands devrait être 1 après SET');

      // GET sur clé existante (hit)
      await cache.get('stat:test1');
      assert(cache.stats.hits === 1, 'hits devrait être 1');
      assert(cache.stats.totalCommands === 2, 'totalCommands devrait être 2');

      // GET sur clé inexistante (miss)
      await cache.get('inexistant:' + Date.now());
      assert(cache.stats.misses === 1, 'misses devrait être 1');
      assert(cache.stats.totalCommands === 3, 'totalCommands devrait être 3');

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 5 : Comportement si MicroCache absent
  await test('Connexion échoue si MicroCache absent', async () => {
    const cache = new MicroCacheClient('127.0.0.1', 9999); // Port inexistant
    try {
      await cache.connect();
      throw new Error('connect() ne devrait pas réussir sur un port fermé');
    } catch (err) {
      // On s'attend à un erreur de connexion
      assert(err.message.includes('Failed to connect') || err.message.includes('ECONNREFUSED'), 
             `Erreur attendue, reçu: ${err.message}`);
    }
  });

  // Test 6 : PING
  await test('PING fonctionne', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();
      const pong = await cache.ping();
      assert(pong === true, 'ping() devrait retourner true');

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 7 : EXISTS
  await test('EXISTS fonctionne', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();

      await cache.set('exists:test', 'value', 30);
      const exists1 = await cache.exists('exists:test');
      assert(exists1 === true, 'EXISTS sur clé existante devrait retourner true');

      const exists2 = await cache.exists('inexistant:' + Date.now());
      assert(exists2 === false, 'EXISTS sur clé inexistante devrait retourner false');

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 8 : DEL
  await test('DEL fonctionne', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();

      await cache.set('del:test', 'value', 30);
      const deleted = await cache.del('del:test');
      assert(deleted === true, 'DEL devrait retourner true');

      const value = await cache.get('del:test');
      assert(value === null, 'GET après DEL devrait retourner null');

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 9 : TTL
  await test('TTL fonctionne', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();

      await cache.set('ttl:test', 'value', 30);
      const ttl = await cache.ttl('ttl:test');
      assert(ttl > 0 && ttl <= 30, `TTL devrait être entre 1 et 30, reçu: ${ttl}`);

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Test 10 : Idempotence du connect()
  await test('connect() est idempotente', async () => {
    const cache = new MicroCacheClient();
    try {
      await cache.connect();
      const socket1 = cache.socket;

      await cache.connect(); // Deuxième appel
      const socket2 = cache.socket;

      assert(socket1 === socket2, 'La socket ne devrait pas changer à second connect()');

      cache.disconnect();
    } catch (err) {
      throw new Error(`MicroCache non disponible (normal si non lancé) : ${err.message}`);
    }
  });

  // Résumé
  console.log(`\n=== RÉSUMÉ ===`);
  console.log(`Réussis : ${testsPassed}`);
  console.log(`Échoués  : ${testsFailed}`);
  console.log(`Total    : ${testsPassed + testsFailed}`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
