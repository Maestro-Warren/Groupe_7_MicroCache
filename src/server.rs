//! Serveur TCP asynchrone de MicroCache.
//!
//! # Flux d'exécution
//! 1. [`run_server`] charge la config et le snapshot, démarre le reaper et la boucle TCP.
//! 2. [`accept_loop`] accepte les connexions et délègue chacune à une tâche Tokio.
//! 3. [`handle_client`] lit les lignes de commande, les parse et renvoie les réponses.
//! 4. [`execute_command`] applique la commande sur le [`SharedStore`] et produit la réponse texte.
//!
//! # Signaux Unix (seulement sur les systèmes Unix)
//! - `SIGUSR1` : déclenche une sauvegarde immédiate du snapshot.
//! - `SIGHUP`  : recharge la configuration depuis le fichier TOML sans redémarrage.

use crate::parser::{parse_line, Command, ParsedLine};
use crate::persistence::{load_config, load_snapshot, save_snapshot, Config};
use crate::reaper::{start_reaper, ReaperHandle};
use crate::store::{shared_store_from, SharedStore, TtlResult};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// Options de démarrage du serveur.
///
/// Créées via [`ServerOptions::default`] pour l'usage normal,
/// ou construites manuellement pour les tests.
#[derive(Debug, Clone)]
pub struct ServerOptions {
    /// Chemin vers le fichier de configuration TOML (`microcache.toml` par défaut).
    pub config_path: PathBuf,
    /// Intervalle en millisecondes entre deux passages du reaper.
    pub reaper_interval_ms: u64,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            config_path: PathBuf::from("microcache.toml"),
            reaper_interval_ms: 200,
        }
    }
}

/// Démarre le serveur MicroCache complet.
///
/// 1. Charge la configuration depuis `options.config_path` (crée les valeurs par défaut si absent).
/// 2. Restaure le dernier snapshot si le fichier existe.
/// 3. Lance le reaper périodique et la boucle de snapshot.
/// 4. Installe les gestionnaires de signaux Unix (`SIGUSR1`, `SIGHUP`).
/// 5. Ouvre l'écoute TCP sur l'adresse définie dans la config et boucle sur les connexions.
pub async fn run_server(options: ServerOptions) -> io::Result<()> {
    let initial_cfg = load_config(&options.config_path).unwrap_or_default();
    let config = Arc::new(RwLock::new(initial_cfg.clone()));

    let store = shared_store_from(load_snapshot(Path::new(&initial_cfg.snapshot_path))?);
    let reaper_handle = start_reaper(store.clone(), Duration::from_millis(options.reaper_interval_ms));

    spawn_snapshot_loop(store.clone(), config.clone());
    spawn_signal_handlers(store.clone(), config.clone(), options.config_path.clone());

    let listener = TcpListener::bind(&initial_cfg.bind_addr).await?;

    accept_loop(listener, store, reaper_handle).await
}

/// Boucle principale d'acceptation des connexions TCP.
///
/// Pour chaque connexion acceptée, une nouvelle tâche Tokio est détachée
/// afin de traiter les commandes en parallèle sans bloquer les autres clients.
async fn accept_loop(
    listener: TcpListener,
    store: SharedStore,
    reaper_handle: ReaperHandle,
) -> io::Result<()> {
    let _reaper_guard = reaper_handle;

    loop {
        let (stream, _) = listener.accept().await?;
        let local_store = store.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_client(stream, local_store).await {
                eprintln!("connection error: {err}");
            }
        });
    }
}

/// Gère une connexion TCP cliente.
///
/// Lit les lignes en continu jusqu'à la fermeture de la connexion (EOF).
/// Chaque ligne est analysée par [`parse_line`] :
/// - En cas d'erreur de parsing, renvoie `-ERR <message>`.
/// - Si la commande nécessite un payload binaire (`BulkSet`), lit exactement `bulk_len` octets.
/// - Sinon, exécute la commande immédiatement via [`execute_command`].
async fn handle_client(stream: TcpStream, store: SharedStore) -> io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            break; // EOF — client déconnecté
        }

        // Retire les terminateurs \r\n ou \n
        let trimmed = line.trim_end_matches(|c| c == '\n' || c == '\r');

        let command = match parse_line(trimmed) {
            Err(err) => {
                write_half
                    .write_all(format!("-ERR {err}\r\n").as_bytes())
                    .await?;
                continue;
            }
            Ok(ParsedLine::Complete(cmd)) => cmd,
            Ok(ParsedLine::BulkSet {
                key,
                ex_seconds,
                bulk_len,
            }) => {
                // Lecture exacte du payload binaire
                let mut value = vec![0u8; bulk_len];
                reader.read_exact(&mut value).await?;
                // Consommation du terminateur de ligne après le payload
                let mut tail = String::new();
                let _ = reader.read_line(&mut tail).await;
                Command::Set {
                    key,
                    value,
                    ex_seconds,
                }
            }
        };

        let response = execute_command(command, &store);
        write_half.write_all(response.as_bytes()).await?;
    }

    Ok(())
}

