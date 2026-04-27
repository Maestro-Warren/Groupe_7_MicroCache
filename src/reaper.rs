use crate::store::SharedStore;
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct ReaperHandle {
    stop_tx: Option<Sender<()>>,
    join_handle: Option<JoinHandle<()>>,
}

impl ReaperHandle {
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
