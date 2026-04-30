const net = require('net');

/**
 * Client TCP pour MicroCache (serveur Rust sur :6379)
 * Protocole textuel simple : commandes et réponses terminées par \n
 * 
 * Réponses MicroCache :
 *   SET key value    → "OK\n"
 *   GET key          → "valeur\n" ou "NIL\n"
 *   EXISTS key       → "1\n" ou "0\n"
 *   DEL key          → "OK\n"
 *   TTL key          → "secondes\n" ou "-1\n"
 * 
 * Géré de manière robuste :
 * - Queue de commandes (une seule à la fois)
 * - Timeouts sur chaque commande
 * - Stats des hits/misses/errors
 * - Idempotence du connect()
 * - Fermeture propre de la socket
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
   * Parser simple : découpage sur \n
   */
  setupSocketListeners() {
    this.socket.setEncoding('utf8');

    this.socket.on('data', (chunk) => {
      this.responseBuffer += chunk;

      // Découper sur \n (pas \r\n)
      const lines = this.responseBuffer.split('\n');
      // La dernière entrée est soit vide soit un fragment incomplet
      this.responseBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim(); // retire \r résiduel et espaces
        if (line === '') continue;

        if (this.commandQueue.length > 0) {
          const pending = this.commandQueue.shift();
          this.isProcessingCommand = false;
          pending.resolve(line); // résout avec la ligne brute trimée
          this.processNextCommand();
        }
      }
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
   * Si non connecté, tente une reconnexion silencieuse avant d'échouer.
   */
  async enqueueCommand(command) {
    if (!this.isConnected) {
      try {
        await this.connect();
      } catch (_) {
        // reconnect failed — fall through to throw below
      }
    }
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
   * Envoie PING → attend PONG
   */
  async ping() {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand('PING');
      return response.includes('PONG');
    } catch (err) {
      return false;
    }
  }

  /**
   * GET key → retourne la valeur ou null
   * Réponse : "valeur\r\n" ou "NIL\r\n"
   */
  async get(key) {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand(`GET ${key}`);

      console.log('[CACHE DEBUG] GET response raw:', JSON.stringify(response));

      if (response === 'NIL' || response === '') {
        this.stats.misses++;
        return null;
      }

      this.stats.hits++;
      return response; // string brute ex: "2153"
    } catch (err) {
      throw err;
    }
  }

  /**
   * SET key value [EX ttlSeconds]
   * Réponse : "OK\n"
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

      return response.includes('OK');
    } catch (err) {
      throw err;
    }
  }

  /**
   * DEL key
   * Réponse : "OK\r\n"
   */
  async del(key) {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand(`DEL ${key}`);
      return response.includes('OK');
    } catch (err) {
      throw err;
    }
  }

  /**
   * EXISTS key
   * Réponse : "1\n" ou "0\n"
   */
  async exists(key) {
    try {
      this.stats.totalCommands++;
      const response = await this.enqueueCommand(`EXISTS ${key}`);
      return response.includes('1');
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
