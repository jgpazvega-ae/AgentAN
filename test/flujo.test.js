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
  const call = async (method, url, body) => {
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
  call.cookie = () => cookie;
  return call;
}
const cookieOf = async (c) => c.cookie();

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
// Salida y regreso: odómetro + foto del tablero con el nivel de combustible (0 a 1).
function odoFuelForm(reading, level) {
  const fd = odometerForm(reading);
  fd.append('fuel', new Blob([JPEG], { type: 'image/jpeg' }), 'tablero.jpg');
  if (level != null) fd.append('fuel_level', String(level));
  return fd;
}
function photoForm(extra = {}) {
  const fd = new FormData();
  fd.append('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'foto.jpg');
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  return fd;
}
// Entrega: odómetro final + fotos de prueba de entrega + quién recibe (+ firma).
function deliveryForm(reading, { pod = 1, receivedBy = 'Laura Gómez', signature = false } = {}) {
  const fd = odometerForm(reading);
  for (let i = 0; i < pod; i++) fd.append('pod', new Blob([JPEG], { type: 'image/jpeg' }), `entrega${i}.jpg`);
  if (signature) fd.append('signature', new Blob([JPEG], { type: 'image/jpeg' }), 'firma.jpg');
  fd.append('received_by', receivedBy);
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

  r = await admin('POST', '/vehicles', { name: 'Camión 1', plate: 'ABC-123', fuel_type: 'Diésel', last_odometer: 100000, tank_liters: 100 });
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
  assert.equal(r.status, 400, 'iniciar pide la foto del combustible');
  r = await driver('POST', `/trips/${tripId}/start`, odoFuelForm(100050));
  assert.equal(r.status, 400, 'iniciar pide el nivel de combustible');
  r = await driver('POST', `/trips/${tripId}/start`, odoFuelForm(100050, 0.75));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.fuel_start, 0.75);
  assert.equal(r.data.status, 'en_recoleccion');
  assert.equal(r.data.odo_start, 100050);
  const startPhoto = r.data.odo_start_photo;

  r = await driver('POST', `/trips/${tripId}/loaded`, {});
  assert.equal(r.data.status, 'cargado');
  r = await driver('POST', `/trips/${tripId}/depart`, new FormData());
  assert.equal(r.status, 400, 'salir a destino pide la foto de la carga');
  r = await driver('POST', `/trips/${tripId}/depart`, photoForm({ lat: 25.7, lng: -100.3 }));
  assert.equal(r.data.status, 'en_ruta');

  const fuel = new FormData();
  fuel.append('liters', '120');
  fuel.append('amount', '2800');
  r = await driver('POST', `/trips/${tripId}/fuel`, fuel);
  assert.equal(r.status, 201);

  r = await driver('POST', `/trips/${tripId}/finish`, deliveryForm(100950));
  assert.equal(r.status, 400, 'primero debe marcar la llegada');
  r = await driver('POST', `/trips/${tripId}/arrive`, new FormData());
  assert.equal(r.status, 400, 'la llegada pide foto');
  r = await driver('POST', `/trips/${tripId}/arrive`, photoForm());
  assert.equal(r.data.status, 'en_destino');

  r = await driver('POST', `/trips/${tripId}/finish`, deliveryForm(100950, { pod: 0 }));
  assert.equal(r.status, 400, 'la entrega pide foto de prueba de entrega');
  r = await driver('POST', `/trips/${tripId}/finish`, deliveryForm(100950, { receivedBy: '' }));
  assert.equal(r.status, 400, 'la entrega pide quién recibe');
  r = await driver('POST', `/trips/${tripId}/finish`, deliveryForm(100000));
  assert.equal(r.status, 400, 'el odómetro final no puede ser menor al inicial');
  r = await driver('POST', `/trips/${tripId}/finish`, deliveryForm(100950, { pod: 2, signature: true }));
  assert.equal(r.data.status, 'entregado');
  assert.equal(r.data.received_by, 'Laura Gómez');
  assert.equal(r.data.km_delivery, 900);

  // Al llegar a su domicilio o base: odómetro y combustible otra vez.
  r = await driver('POST', `/trips/${tripId}/return`, odometerForm(101065));
  assert.equal(r.status, 400, 'el regreso pide la foto del combustible');
  r = await driver('POST', `/trips/${tripId}/return`, odoFuelForm(100900, 0.5));
  assert.equal(r.status, 400, 'el odómetro al regresar no puede ser menor al de la entrega');
  r = await driver('POST', `/trips/${tripId}/return`, odoFuelForm(101065, 1.5));
  assert.equal(r.status, 400, 'nivel de combustible inválido');
  r = await driver('POST', `/trips/${tripId}/return`, odoFuelForm(101065, 0.5));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'finalizado');
  assert.equal(r.data.km_return, 115);
  assert.equal(r.data.km, 1015, 'recorrido completo: de la salida al regreso');
  assert.equal(r.data.fuel_level_liters, 25, '(3/4 − 1/2) × 100 L');
  assert.equal(r.data.fuel_used, 145, '120 L cargados + 25 L que bajó la aguja');
  assert.equal(r.data.km_per_liter, 7);

  // Fotos: el dueño del viaje y el admin sí, otro chofer no.
  assert.equal((await fetch(`${base}/photos/${startPhoto}`)).status, 401);
  r = await other('GET', `/photos/${startPhoto}`);
  assert.equal(r.status, 404);

  // Reporte
  r = await admin('GET', '/reports/fuel');
  assert.equal(r.data.trips.length, 1);
  assert.equal(r.data.byVehicle[0].km_per_liter, 7);
  assert.equal(r.data.byDriver[0].label, 'Juan Chofer');

  r = await admin('GET', `/trips/${tripId}`);
  assert.deepEqual(
    r.data.events.map((e) => e.type),
    ['creado', 'iniciado', 'cargado', 'en_ruta', 'combustible', 'llegada', 'entregado', 'finalizado']
  );
  assert.deepEqual(
    r.data.photos.map((p) => p.kind),
    ['carga', 'llegada', 'entrega', 'entrega', 'firma'],
    'fotos de cada etapa guardadas en la plataforma'
  );
  const vehicles = (await admin('GET', '/vehicles')).data;
  assert.equal(vehicles[0].last_odometer, 101065);
  assert.equal(vehicles[0].tank_liters, 100);
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

