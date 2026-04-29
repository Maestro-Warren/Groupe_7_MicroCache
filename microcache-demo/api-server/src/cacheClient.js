const net = require('net');

/**
 * Client TCP pour MicroCache (serveur Rust sur :6379)
 * Protocole : RESP (Redis Serialization Protocol)
 * 
 * Format des réponses MicroCache RESP:
 *   SET key value    → "+OK\r\n" (simple string)
 *   GET key (hit)    → "$5\r\nhello\r\n" (bulk string)
 *   GET key (miss)   → "$-1\r\n" (nil bulk string)
 *   EXISTS key       → ":1\r\n" ou ":0\r\n" (integer)
 *   DEL key          → ":1\r\n" (integer)
 *   TTL key          → ":N\r\n" (integer)
 *   PING             → "+PONG\r\n" (simple string)
 * 
 * Le parser RESP gère:
 * - Accumulation des données dans un buffer
 * - Parsing des bulk strings multi-lignes
 * - Distinction nil ($-1) vs hit ($N\r\nDATA\r\n)
 * - Queue de commandes (une seule à la fois)
 * - Timeouts et gestion d'erreurs
 * - Stats des hits/misses/errors
 */
class MicroCacheClient {
  constructor(host = '127.0.0.1', port = 6379, options = {}) {
    this.host = host;
    this.port = port;
    this.connectTimeout = options.connectTimeout || 2000;
    this.commandTimeout = options.commandTimeout || 500;

    this.socket = null;
    this.isConnecting = false;
    this.commandQueue = [];
    this.isProcessingCommand = false;

    // Statistiques
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      totalCommands: 0,
    };

