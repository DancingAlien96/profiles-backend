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
  hours                TEXT,
  services             TEXT NOT NULL DEFAULT '[]',
  photo                BLOB,
  photo_type           TEXT,
  photo_updated_at     TEXT,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  published            INTEGER NOT NULL DEFAULT 1,
  edits_day            TEXT,
  edits_count          INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_published ON profiles(published);

-- Invitaciones para que el cliente cree su propio perfil.
-- Un solo uso y con caducidad: si no, quien reenvie el enlace podria dar de
-- alta perfiles en el dominio sin control.
-- La columna slug fija de antemano la direccion de la pagina. Se usa cuando la
-- tarjeta NFC o el QR ya estan impresos: la URL queda decidida antes de que el
-- cliente llene nada, y el formulario no le deja cambiarla.
CREATE TABLE IF NOT EXISTS invitations (
  token        TEXT PRIMARY KEY,
  nota         TEXT NOT NULL DEFAULT '',
  plantilla    TEXT,
  slug         TEXT,
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

  // WAL permite leer mientras se escribe: una visita puede pedir la tarjeta
  // justo mientras su dueño la guarda, sin que ninguna de las dos espere.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Si dos escrituras coinciden, esperar en vez de fallar de inmediato.
  db.pragma('busy_timeout = 5000');

  db.exec(ESQUEMA);
  migrar(db);

  if (ruta !== ':memory:') {
    console.log(`[db] base abierta en ${path.resolve(ruta)}`);
  }
  return db;
}

/**
 * Cambios de esquema sobre bases que ya existen.
 *
 * `CREATE TABLE IF NOT EXISTS` no altera una tabla ya creada, asi que las
 * columnas nuevas hay que añadirlas aparte. Se comprueba antes de tocar nada,
 * de modo que arrancar es idempotente.
 */
function migrar(db) {
  const columnas = (tabla) => db.pragma(`table_info(${tabla})`).map((c) => c.name);

  if (!columnas('invitations').includes('slug')) {
    db.exec('ALTER TABLE invitations ADD COLUMN slug TEXT');
    console.log('[db] migracion: invitations.slug');
  }

  if (!columnas('profiles').includes('hours')) {
    db.exec('ALTER TABLE profiles ADD COLUMN hours TEXT');
    console.log('[db] migracion: profiles.hours');
  }

  if (!columnas('profiles').includes('services')) {
    db.exec("ALTER TABLE profiles ADD COLUMN services TEXT NOT NULL DEFAULT '[]'");
    console.log('[db] migracion: profiles.services');
  }

  if (!columnas('profiles').includes('edits_day')) {
    db.exec('ALTER TABLE profiles ADD COLUMN edits_day TEXT');
    db.exec('ALTER TABLE profiles ADD COLUMN edits_count INTEGER NOT NULL DEFAULT 0');
    console.log('[db] migracion: profiles.edits_day, profiles.edits_count');
  }

  // La tabla meta solo llevaba la cuenta de los deploys de Netlify. Sirviendo
  // el sitio desde el VPS no hay nada que publicar, y nadie la lee ya.
  const existeMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (existeMeta) {
    db.exec('DROP TABLE meta');
    console.log('[db] migracion: eliminada la tabla meta (deploys de Netlify)');
  }
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