/// Exécute une [`Command`] sur le store et retourne la réponse texte à envoyer au client.
///
/// Toutes les réponses sont terminées par `\n`.
/// En cas d'empoisonnement du verrou interne, retourne `ERR internal lock error`.
fn execute_command(command: Command, store: &SharedStore) -> String {
    match command {
        Command::Ping => "PONG\n".to_string(),
        Command::Set {
            key,
            value,
            ex_seconds,
        } => {
            let ttl = ex_seconds.map(Duration::from_secs);
            match store.write() {
                Ok(mut guard) => {
                    guard.set(key, value, ttl);
                    "OK\n".to_string()
                }
                Err(_) => "ERR internal lock error\n".to_string(),
            }
        }
        Command::Get { key } => match store.read() {
            Ok(guard) => match guard.get(&key) {
                Some(value) => {
                    let value_text = String::from_utf8_lossy(&value);
                    format!("{}\n", value_text)
                }
                None => "NIL\n".to_string(),
            },
            Err(_) => "ERR internal lock error\n".to_string(),
        },
        Command::Del { key } => match store.write() {
            Ok(mut guard) => {
                let deleted = guard.delete(&key);
                format!("{}\n", if deleted { 1 } else { 0 })
            }
            Err(_) => "ERR internal lock error\n".to_string(),
        },
        Command::Keys { pattern } => match store.read() {
            Ok(guard) => {
                let keys = guard.keys(&pattern);
                if keys.is_empty() {
                    "\n".to_string()
                } else {
                    format!("{}\n", keys.join(" "))
                }
            }
            Err(_) => "ERR internal lock error\n".to_string(),
        },
        Command::Exists { key } => match store.read() {
            Ok(guard) => format!("{}\n", if guard.exists(&key) { 1 } else { 0 }),
            Err(_) => "ERR internal lock error\n".to_string(),
        },
        Command::Ttl { key } => match store.read() {
            Ok(guard) => match guard.ttl(&key) {
                TtlResult::Missing => "-2\n".to_string(),
                TtlResult::NoExpiry => "-1\n".to_string(),
                TtlResult::ExpiresIn(ttl) => format!("{}\n", ttl.as_secs()),
            },
            Err(_) => "ERR internal lock error\n".to_string(),
        },
    }
}

/// Lance en arrière-plan la tâche Tokio de sauvegarde périodique du snapshot.
///
/// Lit l'intervalle et le chemin de sauvegarde depuis la config à chaque itération
/// afin de prendre en compte un rechargement de config via `SIGHUP`.
fn spawn_snapshot_loop(store: SharedStore, config: Arc<RwLock<Config>>) {
    tokio::spawn(async move {
        loop {
            let (path, interval_secs) = match config.read() {
                Ok(cfg) => (cfg.snapshot_path.clone(), cfg.snapshot_interval_secs.max(1)),
                Err(_) => ("microcache.snapshot".to_string(), 30),
            };

            tokio::time::sleep(Duration::from_secs(interval_secs)).await;
            if let Err(err) = save_snapshot(&store, Path::new(&path)) {
                eprintln!("snapshot error: {err}");
            }
        }
    });
}

