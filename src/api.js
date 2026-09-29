// API JSON que usan las páginas del administrador y del chofer.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { get, all, run, transaction } = require('./db');
const auth = require('./auth');
const notify = require('./notify');
const site = require('./site');
const eta = require('./eta');
const { HttpError, bad, h, str, num, nowLocal } = require('./http');

const router = express.Router();

// Fecha y hora local en formato "AAAA-MM-DDTHH:MM" (lo que produce <input type="datetime-local">).
function localDateTime(value, field, required) {
  const s = str(value, 32);
  if (!s) {
    if (required) throw bad(`Falta ${field}.`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw bad(`La ${field} no es válida.`);
  return s.slice(0, 16);
}

// ---------- Fotos ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (_req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(bad('El archivo debe ser una foto.'));
  },
});

// ¿Algún viaje sigue usando este archivo? (la ida y el regreso comparten la foto del odómetro)
function fileInUse(file) {
  return Boolean(
    get(
      `SELECT 1 FROM trips WHERE ? IN (odo_start_photo, odo_end_photo, odo_return_photo, fuel_start_photo, fuel_end_photo)
       UNION SELECT 1 FROM trip_photos WHERE file = ? UNION SELECT 1 FROM fuel_loads WHERE photo = ?
       UNION SELECT 1 FROM trip_pauses WHERE ? IN (pause_photo, resume_photo) LIMIT 1`,
      file, file, file, file
    )
  );
}

function removeUpload(file) {
  if (file) fs.rm(path.join(config.uploadsDir, path.basename(file)), { force: true }, () => {});
}

// ---------- Consultas de viajes ----------
const TRIP_SELECT = `
  SELECT t.*,
         d.name AS driver_name, d.email AS driver_email, d.phone AS driver_phone,
         v.name AS vehicle_name, v.plate AS vehicle_plate, v.last_odometer AS vehicle_last_odometer,
         v.tank_liters AS vehicle_tank_liters,
         c.name AS client_name, c.email AS client_email, c.company AS client_company,
         (SELECT COALESCE(SUM(f.liters), 0) FROM fuel_loads f WHERE f.trip_id = t.id) AS fuel_liters,
         (SELECT COALESCE(SUM(f.amount), 0) FROM fuel_loads f WHERE f.trip_id = t.id) AS fuel_amount,
         (SELECT r.id FROM trips r WHERE r.parent_trip_id = t.id AND r.status <> 'cancelado' ORDER BY r.id DESC LIMIT 1) AS return_trip_id,
         (SELECT p.status FROM trips p WHERE p.id = t.parent_trip_id) AS parent_status,
         (SELECT json_object('lat', l.lat, 'lng', l.lng, 'at', l.recorded_at, 'accuracy', l.accuracy)
            FROM trip_locations l WHERE l.trip_id = t.id ORDER BY l.id DESC LIMIT 1) AS last_location
    FROM trips t
    LEFT JOIN users d ON d.id = t.driver_id
    LEFT JOIN users c ON c.id = t.client_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id`;

// Cada cuántos minutos se registra la ubicación del chofer (0 = apagado).
function trackingMinutes() {
  const n = Number(site.getSite().tracking_minutes);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : 5;
}

// Página de inicio según el perfil.
function homePage(role) {
  return { superadmin: '/admin.html', admin: '/admin.html', driver: '/chofer.html', client: '/cliente.html' }[role] || '/';
}

// Lo que el cliente puede ver de su viaje (sin odómetro, combustible ni notas internas).
const CLIENT_TRIP_FIELDS = [
  'id', 'name', 'status', 'client', 'cargo', 'pickup_address', 'pickup_lat', 'pickup_lng', 'pickup_at',
  'prepickup_address', 'prepickup_lat', 'prepickup_lng', 'prepickup_at',
  'dest_address', 'dest_lat', 'dest_lng', 'delivery_at', 'started_at', 'loaded_at', 'departed_at',
  'arrived_at', 'finished_at', 'cancelled_at', 'received_by', 'driver_name', 'vehicle_name', 'vehicle_plate',
  'route_km', 'route_minutes', 'eta_at', 'eta_live_at', 'eta', 'paused', 'pause_until', 'at_pickup_at',
];
function forClient(trip) {
  const out = Object.fromEntries(CLIENT_TRIP_FIELDS.map((k) => [k, trip[k] ?? null]));
  // Para el cliente el envío termina al entregarse; el regreso del chofer a su base es interno.
  if (out.status === 'entregado') out.status = 'finalizado';
  return out;
}

// Trazabilidad de km y combustible:
// - km_delivery: de la salida a la entrega (odómetro al entregar − inicial).
// - km: recorrido completo (odómetro al regresar − inicial; si aún no regresa, hasta la entrega).
// - fuel_used: litros cargados + lo que bajó la aguja del tablero (nivel inicial − final) × tanque.
function withMetrics(trip) {
  if (!trip) return trip;
  trip.pauses = all('SELECT * FROM trip_pauses WHERE trip_id = ? ORDER BY id', trip.id);
  if (typeof trip.last_location === 'string') trip.last_location = JSON.parse(trip.last_location);
  const diff = (a, b) => (a != null && b != null ? a - b : null);
  trip.km_delivery = diff(trip.odo_end, trip.odo_start);
  trip.km_return = diff(trip.odo_return, trip.odo_end);
  trip.km = diff(trip.odo_return ?? trip.odo_end, trip.odo_start);
  const tank = trip.vehicle_tank_liters;
  trip.fuel_level_liters =
    trip.fuel_start != null && trip.fuel_end != null && tank > 0 ? Math.round((trip.fuel_start - trip.fuel_end) * tank * 10) / 10 : null;
  const used = (trip.fuel_liters || 0) + (trip.fuel_level_liters || 0);
  trip.fuel_used = used > 0 ? Math.round(used * 10) / 10 : null;
  trip.km_per_liter = trip.km != null && trip.fuel_used ? trip.km / trip.fuel_used : null;
  trip.liters_per_100km = trip.km && trip.fuel_used ? (trip.fuel_used / trip.km) * 100 : null;
  return eta.withEta(trip);
}

function loadTrip(id) {
  return withMetrics(get(`${TRIP_SELECT} WHERE t.id = ?`, id));
}

// El personal ve todos los viajes; el chofer, los que tiene asignados;
// el cliente, los que son suyos.
function canSeeTrip(user, trip) {
  if (auth.isStaff(user)) return true;
  if (user.role === 'driver') return trip.driver_id === user.id;
  if (user.role === 'client') return trip.client_id === user.id;
  return false;
}
function tripForUser(req) {
  const trip = loadTrip(Number(req.params.id));
  if (!trip || !canSeeTrip(req.user, trip)) throw new HttpError(404, 'El viaje no existe.');
  return trip;
}

function tripPhotos(tripId) {
  return all(
    `SELECT p.id, p.kind, p.file, p.lat, p.lng, p.created_at, u.name AS user_name
       FROM trip_photos p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.trip_id = ? ORDER BY p.id`,
    tripId
  );
}

function addEvent(tripId, userId, type, note, body = {}) {
  run(
    'INSERT INTO trip_events (trip_id, user_id, type, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
    tripId,
    userId,
    type,
    note || null,
    num(body.lat),
    num(body.lng)
  );
}

// ---------- Configuración pública y sesión ----------
router.get(
  '/config',
  h((req, res) => {
    const users = get('SELECT COUNT(*) AS n FROM users').n;
    res.json({
      companyName: site.getSite().name,
      googleMapsApiKey: config.googleMapsApiKey,
      vapidPublicKey: notify.vapidPublicKey(),
      emailEnabled: notify.emailEnabled(),
      trackingMinutes: trackingMinutes(),
      needsSetup: users === 0,
    });
  })
);

