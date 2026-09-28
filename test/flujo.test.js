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
