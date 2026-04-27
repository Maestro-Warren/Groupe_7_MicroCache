use crate::store::{SharedStore, Store};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub bind_addr: String,
    pub snapshot_path: String,
    pub snapshot_interval_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind_addr: "127.0.0.1:6379".to_string(),
            snapshot_path: "microcache.snapshot".to_string(),
            snapshot_interval_secs: 30,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SnapshotEntry {
    value: Vec<u8>,
    ttl_ms: Option<u64>,
}

type Snapshot = HashMap<String, SnapshotEntry>;

pub fn load_config(path: &Path) -> io::Result<Config> {
    if !path.exists() {
        return Ok(Config::default());
    }

    let content = fs::read_to_string(path)?;
    toml::from_str::<Config>(&content).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

pub fn save_snapshot(store: &SharedStore, path: &Path) -> io::Result<()> {
    let guard = store
        .read()
        .map_err(|_| io::Error::other("store lock poisoned"))?;

    let now = Instant::now();
    let snapshot: Snapshot = guard
        .snapshot_entries(now)
        .into_iter()
        .map(|(key, value, ttl)| {
            (
                key,
                SnapshotEntry {
                    value,
                    ttl_ms: ttl.map(|d| d.as_millis() as u64),
                },
            )
        })
        .collect();

    let bytes = bincode::serialize(&snapshot)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    fs::write(path, bytes)
}

pub fn load_snapshot(path: &Path) -> io::Result<Store> {
    if !path.exists() {
        return Ok(Store::new());
    }

    let bytes = fs::read(path)?;
    let snapshot = bincode::deserialize::<Snapshot>(&bytes)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;

    let mut store = Store::new();
    for (key, entry) in snapshot {
        let ttl = entry.ttl_ms.map(Duration::from_millis);
        store.restore_entry(key, entry.value, ttl);
    }

    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::{load_snapshot, save_snapshot};
    use crate::store::new_shared_store;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn snapshot_roundtrip_works() {
        let mut path = std::env::temp_dir();
        path.push(format!("microcache_test_{}.bin", std::process::id()));

        let store = new_shared_store();
        {
            let mut guard = store.write().expect("lock");
            guard.set("k1".to_string(), b"v1".to_vec(), None);
            guard.set("k2".to_string(), b"v2".to_vec(), Some(Duration::from_secs(2)));
        }

        save_snapshot(&store, &path).expect("save snapshot");
        let restored = load_snapshot(&path).expect("load snapshot");

        assert_eq!(restored.get("k1"), Some(b"v1".to_vec()));
        assert_eq!(restored.get("k2"), Some(b"v2".to_vec()));

        let _ = fs::remove_file(PathBuf::from(&path));
    }
}