// Primer arranque: crea la cuenta del superadministrador (solo si no hay usuarios).
router.post(
  '/setup',
  h((req, res) => {
    const name = str(req.body.name, 100);
    const email = str(req.body.email, 200);
    const password = String(req.body.password || '');
    if (!name || !email) throw bad('Escribe tu nombre y correo.');
    if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres.');
    const id = transaction(() => {
      if (get('SELECT COUNT(*) AS n FROM users').n > 0) throw new HttpError(403, 'La cuenta de administrador ya existe.');
      return run(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'superadmin')",
        name,
        email.toLowerCase(),
        auth.hashPassword(password)
      ).lastInsertRowid;
    });
    auth.createSession(res, Number(id));
    res.json({ ok: true, role: 'superadmin', home: homePage('superadmin') });
  })
);

router.post(
  '/login',
  auth.loginRateLimit,
  h((req, res) => {
    const email = str(req.body.email, 200);
    const password = String(req.body.password || '');
    const user = email && get('SELECT * FROM users WHERE email = ?', email.toLowerCase());
    if (!user || !user.active || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Correo o contraseña incorrectos.');
    }
    auth.createSession(res, user.id);
    res.json({ ok: true, role: user.role, home: homePage(user.role) });
  })
);

router.post(
  '/logout',
  h((req, res) => {
    auth.destroySession(req, res);
    res.json({ ok: true });
  })
);

router.get('/me', auth.requireUser, (req, res) => res.json({ ...req.user, home: homePage(req.user.role) }));

router.post(
  '/me/password',
  auth.requireUser,
  h((req, res) => {
    const user = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!auth.verifyPassword(String(req.body.current || ''), user.password_hash)) {
      throw bad('La contraseña actual no es correcta.');
    }
    const next = String(req.body.password || '');
    if (next.length < 8) throw bad('La nueva contraseña debe tener al menos 8 caracteres.');
    run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(next), req.user.id);
    res.json({ ok: true });
  })
);

// ---------- Notificaciones push ----------
router.post(
  '/push/subscribe',
  auth.requireUser,
  h((req, res) => {
    const sub = req.body.subscription || {};
    const endpoint = str(sub.endpoint, 1000);
    if (!endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw bad('Suscripción no válida.');
    run(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      req.user.id,
      endpoint,
      String(sub.keys.p256dh),
      String(sub.keys.auth)
    );
    res.json({ ok: true });
  })
);

router.post(
  '/push/unsubscribe',
  auth.requireUser,
  h((req, res) => {
    run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(req.body.endpoint || ''), req.user.id);
    res.json({ ok: true });
  })
);

router.post(
  '/push/test',
  auth.requireUser,
  h(async (req, res) => {
    const sent = await notify.sendPush(req.user.id, {
      title: 'Notificaciones activadas',
      body: req.user.role === 'client' ? 'Así te avisaremos del avance de tus envíos.' : 'Así te avisaremos de los viajes.',
      url: homePage(req.user.role),
    });
    res.json({ ok: true, devices: sent });
  })
);

// ---------- Usuarios: superadministrador, personal de AN, choferes y clientes ----------
// - El superadministrador (dueño) se crea en la configuración inicial y no se
//   puede desactivar ni cambiar de perfil.
// - Solo el superadministrador da de alta o modifica al personal de AN.
// - El personal de AN da de alta y modifica choferes y clientes.
const ROLES = ['admin', 'driver', 'client'];
const ROLE_LABEL = { superadmin: 'Superadministrador', admin: 'Personal de AN', driver: 'Chofer', client: 'Cliente' };

function assertCanManage(actor, targetRole) {
  if (targetRole === 'superadmin') throw new HttpError(403, 'El superadministrador solo se puede modificar a sí mismo.');
  if (targetRole === 'admin' && actor.role !== 'superadmin') {
    throw new HttpError(403, 'Solo el superadministrador puede dar de alta o modificar al personal de AN.');
  }
}

