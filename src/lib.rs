//! Bibliothèque principale de **MicroCache**.
//!
//! Expose les modules internes utilisés par le binaire et les tests d'intégration :
//! - [`parser`]     — analyse des commandes textuelles reçues par le serveur.
//! - [`persistence`] — sauvegarde et restauration du store sur disque (snapshot binaire).
//! - [`reaper`]     — thread de nettoyage périodique des entrées expirées.
//! - [`server`]     — serveur TCP asynchrone (Tokio) et boucle de connexion.
//! - [`store`]      — structure de données centrale (cache clé/valeur avec TTL).

/// Module de parsing des commandes textuelles du protocole MicroCache.
pub mod parser;
/// Module de persistance : configuration TOML et snapshots binaires.
pub mod persistence;
/// Module du reaper : suppression en arrière-plan des entrées expirées.
pub mod reaper;
/// Module serveur : écoute TCP, dispatch des connexions et exécution des commandes.
pub mod server;
/// Module store : cache clé/valeur thread-safe avec support TTL.
pub mod store;
