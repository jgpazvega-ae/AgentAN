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
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(bad('El archivo debe ser una foto.'));
  },
});

function removeUpload(file) {
  if (file) fs.rm(path.join(config.uploadsDir, path.basename(file)), { force: true }, () => {});
}

// ---------- Consultas de viajes ----------
const TRIP_SELECT = `
  SELECT t.*,
         d.name AS driver_name, d.email AS driver_email, d.phone AS driver_phone,
         v.name AS vehicle_name, v.plate AS vehicle_plate, v.last_odometer AS vehicle_last_odometer,
         (SELECT COALESCE(SUM(f.liters), 0) FROM fuel_loads f WHERE f.trip_id = t.id) AS fuel_liters,
         (SELECT COALESCE(SUM(f.amount), 0) FROM fuel_loads f WHERE f.trip_id = t.id) AS fuel_amount
    FROM trips t
    LEFT JOIN users d ON d.id = t.driver_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id`;

function withMetrics(trip) {
  if (!trip) return trip;
  const km = trip.odo_start != null && trip.odo_end != null ? trip.odo_end - trip.odo_start : null;
  trip.km = km;
  trip.km_per_liter = km != null && trip.fuel_liters > 0 ? km / trip.fuel_liters : null;
  trip.liters_per_100km = km && trip.fuel_liters > 0 ? (trip.fuel_liters / km) * 100 : null;
  return trip;
}

function loadTrip(id) {
  return withMetrics(get(`${TRIP_SELECT} WHERE t.id = ?`, id));
}

// El chofer solo puede ver y mover sus propios viajes.
function tripForUser(req) {
  const trip = loadTrip(Number(req.params.id));
  if (!trip) throw new HttpError(404, 'El viaje no existe.');
  if (req.user.role !== 'admin' && trip.driver_id !== req.user.id) throw new HttpError(404, 'El viaje no existe.');
  return trip;
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
      companyName: config.companyName,
      googleMapsApiKey: config.googleMapsApiKey,
      vapidPublicKey: notify.vapidPublicKey(),
      emailEnabled: notify.emailEnabled(),
      needsSetup: users === 0,
    });
  })
);

// Primer arranque: crea la cuenta del administrador (solo si no hay usuarios).
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
        "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
        name,
        email.toLowerCase(),
        auth.hashPassword(password)
      ).lastInsertRowid;
    });
    auth.createSession(res, Number(id));
    res.json({ ok: true, role: 'admin' });
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
    res.json({ ok: true, role: user.role });
  })
);

router.post(
  '/logout',
  h((req, res) => {
    auth.destroySession(req, res);
    res.json({ ok: true });
  })
);

router.get('/me', auth.requireUser, (req, res) => res.json(req.user));

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
      body: 'Así te avisaremos cuando tengas un viaje nuevo.',
      url: req.user.role === 'admin' ? '/admin.html' : '/chofer.html',
    });
    res.json({ ok: true, devices: sent });
  })
);

