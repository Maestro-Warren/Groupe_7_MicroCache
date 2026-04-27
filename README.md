# Groupe_7_MicroCache

MicroCache est un serveur clé/valeur en mémoire, multi-connexions, avec TTL, thread de nettoyage d'expiration, parser de protocole textuel, persistance snapshot, et gestion de signaux Unix.

## Fonctionnalités

- Store en mémoire thread-safe basé sur Arc<RwLock<Store>>.
- Opérations cœur: set, get, delete, exists, ttl, keys.
- TTL optionnel par clé et thread de reaper en arrière-plan.
- Serveur TCP asynchrone Tokio avec une tâche par connexion.
- Parser de commandes textuelles inspiré de Redis.
- Persistance périodique binaire via serde + bincode.
- Signaux Unix:
	- SIGUSR1: snapshot manuel immédiat.
	- SIGHUP: rechargement de configuration.

## Lancer le serveur

```bash
cargo run
```

Adresse par défaut: 127.0.0.1:6379

## Protocole (ligne par ligne)

Chaque commande est envoyée sur une ligne et terminée par un retour chariot/nouvelle ligne.

- PING
- SET key value
- SET key value EX seconds
- GET key
- DEL key
- EXISTS key
- TTL key
- KEYS pattern

Exemple netcat:

```bash
nc 127.0.0.1 6379
PING
SET user42 alice EX 10
GET user42
EXISTS user42
TTL user42
KEYS user*
DEL user42
```

## Configuration

Le serveur lit facultativement le fichier microcache.toml au démarrage.

Exemple:

```toml
bind_addr = "127.0.0.1:6379"
snapshot_path = "microcache.snapshot"
snapshot_interval_secs = 30
```

Si le fichier est absent, la configuration par défaut est utilisée.

## Tests

```bash
cargo test
```

La suite couvre le store, le parser, le reaper, la persistance, et l'exécution des commandes serveur.