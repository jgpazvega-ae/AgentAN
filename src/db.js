// Base de datos SQLite integrada en Node (node:sqlite). No requiere instalar
// ningún servidor de base de datos: todo queda en un archivo dentro de DATA_DIR.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'fletes.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Roles: superadmin (dueño, correo maestro), admin (personal de AN),
// driver (chofer) y client (cliente que sigue sus viajes).
const USERS_SQL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'driver', 'client')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  company TEXT
)`;

// Estados del viaje:
// asignado → en_recoleccion → cargado → en_ruta → en_destino → entregado → finalizado (o cancelado)
// "entregado": ya entregó y va de regreso; "finalizado": llegó a su domicilio o base.
const TRIPS_SQL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  client TEXT,
  cargo TEXT,
  notes TEXT,
  pickup_address TEXT NOT NULL,
  pickup_lat REAL,
  pickup_lng REAL,
  pickup_at TEXT NOT NULL,
  dest_address TEXT NOT NULL,
  dest_lat REAL,
  dest_lng REAL,
  delivery_at TEXT,
  status TEXT NOT NULL DEFAULT 'asignado'
    CHECK (status IN ('asignado', 'en_recoleccion', 'cargado', 'en_ruta', 'en_destino', 'entregado', 'finalizado', 'cancelado')),
  started_at TEXT,
  odo_start REAL,
  odo_start_photo TEXT,
  loaded_at TEXT,
  departed_at TEXT,
  finished_at TEXT,
  odo_end REAL,
  odo_end_photo TEXT,
  cancelled_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_id INTEGER REFERENCES users(id),
  arrived_at TEXT,
  received_by TEXT,
  -- Regreso a domicilio o base: odómetro final del recorrido completo.
  returned_at TEXT,
  odo_return REAL,
  odo_return_photo TEXT,
  -- Nivel de combustible del tablero (0 = vacío, 1 = lleno) al salir y al regresar.
  fuel_start REAL,
  fuel_start_photo TEXT,
  fuel_end REAL,
  fuel_end_photo TEXT
)`;

// Bases de datos creadas con la versión anterior: se reconstruyen las tablas
// cuyas reglas (CHECK) cambiaron, conservando todos los datos.
function tableSql(name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql || '';
}
function rebuildTable(name, createSql) {
  const oldCols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`DROP TABLE IF EXISTS ${name}_new`);
    db.exec(createSql(`${name}_new`));
    const newCols = db.prepare(`PRAGMA table_info(${name}_new)`).all().map((c) => c.name);
    const cols = oldCols.filter((c) => newCols.includes(c)).join(', ');
    db.exec(`INSERT INTO ${name}_new (${cols}) SELECT ${cols} FROM ${name}`);
    db.exec(`DROP TABLE ${name}`);
    db.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
if (tableSql('users') && !tableSql('users').includes('superadmin')) {
  rebuildTable('users', USERS_SQL);
  // El primer administrador (quien configuró la plataforma) pasa a ser el superadministrador.
  db.exec("UPDATE users SET role = 'superadmin' WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin')");
}
if (tableSql('trips') && !tableSql('trips').includes('entregado')) {
  rebuildTable('trips', TRIPS_SQL);
}

db.exec(`${USERS_SQL('users')};
${TRIPS_SQL('trips')};

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plate TEXT,
  fuel_type TEXT,
  last_odometer REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_trips_pickup ON trips(pickup_at);
CREATE INDEX IF NOT EXISTS idx_trips_client ON trips(client_id);

-- Fotos de cada etapa del viaje (el odómetro se guarda en la tabla trips):
-- carga (antes de salir a destino), llegada (al punto de entrega),
-- entrega (prueba de entrega) y firma (firma de quien recibe).
CREATE TABLE IF NOT EXISTS trip_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('carga', 'llegada', 'entrega', 'firma')),
  file TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trip_photos_trip ON trip_photos(trip_id);

CREATE TABLE IF NOT EXISTS trip_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  note TEXT,
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_trip ON trip_events(trip_id);

CREATE TABLE IF NOT EXISTS fuel_loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  liters REAL NOT NULL CHECK (liters > 0),
  amount REAL,
  odometer REAL,
  photo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_trip ON fuel_loads(trip_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recibos de pago a choferes: pago semanal por destajo o bono.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('semanal', 'bono')),
  year INTEGER,
  week INTEGER,
  period_start TEXT,
  period_end TEXT,
  amount REAL NOT NULL CHECK (amount >= 0),
  paid_at TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  description TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'emitido' CHECK (status IN ('emitido', 'cancelado')),
  acknowledged_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_driver ON payments(driver_id, year, week);

CREATE TABLE IF NOT EXISTS payment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  amount REAL
);
CREATE INDEX IF NOT EXISTS idx_payment_items_payment ON payment_items(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_items_trip ON payment_items(trip_id);

-- Solicitudes de cotización enviadas desde la página pública.
CREATE TABLE IF NOT EXISTS quote_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  email TEXT,
  origin TEXT,
  destination TEXT,
  service_date TEXT,
  cargo TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'nueva' CHECK (status IN ('nueva', 'atendida')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Columnas agregadas después de la primera versión (bases de datos existentes).
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('vehicles', 'tank_liters', 'REAL'); // capacidad del tanque, para convertir el nivel en litros
addColumn('quote_requests', 'service', 'TEXT');
addColumn('quote_requests', 'vehicle', 'TEXT');
addColumn('quote_requests', 'km', 'REAL');
addColumn('quote_requests', 'estimate', 'REAL');
addColumn('quote_requests', 'client_type', 'TEXT');
addColumn('quote_requests', 'payment_method', 'TEXT');
addColumn('quote_requests', 'total', 'REAL');
addColumn('quote_requests', 'list_price', 'REAL');

// Ayudantes cortos para no repetir prepare() en todos lados.
function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  );
}

module.exports = { db, get, all, run, transaction, getSetting, setSetting };