// ---------- Usuarios (choferes y administradores) ----------
router.get(
  '/users',
  auth.requireAdmin,
  h((req, res) => {
    res.json(
      all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.created_at,
                  (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS push_devices,
                  (SELECT COUNT(*) FROM trips t WHERE t.driver_id = u.id AND t.status IN ('asignado','en_recoleccion','cargado','en_ruta')) AS open_trips
             FROM users u ORDER BY u.active DESC, u.role, u.name`)
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
    const role = req.body.role === 'admin' ? 'admin' : 'driver';
    const password = String(req.body.password || '');
    if (!name || !email) throw bad('Nombre y correo son obligatorios.');
    if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres.');
    if (get('SELECT id FROM users WHERE email = ?', email)) throw bad('Ya existe un usuario con ese correo.');
    const id = Number(
      run(
        'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
        name,
        email,
        phone,
        auth.hashPassword(password),
        role
      ).lastInsertRowid
    );
    if (req.body.sendWelcome) {
      const page = role === 'admin' ? 'admin.html' : 'chofer.html';
      notify
        .sendEmail({
          to: email,
          subject: `Tu acceso a ${config.companyName}`,
          text: `Hola ${name},\n\nYa tienes acceso a la plataforma de viajes de ${config.companyName}.\n\nEntra en: ${config.appUrl}/${page}\nCorreo: ${email}\nContraseña: ${password}\n\nTe recomendamos cambiar tu contraseña al entrar y activar las notificaciones.\n`,
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
    const name = str(req.body.name, 100) || user.name;
    const email = (str(req.body.email, 200) || user.email).toLowerCase();
    const phone = req.body.phone !== undefined ? str(req.body.phone, 40) : user.phone;
    const role = req.body.role ? (req.body.role === 'admin' ? 'admin' : 'driver') : user.role;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : user.active;
    if (id === req.user.id && (!active || role !== 'admin')) {
      throw bad('No puedes desactivar ni quitarte el rol de administrador a ti mismo.');
    }
    const clash = get('SELECT id FROM users WHERE email = ? AND id <> ?', email, id);
    if (clash) throw bad('Ya existe un usuario con ese correo.');
    run('UPDATE users SET name = ?, email = ?, phone = ?, role = ?, active = ? WHERE id = ?', name, email, phone, role, active, id);
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
      'INSERT INTO vehicles (name, plate, fuel_type, last_odometer) VALUES (?, ?, ?, ?)',
      name,
      str(req.body.plate, 20),
      str(req.body.fuel_type, 20),
      num(req.body.last_odometer)
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
      'UPDATE vehicles SET name = ?, plate = ?, fuel_type = ?, last_odometer = ?, active = ? WHERE id = ?',
      str(req.body.name, 100) || v.name,
      req.body.plate !== undefined ? str(req.body.plate, 20) : v.plate,
      req.body.fuel_type !== undefined ? str(req.body.fuel_type, 20) : v.fuel_type,
      req.body.last_odometer !== undefined ? num(req.body.last_odometer) : v.last_odometer,
      req.body.active !== undefined ? (req.body.active ? 1 : 0) : v.active,
      v.id
    );
    res.json({ ok: true });
  })
);

// ---------- Viajes ----------
const OPEN = ['asignado', 'en_recoleccion', 'cargado', 'en_ruta'];

router.get(
  '/trips',
  auth.requireUser,
  h((req, res) => {
    const where = [];
    const params = [];
    if (req.user.role !== 'admin') {
      where.push('t.driver_id = ?');
      params.push(req.user.id);
    } else if (req.query.driver_id) {
      where.push('t.driver_id = ?');
      params.push(Number(req.query.driver_id));
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
    res.json(rows.map(withMetrics));
  })
);

router.get(
  '/trips/:id',
  auth.requireUser,
  h((req, res) => {
    const trip = tripForUser(req);
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

function readTripFields(body) {
  const fields = {
    driver_id: num(body.driver_id),
    vehicle_id: num(body.vehicle_id),
    client: str(body.client, 200),
    cargo: str(body.cargo, 500),
    notes: str(body.notes, 2000),
    pickup_address: str(body.pickup_address, 500),
    pickup_lat: num(body.pickup_lat),
    pickup_lng: num(body.pickup_lng),
    pickup_at: localDateTime(body.pickup_at, 'fecha de recolección', true),
    dest_address: str(body.dest_address, 500),
    dest_lat: num(body.dest_lat),
    dest_lng: num(body.dest_lng),
    delivery_at: localDateTime(body.delivery_at, 'fecha de entrega', false),
  };
  if (!fields.pickup_address) throw bad('Indica el punto de recolección.');
  if (!fields.dest_address) throw bad('Indica el destino final.');
  if (!fields.driver_id) throw bad('Selecciona el chofer.');
  const driver = get("SELECT id FROM users WHERE id = ? AND active = 1", fields.driver_id);
  if (!driver) throw bad('El chofer seleccionado no existe o está inactivo.');
  if (fields.vehicle_id && !get('SELECT id FROM vehicles WHERE id = ?', fields.vehicle_id)) throw bad('El vehículo no existe.');
  if (fields.delivery_at && fields.delivery_at < fields.pickup_at) {
    throw bad('La entrega no puede ser antes de la recolección.');
  }
  return fields;
}

router.post(
  '/trips',
  auth.requireAdmin,
  h(async (req, res) => {
    const f = readTripFields(req.body);
    const id = Number(
      run(
        `INSERT INTO trips (driver_id, vehicle_id, client, cargo, notes, pickup_address, pickup_lat, pickup_lng, pickup_at,
                            dest_address, dest_lat, dest_lng, delivery_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        f.driver_id,
        f.vehicle_id,
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
        req.user.id
      ).lastInsertRowid
    );
    addEvent(id, req.user.id, 'creado', 'Viaje creado y asignado');
    const trip = loadTrip(id);
    notify.notifyDriverAboutTrip(trip, 'assigned');
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
    const driverChanged = f.driver_id !== before.driver_id;
    if (driverChanged && before.status !== 'asignado') {
      throw bad('Solo se puede cambiar el chofer antes de que inicie el viaje.');
    }
    // Correcciones manuales del odómetro (por si el chofer escribió mal la lectura).
    const odoStart = req.body.odo_start !== undefined ? num(req.body.odo_start) : before.odo_start;
    const odoEnd = req.body.odo_end !== undefined ? num(req.body.odo_end) : before.odo_end;
    if (odoStart != null && odoEnd != null && odoEnd < odoStart) throw bad('El odómetro final no puede ser menor al inicial.');

    run(
      `UPDATE trips SET driver_id = ?, vehicle_id = ?, client = ?, cargo = ?, notes = ?, pickup_address = ?, pickup_lat = ?,
              pickup_lng = ?, pickup_at = ?, dest_address = ?, dest_lat = ?, dest_lng = ?, delivery_at = ?,
              odo_start = ?, odo_end = ?, updated_at = datetime('now')
        WHERE id = ?`,
      f.driver_id,
      f.vehicle_id,
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
      before.id
    );
    const after = loadTrip(before.id);

    if (driverChanged) {
      addEvent(before.id, req.user.id, 'reasignado', `Reasignado de ${before.driver_name || '—'} a ${after.driver_name}`);
      notify.notifyDriverAboutTrip(before, 'cancelled');
      notify.notifyDriverAboutTrip(after, 'assigned');
    } else {
      const watched = ['pickup_address', 'pickup_at', 'dest_address', 'delivery_at', 'vehicle_id', 'client', 'cargo', 'notes'];
      const changed = watched.filter((k) => (before[k] ?? null) !== (after[k] ?? null));
      if (odoStart !== before.odo_start || odoEnd !== before.odo_end) {
        addEvent(before.id, req.user.id, 'correccion', `Odómetro corregido: ${odoStart ?? '—'} → ${odoEnd ?? '—'}`);
      }
      if (changed.length) {
        addEvent(before.id, req.user.id, 'editado', 'Datos del viaje modificados');
        if (after.status !== 'finalizado') notify.notifyDriverAboutTrip(after, 'updated');
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
    if (!OPEN.includes(trip.status)) throw bad('Este viaje ya no se puede cancelar.');
    run("UPDATE trips SET status = 'cancelado', cancelled_at = ?, updated_at = datetime('now') WHERE id = ?", nowLocal(), trip.id);
    addEvent(trip.id, req.user.id, 'cancelado', str(req.body.reason, 500) || 'Viaje cancelado');
    notify.notifyDriverAboutTrip(trip, 'cancelled');
    res.json(loadTrip(trip.id));
  })
);

router.delete(
  '/trips/:id',
  auth.requireAdmin,
  h((req, res) => {
    const trip = tripForUser(req);
    if (trip.status !== 'cancelado') throw bad('Solo se pueden borrar viajes cancelados.');
    const photos = [trip.odo_start_photo, trip.odo_end_photo, ...all('SELECT photo FROM fuel_loads WHERE trip_id = ?', trip.id).map((r) => r.photo)];
    run('DELETE FROM trips WHERE id = ?', trip.id);
    photos.forEach(removeUpload);
    res.json({ ok: true });
  })
);

// ---------- Acciones del chofer ----------
// Cada paso solo se permite desde el estado anterior, así el flujo es:
// asignado → en_recoleccion → cargado → en_ruta → finalizado.
// "cargado" puede durar horas o días (se carga un día y se sale al siguiente).
function driverOnly(req) {
  const trip = tripForUser(req);
  if (req.user.role !== 'admin' && trip.driver_id !== req.user.id) throw new HttpError(403, 'Este viaje no es tuyo.');
  return trip;
}

function odometerStep(photoField, odoField, from, to, stampField, eventType, label) {
  return [
    auth.requireUser,
    upload.single('photo'),
    h(async (req, res) => {
      let trip;
      try {
        trip = driverOnly(req);
        if (trip.status !== from) throw bad('El viaje no está en el paso correcto. Actualiza la página.');
        if (!req.file) throw bad('Toma la foto del odómetro.');
        const reading = num(req.body.odometer);
        if (reading == null || reading < 0) throw bad('Escribe la lectura del odómetro (km).');
        if (odoField === 'odo_end' && trip.odo_start != null && reading < trip.odo_start) {
          throw bad(`La lectura final (${reading}) no puede ser menor que la inicial (${trip.odo_start}).`);
        }
        transaction(() => {
          run(
            `UPDATE trips SET status = ?, ${odoField} = ?, ${photoField} = ?, ${stampField} = ?, updated_at = datetime('now') WHERE id = ?`,
            to,
            reading,
            req.file.filename,
            nowLocal(),
            trip.id
          );
          if (trip.vehicle_id) run('UPDATE vehicles SET last_odometer = ? WHERE id = ?', reading, trip.vehicle_id);
          addEvent(trip.id, req.user.id, eventType, `${label} · odómetro ${reading} km`, req.body);
        });
      } catch (err) {
        if (req.file) removeUpload(req.file.filename);
        throw err;
      }
      const updated = loadTrip(trip.id);
      const summary =
        eventType === 'finalizado' && updated.km != null
          ? ` · ${Math.round(updated.km)} km${updated.km_per_liter ? ` · ${updated.km_per_liter.toFixed(2)} km/L` : ''}`
          : '';
      notify.notifyAdmins(`${updated.driver_name}: ${label.toLowerCase()} (viaje #${trip.id})`, `${updated.pickup_address} → ${updated.dest_address}${summary}`, `/admin.html#viaje-${trip.id}`);
      res.json(updated);
    }),
  ];
}

router.post('/trips/:id/start', ...odometerStep('odo_start_photo', 'odo_start', 'asignado', 'en_recoleccion', 'started_at', 'iniciado', 'Inició el viaje'));
router.post('/trips/:id/finish', ...odometerStep('odo_end_photo', 'odo_end', 'en_ruta', 'finalizado', 'finished_at', 'finalizado', 'Finalizó el viaje'));

function simpleStep(from, to, stampField, eventType, label) {
  return [
    auth.requireUser,
    h((req, res) => {
      const trip = driverOnly(req);
      if (trip.status !== from) throw bad('El viaje no está en el paso correcto. Actualiza la página.');
      run(`UPDATE trips SET status = ?, ${stampField} = ?, updated_at = datetime('now') WHERE id = ?`, to, nowLocal(), trip.id);
      addEvent(trip.id, req.user.id, eventType, str(req.body.note, 500) || label, req.body);
      const updated = loadTrip(trip.id);
      notify.notifyAdmins(`${updated.driver_name}: ${label.toLowerCase()} (viaje #${trip.id})`, `${updated.pickup_address} → ${updated.dest_address}`, `/admin.html#viaje-${trip.id}`);
      res.json(updated);
    }),
  ];
}

router.post('/trips/:id/loaded', ...simpleStep('en_recoleccion', 'cargado', 'loaded_at', 'cargado', 'Terminó de cargar'));
router.post('/trips/:id/depart', ...simpleStep('cargado', 'en_ruta', 'departed_at', 'en_ruta', 'Salió rumbo al destino'));

// Nota libre del chofer (incidencias, retrasos, etc.).
router.post(
  '/trips/:id/note',
  auth.requireUser,
  h((req, res) => {
    const trip = driverOnly(req);
    const note = str(req.body.note, 1000);
    if (!note) throw bad('Escribe la nota.');
    addEvent(trip.id, req.user.id, 'nota', note, req.body);
    notify.notifyAdmins(`Nota de ${req.user.name} (viaje #${trip.id})`, note, `/admin.html#viaje-${trip.id}`);
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
      if (req.user.role !== 'admin' && trip.status === 'finalizado') {
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
    const owner = get(
      `SELECT t.driver_id FROM trips t
        WHERE t.odo_start_photo = ? OR t.odo_end_photo = ?
           OR t.id IN (SELECT trip_id FROM fuel_loads WHERE photo = ?)`,
      file,
      file,
      file
    );
    if (!owner || (req.user.role !== 'admin' && owner.driver_id !== req.user.id)) throw new HttpError(404, 'Foto no encontrada.');
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
        if (t.km != null && t.fuel_liters > 0) {
          g.measured_trips += 1;
          g.measured_km = (g.measured_km || 0) + t.km;
          g.liters += t.fuel_liters;
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

// ---------- Recibos de pago ----------
router.use(require('./payments'));

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
