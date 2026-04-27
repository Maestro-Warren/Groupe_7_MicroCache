use Groupe_7_MicroCache::server::{run_server, ServerOptions};

#[tokio::main]
async fn main() {
    if let Err(err) = run_server(ServerOptions::default()).await {
        eprintln!("microcache stopped with error: {err}");
    }
}
