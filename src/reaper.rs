//! Reaper : nettoyage périodique des entrées expirées du cache.
//!
//! Le reaper tourne dans un thread OS dédié (pas une tâche Tokio) afin
//! d'isoler le travail de purge des I/O asynchrones.
//! Il appelle [`Store::purge_expired`](crate::store::Store::purge_expired) à
//! chaque expiration de l'intervalle configuré, puis se rendort.

use crate::store::SharedStore;
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Handle vers le thread reaper.
///
/// Envoyer un signal d'arrêt via [`stop`](ReaperHandle::stop) ou
/// simplement dropper cette valeur suffit à arrêter le thread proprement.
pub struct ReaperHandle {
    /// Canal pour signaler l'arrêt au thread reaper.
    stop_tx: Option<Sender<()>>,
    /// Handle du thread OS pour attendre sa terminaison.
    join_handle: Option<JoinHandle<()>>,
}

impl ReaperHandle {
    /// Arrête le thread reaper et attend sa terminaison.
    /// Préférer cette méthode explicite à un simple drop pour un arrêt ordonné.
    pub fn stop(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ReaperHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }
}

/// Démarre le thread reaper et retourne un [`ReaperHandle`] pour le contrôler.
///
/// Le thread se réveille toutes les `interval` ms, acquiert un verrou en écriture
/// sur le store et supprime les entrées expirées via [`purge_expired`](crate::store::Store::purge_expired).
/// Il s'arrête dès reception d'un signal d'arrêt ou si le canal est fermé.
pub fn start_reaper(store: SharedStore, interval: Duration) -> ReaperHandle {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let join_handle = thread::spawn(move || loop {
        match stop_rx.recv_timeout(interval) {
            Ok(()) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut guard) = store.write() {
                    guard.purge_expired();
                }
            }
        }
    });

    ReaperHandle {
        stop_tx: Some(stop_tx),
        join_handle: Some(join_handle),
    }
}

#[cfg(test)]
mod tests {
    use super::start_reaper;
    use crate::store::new_shared_store;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn reaper_removes_expired_entries() {
        let store = new_shared_store();
        {
            let mut guard = store.write().expect("lock");
            guard.set(
                "short".to_string(),
                b"life".to_vec(),
                Some(Duration::from_millis(40)),
            );
        }

        let handle = start_reaper(store.clone(), Duration::from_millis(20));
        thread::sleep(Duration::from_millis(90));

        {
            let guard = store.read().expect("lock");
            assert!(!guard.exists("short"));
        }

        handle.stop();
    }
}