    // Buffer de réponses en attente
    this.responseBuffer = '';
  }

  /**
   * Ouvre la connexion TCP. Idempotente.
   * Rejette après connectTimeout ms si impossible.
   */
  async connect() {
    // Si déjà connecté, résout immédiatement
    if (this.isConnected) {
      return Promise.resolve();
    }

    // Si déjà en cours de connexion, attend
    if (this.isConnecting) {
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (this.isConnected) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);

        setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Connect timeout'));
        }, this.connectTimeout);
      });
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.host,
        port: this.port,
        timeout: this.connectTimeout,
      });

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        this.isConnecting = false;
        reject(new Error(`Failed to connect to ${this.host}:${this.port} within ${this.connectTimeout}ms`));
      }, this.connectTimeout);

      socket.on('connect', () => {
        clearTimeout(connectTimeout);
        this.socket = socket;
        this.isConnecting = false;
        this.setupSocketListeners();
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(connectTimeout);
        this.isConnecting = false;
        reject(err);
      });
    });
  }

  /**
   * Configure les event listeners sur la socket
   * Parser RESP (Redis Serialization Protocol) :
   *   - Simple string: +OK\r\n
   *   - Error: -ERR\r\n
   *   - Integer: :1\r\n
   *   - Bulk string: $5\r\nhello\r\n
   *   - Nil bulk string: $-1\r\n
   */
  setupSocketListeners() {
    this.socket.setEncoding('utf8');

    this.socket.on('data', (chunk) => {
      this.responseBuffer += chunk;
      this.processResponses();
    });

    this.socket.on('close', () => {
      this.socket = null;
      this.rejectAllQueuedCommands('Socket closed unexpectedly');
    });

    this.socket.on('error', (err) => {
      this.socket = null;
      this.rejectAllQueuedCommands(`Socket error: ${err.message}`);
    });
  }

  /**
   * Parse et traite les réponses RESP du buffer
   */
  processResponses() {
    while (true) {
      const crlfIdx = this.responseBuffer.indexOf('\r\n');
      if (crlfIdx === -1) break; // Pas de réponse complète

      const line = this.responseBuffer.substring(0, crlfIdx);
      const prefix = line[0];

      // Bulk string: $N\r\nDATA\r\n
      if (prefix === '$') {
        const len = parseInt(line.substring(1), 10);

        // Nil bulk string: $-1\r\n
        if (len === -1) {
          this.responseBuffer = this.responseBuffer.substring(crlfIdx + 2);
          this.resolveNext(null); // null = miss
          continue;
        }

        // Vérifier que les données complètes sont présentes
        const dataStart = crlfIdx + 2;
        const dataEnd = dataStart + len;
        const termEnd = dataEnd + 2; // \r\n final
        if (this.responseBuffer.length < termEnd) break; // Attendre plus de données

        const value = this.responseBuffer.substring(dataStart, dataEnd);
        this.responseBuffer = this.responseBuffer.substring(termEnd);
        this.resolveNext(value); // Valeur réelle
        continue;
      }

      // Simple string: +OK\r\n
      if (prefix === '+') {
        this.responseBuffer = this.responseBuffer.substring(crlfIdx + 2);
        this.resolveNext(line.substring(1)); // "OK"
        continue;
      }

      // Integer: :1\r\n
      if (prefix === ':') {
        this.responseBuffer = this.responseBuffer.substring(crlfIdx + 2);
        this.resolveNext(line.substring(1)); // "1"
        continue;
      }

      // Error: -ERR\r\n
      if (prefix === '-') {
        this.responseBuffer = this.responseBuffer.substring(crlfIdx + 2);
        this.resolveNext(line); // "-ERR ..."
        continue;
      }

      // Type inconnu, ignorer
      this.responseBuffer = this.responseBuffer.substring(crlfIdx + 2);
      this.resolveNext(null);
    }
  }

  /**
   * Résout la prochaine commande en attente
   */
  resolveNext(value) {
    if (this.commandQueue.length > 0) {
      const pending = this.commandQueue.shift();
      this.isProcessingCommand = false;
      pending.resolve(value); // string ou null
      this.processNextCommand();
    }
  }

  /**
   * Traite la prochaine commande dans la queue
   */
  processNextCommand() {
    if (this.isProcessingCommand || this.commandQueue.length === 0 || !this.isConnected) {
      return;
    }

    this.isProcessingCommand = true;
    const pending = this.commandQueue[0];

    try {
      this.socket.write(pending.command + '\n');
    } catch (err) {
      this.commandQueue.shift();
      pending.reject(err);
      this.stats.errors++;
      this.isProcessingCommand = false;
      this.processNextCommand();
    }
  }

  /**
   * Enfile une commande et la traite
   */
  async enqueueCommand(command) {
    if (!this.isConnected) {
      this.stats.errors++;
      throw new Error('Not connected to MicroCache');
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        // Retirer de la queue si toujours là
        const idx = this.commandQueue.indexOf(pending);
        if (idx !== -1) {
          this.commandQueue.splice(idx, 1);
        }
        this.stats.errors++;
        reject(new Error('Command timeout'));
      }, this.commandTimeout);

      const pending = {
        command,
        resolve: (response) => {
          clearTimeout(timeoutHandle);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeoutHandle);
          reject(err);
        },
      };

      this.commandQueue.push(pending);
      this.processNextCommand();
    });
  }

  /**
   * Rejette toutes les commandes en attente
   */
  rejectAllQueuedCommands(reason) {
    const error = new Error(reason);
    while (this.commandQueue.length > 0) {
      const pending = this.commandQueue.shift();
      pending.reject(error);
      this.stats.errors++;
    }
    this.isProcessingCommand = false;
  }

  /**
   * PING → attend PONG (simple string: +PONG\r\n)
   */
  async ping() {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand('PING');
      return response === 'PONG';
    } catch (err) {
      return false;
    }
  }

  /**
   * GET key → retourne la valeur ou null
   * Réponse RESP: 
   *   - Clé présente: $5\r\nhello\r\n → resolve('hello')
   *   - Clé absente:  $-1\r\n → resolve(null)
   */
  async get(key) {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand(`GET ${key}`);

      console.log('[CACHE DEBUG] GET response raw:', JSON.stringify(response));

      // response === null → nil bulk string → MISS
      if (response === null) {
        this.stats.misses++;
        return null;
      }

      // response === string → HIT
      this.stats.hits++;
      return response; // Valeur réelle ex: "2153"
    } catch (err) {
      throw err;
    }
  }

  /**
   * SET key value [EX ttlSeconds] → OK
   * Réponse RESP: +OK\r\n → resolve('OK')
   */
  async set(key, value, ttlSeconds = null) {
    try {
      this.stats.totalCommands++;

      const command = ttlSeconds
        ? `SET ${key} ${value} EX ${ttlSeconds}`
        : `SET ${key} ${value}`;

      console.log('[CACHE DEBUG] Sending:', JSON.stringify(command));

      const response = await this.enqueueCommand(command);
      console.log('[CACHE DEBUG] SET response raw:', JSON.stringify(response));

      return response === 'OK';
    } catch (err) {
      throw err;
    }
  }

  /**
   * DEL key → nombre de clés supprimées
   * Réponse RESP: :1\r\n → resolve('1')
   */
  async del(key) {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand(`DEL ${key}`);
      return response === '1';
    } catch (err) {
      throw err;
    }
  }

  /**
   * EXISTS key → 1 si existe, 0 sinon
   * Réponse RESP: :1\r\n ou :0\r\n
   */
  async exists(key) {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand(`EXISTS ${key}`);
      return response === '1';
    } catch (err) {
      throw err;
    }
  }

  /**
   * TTL key
   * Réponse : "secondes\n" ou "-1\n"
   */
  async ttl(key) {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand(`TTL ${key}`);
      const seconds = parseInt(response, 10);
      return Number.isNaN(seconds) ? -1 : seconds;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Ferme la socket (synchrone)
   */
  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.isConnecting = false;
    this.isProcessingCommand = false;
    this.commandQueue = [];
    this.responseBuffer = '';
  }

  /**
   * Propriété : connecté ?
   */
  get isConnected() {
    return this.socket !== null && !this.socket.destroyed;
  }
}

module.exports = { MicroCacheClient };