router.get(
  '/users',
  auth.requireAdmin,
  h((req, res) => {
    res.json(
      all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.company, u.active, u.notify_email, u.created_at,
                  (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS push_devices,
                  (SELECT COUNT(*) FROM trips t WHERE (t.driver_id = u.id OR t.client_id = u.id)
                      AND t.status IN ('asignado','en_recoleccion','cargado','en_ruta','en_destino','entregado')) AS open_trips
             FROM users u
            ORDER BY u.active DESC, CASE u.role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 WHEN 'driver' THEN 2 ELSE 3 END, u.name`)
    );
  })
);

router.post(
  '/users',
  auth.requireAdmin,
  h(async (req, res) => {
    const name = str(req.body.name, 100);
    const email = str(req.body.email, 200)?.toLowerCase();
    const phone = str(req.body.phone, 40);
    const role = ROLES.includes(req.body.role) ? req.body.role : 'driver';
    assertCanManage(req.user, role);
    const company = role === 'client' ? str(req.body.company, 150) : null;
    const notifyEmail = req.body.notify_email === undefined || req.body.notify_email ? 1 : 0;
    const password = String(req.body.password || '');
    if (!name || !email) throw bad('Nombre y correo son obligatorios.');
    if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres.');
    if (get('SELECT id FROM users WHERE email = ?', email)) throw bad('Ya existe un usuario con ese correo.');
    const id = Number(
      run(
        'INSERT INTO users (name, email, phone, password_hash, role, company, notify_email) VALUES (?, ?, ?, ?, ?, ?, ?)',
        name,
        email,
        phone,
        auth.hashPassword(password),
        role,
        company,
        notifyEmail
      ).lastInsertRowid
    );
    if (req.body.sendWelcome) {
      const what = role === 'client' ? 'para dar seguimiento a tus envíos' : 'a la plataforma de viajes';
      notify
        .sendEmail({
          to: email,
          subject: `Tu acceso a ${site.getSite().name}`,
          text: `Hola ${name},\n\nYa tienes acceso ${what} de ${site.getSite().name} (${ROLE_LABEL[role]}).\n\nEntra en: ${config.appUrl}/login.html\nCorreo: ${email}\nContraseña: ${password}\n\nTe recomendamos cambiar tu contraseña al entrar y activar las notificaciones.\n`,
        })
        .catch((err) => console.error('No se pudo enviar el correo de bienvenida:', err.message));
    }
    res.status(201).json({ id });
  })
);

router.put(
  '/users/:id',
  auth.requireAdmin,
  h((req, res) => {
    const id = Number(req.params.id);
    const user = get('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw new HttpError(404, 'El usuario no existe.');
    const self = id === req.user.id;
    if (!self) assertCanManage(req.user, user.role);
    const name = str(req.body.name, 100) || user.name;
    const email = (str(req.body.email, 200) || user.email).toLowerCase();
    const phone = req.body.phone !== undefined ? str(req.body.phone, 40) : user.phone;
    let role = user.role;
    if (req.body.role && req.body.role !== user.role) {
      if (self) throw bad('No puedes cambiar tu propio perfil.');
      if (!ROLES.includes(req.body.role)) throw bad('Perfil no válido.');
      assertCanManage(req.user, req.body.role);
      role = req.body.role;
    }
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : user.active;
    if (self && !active) throw bad('No puedes desactivar tu propia cuenta.');
    const company = role === 'client' ? (req.body.company !== undefined ? str(req.body.company, 150) : user.company) : null;
    const notifyEmail = req.body.notify_email !== undefined ? (req.body.notify_email ? 1 : 0) : user.notify_email;
    const clash = get('SELECT id FROM users WHERE email = ? AND id <> ?', email, id);
    if (clash) throw bad('Ya existe un usuario con ese correo.');
    run(
      'UPDATE users SET name = ?, email = ?, phone = ?, role = ?, active = ?, company = ?, notify_email = ? WHERE id = ?',
      name,
      email,
      phone,
      role,
      active,
      company,
      notifyEmail,
      id
    );
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw bad('La contraseña debe tener al menos 8 caracteres.');
      run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(String(req.body.password)), id);
      run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (!active) run('DELETE FROM sessions WHERE user_id = ?', id);
    res.json({ ok: true });
  })
);

// ---------- Vehículos ----------
router.get(
  '/vehicles',
  auth.requireUser,
  h((req, res) => {
    res.json(all('SELECT * FROM vehicles ORDER BY active DESC, name'));
  })
);

router.post(
  '/vehicles',
  auth.requireAdmin,
  h((req, res) => {
    const name = str(req.body.name, 100);
    if (!name) throw bad('Escribe un nombre para el vehículo.');
    const id = run(
      'INSERT INTO vehicles (name, plate, fuel_type, last_odometer, tank_liters) VALUES (?, ?, ?, ?, ?)',
      name,
      str(req.body.plate, 20),
      str(req.body.fuel_type, 20),
      num(req.body.last_odometer),
      num(req.body.tank_liters)
    ).lastInsertRowid;
    res.status(201).json({ id: Number(id) });
  })
);

router.put(
  '/vehicles/:id',
  auth.requireAdmin,
  h((req, res) => {
    const v = get('SELECT * FROM vehicles WHERE id = ?', Number(req.params.id));
    if (!v) throw new HttpError(404, 'El vehículo no existe.');
    run(
      'UPDATE vehicles SET name = ?, plate = ?, fuel_type = ?, last_odometer = ?, tank_liters = ?, active = ? WHERE id = ?',
      str(req.body.name, 100) || v.name,
      req.body.plate !== undefined ? str(req.body.plate, 20) : v.plate,
      req.body.fuel_type !== undefined ? str(req.body.fuel_type, 20) : v.fuel_type,
      req.body.last_odometer !== undefined ? num(req.body.last_odometer) : v.last_odometer,
      req.body.tank_liters !== undefined ? num(req.body.tank_liters) : v.tank_liters,
      req.body.active !== undefined ? (req.body.active ? 1 : 0) : v.active,
      v.id
    );
    res.json({ ok: true });
  })
);

// ---------- Viajes ----------
// Abiertos para el personal y el chofer ("entregado" = va de regreso a su base).
const OPEN = ['asignado', 'en_recoleccion', 'cargado', 'en_ruta', 'en_destino', 'entregado'];
const CANCELABLE = ['asignado', 'en_recoleccion', 'cargado', 'en_ruta', 'en_destino'];

router.get(
  '/trips',
  auth.requireUser,
  h((req, res) => {
    const where = [];
    const params = [];
    if (req.user.role === 'driver') {
      where.push('t.driver_id = ?');
      params.push(req.user.id);
    } else if (req.user.role === 'client') {
      where.push('t.client_id = ?');
      params.push(req.user.id);
    } else if (!auth.isStaff(req.user)) {
      throw new HttpError(403, 'Sin acceso.');
    } else {
      if (req.query.driver_id) where.push('t.driver_id = ?'), params.push(Number(req.query.driver_id));
      if (req.query.client_id) where.push('t.client_id = ?'), params.push(Number(req.query.client_id));
    }
    if (req.query.scope === 'open') where.push(`t.status IN (${OPEN.map(() => '?').join(',')})`), params.push(...OPEN);
    if (req.query.scope === 'closed') where.push("t.status IN ('finalizado','cancelado')");
    if (req.query.status) where.push('t.status = ?'), params.push(String(req.query.status));
    if (req.query.vehicle_id) where.push('t.vehicle_id = ?'), params.push(Number(req.query.vehicle_id));
    if (req.query.from) where.push('t.pickup_at >= ?'), params.push(String(req.query.from));
    if (req.query.to) where.push('t.pickup_at <= ?'), params.push(`${req.query.to}T23:59`);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const order = req.query.scope === 'closed' ? 'COALESCE(t.finished_at, t.cancelled_at, t.pickup_at) DESC' : 't.pickup_at ASC';
    const rows = all(
      `${TRIP_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${limit}`,
      ...params
    );
    if (req.user.role === 'client') {
      return res.json(rows.map((t) => ({ ...forClient(t), photos: tripPhotos(t.id) })));
    }
    res.json(rows.map(withMetrics));
  })
);

router.get(
  '/trips/:id',
  auth.requireUser,
  h((req, res) => {
    const trip = tripForUser(req);
    if (req.user.role === 'client') return res.json({ ...forClient(trip), photos: tripPhotos(trip.id) });
    trip.photos = tripPhotos(trip.id);
    trip.events = all(
      `SELECT e.*, u.name AS user_name FROM trip_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.trip_id = ? ORDER BY e.id`,
      trip.id
    );
    trip.fuel = all(
      `SELECT f.*, u.name AS user_name FROM fuel_loads f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.trip_id = ? ORDER BY f.id`,
      trip.id
    );
    res.json(trip);
  })
);

// Lista de correos separados por coma, punto y coma o renglón (máximo 5).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function readEmailList(value) {
  const list = [...new Set(String(value || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const invalid = list.find((e) => !EMAIL_RE.test(e) || e.length > 200);
  if (invalid) throw bad(`El correo "${invalid}" no es válido.`);
  if (list.length > 5) throw bad('Puedes agregar hasta 5 correos para avisos.');
  return list.length ? list.join(', ') : null;
}

function readTripFields(body) {
  const fields = {
    name: str(body.name, 150),
    driver_id: num(body.driver_id),
    vehicle_id: num(body.vehicle_id),
    client: str(body.client, 200),
    cargo: str(body.cargo, 500),
    notes: str(body.notes, 2000),
    pickup_address: str(body.pickup_address, 500),
    pickup_lat: num(body.pickup_lat),
    pickup_lng: num(body.pickup_lng),
    pickup_at: localDateTime(body.pickup_at, 'fecha y hora de inicio', true),
    dest_address: str(body.dest_address, 500),
    dest_lat: num(body.dest_lat),
    dest_lng: num(body.dest_lng),
    delivery_at: localDateTime(body.delivery_at, 'fecha de entrega', false),
    client_id: num(body.client_id),
    notify_emails: readEmailList(body.notify_emails),
    prepickup_address: null,
    prepickup_lat: null,
    prepickup_lng: null,
    prepickup_at: null,
    route_km: num(body.route_km),
    route_minutes: num(body.route_minutes),
    route_source: ['google', 'manual', 'estimado'].includes(body.route_source) ? body.route_source : null,
    overnight_nights: Math.max(0, Math.min(30, Math.round(num(body.overnight_nights) || 0))),
    lodging_notes: str(body.lodging_notes, 500),
  };
  if (!fields.pickup_address) throw bad('Indica el punto de inicio.');
  if (!fields.dest_address) throw bad('Indica el destino final.');
  if (!fields.driver_id) throw bad('Selecciona el chofer.');
  const driver = get("SELECT id FROM users WHERE id = ? AND active = 1 AND role <> 'client'", fields.driver_id);
  if (!driver) throw bad('El chofer seleccionado no existe o está inactivo.');
  if (fields.client_id) {
    const client = get("SELECT name, company FROM users WHERE id = ? AND role = 'client'", fields.client_id);
    if (!client) throw bad('El cliente seleccionado no existe.');
    if (!fields.client) fields.client = client.company || client.name;
  }
  if (fields.vehicle_id && !get('SELECT id FROM vehicles WHERE id = ?', fields.vehicle_id)) throw bad('El vehículo no existe.');
  if (fields.delivery_at && fields.delivery_at < fields.pickup_at) {
    throw bad('La entrega no puede ser antes del inicio del viaje.');
  }
  // Recolección anticipada: mini flete para cargar la unidad antes del viaje principal.
  if (body.has_prepickup === true || body.has_prepickup === 'true' || body.has_prepickup === 'on') {
    fields.prepickup_address = str(body.prepickup_address, 500);
    fields.prepickup_lat = num(body.prepickup_lat);
    fields.prepickup_lng = num(body.prepickup_lng);
    fields.prepickup_at = localDateTime(body.prepickup_at, 'fecha y hora de la recolección anticipada', true);
    if (!fields.prepickup_address) throw bad('Indica el lugar de la recolección anticipada.');
    if (fields.prepickup_at > fields.pickup_at) throw bad('La recolección anticipada debe ser antes del inicio del viaje.');
  }
  // Tiempo de manejo del inicio al destino (para el ETA).
  if (fields.route_minutes != null) {
    if (fields.route_minutes <= 0 || fields.route_minutes > 7 * 24 * 60) throw bad('El tiempo estimado de manejo no es válido.');
    fields.route_minutes = Math.round(fields.route_minutes);
    fields.route_source = fields.route_source || 'manual';
  } else {
    const rough = eta.roughRoute(
      { lat: fields.pickup_lat, lng: fields.pickup_lng },
      { lat: fields.dest_lat, lng: fields.dest_lng }
    );
    if (rough) Object.assign(fields, { route_km: fields.route_km ?? rough.km, route_minutes: rough.minutes, route_source: 'estimado' });
  }
  if (fields.route_km != null) fields.route_km = Math.round(fields.route_km * 10) / 10;
  return fields;
}

// Columnas del viaje que se guardan igual al crear y al editar.
const EXTRA_COLS = [
  'name', 'notify_emails', 'prepickup_address', 'prepickup_lat', 'prepickup_lng', 'prepickup_at',
  'route_km', 'route_minutes', 'route_source', 'overnight_nights', 'lodging_notes',
];

router.post(
  '/trips',
  auth.requireAdmin,
  h(async (req, res) => {
    const f = readTripFields(req.body);
    // Viaje de regreso: se liga al viaje de ida y usa la misma unidad y chofer.
    const parentId = num(req.body.parent_trip_id);
    if (parentId) {
      const parent = loadTrip(parentId);
      if (!parent) throw bad('El viaje de ida no existe.');
      if (['finalizado', 'cancelado'].includes(parent.status)) throw bad('El viaje de ida ya está cerrado; crea un viaje normal.');
      if (parent.return_trip_id) throw bad(`El viaje #${parent.id} ya tiene un viaje de regreso (#${parent.return_trip_id}).`);
      if (f.driver_id !== parent.driver_id) throw bad('El viaje de regreso debe ser con el mismo chofer del viaje de ida.');
      if ((f.vehicle_id || null) !== (parent.vehicle_id || null)) throw bad('El viaje de regreso debe ser con la misma unidad del viaje de ida.');
    }
    const id = Number(
      run(
        `INSERT INTO trips (driver_id, vehicle_id, client_id, client, cargo, notes, pickup_address, pickup_lat, pickup_lng, pickup_at,
                            dest_address, dest_lat, dest_lng, delivery_at, created_by, ${EXTRA_COLS.join(', ')}, track_token, parent_trip_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${EXTRA_COLS.map(() => '?').join(', ')}, ?, ?)`,
        f.driver_id,
        f.vehicle_id,
        f.client_id,
        f.client,
        f.cargo,
        f.notes,
        f.pickup_address,
        f.pickup_lat,
        f.pickup_lng,
        f.pickup_at,
        f.dest_address,
        f.dest_lat,
        f.dest_lng,
        f.delivery_at,
        req.user.id,
        ...EXTRA_COLS.map((k) => f[k]),
        crypto.randomBytes(16).toString('hex'),
        parentId || null
      ).lastInsertRowid
    );
    addEvent(id, req.user.id, 'creado', parentId ? `Viaje de regreso del viaje #${parentId}` : 'Viaje creado y asignado');
    if (parentId) addEvent(parentId, req.user.id, 'regreso', `Se programó el viaje de regreso #${id}`);
    const trip = loadTrip(id);
    notify.notifyDriverAboutTrip(trip, 'assigned');
    notify.notifyTripStatus(trip, 'programado', req.user.id);
    res.status(201).json(trip);
  })
);

router.put(
  '/trips/:id',
  auth.requireAdmin,
  h(async (req, res) => {
    const before = tripForUser(req);
    if (before.status === 'cancelado') throw bad('El viaje está cancelado.');
    const f = readTripFields(req.body);
    if (before.parent_trip_id || before.return_trip_id) {
      if (f.driver_id !== before.driver_id || (f.vehicle_id || null) !== (before.vehicle_id || null)) {
        throw bad('La ida y el regreso comparten chofer y unidad: no se pueden cambiar en uno solo.');
      }
    }
    const driverChanged = f.driver_id !== before.driver_id;
    if (driverChanged && before.status !== 'asignado') {
      throw bad('Solo se puede cambiar el chofer antes de que inicie el viaje.');
    }
    // Correcciones manuales del odómetro (por si el chofer escribió mal la lectura).
    const odoStart = req.body.odo_start !== undefined ? num(req.body.odo_start) : before.odo_start;
    const odoEnd = req.body.odo_end !== undefined ? num(req.body.odo_end) : before.odo_end;
    const odoReturn = req.body.odo_return !== undefined ? num(req.body.odo_return) : before.odo_return;
    if (odoStart != null && odoEnd != null && odoEnd < odoStart) throw bad('El odómetro al entregar no puede ser menor al inicial.');
    if (odoReturn != null && odoReturn < (odoEnd ?? odoStart ?? 0)) throw bad('El odómetro al regresar no puede ser menor al de la entrega.');

    run(
      `UPDATE trips SET driver_id = ?, vehicle_id = ?, client_id = ?, client = ?, cargo = ?, notes = ?, pickup_address = ?, pickup_lat = ?,
              pickup_lng = ?, pickup_at = ?, dest_address = ?, dest_lat = ?, dest_lng = ?, delivery_at = ?,
              odo_start = ?, odo_end = ?, odo_return = ?, ${EXTRA_COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now')
        WHERE id = ?`,
      f.driver_id,
      f.vehicle_id,
      f.client_id,
      f.client,
      f.cargo,
      f.notes,
      f.pickup_address,
      f.pickup_lat,
      f.pickup_lng,
      f.pickup_at,
      f.dest_address,
      f.dest_lat,
      f.dest_lng,
      f.delivery_at,
      odoStart,
      odoEnd,
      odoReturn,
      ...EXTRA_COLS.map((k) => f[k]),
      before.id
    );
    const after = loadTrip(before.id);
    // Avisos al cliente: si se le acaba de asignar el viaje, "programado";
    // si cambió algo que le importa (lugares, horarios, ETA), "reprogramado".
    const clientFacing = ['name', 'pickup_address', 'pickup_at', 'prepickup_address', 'prepickup_at', 'dest_address', 'delivery_at', 'eta_at'];
    const newRecipients = (after.client_id && after.client_id !== before.client_id) || (after.notify_emails || '') !== (before.notify_emails || '');
    if (newRecipients) notify.notifyTripStatus(after, 'programado', req.user.id, { onlyClients: true });
    else if (after.status !== 'finalizado' && clientFacing.some((k) => (before[k] ?? null) !== (after[k] ?? null))) {
      notify.notifyTripStatus(after, 'reprogramado', req.user.id, { onlyClients: true });
    }

    if (driverChanged) {
      addEvent(before.id, req.user.id, 'reasignado', `Reasignado de ${before.driver_name || '—'} a ${after.driver_name}`);
      notify.notifyDriverAboutTrip(before, 'cancelled');
      notify.notifyDriverAboutTrip(after, 'assigned');
    } else {
      const watched = ['name', 'pickup_address', 'pickup_at', 'prepickup_address', 'prepickup_at', 'dest_address', 'delivery_at', 'vehicle_id', 'client', 'cargo', 'notes'];
      const changed = watched.filter((k) => (before[k] ?? null) !== (after[k] ?? null));
      if (odoStart !== before.odo_start || odoEnd !== before.odo_end || odoReturn !== before.odo_return) {
        addEvent(before.id, req.user.id, 'correccion', `Odómetro corregido: ${odoStart ?? '—'} → ${odoEnd ?? '—'} → ${odoReturn ?? '—'}`);
      }
      if (changed.length) {
        addEvent(before.id, req.user.id, 'editado', 'Datos del viaje modificados');
        if (!['entregado', 'finalizado'].includes(after.status)) notify.notifyDriverAboutTrip(after, 'updated');
      }
    }
    res.json(after);
  })
);

router.post(
  '/trips/:id/cancel',
  auth.requireAdmin,
  h((req, res) => {
    const trip = tripForUser(req);
    if (!CANCELABLE.includes(trip.status)) throw bad('Este viaje ya no se puede cancelar.');
    run("UPDATE trips SET status = 'cancelado', cancelled_at = ?, updated_at = datetime('now') WHERE id = ?", nowLocal(), trip.id);
    addEvent(trip.id, req.user.id, 'cancelado', str(req.body.reason, 500) || 'Viaje cancelado');
    notify.notifyDriverAboutTrip(trip, 'cancelled');
    const cancelled = loadTrip(trip.id);
    notify.notifyTripStatus(cancelled, 'cancelado', req.user.id);
    res.json(cancelled);
  })
);

router.delete(
  '/trips/:id',
  auth.requireAdmin,
  h((req, res) => {
    const trip = tripForUser(req);
    if (trip.status !== 'cancelado') throw bad('Solo se pueden borrar viajes cancelados.');
    const photos = [
      trip.odo_start_photo,
      trip.odo_end_photo,
      trip.odo_return_photo,
      trip.fuel_start_photo,
      trip.fuel_end_photo,
      ...all('SELECT photo FROM fuel_loads WHERE trip_id = ?', trip.id).map((r) => r.photo),
      ...all('SELECT file FROM trip_photos WHERE trip_id = ?', trip.id).map((r) => r.file),
      ...all('SELECT pause_photo, resume_photo FROM trip_pauses WHERE trip_id = ?', trip.id).flatMap((r) => [r.pause_photo, r.resume_photo]),
    ].filter(Boolean);
    run('UPDATE trips SET parent_trip_id = NULL WHERE parent_trip_id = ?', trip.id);
    run('DELETE FROM trips WHERE id = ?', trip.id);
    // La foto del odómetro al iniciar un regreso también cierra el viaje de ida: no se borra si otro viaje la usa.
    photos.filter((f) => !fileInUse(f)).forEach(removeUpload);
    res.json({ ok: true });
  })
);

// ---------- Acciones del chofer ----------
// Cada paso solo se permite desde el estado anterior:
//   asignado ──(odómetro y combustible)──▶ en_recoleccion
//     ──(foto al llegar a cargar)── (sigue en_recoleccion, marca at_pickup_at)
//     ──(foto de la unidad cargada)──▶ cargado
//   ──(foto de salida si pasaron más de 3 h desde que cargó)──▶ en_ruta
//   ──(foto de llegada)──▶ en_destino
//   ──(prueba de entrega: fotos, quién recibe, firma y odómetro)──▶ entregado
//   ──(de regreso en su domicilio o base: odómetro y combustible)──▶ finalizado
// En cualquier etapa activa el chofer puede PAUSAR (hotel, domicilio, descanso)
// con foto y odómetro, y REANUDAR con foto del odómetro. Mientras está en pausa
// no puede avanzar pasos y no se registra su ubicación.
// Si el viaje tiene un viaje de regreso ligado, el de ida se cierra solo cuando
// el chofer inicia el regreso (con esa misma lectura de odómetro y combustible).
function driverOnly(req) {
  const trip = tripForUser(req);
  if (!auth.isStaff(req.user) && !(req.user.role === 'driver' && trip.driver_id === req.user.id)) {
    throw new HttpError(403, 'Este viaje no es tuyo.');
  }
  return trip;
}

const stepUpload = upload.fields([
  { name: 'photo', maxCount: 1 }, // odómetro o foto principal del paso
  { name: 'fuel', maxCount: 1 }, // tablero con el nivel de combustible
  { name: 'pod', maxCount: 3 }, // prueba de entrega
  { name: 'signature', maxCount: 1 }, // firma de quien recibe
]);
const uploadedFiles = (req) => Object.values(req.files || {}).flat();

function addPhoto(tripId, kind, file, req) {
  run(
    'INSERT INTO trip_photos (trip_id, kind, file, user_id, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
    tripId,
    kind,
    file,
    req.user.id,
    num(req.body.lat),
    num(req.body.lng)
  );
}

// Paso del viaje: valida, guarda fotos y cambia de estado en una sola transacción.
function tripStep({ from, to, stamp, event, label, apply, guard }) {
  return [
    auth.requireUser,
    stepUpload,
    h(async (req, res) => {
      let trip;
      try {
        trip = driverOnly(req);
        if (trip.status !== from) throw bad('El viaje no está en el paso correcto. Actualiza la página.');
        if (trip.paused) throw bad('El viaje está en pausa. Primero presiona "Reanudar viaje".');
        if (guard) guard(trip);
        const files = {
          photo: req.files?.photo?.[0],
          fuel: req.files?.fuel?.[0],
          pod: req.files?.pod || [],
          signature: req.files?.signature?.[0],
        };
        transaction(() => {
          const note = apply ? apply(trip, files, req) : label;
          run(`UPDATE trips SET status = ?, ${stamp} = ?, updated_at = datetime('now') WHERE id = ?`, to, nowLocal(), trip.id);
          addEvent(trip.id, req.user.id, event, note, req.body);
        });
      } catch (err) {
        uploadedFiles(req).forEach((f) => removeUpload(f.filename));
        throw err;
      }
      const updated = loadTrip(trip.id);
      // Correo y notificación de cada cambio de estatus: personal de AN, cliente y correos adicionales.
      notify.notifyTripStatus(updated, event, req.user.id);
      // Al iniciar un viaje de regreso se cierra el viaje de ida.
      if (event === 'iniciado' && trip.parent_trip_id && trip.parent_status === 'entregado') {
        notify.notifyTripStatus(loadTrip(trip.parent_trip_id), 'finalizado', req.user.id);
      }
      res.json(updated);
    }),
  ];
}

function requirePhoto(file, message) {
  if (!file) throw bad(message);
  return file.filename;
}

// minimum: lectura anterior del mismo viaje (el odómetro nunca baja).
function readOdometer(req, minimum, minimumLabel) {
  const reading = num(req.body.odometer);
  if (reading == null || reading < 0) throw bad('Escribe la lectura del odómetro (km).');
  if (minimum != null && reading < minimum) {
    throw bad(`La lectura (${reading}) no puede ser menor que ${minimumLabel} (${minimum}).`);
  }
  return reading;
}

// Nivel de la aguja de combustible: 0 (vacío) a 1 (lleno).
function readFuelLevel(req) {
  const level = num(req.body.fuel_level);
  if (level == null || level < 0 || level > 1) throw bad('Indica el nivel de combustible del tablero.');
  return level;
}
const fuelText = (level) => `${Math.round(level * 100)}%`;

// Última lectura de odómetro conocida del viaje (inicio, pausas o entrega).
function lastReading(trip) {
  const readings = [trip.odo_start, trip.odo_end, ...trip.pauses.flatMap((p) => [p.pause_odometer, p.resume_odometer])].filter((v) => v != null);
  return readings.length ? Math.max(...readings) : null;
}

// 1) Antes de arrancar: foto y lectura del odómetro.
router.post(
  '/trips/:id/start',
  ...tripStep({
    from: 'asignado',
    to: 'en_recoleccion',
    stamp: 'started_at',
    event: 'iniciado',
    label: 'Inició el viaje',
    guard(trip) {
      if (trip.parent_trip_id && !['entregado', 'finalizado', 'cancelado'].includes(trip.parent_status)) {
        throw bad(`Primero termina la entrega del viaje de ida #${trip.parent_trip_id}.`);
      }
    },
    apply(trip, files, req) {
      const photo = requirePhoto(files.photo, 'Toma la foto del odómetro.');
      const fuelPhoto = requirePhoto(files.fuel, 'Toma la foto del tablero con el nivel de combustible.');
      const parent = trip.parent_trip_id ? loadTrip(trip.parent_trip_id) : null;
      const reading = parent && parent.status === 'entregado' ? readOdometer(req, lastReading(parent), 'la última del viaje de ida') : readOdometer(req, null);
      const level = readFuelLevel(req);
      if (parent && parent.status === 'entregado') closeParent(parent, { reading, photo, level, fuelPhoto, req });
      run(
        'UPDATE trips SET odo_start = ?, odo_start_photo = ?, fuel_start = ?, fuel_start_photo = ? WHERE id = ?',
        reading,
        photo,
        level,
        fuelPhoto,
        trip.id
      );
      if (trip.vehicle_id) run('UPDATE vehicles SET last_odometer = ? WHERE id = ?', reading, trip.vehicle_id);
      return `Inició el viaje · odómetro ${reading} km · combustible ${fuelText(level)}`;
    },
  })
);

// 2a) Llegó al punto de carga (recolección anticipada o punto de inicio): foto.
router.post(
  '/trips/:id/at-pickup',
  ...tripStep({
    from: 'en_recoleccion',
    to: 'en_recoleccion',
    stamp: 'at_pickup_at',
    event: 'llegada_carga',
    label: 'Llegó a cargar',
    guard(trip) {
      if (trip.at_pickup_at) throw bad('Ya registraste la llegada al punto de carga.');
    },
    apply(trip, files, req) {
      addPhoto(trip.id, 'llegada_carga', requirePhoto(files.photo, 'Toma una foto al llegar al punto de carga.'), req);
      return 'Llegó al punto de carga · foto de llegada';
    },
  })
);

// 2b) Terminó de cargar: foto de la unidad cargada (puede salir hasta otro día).
router.post(
  '/trips/:id/loaded',
  ...tripStep({
    from: 'en_recoleccion',
    to: 'cargado',
    stamp: 'loaded_at',
    event: 'cargado',
    label: 'Terminó de cargar',
    guard(trip) {
      if (!trip.at_pickup_at) throw bad('Primero marca "Llegué a cargar" con su foto.');
    },
    apply(trip, files, req) {
      addPhoto(trip.id, 'carga', requirePhoto(files.photo, 'Toma la foto de la unidad cargada.'), req);
      return 'Terminó de cargar · foto de la unidad cargada';
    },
  })
);

// 3) Sale rumbo al destino. Si pasaron más de 3 horas desde que cargó (o desde
//    que reanudó tras una pausa), se pide una foto de salida.
const DEPART_PHOTO_AFTER_MIN = 180;
router.post(
  '/trips/:id/depart',
  ...tripStep({
    from: 'cargado',
    to: 'en_ruta',
    stamp: 'departed_at',
    event: 'en_ruta',
    label: 'Salió rumbo al destino',
    apply(trip, files, req) {
      const lastActivity = [trip.loaded_at, ...trip.pauses.map((p) => p.resumed_at)].filter(Boolean).sort().at(-1);
      const waited = lastActivity ? eta.minutesBetween(lastActivity, nowLocal()) : 0;
      if (!files.photo && waited > DEPART_PHOTO_AFTER_MIN) {
        throw bad('Pasaron más de 3 horas desde que cargaste: toma una foto de la unidad antes de salir.');
      }
      if (files.photo) addPhoto(trip.id, 'salida', files.photo.filename, req);
      return `Salió rumbo al destino${files.photo ? ' · foto de salida' : ''}`;
    },
  })
);

// 4) Llegó al punto de entrega: foto de llegada.
router.post(
  '/trips/:id/arrive',
  ...tripStep({
    from: 'en_ruta',
    to: 'en_destino',
    stamp: 'arrived_at',
    event: 'llegada',
    label: 'Llegó al punto de entrega',
    apply(trip, files, req) {
      addPhoto(trip.id, 'llegada', requirePhoto(files.photo, 'Toma la foto de llegada al punto de entrega.'), req);
      return 'Llegó al punto de entrega · foto de llegada';
    },
  })
);

// 5) Entrega: fotos de prueba de entrega, nombre de quien recibe, firma (opcional)
//    y odómetro al entregar.
router.post(
  '/trips/:id/finish',
  ...tripStep({
    from: 'en_destino',
    to: 'entregado',
    stamp: 'finished_at',
    event: 'entregado',
    label: 'Entregó la carga',
    apply(trip, files, req) {
      if (!files.pod.length) throw bad('Toma al menos una foto de la prueba de entrega.');
      const receivedBy = str(req.body.received_by, 150);
      if (!receivedBy) throw bad('Escribe el nombre de quien recibe.');
      const odo = requirePhoto(files.photo, 'Toma la foto del odómetro al entregar.');
      const reading = readOdometer(req, lastReading(trip), 'la última registrada');
      files.pod.forEach((f) => addPhoto(trip.id, 'entrega', f.filename, req));
      if (files.signature) addPhoto(trip.id, 'firma', files.signature.filename, req);
      run('UPDATE trips SET odo_end = ?, odo_end_photo = ?, received_by = ? WHERE id = ?', reading, odo, receivedBy, trip.id);
      if (trip.vehicle_id) run('UPDATE vehicles SET last_odometer = ? WHERE id = ?', reading, trip.vehicle_id);
      return `Entregado a ${receivedBy} · ${files.pod.length} foto(s) de entrega${files.signature ? ' · con firma' : ''} · odómetro ${reading} km`;
    },
  })
);

// 6) Regreso a su domicilio o base: odómetro y nivel de combustible para cerrar
//    el recorrido completo (km y combustible de ida y vuelta).
router.post(
  '/trips/:id/return',
  ...tripStep({
    from: 'entregado',
    to: 'finalizado',
    stamp: 'returned_at',
    event: 'finalizado',
    label: 'Llegó a su base y cerró el viaje',
    guard(trip) {
      if (trip.return_trip_id) {
        throw bad(`Este viaje continúa con el viaje de regreso #${trip.return_trip_id}: se cierra solo al iniciar el regreso.`);
      }
    },
    apply(trip, files, req) {
      const photo = requirePhoto(files.photo, 'Toma la foto del odómetro al llegar.');
      const fuelPhoto = requirePhoto(files.fuel, 'Toma la foto del tablero con el nivel de combustible.');
      const reading = readOdometer(req, lastReading(trip), 'la última registrada');
      const level = readFuelLevel(req);
      run(
        'UPDATE trips SET odo_return = ?, odo_return_photo = ?, fuel_end = ?, fuel_end_photo = ? WHERE id = ?',
        reading,
        photo,
        level,
        fuelPhoto,
        trip.id
      );
      if (trip.vehicle_id) run('UPDATE vehicles SET last_odometer = ? WHERE id = ?', reading, trip.vehicle_id);
      return `Llegó a su base · odómetro ${reading} km · combustible ${fuelText(level)}`;
    },
  })
);

// Cierra el viaje de ida al iniciar su viaje de regreso: la lectura de odómetro y
// combustible al iniciar el regreso es la lectura final de la ida.
function closeParent(parent, { reading, photo, level, fuelPhoto, req }) {
  const now = nowLocal();
  const open = parent.pauses.find((p) => !p.resumed_at);
  if (open) {
    run(
      'UPDATE trip_pauses SET resumed_at = ?, resume_photo = ?, resume_odometer = ?, resume_lat = ?, resume_lng = ? WHERE id = ?',
      now, photo, reading, num(req.body.lat), num(req.body.lng), open.id
    );
  }
  run(
    `UPDATE trips SET status = 'finalizado', returned_at = ?, odo_return = ?, odo_return_photo = ?, fuel_end = ?, fuel_end_photo = ?,
            updated_at = datetime('now') WHERE id = ?`,
    now, reading, photo, level, fuelPhoto, parent.id
  );
  addEvent(parent.id, req.user.id, 'finalizado', `Cerrado al iniciar el viaje de regreso · odómetro ${reading} km · combustible ${fuelText(level)}`, req.body);
}

// ---------- Pausas: descanso, hotel o domicilio ----------
const PAUSABLE = ['en_recoleccion', 'cargado', 'en_ruta', 'en_destino', 'entregado'];
const PAUSE_PLACES = { hotel: 'Hotel', domicilio: 'Domicilio del chofer', base: 'Base de AN', cliente: 'Instalaciones del cliente', carretera: 'Descanso en carretera', otro: 'Otro lugar' };
const MOVED_KM_ALERT = 5; // km que puede variar el odómetro durante una pausa sin alerta

router.post(
  '/trips/:id/pause',
  auth.requireUser,
  stepUpload,
  h(async (req, res) => {
    let trip;
    let pauseId;
    try {
      trip = driverOnly(req);
      if (!PAUSABLE.includes(trip.status)) throw bad('Este viaje no se puede pausar en esta etapa.');
      if (trip.paused) throw bad('El viaje ya está en pausa.');
      const place = PAUSE_PLACES[req.body.place] ? req.body.place : null;
      if (!place) throw bad('Indica dónde haces la pausa.');
      const photo = requirePhoto(req.files?.photo?.[0], 'Toma una foto de la unidad estacionada.');
      const reading = readOdometer(req, lastReading(trip), 'la última registrada');
      const planned = localDateTime(req.body.resume_planned_at, 'fecha y hora para reanudar', false);
      if (planned && planned < nowLocal()) throw bad('La hora para reanudar debe ser en el futuro.');
      const note = str(req.body.place_note, 200);
      pauseId = transaction(() => {
        const id = Number(
          run(
            `INSERT INTO trip_pauses (trip_id, user_id, status, place, place_note, paused_at, pause_photo, pause_odometer, pause_lat, pause_lng, resume_planned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            trip.id, req.user.id, trip.status, place, note, nowLocal(), photo, reading, num(req.body.lat), num(req.body.lng), planned
          ).lastInsertRowid
        );
        addEvent(
          trip.id,
          req.user.id,
          'pausa',
          `Pausa: ${PAUSE_PLACES[place]}${note ? ` (${note})` : ''} · odómetro ${reading} km${planned ? ` · reanuda ${planned.replace('T', ' ')}` : ''}`,
          req.body
        );
        run("UPDATE trips SET updated_at = datetime('now') WHERE id = ?", trip.id);
        return id;
      });
    } catch (err) {
      uploadedFiles(req).forEach((f) => removeUpload(f.filename));
      throw err;
    }
    const updated = loadTrip(trip.id);
    const pause = updated.pauses.find((p) => p.id === pauseId);
    // Pernocta en hotel sin noches autorizadas (o más noches de las autorizadas).
    const hotelNights = updated.pauses.filter((p) => p.place === 'hotel').length;
    const alert = pause.place === 'hotel' && hotelNights > (updated.overnight_nights || 0)
      ? `Pernocta no autorizada: ${hotelNights} noche(s) de hotel y ${updated.overnight_nights || 0} autorizada(s).`
      : null;
    notify.notifyTripStatus(updated, 'pausa', req.user.id, { pause: { ...pause, placeLabel: PAUSE_PLACES[pause.place] }, alert });
    res.json(updated);
  })
);

router.post(
  '/trips/:id/resume',
  auth.requireUser,
  stepUpload,
  h(async (req, res) => {
    let trip;
    let moved = 0;
    let pause;
    try {
      trip = driverOnly(req);
      pause = trip.pauses.find((p) => !p.resumed_at);
      if (!pause) throw bad('El viaje no está en pausa.');
      const photo = requirePhoto(req.files?.photo?.[0], 'Toma la foto del odómetro antes de arrancar.');
      const reading = readOdometer(req, pause.pause_odometer, 'la registrada al pausar');
      moved = Math.round((reading - pause.pause_odometer) * 10) / 10;
      transaction(() => {
        run(
          'UPDATE trip_pauses SET resumed_at = ?, resume_photo = ?, resume_odometer = ?, resume_lat = ?, resume_lng = ? WHERE id = ?',
          nowLocal(), photo, reading, num(req.body.lat), num(req.body.lng), pause.id
        );
        addEvent(trip.id, req.user.id, 'reanudado', `Reanudó el viaje · odómetro ${reading} km${moved > MOVED_KM_ALERT ? ` · ⚠ la unidad se movió ${moved} km durante la pausa` : ''}`, req.body);
        run("UPDATE trips SET updated_at = datetime('now') WHERE id = ?", trip.id);
        if (trip.vehicle_id) run('UPDATE vehicles SET last_odometer = MAX(COALESCE(last_odometer, 0), ?) WHERE id = ?', reading, trip.vehicle_id);
      });
    } catch (err) {
      uploadedFiles(req).forEach((f) => removeUpload(f.filename));
      throw err;
    }
    const updated = loadTrip(trip.id);
    const alert = moved > MOVED_KM_ALERT ? `La unidad se movió ${moved} km durante la pausa (${PAUSE_PLACES[pause.place]}).` : null;
    notify.notifyTripStatus(updated, 'reanudado', req.user.id, { pause: { ...pause, placeLabel: PAUSE_PLACES[pause.place] }, alert });
    res.json(updated);
  })
);

// ---------- Ubicación del chofer ----------
// El celular manda puntos cada cierto tiempo (y los acumula si no hay señal).
// Solo se guardan mientras el viaje está activo y no está en pausa.
const TRACKED = ['en_recoleccion', 'cargado', 'en_ruta', 'en_destino', 'entregado'];
router.post(
  '/trips/:id/locations',
  auth.requireUser,
  h((req, res) => {
    const trip = driverOnly(req);
    if (!TRACKED.includes(trip.status) || trip.paused || trackingMinutes() === 0) return res.json({ accepted: 0, stop: true });
    const points = Array.isArray(req.body.points) ? req.body.points.slice(0, 100) : [];
    const now = Date.now();
    let accepted = 0;
    transaction(() => {
      for (const p of points) {
        const lat = num(p.lat);
        const lng = num(p.lng);
        const t = num(p.t);
        if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !t) continue;
        if (t > now + 5 * 60000 || t < now - 48 * 3600000) continue; // hora del celular fuera de rango
        run(
          'INSERT INTO trip_locations (trip_id, user_id, lat, lng, accuracy, speed, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          trip.id, req.user.id, lat, lng, num(p.accuracy), num(p.speed), new Date(t).toISOString()
        );
        accepted += 1;
      }
    });
    res.json({ accepted, interval: trackingMinutes() });
  })
);

router.get(
  '/trips/:id/locations',
  auth.requireAdmin,
  h((req, res) => {
    const trip = tripForUser(req);
    res.json(all('SELECT lat, lng, accuracy, speed, recorded_at FROM trip_locations WHERE trip_id = ? ORDER BY id LIMIT 5000', trip.id));
  })
);

// Nota libre del chofer (incidencias, retrasos, etc.).
router.post(
  '/trips/:id/note',
  auth.requireUser,
  h((req, res) => {
    const trip = driverOnly(req);
    const note = str(req.body.note, 1000);
    if (!note) throw bad('Escribe la nota.');
    addEvent(trip.id, req.user.id, 'nota', note, req.body);
    notify.notifyAdmins(`Nota de ${req.user.name} (viaje #${trip.id})`, note, `/admin.html#viaje-${trip.id}`, { email: true });
    res.json({ ok: true });
  })
);

// Cargas de combustible: sirven para calcular el rendimiento (km/L).
router.post(
  '/trips/:id/fuel',
  auth.requireUser,
  upload.single('photo'),
  h((req, res) => {
    try {
      const trip = driverOnly(req);
      if (trip.status === 'cancelado') throw bad('El viaje está cancelado.');
      if (!auth.isStaff(req.user) && trip.status === 'finalizado') {
        throw bad('El viaje ya terminó. Pide al administrador que registre la carga.');
      }
      const liters = num(req.body.liters);
      if (!liters || liters <= 0) throw bad('Escribe los litros cargados.');
      run(
        'INSERT INTO fuel_loads (trip_id, user_id, liters, amount, odometer, photo) VALUES (?, ?, ?, ?, ?, ?)',
        trip.id,
        req.user.id,
        liters,
        num(req.body.amount),
        num(req.body.odometer),
        req.file ? req.file.filename : null
      );
      addEvent(trip.id, req.user.id, 'combustible', `Cargó ${liters} L${num(req.body.amount) ? ` ($${num(req.body.amount)})` : ''}`, req.body);
      res.status(201).json(loadTrip(trip.id));
    } catch (err) {
      if (req.file) removeUpload(req.file.filename);
      throw err;
    }
  })
);

router.delete(
  '/fuel/:id',
  auth.requireAdmin,
  h((req, res) => {
    const load = get('SELECT * FROM fuel_loads WHERE id = ?', Number(req.params.id));
    if (!load) throw new HttpError(404, 'La carga no existe.');
    run('DELETE FROM fuel_loads WHERE id = ?', load.id);
    removeUpload(load.photo);
    addEvent(load.trip_id, req.user.id, 'correccion', `Se eliminó la carga de ${load.liters} L`);
    res.json({ ok: true });
  })
);

// ---------- Fotos (solo usuarios con acceso al viaje) ----------
router.get(
  '/photos/:file',
  auth.requireUser,
  h((req, res) => {
    const file = path.basename(req.params.file);
    // Fotos de etapas (carga, llegada, entrega, firma): las ve también el cliente del viaje.
    const stage = get(
      'SELECT t.driver_id, t.client_id FROM trip_photos p JOIN trips t ON t.id = p.trip_id WHERE p.file = ?',
      file
    );
    // Odómetro y tickets de combustible: solo personal y chofer.
    const internal = stage
      ? null
      : get(
          `SELECT t.driver_id, NULL AS client_id FROM trips t
            WHERE ? IN (t.odo_start_photo, t.odo_end_photo, t.odo_return_photo, t.fuel_start_photo, t.fuel_end_photo)
               OR t.id IN (SELECT trip_id FROM fuel_loads WHERE photo = ?)
               OR t.id IN (SELECT trip_id FROM trip_pauses WHERE pause_photo = ? OR resume_photo = ?)`,
          file,
          file,
          file,
          file
        );
    const owner = stage || internal;
    const allowed =
      owner &&
      (auth.isStaff(req.user) ||
        (req.user.role === 'driver' && owner.driver_id === req.user.id) ||
        (req.user.role === 'client' && owner.client_id === req.user.id));
    if (!allowed) throw new HttpError(404, 'Foto no encontrada.');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(config.uploadsDir, file));
  })
);

// ---------- Seguimiento público (enlace que se envía por correo o WhatsApp) ----------
// Cualquiera con el enlace ve lo mismo que el cliente: estatus, ETA y fotos de
// carga, llegada y entrega. Nunca odómetro, combustible ni notas internas.
function tripByToken(token) {
  const t = String(token || '');
  if (!/^[0-9a-f]{32}$/.test(t)) throw new HttpError(404, 'Enlace de seguimiento no válido.');
  const row = get('SELECT id FROM trips WHERE track_token = ?', t);
  if (!row) throw new HttpError(404, 'Enlace de seguimiento no válido.');
  return loadTrip(row.id);
}

router.get(
  '/track/:token',
  h((req, res) => {
    const trip = tripByToken(req.params.token);
    const photos = tripPhotos(trip.id).map(({ kind, file, created_at }) => ({ kind, file, created_at }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...forClient(trip), photos, company: site.getSite().name });
  })
);

router.get(
  '/track/:token/photos/:file',
  h((req, res) => {
    const trip = tripByToken(req.params.token);
    const file = path.basename(req.params.file);
    if (!get('SELECT id FROM trip_photos WHERE trip_id = ? AND file = ?', trip.id, file)) throw new HttpError(404, 'Foto no encontrada.');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(config.uploadsDir, file));
  })
);

// ---------- Reporte de rendimiento de combustible ----------
router.get(
  '/reports/fuel',
  auth.requireAdmin,
  h((req, res) => {
    const where = ["t.status = 'finalizado'"];
    const params = [];
    if (req.query.from) where.push('t.finished_at >= ?'), params.push(String(req.query.from));
    if (req.query.to) where.push('t.finished_at <= ?'), params.push(`${req.query.to}T23:59`);
    if (req.query.vehicle_id) where.push('t.vehicle_id = ?'), params.push(Number(req.query.vehicle_id));
    if (req.query.driver_id) where.push('t.driver_id = ?'), params.push(Number(req.query.driver_id));
    const trips = all(`${TRIP_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.finished_at DESC`, ...params).map(withMetrics);

    // Totales por vehículo y por chofer. Solo cuentan los viajes con km y litros
    // para no distorsionar el promedio.
    const group = (keyFn, labelFn) => {
      const map = new Map();
      for (const t of trips) {
        const key = keyFn(t);
        const g = map.get(key) || { key, label: labelFn(t), trips: 0, km: 0, liters: 0, amount: 0, measured_trips: 0 };
        g.trips += 1;
        if (t.km != null) g.km += t.km;
        g.amount += t.fuel_amount || 0;
        if (t.km != null && t.fuel_used > 0) {
          g.measured_trips += 1;
          g.measured_km = (g.measured_km || 0) + t.km;
          g.liters += t.fuel_used;
        }
        map.set(key, g);
      }
      return [...map.values()].map((g) => ({
        ...g,
        km_per_liter: g.liters > 0 ? g.measured_km / g.liters : null,
        cost_per_km: g.km > 0 && g.amount > 0 ? g.amount / g.km : null,
      }));
    };

    res.json({
      trips,
      byVehicle: group(
        (t) => t.vehicle_id || 0,
        (t) => (t.vehicle_name ? `${t.vehicle_name}${t.vehicle_plate ? ` (${t.vehicle_plate})` : ''}` : 'Sin vehículo')
      ),
      byDriver: group((t) => t.driver_id, (t) => t.driver_name || '—'),
    });
  })
);

// ---------- Recibos de pago y página pública ----------
router.use(require('./payments'));
router.use(require('./site-api'));

// ---------- Errores ----------
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'La foto es demasiado grande.' : 'No se pudo subir la foto.' });
  }
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Ocurrió un error inesperado. Inténtalo de nuevo.' });
});

module.exports = router;