test('recibos de pago semanal y bono', async () => {
  const admin = client();
  const driver = client();
  await admin('POST', '/login', { email: 'dueno@example.com', password: 'secreto123' });
  await driver('POST', '/login', { email: 'juan@example.com', password: 'chofer123' });
  const juan = (await admin('GET', '/users')).data.find((u) => u.email === 'juan@example.com');

  // El viaje de la primera prueba terminó hoy: se busca en la semana actual.
  const info = (await admin('GET', '/payments/week-info')).data;
  let r = await admin('GET', `/payments/week-trips?driver_id=${juan.id}&year=${info.current.year}&week=${info.current.week}`);
  assert.equal(r.data.trips.length, 1);
  const trip = r.data.trips[0];

  r = await admin('POST', '/payments', {
    kind: 'semanal',
    driver_id: juan.id,
    year: info.current.year,
    week: info.current.week,
    paid_at: '2026-10-05',
    method: 'Transferencia',
    notes: 'Pago por destajo de 1 viaje',
    items: [{ trip_id: trip.id, description: `Viaje #${trip.id}`, amount: 1800 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.amount, 1800, 'el total se calcula con los renglones');
  assert.match(r.data.folio, /^P-\d{5}$/);
  const weeklyId = r.data.id;

  r = await admin('GET', `/payments/week-trips?driver_id=${juan.id}&year=${info.current.year}&week=${info.current.week}`);
  assert.equal(r.data.trips[0].paid_in, weeklyId, 'el viaje queda marcado como pagado');
  assert.equal(r.data.existing.length, 1);

  // Semana sin viajes: se permite con importe manual.
  r = await admin('POST', '/payments', { kind: 'semanal', driver_id: juan.id, year: 2026, week: 1, paid_at: '2026-01-05', amount: 500, notes: 'Pago a cuenta' });
  assert.equal(r.status, 201);
  r = await admin('POST', '/payments', { kind: 'semanal', driver_id: juan.id, year: 2026, week: 54, paid_at: '2026-01-05', amount: 1 });
  assert.equal(r.status, 400, 'semana inválida');
  r = await admin('POST', '/payments', { kind: 'bono', driver_id: juan.id, paid_at: '2026-10-05', amount: 300 });
  assert.equal(r.status, 400, 'el bono requiere descripción');
  r = await admin('POST', '/payments', { kind: 'bono', driver_id: juan.id, paid_at: '2026-10-05', amount: 300, description: 'Puntualidad' });
  assert.equal(r.status, 201);
  assert.match(r.data.folio, /^B-/);
  const bonusId = r.data.id;

  // El chofer ve sus recibos, descarga el PDF y confirma.
  r = await driver('GET', '/payments');
  assert.equal(r.data.length, 3);
  r = await driver('POST', `/payments/${bonusId}/ack`);
  assert.ok(r.data.acknowledged_at);
  r = await driver('POST', '/payments', { kind: 'bono', driver_id: juan.id, paid_at: '2026-10-05', amount: 1, description: 'x' });
  assert.equal(r.status, 403, 'el chofer no puede crear recibos');

  const pdf = await fetch(`${base}/payments/${weeklyId}/pdf`, { headers: { cookie: await cookieOf(driver) } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');

  const other = client();
  await other('POST', '/setup', {});
  r = await other('GET', `/payments/${weeklyId}`);
  assert.equal(r.status, 401);

  r = await admin('POST', `/payments/${weeklyId}/cancel`, { reason: 'Error de captura' });
  assert.equal(r.data.status, 'cancelado');
  r = await driver('POST', `/payments/${weeklyId}/ack`);
  assert.equal(r.status, 400);
});

test('página pública, datos de la empresa y cotizaciones', async () => {
  const admin = client();
  const visitor = client();
  await admin('POST', '/login', { email: 'dueno@example.com', password: 'secreto123' });

  const home = await fetch(base.replace('/api', '/'));
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /AN Mobility Group/);
  assert.match(html, /href="\/login\.html"/);
  assert.doesNotMatch(html, /\{\{|<!--if:/, 'no quedan marcadores sin reemplazar');
  assert.doesNotMatch(html, /id="nosotros"/, 'sin texto de "Nosotros" no se muestra la sección');

  let r = await visitor('PUT', '/site', { name: 'X' });
  assert.equal(r.status, 401);
  r = await admin('PUT', '/site', { about: 'Somos una empresa <familiar>.', whatsapp: '81 1234 5678', quotes_email: 'ventas@example.com' });
  assert.equal(r.status, 200);
  r = await visitor('GET', '/site');
  assert.equal(r.data.quotes_email, undefined, 'el correo interno no es público');
  const html2 = await (await fetch(base.replace('/api', '/'))).text();
  assert.match(html2, /Somos una empresa &lt;familiar&gt;\./, 'el texto se escapa');
  assert.match(html2, /https:\/\/wa\.me\/528112345678/);

  r = await visitor('POST', '/quotes', { name: 'Cliente', origin: 'Monterrey' });
  assert.equal(r.status, 400, 'pide teléfono o correo');
  r = await visitor('POST', '/quotes', { name: 'Robot', phone: '1', website: 'spam' });
  assert.equal(r.status, 200);
  r = await visitor('POST', '/quotes', { name: 'Cliente Uno', phone: '8111111111', origin: 'Monterrey', destination: 'Saltillo', cargo: '5 tarimas' });
  assert.equal(r.status, 201);
  r = await visitor('GET', '/quotes');
  assert.equal(r.status, 401);
  r = await admin('GET', '/quotes');
  assert.equal(r.data.length, 1, 'la solicitud del robot no se guarda');
  r = await admin('PUT', `/quotes/${r.data[0].id}`, { status: 'atendida' });
  assert.equal(r.status, 200);
});

test('tarifas del cotizador y versión para GitHub Pages', async () => {
  const { DEFAULT_PRICING, estimate } = require('../src/pricing');
  // Base de $1,500 dentro de 40 km; después, km adicionales por unidad.
  assert.equal(estimate(DEFAULT_PRICING, { vehicle: 't35', km: 30 }).total, 1500);
  assert.equal(estimate(DEFAULT_PRICING, { vehicle: 't35', km: 171 }).total, 5550);
  assert.equal(estimate(DEFAULT_PRICING, { vehicle: 'van', km: 335 }).total, 8300);
  // Monterrey: 1 noche de viáticos ($1,500) por pasar de 450 km.
  const mty = estimate(DEFAULT_PRICING, { vehicle: 'van', km: 690 });
  assert.equal(mty.nights, 1);
  assert.equal(mty.total, 16450 + 1500);
  assert.equal(estimate(DEFAULT_PRICING, { vehicle: 'grande', km: 690 }), null, 'unidad grande: cotización especial');
  // Precio de lista (tarjeta): el descuento de 4% por efectivo/transferencia cubre la comisión.
  assert.equal(estimate(DEFAULT_PRICING, { vehicle: 't35', km: 171 }).list, 5790);
  assert.equal(estimate(DEFAULT_PRICING, { vehicle: 't35', km: 20 }).list, 1570);
  const { listPrice } = require('../src/pricing');
  assert.equal(listPrice({ ...DEFAULT_PRICING, cash_discount: 0 }, 4900), 4900, 'sin descuento, lista = precio');

  const admin = client();
  await admin('POST', '/login', { email: 'dueno@example.com', password: 'secreto123' });
  let r = await admin('PUT', '/pricing', { included_km: 40, vehicles: { t35: { base: 1800, per_km: 28 }, van: { base: 1500, per_km: 18, enabled: false } } });
  assert.equal(r.status, 200);
  const pub = (await fetch(`${base}/pricing`).then((x) => x.json()));
  const vehicles = pub.services.flatMap((s) => s.vehicles);
  assert.equal(vehicles.find((v) => v.id === 't35').base, 1800);
  assert.ok(!vehicles.some((v) => v.id === 'van'), 'la unidad desactivada no se muestra al público');
  const html = await (await fetch(base.replace('/api', '/'))).text();
  assert.match(html, /"per_km":28/);

  const visitor = client();
  r = await visitor('POST', '/quotes', { name: 'Con estimado', phone: '4420000000', service: 'Flete', vehicle: 'Camioneta 3.5 toneladas', km: 171, estimate: 5400 });
  assert.equal(r.status, 201);
  const q = (await admin('GET', '/quotes')).data[0];
  assert.equal(q.estimate, 5400);
  assert.equal(q.vehicle, 'Camioneta 3.5 toneladas');

  // Versión estática
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-pages.js')]);
  const out = path.join(__dirname, '..', '_site');
  const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(page, /(href|src)="\/[^/]/, 'solo rutas relativas');
  assert.match(page, /"static":true/);
  assert.match(page, /id="cuanto-pagare"/, 'sección ¿Cuánto pagaré?');
  assert.match(page, /"mapsKey":""/, 'sin llave de Google no se activa la ruta personalizada');

  // Ruta personalizada: la mitad del recorrido completo de la unidad.
  const { routeKm } = require('../src/pricing');
  assert.equal(routeKm({ baseToOrigin: 0, originToDest: 171, destToBase: 171 }), 171, 'saliendo de Querétaro = viaje normal');
  assert.equal(routeKm({ baseToOrigin: 171, originToDest: 480, destToBase: 335 }), 493, 'León → Puebla');
  for (const f of ['css/site.css', 'js/cotizador.js', 'img/logo.png', 'login.html']) assert.ok(fs.existsSync(path.join(out, f)), f);
});

test('impuestos del cotizador por tipo de cliente', async () => {
  const { DEFAULT_PRICING, taxBreakdown } = require('../src/pricing');
  // León en 3.5 t: subtotal $4,900
  let t = taxBreakdown(DEFAULT_PRICING, { subtotal: 4900, clientType: 'moral', service: 'flete' });
  assert.deepEqual(t.lines.map((l) => l.amount), [784, -196, -61.25]);
  assert.equal(t.total, 5426.75);
  t = taxBreakdown(DEFAULT_PRICING, { subtotal: 4900, clientType: 'fisica', service: 'flete' });
  assert.equal(t.total, 5684, 'persona física: solo IVA');
  t = taxBreakdown(DEFAULT_PRICING, { subtotal: 4900, clientType: 'moral', service: 'ejecutivo' });
  assert.equal(t.total, 5622.75, 'viaje ejecutivo: sin retención de IVA de fletes');

  const admin = client();
  await admin('POST', '/login', { email: 'dueno@example.com', password: 'secreto123' });
  const current = (await admin('GET', '/pricing')).data;
  const rules = { fisica: { iva: true, ret_iva: true, ret_isr: false }, moral: { iva: true, ret_iva: true, ret_isr: false } };
  let r = await admin('PUT', '/pricing', { included_km: current.included_km, vehicles: {}, taxes: { iva: 16, ret_iva: 4, ret_isr: 1.25, rules } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.taxes.rules.fisica, rules.fisica, 'las reglas se pueden ajustar');
  r = await admin('PUT', '/pricing', { included_km: 40, vehicles: {}, taxes: { iva: 99, ret_iva: 4, ret_isr: 1.25, rules } });
  assert.equal(r.status, 400);
  r = await admin('PUT', '/pricing', { included_km: 40, vehicles: {}, cash_discount: 3.5 });
  assert.equal(r.data.cash_discount, 3.5);
  assert.equal(r.data.taxes.rules.fisica.ret_iva, true, 'guardar el descuento no borra los impuestos');
  r = await admin('PUT', '/pricing', { included_km: 40, vehicles: {}, cash_discount: 30 });
  assert.equal(r.status, 400);
  r = await admin('PUT', '/pricing', { included_km: 40, vehicles: {}, overnight_km: 400, overnight_cost: 1800 });
  assert.equal(r.data.overnight_cost, 1800);
  assert.equal(r.data.cash_discount, 3.5, 'guardar viáticos no borra el descuento');
  assert.deepEqual((await admin('GET', '/pricing')).data.payment_methods.length, 3);

  const visitor = client();
  r = await visitor('POST', '/quotes', { name: 'Empresa SA', company: 'Empresa SA de CV', phone: '4421234567', client_type: 'moral', payment_method: 'Transferencia', estimate: 4900, list_price: 5110, total: 5426.75, km: 171 });
  assert.equal(r.status, 201);
  const q = (await admin('GET', '/quotes')).data[0];
  assert.equal(q.client_type, 'moral');
  assert.equal(q.total, 5426.75);
  assert.equal(q.payment_method, 'Transferencia');
  assert.equal(q.list_price, 5110);
});

test('perfiles: superadministrador, personal de AN, choferes y clientes', async () => {
  const boss = client();
  await boss('POST', '/login', { email: 'dueno@example.com', password: 'secreto123' });
  assert.equal((await boss('GET', '/me')).data.role, 'superadmin', 'quien configuró la plataforma es el superadministrador');

  // El superadministrador da de alta al personal de AN.
  let r = await boss('POST', '/users', { name: 'Ana Oficina', email: 'ana@example.com', password: 'personal123', role: 'admin' });
  assert.equal(r.status, 201);
  const staff = client();
  r = await staff('POST', '/login', { email: 'ana@example.com', password: 'personal123' });
  assert.equal(r.data.home, '/admin.html');

  // El personal da de alta choferes y clientes, pero no a más personal.
  r = await staff('POST', '/users', { name: 'Otro', email: 'otro@example.com', password: 'personal123', role: 'admin' });
  assert.equal(r.status, 403);
  r = await staff('POST', '/users', { name: 'Carla Cliente', email: 'carla@example.com', password: 'cliente123', role: 'client', company: 'Abarrotes SA' });
  assert.equal(r.status, 201);
  const clientId = r.data.id;
  const bossId = (await boss('GET', '/me')).data.id;
  r = await staff('PUT', `/users/${bossId}`, { name: 'Cambio' });
  assert.equal(r.status, 403, 'nadie modifica al superadministrador');
  r = await boss('PUT', `/users/${bossId}`, { active: false });
  assert.equal(r.status, 400, 'el superadministrador no se desactiva a sí mismo');
  r = await boss('PUT', `/users/${bossId}`, { role: 'driver' });
  assert.equal(r.status, 400);
  r = await staff('PUT', '/site', { name: 'Otra empresa' });
  assert.equal(r.status, 403, 'datos de la empresa: solo el superadministrador');
  r = await staff('PUT', '/pricing', { included_km: 40, vehicles: {} });
  assert.equal(r.status, 403, 'tarifas: solo el superadministrador');

  // Viaje de un cliente.
  const juan = (await boss('GET', '/users')).data.find((u) => u.email === 'juan@example.com');
  r = await staff('POST', '/trips', { driver_id: juan.id, client_id: clientId, pickup_address: 'Bodega', dest_address: 'Tienda', pickup_at: '2026-10-10T09:00' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const tripId = r.data.id;
  assert.equal(r.data.client, 'Abarrotes SA', 'toma la empresa del cliente');
  r = await staff('POST', '/trips', { driver_id: clientId, pickup_address: 'A', dest_address: 'B', pickup_at: '2026-10-10T09:00' });
  assert.equal(r.status, 400, 'un cliente no puede ser chofer');

  const driver = client();
  await driver('POST', '/login', { email: 'juan@example.com', password: 'chofer123' });
  r = await driver('POST', `/trips/${tripId}/start`, odoFuelForm(101100, 1));
  const odoPhoto = r.data.odo_start_photo;
  const fuelPhoto = r.data.fuel_start_photo;
  await driver('POST', `/trips/${tripId}/loaded`, {});
  r = await driver('POST', `/trips/${tripId}/depart`, photoForm());
  assert.equal(r.data.status, 'en_ruta');

  const cli = client();
  r = await cli('POST', '/login', { email: 'carla@example.com', password: 'cliente123' });
  assert.equal(r.data.home, '/cliente.html');
  r = await cli('GET', '/trips');
  assert.equal(r.data.length, 1, 'el cliente solo ve sus envíos');
  assert.equal(r.data[0].status, 'en_ruta');
  assert.equal(r.data[0].odo_start, undefined, 'sin datos internos (odómetro)');
  assert.equal(r.data[0].notes, undefined);
  assert.equal(r.data[0].photos[0].kind, 'carga');
  r = await cli('GET', `/photos/${r.data[0].photos[0].file}`);
  assert.equal(r.status, 200, 've la foto de la carga');
  r = await cli('GET', `/photos/${odoPhoto}`);
  assert.equal(r.status, 404, 'no ve la foto del odómetro');
  r = await cli('GET', `/photos/${fuelPhoto}`);
  assert.equal(r.status, 404, 'no ve la foto del combustible');
  r = await cli('POST', `/trips/${tripId}/arrive`, photoForm());
  assert.equal(r.status, 403, 'el cliente no mueve el viaje');
  r = await cli('GET', '/users');
  assert.equal(r.status, 403);
  r = await cli('GET', '/payments');
  assert.equal(r.data.length, 0);
});

test('migración: una base de datos anterior conserva sus datos y el primer admin pasa a superadministrador', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fletes-mig-'));
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'fletes.db'));
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'driver')), active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, plate TEXT, fuel_type TEXT, last_odometer REAL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER REFERENCES users(id), vehicle_id INTEGER REFERENCES vehicles(id),
      client TEXT, cargo TEXT, notes TEXT, pickup_address TEXT NOT NULL, pickup_lat REAL, pickup_lng REAL, pickup_at TEXT NOT NULL,
      dest_address TEXT NOT NULL, dest_lat REAL, dest_lng REAL, delivery_at TEXT,
      status TEXT NOT NULL DEFAULT 'asignado' CHECK (status IN ('asignado', 'en_recoleccion', 'cargado', 'en_ruta', 'finalizado', 'cancelado')),
      started_at TEXT, odo_start REAL, odo_start_photo TEXT, loaded_at TEXT, departed_at TEXT, finished_at TEXT, odo_end REAL,
      odo_end_photo TEXT, cancelled_at TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (name, email, password_hash, role) VALUES ('Dueño', 'd@x.com', 'h', 'admin'), ('Chofer', 'c@x.com', 'h', 'driver');
    INSERT INTO trips (driver_id, pickup_address, pickup_at, dest_address, status) VALUES (2, 'A', '2026-01-01T10:00', 'B', 'en_ruta');
  `);
  old.close();
  const out = execFileSync(
    process.execPath,
    ['-e', `
      const { get, run } = require('./src/db');
      const boss = get("SELECT role FROM users WHERE email = 'd@x.com'");
      const trip = get('SELECT * FROM trips WHERE id = 1');
      run("UPDATE trips SET status = 'en_destino' WHERE id = 1");
      run("INSERT INTO users (name, email, password_hash, role) VALUES ('Cli', 'cli@x.com', 'h', 'client')");
      console.log(JSON.stringify({ role: boss.role, status: trip.status, driver: trip.driver_id }));
    `],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { role: 'superadmin', status: 'en_ruta', driver: 2 });
  fs.rmSync(dir, { recursive: true, force: true });
});
