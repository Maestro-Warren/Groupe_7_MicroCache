//! Point d'entrée du binaire **MicroCache**.
//!
//! Démarre le serveur TCP avec les options par défaut (port 6379, config `microcache.toml`).
//! En cas d'erreur fatale, le message est affiché sur stderr et le processus se termine.

use Groupe_7_MicroCache::server::{run_server, ServerOptions};

/// Lance le serveur MicroCache avec la configuration par défaut.
/// Lit `microcache.toml` s'il existe, sinon utilise les valeurs intégrées.
#[tokio::main]
async fn main() {
    if let Err(err) = run_server(ServerOptions::default()).await {
        eprintln!("microcache stopped with error: {err}");
    }
}
