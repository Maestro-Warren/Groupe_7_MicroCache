const express = require('express');
const { getConcertById, getAvailableSeats, getAllConcerts, simulateDbLatency } = require('../db');
const stats = require('../stats');

// Configuration du TTL du cache via variable d'environnement
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '30', 10);
console.log(`[CONFIG] CACHE_TTL = ${CACHE_TTL}s`);

/**
 * Factory function pour créer le routeur des tickets
 * Accepte db (connexion SQLite) et cache (client MicroCache)
 */
module.exports = function createTicketsRouter(db, cache) {
  const router = express.Router();

  /**
   * Route 1 : GET /api/tickets — WITH CACHE (Cache-Aside pattern)
   * Paramètre optionnel : ?concertId=1 (défaut: 1)
   */
  router.get('/tickets', async (req, res) => {
    const concertId = parseInt(req.query.concertId || '1', 10);
    const t0 = Date.now();
    const cacheKey = `concert:${concertId}:seats`;

    try {
      // Tenter le cache d'abord
      let cachedValue;
      try {
        cachedValue = await cache.get(cacheKey);
      } catch (err) {
        console.warn(`Cache error on GET ${cacheKey}:`, err.message);
        cachedValue = null;
      }

      // Cache HIT
      if (cachedValue !== null) {
        const latency = Date.now() - t0;
        stats.recordCacheHit(latency);

        return res.json({
          success: true,
          data: {
            source: 'cache',
            concertId,
            availableSeats: parseInt(cachedValue, 10),
            latencyMs: latency,
          },
          meta: {
            latencyMs: latency,
            source: 'cache',
            timestamp: Date.now(),
          },
        });
      }

      // Cache MISS — faire la requête DB
      if (!cache.isConnected) {
        stats.recordCacheError();
      }

      await simulateDbLatency();
      const seats = getAvailableSeats(db, concertId);

      if (seats === null) {
        return res.status(404).json({
          success: false,
          error: 'Concert not found',
          meta: { timestamp: Date.now() },
        });
      }

      // Stocker dans le cache pour la prochaine fois
      try {
        await cache.set(cacheKey, String(seats), CACHE_TTL);
      } catch (err) {
        console.warn(`Cache SET error on ${cacheKey}:`, err.message);
      }

      const latency = Date.now() - t0;
      stats.recordCacheMiss(latency);

      return res.json({
        success: true,
        data: {
          source: 'db',
          concertId,
          availableSeats: seats,
          latencyMs: latency,
        },
        meta: {
          latencyMs: latency,
          source: 'db',
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.error('Error in /api/tickets:', err);
      stats.recordCacheError();

      return res.status(500).json({
        success: false,
        error: err.message,
        meta: { timestamp: Date.now() },
      });
    }
  });

  /**
   * Route 2 : GET /api/tickets/nocache — WITHOUT CACHE (DB direct always)
   * Paramètre optionnel : ?concertId=1 (défaut: 1)
   */
  router.get('/tickets/nocache', async (req, res) => {
    const concertId = parseInt(req.query.concertId || '1', 10);
    const t0 = Date.now();

    try {
      await simulateDbLatency();
      const seats = getAvailableSeats(db, concertId);

      if (seats === null) {
        return res.status(404).json({
          success: false,
          error: 'Concert not found',
          meta: { timestamp: Date.now() },
        });
      }

      const latency = Date.now() - t0;
      stats.recordNocacheRequest(latency);

      return res.json({
        success: true,
        data: {
          source: 'db',
          concertId,
          availableSeats: seats,
          latencyMs: latency,
        },
        meta: {
          latencyMs: latency,
          source: 'db',
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.error('Error in /api/tickets/nocache:', err);

      return res.status(500).json({
        success: false,
        error: err.message,
        meta: { timestamp: Date.now() },
      });
    }
  });

  /**
   * Route 3 : GET /api/concerts — get all concerts (no cache)
   */
  router.get('/concerts', async (req, res) => {
    try {
      await simulateDbLatency();
      const concerts = getAllConcerts(db);

      return res.json({
        success: true,
        data: concerts,
        meta: {
          count: concerts.length,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.error('Error in /api/concerts:', err);

      return res.status(500).json({
        success: false,
        error: err.message,
        meta: { timestamp: Date.now() },
      });
    }
  });

  /**
   * Route 4 : GET /api/stats — get current metrics snapshot
   */
  router.get('/stats', (req, res) => {
    try {
      const snapshot = stats.getSnapshot();

      return res.json({
        success: true,
        data: snapshot,
        meta: {
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.error('Error in /api/stats:', err);

      return res.status(500).json({
        success: false,
        error: err.message,
        meta: { timestamp: Date.now() },
      });
    }
  });

  return router;
};

