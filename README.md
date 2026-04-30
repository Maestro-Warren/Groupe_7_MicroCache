# MicroCache — Cache haute performance pour billetterie concert

**MicroCache** est une démonstration complète d'un **système de cache distributé** validant le gain de performance dans un scénario de charge élevée (vente de tickets de concert).

Le projet comprend :

1. **Serveur MicroCache** (Rust) — Cache clé/valeur en mémoire TCP thread-safe
2. **API Backend** (Node.js + Express) — Billetterie concert avec cache-aside pattern
3. **Dashboard temps réel** (HTML/CSS/JS vanilla) — Visualisation WebSocket des métriques
4. **Script de test de charge** (Node.js) — Validation finale du projet

---

## Architecture

```
┌─────────────────┐
│   Dashboard     │  ← Vanilla HTML/CSS/JS (Chart.js)
│  (port 3000)    │     WebSocket pour métriques en temps réel
└────────┬────────┘
         │
    ┌────▼─────────────────────────────┐
    │   API Backend (Node.js Express)  │
    │   port 3000                      │
    │  Cache-Aside pattern             │
    │  SQLite (node:sqlite)            │
    │  Metrics singleton               │
    └────┬──────────────┬──────────────┘
         │              │
    ┌────▼────┐    ┌────▼────────────┐
    │SQLite DB│    │MicroCache TCP   │
    │         │    │  (port 6379)    │
    └─────────┘    └─────────────────┘
                          ▲
                    [Rust Tokio]
```

---

## Démarrage rapide

### 1. Cloner le projet

- Ouvrir le dossier dans le quel on souhaite cloner le projet sur VsCode
- Ouvrir le terminal et exécuter la commande :

```bash
git clone https://github.com/Maestro-Warren/Groupe_7_MicroCache
```

### 2. Lancer MicroCache (Rust)

```bash
cd Groupe_7_MicroCache
cargo run
# ✓ Server listening on 127.0.0.1:6379
```

### 3. Lancer le Backend API (Node.js)

```bash
cd microcache-demo/api-server
npm install
npm start
# ✓ API Server running on http://localhost:3000
# ✓ WebSocket: ws://localhost:3000/ws
```

### 4. Ouvrir le Dashboard

Naviguer vers **http://localhost:3000** dans le navigateur.

---

## Fonctionnalités du Dashboard

- **Indicateur de connexion** — État WebSocket en temps réel
- **Métriques principales** — Requêtes totales, hit rate, speedup factor, places disponibles
- **Comparaison visuelle** — 2 panneaux côte à côte (sans cache vs avec MicroCache)
- **Graphique temps réel** — 60 points de latence (Chart.js)
- **Générateur de trafic** — Boutons : Stop / Normal (5 req/s) / Afflux (30 req/s) / Panique (150 req/s)
- **Journal des requêtes** — 50 derniers requêtes avec badge (HIT/MISS/DB) et latence
- **Sélecteur de concert** — Test sur 5 concerts différents

---

## Test de charge

```bash
cd microcache-demo/api-server

# Défaut : 100 req/route, 10 concurrentes
node src/loadtest.js

# Personnalisé
node src/loadtest.js --requests 500 --concurrency 50 --concertId 4 --duration 30
```

**Rapport attendu** :

```
╔═══════════════════════════════════════════════════════════════╗
║           MicroCache — Rapport de performance                 ║
╠═══════════════════════════════════════════════════════════════╣
║  Latence moyenne         ║    87 ms       ║      4 ms         ║
║  Req/sec                 ║    12.3        ║     89.7          ║
║  Cache hit rate          ║    —           ║     92%           ║
║  GAIN DE VITESSE         ║       ×22 plus rapide avec cache   ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## Structure du projet

### Backend (api-server/src/)

- **index.js** — Serveur Express + WebSocket (diffusion des metrics toutes les 500ms)
- **cacheClient.js** — Client TCP MicroCache (protocole texte simple, TTL 30s)
- **db.js** — SQLite avec node:sqlite (DatabaseSync, 5 concerts pré-chargés)
- **stats.js** — Collecteur de métriques (hit/miss/latence avec sliding windows)
- **routes/tickets.js** — Routes API (/api/tickets, /api/tickets/nocache, /api/concerts, /api/stats)
- **loadtest.js** — Script de test de charge avec CLI

### Frontend (dashboard/)

- **index.html** — Single-file dashboard (HTML + CSS inline + JS vanilla)

### Rust (src/)

- **lib.rs** — Core (Store, Reaper, Persistence)
- **server.rs** — TCP server Tokio
- **parser.rs** — Commande parser textuel
- **store.rs** — Thread-safe key/value store
- **reaper.rs** — GC background pour TTL
- **persistence.rs** — Snapshot binaire

---

## Protocole MicroCache

Textuel ligne-par-ligne (terminateur : `\n`) :

```
PING                    → PONG
SET key value           → OK
SET key value EX 30     → OK
GET key                 → value ou NIL
EXISTS key              → 1 ou 0
DEL key                 → OK
TTL key                 → secondes restantes ou -1
```

---

## Critères de validation

Le projet est validé quand le test de charge affiche :

- Gain de vitesse **≥ ×10**
- Cache hit rate **≥ 80%**
- Taux de succès **= 100%** (les deux routes)

```bash
node src/loadtest.js --requests 200 --concurrency 20
# Si exit code = 0 → Projet TERMINÉ
```

---

## Stack technologique

| Composant | Technologie          | Version         |
| --------- | -------------------- | --------------- |
| Backend   | Node.js + Express    | 23.1.0 + 4.18.2 |
| Cache     | Rust + Tokio         | 1.40+           |
| DB        | SQLite (node:sqlite) | built-in        |
| Dashboard | Vanilla HTML/CSS/JS  | Chart.js 4.4.1  |
| WebSocket | ws                   | 8.16.0          |

---

## Troubleshooting

**Dashboard ne se connecte pas (indicateur gris)**

- Vérifier que le serveur Node.js tourne (`npm start`)
- Vérifier que WebSocket écoute sur port 3000

**Cache ne fonctionne pas (toujours MISS)**

- Vérifier que MicroCache Rust tourne (`cargo run`)
- Vérifier que cacheClient.js peut se connecter à 127.0.0.1:6379
- Consulter les logs `[CACHE DEBUG]` dans la console serveur

**Latence sans cache trop élevée**

- C'est normal : 40-120ms de delay simulée intentionnellement
- Le cache passe à ~1-5ms

---

Groupe 7 MicroCache
