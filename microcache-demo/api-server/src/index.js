"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const { initDatabase } = require("./db");
const { MicroCacheClient } = require("./cacheClient");
const createTicketsRouter = require("./routes/tickets");
const stats = require("./stats");

const PORT = process.env.PORT || 3000;
const CACHE_HOST = process.env.CACHE_HOST || "127.0.0.1";
const CACHE_PORT = parseInt(process.env.CACHE_PORT || "6379");
const WS_INTERVAL_MS = 500;

// ─── 1. Base de données ───────────────────────────────────────────────────────
const db = initDatabase();
console.log("[DB] SQLite initialisé");

// ─── 2. Client MicroCache ─────────────────────────────────────────────────────
const cache = new MicroCacheClient(CACHE_HOST, CACHE_PORT, {
  connectTimeout: 2000,
  commandTimeout: 500,
});

// Tentative de connexion non-bloquante au démarrage
cache
  .connect()
  .then(() =>
    console.log(
      `[CACHE] Connecté à MicroCache sur ${CACHE_HOST}:${CACHE_PORT}`,
    ),
  )
  .catch((err) =>
    console.warn(`[CACHE] Non disponible (mode dégradé): ${err.message}`),
  );

// ─── 3. Application Express ───────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// Logger de requêtes minimal
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `[HTTP] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`,
    );
  });
  next();
});

// Routes API
app.use("/api", createTicketsRouter(db, cache));

// Sanity check
app.get("/health", (req, res) =>
  res.json({ status: "ok", uptime: process.uptime() }),
);

// Dashboard — servir le fichier HTML statique
const DASHBOARD_PATH = path.resolve(__dirname, "../../dashboard/index.html");
app.get("/", (req, res) => res.sendFile(DASHBOARD_PATH));

// Fallback 404
app.use((req, res) =>
  res.status(404).json({ success: false, error: "Not found" }),
);

// ─── 4. Serveur HTTP ──────────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── 5. Serveur WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  console.log(`[WS] Nouveau client connecté (${wss.clients.size} total)`);

  // Envoyer un snapshot immédiat à la connexion
  ws.send(JSON.stringify({ type: "snapshot", payload: stats.getSnapshot() }));

  ws.on("close", () => {
    console.log(`[WS] Client déconnecté (${wss.clients.size} restants)`);
  });

  ws.on("error", (err) => {
    console.error("[WS] Erreur client:", err.message);
  });
});

// Broadcaster les métriques à tous les clients connectés
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // OPEN
      client.send(msg, (err) => {
        if (err) console.error("[WS] Send error:", err.message);
      });
    }
  });
}

const metricsInterval = setInterval(() => {
  if (wss.clients.size === 0) return; // ne pas calculer si personne n'écoute
  broadcast({ type: "metrics", payload: stats.getSnapshot() });
}, WS_INTERVAL_MS);

// ─── 6. Démarrage ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║        MicroCache Demo — API Server      ║");
  console.log(`║  Dashboard : http://localhost:${PORT}       ║`);
  console.log(`║  API       : http://localhost:${PORT}/api   ║`);
  console.log(`║  Health    : http://localhost:${PORT}/health ║`);
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
});

// ─── 7. Arrêt propre ──────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[SERVER] Signal ${signal} reçu — arrêt propre...`);
  clearInterval(metricsInterval);
  cache.disconnect();
  server.close(() => {
    console.log("[SERVER] HTTP server fermé");
    process.exit(0);
  });
  // Forcer si nécessaire après 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
