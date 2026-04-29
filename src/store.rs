//! Store principal de MicroCache : cache clé/valeur thread-safe avec support TTL.
//!
//! # Architecture
//! - [`CacheEntry`] stocke une valeur brute (`Vec<u8>`) et une expiration optionnelle.
//! - [`Store`] contient la `HashMap` interne et expose toutes les opérations CRUD.
//! - [`SharedStore`] est un alias `Arc<RwLock<Store>>` partagé entre les tâches Tokio.
//! - [`glob_match`] fournit une correspondance de motifs `*` pour la commande `KEYS`.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// Une entrée individuelle du cache.
///
/// Contient la valeur binaire brute et, optionnellement, l'instant d'expiration.
/// L'expiration est calculée une seule fois à l'insertion (`Instant::now() + ttl`).
#[derive(Clone, Debug)]
pub struct CacheEntry {
    /// Valeur brute stockée (peut être du texte ou du binaire arbitraire).
    pub value: Vec<u8>,
    /// Instant d'expiration absolu. `None` signifie que l'entrée n'expire jamais.
    pub expires_at: Option<Instant>,
}

impl CacheEntry {
    /// Crée une nouvelle entrée avec la valeur et le TTL donnés.
    /// Si `ttl` est `Some(d)`, l'expiration est fixée à `maintenant + d`.
    fn new(value: Vec<u8>, ttl: Option<Duration>) -> Self {
        Self {
            value,
            expires_at: ttl.map(|d| Instant::now() + d),
        }
    }

    /// Retourne `true` si cette entrée a expiré au moment `now`.
    fn is_expired_at(&self, now: Instant) -> bool {
        self.expires_at.is_some_and(|expires_at| now >= expires_at)
    }

    /// Retourne le TTL restant à l'instant `now`, ou `None` si l'entrée n'expire pas.
    fn remaining_ttl(&self, now: Instant) -> Option<Duration> {
        self.expires_at
            .and_then(|expires_at| expires_at.checked_duration_since(now))
    }
}

/// Résultat de la commande `TTL key`.
///
/// Reproduit la sémantique Redis :
/// - `-2` si la clé est absente ou expirée ([`Missing`](TtlResult::Missing)).
/// - `-1` si la clé existe mais n'a pas d'expiration ([`NoExpiry`](TtlResult::NoExpiry)).
/// - `>= 0` nombre de secondes restantes ([`ExpiresIn`](TtlResult::ExpiresIn)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtlResult {
    /// Clé absente ou déjà expirée (correspond à `-2`).
    Missing,
    /// Clé présente sans expiration (correspond à `-1`).
    NoExpiry,
    /// Clé présente avec un TTL restant.
    ExpiresIn(Duration),
}

/// Cache clé/valeur en mémoire avec support TTL.
///
/// Le `Store` n'est **pas** thread-safe seul ; utilisez [`SharedStore`] pour
/// le partager entre plusieurs tâches Tokio ou threads OS.
#[derive(Default, Debug)]
pub struct Store {
    /// Table de hachage interne indexée par clé UTF-8.
    entries: HashMap<String, CacheEntry>,
}

/// Alias pratique pour un `Store` partagé entre tâches via `Arc<RwLock<_>>`.
/// Utiliser [`new_shared_store`] ou [`shared_store_from`] pour créer une instance.
pub type SharedStore = Arc<RwLock<Store>>;

impl Store {
    /// Crée un store vide.
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Insère ou remplace une entrée. Si `ttl` est `Some`, l'entrée expirera après ce délai.
    pub fn set(&mut self, key: String, value: Vec<u8>, ttl: Option<Duration>) {
        self.entries.insert(key, CacheEntry::new(value, ttl));
    }

