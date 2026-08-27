import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

let db = null;

/**
 * Esquema. Los enlaces van como JSON en una columna porque siempre se leen y
 * se escriben completos, junto con el perfil: una tabla aparte solo añadiria
 * un join sin ganar nada.
 *
 * Las fechas se guardan como texto ISO 8601, que en SQLite ordena y compara
 * correctamente por ser lexicograficamente monotono.
 */
const ESQUEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  slug                 TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT '',
  tagline              TEXT NOT NULL DEFAULT '',
  footer               TEXT NOT NULL DEFAULT '',
  theme                TEXT NOT NULL DEFAULT 'oro-tech',
  links                TEXT NOT NULL DEFAULT '[]',
  photo                BLOB,
  photo_type           TEXT,
  photo_updated_at     TEXT,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  published            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_published ON profiles(published);

-- Invitaciones para que el cliente cree su propio perfil.
-- Un solo uso y con caducidad: si no, quien reenvie el enlace podria dar de
-- alta perfiles en el dominio sin control.
CREATE TABLE IF NOT EXISTS invitations (
  token        TEXT PRIMARY KEY,
  nota         TEXT NOT NULL DEFAULT '',
  plantilla    TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  used_by_slug TEXT
);

CREATE INDEX IF NOT EXISTS idx_invitations_used ON invitations(used_at);
`;

/**
 * Abre la base y prepara el esquema.
 * Ruta por defecto: ./data/perfiles.db (en el VPS, /var/lib/perfiles-api).
 */
export function conectarDB(ruta = process.env.DB_PATH || './data/perfiles.db') {
  if (db) return db;

  if (ruta !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(ruta)), { recursive: true });
  }

  db = new Database(ruta);

  // WAL permite leer mientras se escribe: el build del frontend puede pedir
  // los perfiles justo mientras un cliente guarda, sin bloquearse.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Si dos escrituras coinciden, esperar en vez de fallar de inmediato.
  db.pragma('busy_timeout = 5000');

  db.exec(ESQUEMA);

  if (ruta !== ':memory:') {
    console.log(`[db] base abierta en ${path.resolve(ruta)}`);
  }
  return db;
}

export function obtenerDB() {
  if (!db) throw new Error('La base no esta abierta. Llama a conectarDB() primero.');
  return db;
}

export function cerrarDB() {
  if (db) {
    db.close();
    db = null;
  }
}
