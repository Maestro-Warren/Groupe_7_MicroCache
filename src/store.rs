use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct CacheEntry {
    pub value: Vec<u8>,
    pub expires_at: Option<Instant>,
}

impl CacheEntry {
    fn new(value: Vec<u8>, ttl: Option<Duration>) -> Self {
        Self {
            value,
            expires_at: ttl.map(|d| Instant::now() + d),
        }
    }

    fn is_expired_at(&self, now: Instant) -> bool {
        self.expires_at.is_some_and(|expires_at| now >= expires_at)
    }

    fn remaining_ttl(&self, now: Instant) -> Option<Duration> {
        self.expires_at
            .and_then(|expires_at| expires_at.checked_duration_since(now))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtlResult {
    Missing,
    NoExpiry,
    ExpiresIn(Duration),
}

#[derive(Default, Debug)]
pub struct Store {
    entries: HashMap<String, CacheEntry>,
}

pub type SharedStore = Arc<RwLock<Store>>;

impl Store {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub fn set(&mut self, key: String, value: Vec<u8>, ttl: Option<Duration>) {
        self.entries.insert(key, CacheEntry::new(value, ttl));
    }

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

    pub fn delete(&mut self, key: &str) -> bool {
        let now = Instant::now();
        match self.entries.remove(key) {
            Some(entry) if entry.is_expired_at(now) => false,
            Some(_) => true,
            None => false,
        }
    }

    pub fn exists(&self, key: &str) -> bool {
        let now = Instant::now();
        self.entries
            .get(key)
            .is_some_and(|entry| !entry.is_expired_at(now))
    }

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

    pub fn purge_expired(&mut self) -> usize {
        let now = Instant::now();
        let before = self.entries.len();
        self.entries.retain(|_, entry| !entry.is_expired_at(now));
        before.saturating_sub(self.entries.len())
    }

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

    pub fn restore_entry(&mut self, key: String, value: Vec<u8>, ttl: Option<Duration>) {
        self.set(key, value, ttl);
    }
}

pub fn new_shared_store() -> SharedStore {
    Arc::new(RwLock::new(Store::new()))
}

pub fn shared_store_from(store: Store) -> SharedStore {
    Arc::new(RwLock::new(store))
}

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