    /// Retourne la valeur associée à `key`, ou `None` si la clé est absente ou expirée.
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let now = Instant::now();
        self.entries.get(key).and_then(|entry| {
            if entry.is_expired_at(now) {
                None
            } else {
                Some(entry.value.clone())
            }
        })
    }

    /// Supprime `key` du store.
    /// Retourne `true` si une entrée non-expirée a été supprimée, `false` sinon.
    pub fn delete(&mut self, key: &str) -> bool {
        let now = Instant::now();
        match self.entries.remove(key) {
            // L'entrée existait mais était déjà expirée : on considère qu'elle n'existait pas.
            Some(entry) if entry.is_expired_at(now) => false,
            Some(_) => true,
            None => false,
        }
    }

    /// Retourne `true` si `key` existe et n'a pas expiré.
    pub fn exists(&self, key: &str) -> bool {
        let now = Instant::now();
        self.entries
            .get(key)
            .is_some_and(|entry| !entry.is_expired_at(now))
    }

    /// Retourne le TTL de `key` sous forme de [`TtlResult`].
    pub fn ttl(&self, key: &str) -> TtlResult {
        let now = Instant::now();
        match self.entries.get(key) {
            None => TtlResult::Missing,
            Some(entry) if entry.is_expired_at(now) => TtlResult::Missing,
            Some(entry) => match entry.remaining_ttl(now) {
                Some(ttl) => TtlResult::ExpiresIn(ttl),
                None => TtlResult::NoExpiry,
            },
        }
    }

    /// Retourne toutes les clés non-expirées dont le nom correspond à `pattern`.
    /// Supporte le wildcard `*` (ex : `"user:*"`, `"*"`).
    /// Les clés sont retournées triées par ordre lexicographique.
    pub fn keys(&self, pattern: &str) -> Vec<String> {
        let now = Instant::now();
        let mut keys = self
            .entries
            .iter()
            .filter(|(_, entry)| !entry.is_expired_at(now))
            .map(|(key, _)| key)
            .filter(|key| glob_match(key, pattern))
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    /// Supprime toutes les entrées expirées du store.
    /// Retourne le nombre d'entrées supprimées.
    /// Appelée périodiquement par le [`reaper`](crate::reaper).
    pub fn purge_expired(&mut self) -> usize {
        let now = Instant::now();
        let before = self.entries.len();
        self.entries.retain(|_, entry| !entry.is_expired_at(now));
        before.saturating_sub(self.entries.len())
    }

    /// Retourne toutes les entrées non-expirées sous forme sérialisable `(clé, valeur, ttl_restant)`.
    /// Utilisé par le module [`persistence`](crate::persistence) pour sauvegarder le store sur disque.
    pub fn snapshot_entries(&self, now: Instant) -> Vec<(String, Vec<u8>, Option<Duration>)> {
        self.entries
            .iter()
            .filter_map(|(key, entry)| {
                if entry.is_expired_at(now) {
                    return None;
                }
                Some((
                    key.clone(),
                    entry.value.clone(),
                    entry.remaining_ttl(now),
                ))
            })
            .collect()
    }

    /// Réinsère une entrée lors de la restauration depuis un snapshot.
    /// Délègue à [`set`](Store::set) pour recalculer l'expiration absolue.
    pub fn restore_entry(&mut self, key: String, value: Vec<u8>, ttl: Option<Duration>) {
        self.set(key, value, ttl);
    }
}

/// Crée un [`SharedStore`] vide prêt à l'emploi.
pub fn new_shared_store() -> SharedStore {
    Arc::new(RwLock::new(Store::new()))
}

/// Encapsule un `Store` existant dans un [`SharedStore`].
/// Utile au démarrage pour restaurer un snapshot avant de lancer le serveur.
pub fn shared_store_from(store: Store) -> SharedStore {
    Arc::new(RwLock::new(store))
}

/// Teste si `candidate` correspond au `pattern` glob simple (seul `*` est supporté).
///
/// # Règles
/// - `"*"` seul correspond à tout.
/// - Sans `*`, correspondance exacte.
/// - Avec `*`, chaque segment littéral doit apparaître dans l'ordre dans `candidate`.
/// - Un segment en début de motif (sans `*` devant) est ancré au début de la chaîne.
/// - Un segment en fin de motif (sans `*` après) est ancré à la fin de la chaîne.
fn glob_match(candidate: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }

    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return candidate == pattern;
    }

    let mut remaining = candidate;
    let mut first = true;

    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }

        if first && !pattern.starts_with('*') {
            if let Some(stripped) = remaining.strip_prefix(part) {
                remaining = stripped;
                first = false;
                continue;
            }
            return false;
        }

        if index == parts.len() - 1 && !pattern.ends_with('*') {
            return remaining.ends_with(part);
        }

        if let Some(pos) = remaining.find(part) {
            remaining = &remaining[pos + part.len()..];
            first = false;
        } else {
            return false;
        }
    }

    if !pattern.ends_with('*') {
        parts
            .last()
            .is_none_or(|last| last.is_empty() || candidate.ends_with(last))
    } else {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{Store, TtlResult};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn set_get_delete_works() {
        let mut store = Store::new();
        store.set("a".to_string(), b"v1".to_vec(), None);

        assert_eq!(store.get("a"), Some(b"v1".to_vec()));
        assert!(store.delete("a"));
        assert_eq!(store.get("a"), None);
        assert!(!store.delete("a"));
    }

    #[test]
    fn exists_and_ttl_work() {
        let mut store = Store::new();
        store.set("permanent".to_string(), b"x".to_vec(), None);
        store.set(
            "ephemeral".to_string(),
            b"y".to_vec(),
            Some(Duration::from_millis(25)),
        );

        assert!(store.exists("permanent"));
        assert!(matches!(store.ttl("permanent"), TtlResult::NoExpiry));
        assert!(matches!(store.ttl("ephemeral"), TtlResult::ExpiresIn(_)));

        thread::sleep(Duration::from_millis(35));
        assert!(!store.exists("ephemeral"));
        assert!(matches!(store.ttl("ephemeral"), TtlResult::Missing));
    }

    #[test]
    fn purge_and_keys_respect_expiration_and_pattern() {
        let mut store = Store::new();
        store.set("alpha".to_string(), b"1".to_vec(), None);
        store.set("alpine".to_string(), b"2".to_vec(), None);
        store.set(
            "beta".to_string(),
            b"3".to_vec(),
            Some(Duration::from_millis(10)),
        );

        thread::sleep(Duration::from_millis(20));
        assert_eq!(store.purge_expired(), 1);
        assert_eq!(store.keys("al*"), vec!["alpha".to_string(), "alpine".to_string()]);
        assert_eq!(store.keys("*ta"), Vec::<String>::new());
    }
}
