// Prueba de punta a punta: admin crea chofer, vehículo y viaje; el chofer lo
// recorre con fotos del odómetro y se calcula el rendimiento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletes-test-'));
process.env.DATA_DIR = dataDir;
process.env.SMTP_HOST = '';

const app = require('../src/server');
let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = { cookie };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

// JPEG mínimo (1x1) para simular la foto del odómetro.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);
function odometerForm(reading) {
  const fd = new FormData();
  fd.append('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'odo.jpg');
  fd.append('odometer', String(reading));
  return fd;
}

test('flujo completo de un viaje', async () => {
  const admin = client();
  const driver = client();
  const other = client();

  let r = await admin('GET', '/config');
  assert.equal(r.data.needsSetup, true);

  r = await admin('POST', '/setup', { name: 'Dueño', email: 'dueno@example.com', password: 'secreto123' });
  assert.equal(r.status, 200);
  r = await other('POST', '/setup', { name: 'Intruso', email: 'x@example.com', password: 'secreto123' });
  assert.equal(r.status, 403, 'la configuración inicial solo se puede hacer una vez');

  r = await admin('POST', '/users', { name: 'Juan Chofer', email: 'juan@example.com', password: 'chofer123', role: 'driver' });
  assert.equal(r.status, 201);
  const driverId = r.data.id;
  await admin('POST', '/users', { name: 'Pedro', email: 'pedro@example.com', password: 'chofer123', role: 'driver' });

  r = await admin('POST', '/vehicles', { name: 'Camión 1', plate: 'ABC-123', fuel_type: 'Diésel', last_odometer: 100000 });
  const vehicleId = r.data.id;

  // Se carga un día y se entrega al siguiente.
  r = await admin('POST', '/trips', {
    driver_id: driverId,
    vehicle_id: vehicleId,
    pickup_address: 'Bodega Norte, Monterrey',
    pickup_lat: 25.6866,
    pickup_lng: -100.3161,
    pickup_at: '2026-10-01T16:00',
    dest_address: 'Centro de distribución, CDMX',
    delivery_at: '2026-10-02T12:00',
    client: 'ACME',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const tripId = r.data.id;
  assert.equal(r.data.status, 'asignado');

  r = await admin('POST', '/trips', { driver_id: driverId, pickup_address: 'A', dest_address: 'B', pickup_at: '2026-10-02T10:00', delivery_at: '2026-10-01T10:00' });
  assert.equal(r.status, 400, 'la entrega no puede ser antes de la recolección');

  // El chofer inicia sesión y solo ve sus viajes.
  r = await driver('POST', '/login', { email: 'JUAN@example.com', password: 'chofer123' });
  assert.equal(r.data.role, 'driver');
  r = await driver('GET', '/trips?scope=open');
  assert.equal(r.data.length, 1);
  r = await driver('GET', '/users');
  assert.equal(r.status, 403, 'el chofer no puede ver usuarios');

  await other('POST', '/login', { email: 'pedro@example.com', password: 'chofer123' });
  r = await other('GET', `/trips/${tripId}`);
  assert.equal(r.status, 404, 'otro chofer no ve el viaje');

  // No se puede saltar pasos.
  r = await driver('POST', `/trips/${tripId}/depart`, {});
  assert.equal(r.status, 400);

  // Iniciar sin foto falla; con foto funciona.
  const noPhoto = new FormData();
  noPhoto.append('odometer', '100050');
  r = await driver('POST', `/trips/${tripId}/start`, noPhoto);
  assert.equal(r.status, 400);
  r = await driver('POST', `/trips/${tripId}/start`, odometerForm(100050));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'en_recoleccion');
  assert.equal(r.data.odo_start, 100050);
  const startPhoto = r.data.odo_start_photo;

  r = await driver('POST', `/trips/${tripId}/loaded`, {});
  assert.equal(r.data.status, 'cargado');
  r = await driver('POST', `/trips/${tripId}/depart`, { lat: 25.7, lng: -100.3 });
  assert.equal(r.data.status, 'en_ruta');

  const fuel = new FormData();
  fuel.append('liters', '120');
  fuel.append('amount', '2800');
  r = await driver('POST', `/trips/${tripId}/fuel`, fuel);
  assert.equal(r.status, 201);

  r = await driver('POST', `/trips/${tripId}/finish`, odometerForm(100000));
  assert.equal(r.status, 400, 'el odómetro final no puede ser menor al inicial');
  r = await driver('POST', `/trips/${tripId}/finish`, odometerForm(100950));
  assert.equal(r.data.status, 'finalizado');
  assert.equal(r.data.km, 900);
  assert.equal(r.data.km_per_liter, 7.5);

  // Fotos: el dueño del viaje y el admin sí, otro chofer no.
  assert.equal((await fetch(`${base}/photos/${startPhoto}`)).status, 401);
  r = await other('GET', `/photos/${startPhoto}`);
  assert.equal(r.status, 404);

  // Reporte
  r = await admin('GET', '/reports/fuel');
  assert.equal(r.data.trips.length, 1);
  assert.equal(r.data.byVehicle[0].km_per_liter, 7.5);
  assert.equal(r.data.byDriver[0].label, 'Juan Chofer');

  r = await admin('GET', `/trips/${tripId}`);
  assert.deepEqual(
    r.data.events.map((e) => e.type),
    ['creado', 'iniciado', 'cargado', 'en_ruta', 'combustible', 'finalizado']
  );
  const vehicles = (await admin('GET', '/vehicles')).data;
  assert.equal(vehicles[0].last_odometer, 100950);
});

test('reasignar y cancelar', async () => {
  const admin = client();
  await admin('POST', '/login', { email: 'dueno@example.com', password: 'secreto123' });
  const users = (await admin('GET', '/users')).data;
  const juan = users.find((u) => u.email === 'juan@example.com');
  const pedro = users.find((u) => u.email === 'pedro@example.com');
  let r = await admin('POST', '/trips', { driver_id: juan.id, pickup_address: 'A', dest_address: 'B', pickup_at: '2026-10-05T09:00' });
  const id = r.data.id;
  r = await admin('PUT', `/trips/${id}`, { driver_id: pedro.id, pickup_address: 'A', dest_address: 'B', pickup_at: '2026-10-05T10:00' });
  assert.equal(r.data.driver_name, 'Pedro');
  r = await admin('POST', `/trips/${id}/cancel`, { reason: 'Cliente canceló' });
  assert.equal(r.data.status, 'cancelado');
  r = await admin('DELETE', `/trips/${id}`);
  assert.equal(r.status, 200);

  // Un chofer desactivado ya no puede entrar.
  await admin('PUT', `/users/${pedro.id}`, { active: false });
  const p = client();
  r = await p('POST', '/login', { email: 'pedro@example.com', password: 'chofer123' });
  assert.equal(r.status, 401);
});