/// Installe les gestionnaires de signaux Unix.
///
/// - `SIGUSR1` : déclenche une sauvegarde immédiate du snapshot sans interrompre le serveur.
/// - `SIGHUP`  : recharge la configuration depuis le fichier TOML à chaud.
#[cfg(unix)]
fn spawn_signal_handlers(
    store: SharedStore,
    config: Arc<RwLock<Config>>,
    config_path: PathBuf,
) {
    use tokio::signal::unix::{signal, SignalKind};

    tokio::spawn({
        let store = store.clone();
        let config = config.clone();
        async move {
            let Ok(mut stream) = signal(SignalKind::user_defined1()) else {
                return;
            };
            while stream.recv().await.is_some() {
                let path = match config.read() {
                    Ok(cfg) => cfg.snapshot_path.clone(),
                    Err(_) => "microcache.snapshot".to_string(),
                };
                if let Err(err) = save_snapshot(&store, Path::new(&path)) {
                    eprintln!("SIGUSR1 snapshot failed: {err}");
                }
            }
        }
    });

    tokio::spawn(async move {
        let Ok(mut stream) = signal(SignalKind::hangup()) else {
            return;
        };

        while stream.recv().await.is_some() {
            match load_config(&config_path) {
                Ok(new_cfg) => {
                    if let Ok(mut cfg) = config.write() {
                        *cfg = new_cfg;
                    }
                }
                Err(err) => {
                    eprintln!("SIGHUP config reload failed: {err}");
                }
            }
        }
    });
}

#[cfg(not(unix))]
fn spawn_signal_handlers(
    _store: SharedStore,
    _config: Arc<RwLock<Config>>,
    _config_path: PathBuf,
) {
}

#[cfg(test)]
mod tests {
    use super::execute_command;
    use crate::parser::Command;
    use crate::store::new_shared_store;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};

    #[test]
    fn command_execution_roundtrip() {
        let store = new_shared_store();

        let set_resp = execute_command(
            Command::Set {
                key: "k".to_string(),
                value: b"v".to_vec(),
                ex_seconds: None,
            },
            &store,
        );
        assert_eq!(set_resp, "+OK\r\n");

        let get_resp = execute_command(
            Command::Get {
                key: "k".to_string(),
            },
            &store,
        );
        assert!(get_resp.contains("v"));

        let del_resp = execute_command(
            Command::Del {
                key: "k".to_string(),
            },
            &store,
        );
        assert_eq!(del_resp, ":1\r\n");
    }

    #[test]
    fn ping_works() {
        let store = new_shared_store();
        let resp = execute_command(Command::Ping, &store);
        assert_eq!(resp, "+PONG\r\n");
    }

    #[test]
    fn ttl_and_exists_work() {
        let store = new_shared_store();

        let missing_exists = execute_command(
            Command::Exists {
                key: "ghost".to_string(),
            },
            &store,
        );
        let missing_ttl = execute_command(
            Command::Ttl {
                key: "ghost".to_string(),
            },
            &store,
        );
        assert_eq!(missing_exists, ":0\r\n");
        assert_eq!(missing_ttl, ":-2\r\n");

        let _ = execute_command(
            Command::Set {
                key: "k".to_string(),
                value: b"v".to_vec(),
                ex_seconds: Some(10),
            },
            &store,
        );

        let present_exists = execute_command(
            Command::Exists {
                key: "k".to_string(),
            },
            &store,
        );
        let present_ttl = execute_command(
            Command::Ttl {
                key: "k".to_string(),
            },
            &store,
        );
        assert_eq!(present_exists, ":1\r\n");
        assert!(present_ttl.starts_with(':'));
        assert_ne!(present_ttl, ":-1\r\n");
        assert_ne!(present_ttl, ":-2\r\n");
    }

    #[tokio::test]
    async fn socket_roundtrip_works() {
        let store = new_shared_store();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");

        let server_store = store.clone();
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            super::handle_client(stream, server_store)
                .await
                .expect("handle client");
        });

        let mut client = TcpStream::connect(addr).await.expect("connect");

        // Protocole texte classique (token sans espace)
        client
            .write_all(b"PING\nSET u alice\nEXISTS u\nTTL u\nGET u\n")
            .await
            .expect("write plain");

        // Framing binaire : valeur avec espace (11 octets = "hello world")
        client
            .write_all(b"SET msg $11\r\nhello world\r\nGET msg\n")
            .await
            .expect("write bulk");

        client.shutdown().await.expect("shutdown");

        let mut reader = BufReader::new(client);
        let mut all = String::new();
        reader.read_to_string(&mut all).await.expect("read");

        // Commandes texte
        assert!(all.contains("+PONG"));
        assert!(all.contains("+OK"));
        assert!(all.contains(":1"));
        assert!(all.contains("alice"));

        // Framing binaire
        assert!(
            all.contains("hello world"),
            "bulk framing: valeur avec espace introuvable dans: {all:?}"
        );

        server_task.await.expect("join");
    }
}
