const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

/**
 * Couche d'accès à la base de données SQLite (node:sqlite API expérimentale)
 * Simule une vraie BD sous charge avec latence réaliste
 * 
 * Note: node:sqlite est synchrone (comme better-sqlite3)
 * Zéro dépendance externe, API native Node 23+
 */

const SEED_CONCERTS = [
  { id: 1, artist: 'Burna Boy',      venue: 'Palais Omnisports de Bercy', event_date: '2025-11-15', total_seats: 15000, sold_seats: 12847, price_eur: 75  },
  { id: 2, artist: 'Davido',         venue: 'Accor Arena Paris',          event_date: '2025-12-03', total_seats: 18000, sold_seats: 17901, price_eur: 65  },
  { id: 3, artist: 'Tiwa Savage',    venue: 'Zénith de Paris',            event_date: '2026-01-20', total_seats: 6300,  sold_seats: 5100,  price_eur: 55  },
  { id: 4, artist: 'WizKid',         venue: 'Stade de France',            event_date: '2026-02-14', total_seats: 80000, sold_seats: 79500, price_eur: 90  },
  { id: 5, artist: 'Aya Nakamura',   venue: 'Accor Arena Paris',          event_date: '2026-03-08', total_seats: 18000, sold_seats: 9200,  price_eur: 60  },
];

/**
 * Initialise la base de données SQLite (node:sqlite)
 * Crée les tables et les données seed au premier démarrage
 */
function initDatabase() {
  // Construire le chemin absolu vers le répertoire db/
  const dbDir = path.join(__dirname, '..', 'db');
  const dbPath = path.join(dbDir, 'demo.db');

  // Créer le répertoire db/ s'il n'existe pas
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Ouvrir la connexion SQLite
  const db = new DatabaseSync(dbPath);

  // Créer la table concerts
  db.exec(`
    CREATE TABLE IF NOT EXISTS concerts (
      id          INTEGER PRIMARY KEY,
      artist      TEXT    NOT NULL,
      venue       TEXT    NOT NULL,
      event_date  TEXT    NOT NULL,
      total_seats INTEGER NOT NULL,
      sold_seats  INTEGER NOT NULL DEFAULT 0,
      price_eur   INTEGER NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Créer la table ticket_reservations
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_reservations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      concert_id  INTEGER NOT NULL REFERENCES concerts(id),
      user_ref    TEXT    NOT NULL,
      quantity    INTEGER NOT NULL DEFAULT 1,
      reserved_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Insérer les données seed si la table concerts est vide
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM concerts');
  const countConcerts = countStmt.get();
  
  if (countConcerts.count === 0) {
    const insertConcert = db.prepare(`
      INSERT INTO concerts (id, artist, venue, event_date, total_seats, sold_seats, price_eur)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const concert of SEED_CONCERTS) {
      insertConcert.run(
        concert.id,
        concert.artist,
        concert.venue,
        concert.event_date,
        concert.total_seats,
        concert.sold_seats,
        concert.price_eur
      );
    }
  }

  return db;
}

/**
 * Simule une latence réaliste de BD sous charge (avec réseau)
 * Délai aléatoire entre 80ms et 250ms (vs cache ~1-15ms)
 * Cela représente une vraie BD avec I/O disque + réseau
 */
function simulateDbLatency() {
  const minLatency = 80;
  const maxLatency = 250;
  const delay = minLatency + Math.random() * (maxLatency - minLatency);

  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Récupère un concert par ID
 */
function getConcertById(db, concertId) {
  return db.prepare('SELECT * FROM concerts WHERE id = ?').get(concertId);
}

/**
 * Retourne le nombre de places disponibles pour un concert
 */
function getAvailableSeats(db, concertId) {
  const concert = getConcertById(db, concertId);
  if (!concert) {
    return null;
  }
  return concert.total_seats - concert.sold_seats;
}

/**
 * Récupère tous les concerts avec places disponibles calculées
 * Triés par date d'événement
 */
function getAllConcerts(db) {
  const concerts = db.prepare('SELECT * FROM concerts ORDER BY event_date ASC').all();

  return concerts.map(concert => ({
    ...concert,
    available_seats: concert.total_seats - concert.sold_seats,
  }));
}

/**
 * Réserve des places pour un concert
 * node:sqlite n'expose pas directement les transactions,
 * on utilise les commandes BEGIN/COMMIT/ROLLBACK
 */
function reserveSeats(db, concertId, userRef, quantity = 1) {
  try {
    const concert = getConcertById(db, concertId);

    if (!concert) {
      return { success: false, reason: 'Concert not found' };
    }

    const availableSeats = concert.total_seats - concert.sold_seats;
    if (availableSeats < quantity) {
      return { success: false, reason: 'Insufficient seats' };
    }

    // Transaction manuelle
    try {
      db.exec('BEGIN');

      // Insérer la réservation
      const insertRes = db.prepare(`
        INSERT INTO ticket_reservations (concert_id, user_ref, quantity)
        VALUES (?, ?, ?)
      `);
      insertRes.run(concertId, userRef, quantity);

      // Récupérer l'ID inséré
      const lastIdStmt = db.prepare('SELECT last_insert_rowid() as id');
      const lastIdResult = lastIdStmt.get();
      const reservationId = lastIdResult.id;

      // Mettre à jour le nombre de places vendues
      db.prepare(`
        UPDATE concerts SET sold_seats = sold_seats + ? WHERE id = ?
      `).run(quantity, concertId);

      db.exec('COMMIT');

      return { success: true, reservationId };
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

module.exports = {
  initDatabase,
  getConcertById,
  getAvailableSeats,
  getAllConcerts,
  reserveSeats,
  simulateDbLatency,
};
