// Panel del administrador: viajes, choferes, vehículos y rendimiento.
let cfg = {};
let me = null;
let users = [];
let vehicles = [];
let trips = [];
let editingTrip = null;
let returnParent = null; // viaje de ida cuando se crea su viaje de regreso
let editingUser = null;
let editingVehicle = null;
let pickupPicker;
let destPicker;
let prepickupPicker;
let fillingTripForm = false; // mientras se llena el formulario no se recalcula la ruta

async function init() {
  registerServiceWorker();
  [cfg, me] = await Promise.all([api('/config'), api('/me')]);
  if (!isStaffRole(me.role)) {
    location.href = me.home;
    return;
  }
  // Datos de la empresa y tarifas: solo el superadministrador.
  if (me.role !== 'superadmin') $('.tabs [data-tab=company]').classList.add('hidden');
  if (me.role !== 'superadmin') $('#user-form [name=role] option[value=admin]').remove();
  $('#brand').textContent = me.role === 'superadmin' ? 'Administración · Superadministrador' : 'Administración';
  document.title = `Administración · ${cfg.companyName}`;
  $('#menu-name').textContent = me.name;
  $('#menu-email').textContent = me.email;
  $('#menu-email-status').textContent = cfg.emailEnabled
    ? '✉️ Envío de correos activo.'
    : '✉️ El envío de correos no está configurado (ver README: variables SMTP).';
  const routeChanged = () => !fillingTripForm && scheduleRoute();
  pickupPicker = new PlacePicker($('#pickup-picker'), { apiKey: cfg.googleMapsApiKey, placeholder: 'Dirección del punto de inicio', onChange: routeChanged });
  destPicker = new PlacePicker($('#dest-picker'), { apiKey: cfg.googleMapsApiKey, placeholder: 'Dirección de destino', onChange: routeChanged });
  prepickupPicker = new PlacePicker($('#prepickup-picker'), { apiKey: cfg.googleMapsApiKey, placeholder: 'Dirección de la recolección anticipada' });
  syncPushSubscription();
  renderBanners();
  await Promise.all([loadUsers(), loadVehicles()]);
  await loadTrips();
  refreshQuotesCount();
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
  setInterval(() => document.visibilityState === 'visible' && !$('#tab-trips').classList.contains('hidden') && loadTrips(), 60000);
  navigator.serviceWorker?.addEventListener('message', (e) => e.data?.type === 'push' && loadTrips());
}

function openFromHash() {
  if (location.hash === '#pagos') return switchTab('payments');
  if (location.hash === '#cotizaciones') return switchTab('quotes');
  const m = location.hash.match(/viaje-(\d+)/);
  if (m) openDetail(Number(m[1]));
}

// ---------- Pestañas ----------
function switchTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${name}`));
  if (name === 'trips') loadTrips();
  if (name === 'drivers') loadUsers();
  if (name === 'vehicles') loadVehicles();
  if (name === 'payments') loadPayments();
  if (name === 'report') loadReport();
  if (name === 'quotes') loadQuotes();
  if (name === 'company') loadCompany();
}
$$('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

// ---------- Viajes ----------
async function loadTrips() {
  const params = new URLSearchParams();
  if ($('#f-scope').value) params.set('scope', $('#f-scope').value);
  if ($('#f-driver').value) params.set('driver_id', $('#f-driver').value);
  try {
    trips = await api(`/trips?${params}`);
    renderTrips();
  } catch (err) {
    $('#trips-body').innerHTML = `<tr><td colspan="8">${esc(err.message)}</td></tr>`;
  }
}

function renderTrips() {
  const body = $('#trips-body');
  if (!trips.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">No hay viajes. Crea uno con “Nuevo viaje”.</td></tr>`;
    return;
  }
  body.innerHTML = trips
    .map(
      (t) => `
      <tr class="clickable" data-id="${t.id}">
        <td>${t.id}</td>
        <td>${statusBadge(t.status)}${t.paused ? '<div><span class="badge st-pausa">⏸ En pausa</span></div>' : ''}${t.parent_trip_id ? `<div class="muted small">↩ regreso de #${t.parent_trip_id}</div>` : ''}</td>
        <td style="white-space:nowrap">${esc(fmtDate(t.pickup_at))}${t.prepickup_at ? `<div class="muted small">📦 ${esc(fmtDate(t.prepickup_at))}</div>` : ''}</td>
        <td>${t.name ? `<b>${esc(t.name)}</b>` : ''}<div class="${t.name ? 'muted small' : ''}">${esc(t.pickup_address)}</div><div class="muted small">→ ${esc(t.dest_address)}</div></td>
        <td style="white-space:nowrap">${t.eta ? `<span class="eta-chip">${esc(fmtDate(t.eta))}</span>${t.eta_live_at ? '<div class="muted small">en ruta</div>' : ''}` : '<span class="muted">—</span>'}</td>
        <td>${esc(t.driver_name || '—')}<div class="muted small">${esc(t.vehicle_name || '')}</div>${
          t.last_location && !['finalizado', 'cancelado'].includes(t.status) ? `<div class="small">📍 ${esc(fmtAgo(t.last_location.at))}</div>` : ''
        }</td>
        <td class="num">${t.km != null ? fmtNum(t.km) : '—'}</td>
        <td class="num">${t.km_per_liter ? fmtNum(t.km_per_liter, 2) : '—'}</td>
      </tr>`
    )
    .join('');
}

$('#trips-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) openDetail(Number(row.dataset.id));
});
$('#f-scope').onchange = loadTrips;
$('#f-driver').onchange = loadTrips;

function fillSelects() {
  // Choferes (y personal, por si alguien de la oficina hace un viaje); nunca clientes.
  const drivers = users.filter((u) => u.active && u.role !== 'client');
  $('#trip-form [name=driver_id]').innerHTML =
    '<option value="">— Selecciona —</option>' +
    drivers.map((u) => `<option value="${u.id}">${esc(u.name)}${u.role !== 'driver' ? ` (${ROLE_LABEL[u.role]})` : ''}</option>`).join('');
  const clients = users.filter((u) => u.active && u.role === 'client');
  $('#trip-form [name=client_id]').innerHTML =
    '<option value="">— Ninguno —</option>' +
    clients.map((u) => `<option value="${u.id}">${esc(u.company ? `${u.company} · ${u.name}` : u.name)}</option>`).join('');
  const current = $('#f-driver').value;
  $('#f-driver').innerHTML =
    '<option value="">Todos</option>' + users.filter((u) => u.role !== 'client').map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  $('#f-driver').value = current;
  $('#trip-form [name=vehicle_id]').innerHTML =
    '<option value="">— Sin asignar —</option>' +
    vehicles.filter((v) => v.active).map((v) => `<option value="${v.id}">${esc(v.name)}${v.plate ? ` · ${esc(v.plate)}` : ''}</option>`).join('');
}

// returnOf: viaje de ida para crear su viaje de regreso (misma unidad y chofer).
function openTripForm(trip, returnOf = null) {
  editingTrip = trip || null;
  returnParent = returnOf;
  const form = $('#trip-form');
  form.reset();
  fillSelects();
  form.querySelector('.msg').innerHTML = '';
  $('#trip-form-title').textContent = trip ? `Editar viaje #${trip.id}` : returnOf ? `Viaje de regreso del #${returnOf.id}` : 'Nuevo viaje';
  $('#trip-save').textContent = trip ? 'Guardar cambios' : 'Guardar y avisar al chofer';
  $('#odo-fix').classList.toggle('hidden', !trip || trip.odo_start == null);
  const t = trip || (returnOf
    ? {
        name: `Regreso${returnOf.name ? ` · ${returnOf.name}` : ''}`,
        driver_id: returnOf.driver_id,
        driver_name: returnOf.driver_name,
        vehicle_id: returnOf.vehicle_id,
        vehicle_name: returnOf.vehicle_name,
        pickup_address: returnOf.dest_address,
        pickup_lat: returnOf.dest_lat,
        pickup_lng: returnOf.dest_lng,
        dest_address: returnOf.pickup_address,
        dest_lat: returnOf.pickup_lat,
        dest_lng: returnOf.pickup_lng,
        overnight_nights: 0,
      }
    : {});
  if (trip || returnOf) {
    // Si el chofer o vehículo ya está inactivo, se agrega para no perderlo.
    for (const [sel, id, label] of [
      ['driver_id', t.driver_id, t.driver_name],
      ['vehicle_id', t.vehicle_id, t.vehicle_name],
      ['client_id', t.client_id, t.client_name],
    ]) {
      const select = form[sel];
      if (id && ![...select.options].some((o) => Number(o.value) === id)) select.add(new Option(label, id));
    }
  }
  form.driver_id.value = t.driver_id || '';
  // La ida y el regreso comparten chofer y unidad.
  const linked = Boolean(returnOf || t.parent_trip_id || t.return_trip_id);
  form.driver_id.disabled = Boolean(linked || (trip && trip.status !== 'asignado'));
  form.vehicle_id.value = t.vehicle_id || '';
  form.vehicle_id.disabled = linked;
  form.overnight_nights.value = String(t.overnight_nights || 0);
  if (![...form.overnight_nights.options].some((o) => o.value === String(t.overnight_nights || 0))) form.overnight_nights.add(new Option(`${t.overnight_nights} noches`, t.overnight_nights));
  form.overnight_nights.value = String(t.overnight_nights || 0);
  form.lodging_notes.value = t.lodging_notes || '';
  form.client_id.value = t.client_id || '';
  form.elements.name.value = t.name || '';
  form.notify_emails.value = t.notify_emails || '';
  form.pickup_at.value = t.pickup_at || '';
  form.delivery_at.value = t.delivery_at || '';
  form.has_prepickup.checked = Boolean(t.prepickup_address);
  form.prepickup_at.value = t.prepickup_at || '';
  routeState = { km: t.route_km ?? null, source: t.route_source || null };
  setRouteMinutes(t.route_minutes ?? null);
  $('#route-info').textContent = t.route_minutes != null ? routeInfoText() : 'Elige el punto de inicio y el destino para calcular la ruta.';
  form.client.value = t.client || '';
  form.cargo.value = t.cargo || '';
  form.notes.value = t.notes || '';
  form.odo_start.value = t.odo_start ?? '';
  form.odo_end.value = t.odo_end ?? '';
  form.odo_return.value = t.odo_return ?? '';
  fillingTripForm = true;
  pickupPicker.setValue({ address: t.pickup_address, lat: t.pickup_lat, lng: t.pickup_lng });
  destPicker.setValue({ address: t.dest_address, lat: t.dest_lat, lng: t.dest_lng });
  prepickupPicker.setValue({ address: t.prepickup_address, lat: t.prepickup_lat, lng: t.prepickup_lng });
  fillingTripForm = false;
  syncPrepickup();
  updateEta();
  $('#trip-dialog').showModal();
}

// ---------- Recolección anticipada ----------
function syncPrepickup() {
  const on = $('#trip-form').has_prepickup.checked;
  $('#prepickup-box').classList.toggle('hidden', !on);
  $('#trip-form').prepickup_at.required = on;
  // Oculto no debe bloquear el guardado (el campo de dirección del selector es obligatorio).
  $('#prepickup-picker .address').required = on;
  $('#start-help').textContent = on
    ? 'De donde sale la unidad (ya cargada) rumbo al destino.'
    : 'Donde se carga y de donde sale la unidad rumbo al destino.';
}
$('#trip-form [name=has_prepickup]').addEventListener('change', syncPrepickup);

// ---------- Ruta y ETA ----------
// El tiempo de manejo se calcula con Google Maps (Routes API) si hay llave; si
// no, con una estimación en línea recta. El personal lo puede ajustar a mano.
let routeState = { km: null, source: null };
let routeTimer;
let routeRequest = 0;

function routeMinutes() {
  const form = $('#trip-form');
  if (form.route_h.value === '' && form.route_m.value === '') return null;
  return Number(form.route_h.value || 0) * 60 + Number(form.route_m.value || 0);
}
function setRouteMinutes(minutes) {
  const form = $('#trip-form');
  form.route_h.value = minutes == null ? '' : Math.floor(minutes / 60);
  form.route_m.value = minutes == null ? '' : Math.round(minutes % 60);
}
function routeInfoText() {
  const source = { google: 'Calculado con Google Maps', estimado: 'Estimación aproximada (sin Google Maps)', manual: 'Capturado a mano' }[routeState.source] || '';
  return [routeState.km != null ? `${fmtNum(routeState.km)} km` : '', source].filter(Boolean).join(' · ') + '. Ajústalo si harás paradas o la unidad va más lenta.';
}

function updateEta() {
  const form = $('#trip-form');
  const eta = addMinutesLocal(form.pickup_at.value, routeMinutes());
  $('#eta-value').textContent = eta ? fmtDate(eta, true) : '—';
  const late = eta && form.delivery_at.value && eta > form.delivery_at.value;
  $('#eta-warn').textContent = late ? '⚠ Llega después de la entrega pactada.' : '';
  $('#eta-warn').className = `small ${late ? 'eta-warn' : ''}`;
}
['pickup_at', 'delivery_at', 'route_h', 'route_m'].forEach((n) => $(`#trip-form [name=${n}]`).addEventListener('input', () => {
  if (n.startsWith('route_')) {
    routeState.source = 'manual';
    $('#route-info').textContent = routeInfoText();
  }
  updateEta();
}));

function scheduleRoute() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(computeRoute, 400);
}
$('#route-calc').onclick = computeRoute;

const routeWaypoint = (p) => (p.lat != null ? { location: { latLng: { latitude: p.lat, longitude: p.lng } } } : { address: p.address });
async function googleRoute(from, to) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': cfg.googleMapsApiKey, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
    body: JSON.stringify({ origin: routeWaypoint(from), destination: routeWaypoint(to), travelMode: 'DRIVE', languageCode: 'es-MX', regionCode: 'MX' }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.routes?.length) throw new Error(out.error?.message || 'Sin ruta');
  return { km: Math.round(out.routes[0].distanceMeters / 100) / 10, minutes: Math.round(parseInt(out.routes[0].duration, 10) / 60) };
}

async function computeRoute() {
  const from = pickupPicker.getValue();
  const to = destPicker.getValue();
  const info = $('#route-info');
  if (!from.address || !to.address) {
    info.textContent = 'Elige el punto de inicio y el destino para calcular la ruta.';
    return;
  }
  const request = ++routeRequest;
  let route = null;
  if (cfg.googleMapsApiKey) {
    info.textContent = 'Calculando ruta con Google Maps…';
    try {
      route = { ...(await googleRoute(from, to)), source: 'google' };
    } catch {
      route = null;
    }
  }
  if (!route) {
    const rough = roughRoute(from, to);
    route = rough && { ...rough, source: 'estimado' };
  }
  if (request !== routeRequest) return;
  if (!route) {
    info.textContent = 'No se pudo calcular la ruta. Marca los puntos en el mapa o captura el tiempo a mano.';
    return;
  }
  routeState = { km: route.km, source: route.source };
  setRouteMinutes(route.minutes);
  info.textContent = routeInfoText();
  updateEta();
}
$('#new-trip').onclick = () => openTripForm(null);

$('#trip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const pickup = pickupPicker.getValue();
  const dest = destPicker.getValue();
  const prepickup = prepickupPicker.getValue();
  const minutes = routeMinutes();
  const body = {
    name: form.elements.name.value,
    notify_emails: form.notify_emails.value,
    has_prepickup: form.has_prepickup.checked,
    prepickup_address: prepickup.address,
    prepickup_lat: prepickup.lat,
    prepickup_lng: prepickup.lng,
    prepickup_at: form.prepickup_at.value,
    route_minutes: minutes,
    route_km: routeState.km,
    route_source: minutes != null ? routeState.source || 'manual' : null,
    overnight_nights: form.overnight_nights.value,
    lodging_notes: form.lodging_notes.value,
    parent_trip_id: returnParent?.id,
    driver_id: form.driver_id.value,
    vehicle_id: form.vehicle_id.value,
    client_id: form.client_id.value,
    pickup_address: pickup.address,
    pickup_lat: pickup.lat,
    pickup_lng: pickup.lng,
    pickup_at: form.pickup_at.value,
    dest_address: dest.address,
    dest_lat: dest.lat,
    dest_lng: dest.lng,
    delivery_at: form.delivery_at.value,
    client: form.client.value,
    cargo: form.cargo.value,
    notes: form.notes.value,
  };
  if (editingTrip && editingTrip.odo_start != null) {
    body.odo_start = form.odo_start.value;
    body.odo_end = form.odo_end.value;
    body.odo_return = form.odo_return.value;
  }
  const btn = $('#trip-save');
  btn.disabled = true;
  try {
    const saved = editingTrip
      ? await api(`/trips/${editingTrip.id}`, { method: 'PUT', body })
      : await api('/trips', { method: 'POST', body });
    $('#trip-dialog').close();
    toast(editingTrip ? 'Viaje actualizado' : `Viaje #${saved.id} creado. Se avisó a ${saved.driver_name}.`);
    await loadTrips();
    if (editingTrip) openDetail(saved.id);
  } catch (err) {
    showError(form.querySelector('.msg'), err);
  } finally {
    btn.disabled = false;
  }
});

// Recorrido GPS del chofer: mapa con la línea del recorrido (con Google Maps)
// o la lista de puntos. También suma los km entre puntos para compararlos con el odómetro.
async function showTrack(t) {
  const box = $('#track-box');
  box.innerHTML = '<p class="muted small">Cargando recorrido…</p>';
  let points;
  try {
    points = await api(`/trips/${t.id}/locations`);
  } catch (err) {
    return showError(box, err);
  }
  if (!points.length) return (box.innerHTML = '<p class="muted small">Sin puntos registrados.</p>');
  const rad = (x) => (x * Math.PI) / 180;
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    km += 2 * 6371 * Math.asin(Math.sqrt(h));
  }
  const summary = `<p class="muted small">${points.length} puntos · ~${fmtNum(km)} km en línea recta entre puntos (la carretera suele ser 10–30 % más).</p>`;
  const google = window.google?.maps ? window.google : await loadGoogleMaps(cfg.googleMapsApiKey);
  if (google?.maps) {
    box.innerHTML = `${summary}<div class="map-track"></div>`;
    const { Map } = await google.maps.importLibrary('maps');
    const path = points.map((p) => ({ lat: p.lat, lng: p.lng }));
    const map = new Map(box.querySelector('.map-track'), { mapTypeControl: false, streetViewControl: false });
    new google.maps.Polyline({ map, path, strokeColor: '#13294b', strokeWeight: 4, strokeOpacity: 0.85 });
    new google.maps.Marker({ map, position: path[0], label: 'A', title: fmtUtc(points[0].recorded_at.replace('T', ' ').slice(0, 19)) });
    new google.maps.Marker({ map, position: path.at(-1), label: 'B', title: fmtUtc(points.at(-1).recorded_at.replace('T', ' ').slice(0, 19)) });
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds);
    return;
  }
  box.innerHTML = `${summary}<div class="table-wrap" style="max-height:240px;overflow:auto"><table class="list"><tbody>${points
    .slice()
    .reverse()
    .map(
      (p) => `<tr><td>${esc(fmtUtc(p.recorded_at.replace('T', ' ').slice(0, 19)))}</td><td>${p.speed != null ? `${fmtNum(p.speed * 3.6)} km/h` : ''}</td>
        <td><a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${p.lat},${p.lng}">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</a></td></tr>`
    )
    .join('')}</tbody></table></div>`;
}

// ---------- Detalle ----------
async function openDetail(id) {
  let t;
  try {
    t = await api(`/trips/${id}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  const photo = (file, caption) =>
    file ? `<figure><img data-zoom src="/api/photos/${encodeURIComponent(file)}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>` : '';
  // Fotos en el orden del viaje: odómetro y combustible al salir, carga, llegada,
  // entrega, firma, odómetro al entregar, odómetro y combustible al regresar, tickets.
  const stagePhotos = (kind) => t.photos.filter((p) => p.kind === kind).map((p) => photo(p.file, `${PHOTO_KIND[kind]} · ${fmtUtc(p.created_at)}`));
  const photos = [
    photo(t.odo_start_photo, `Odómetro al salir: ${fmtNum(t.odo_start)} km`),
    photo(t.fuel_start_photo, `Combustible al salir: ${fuelLabel(t.fuel_start)}`),
    ...stagePhotos('llegada_carga'),
    ...stagePhotos('carga'),
    ...stagePhotos('salida'),
    ...stagePhotos('llegada'),
    ...stagePhotos('entrega'),
    ...stagePhotos('firma'),
    ...t.pauses.flatMap((p) => [
      photo(p.pause_photo, `Pausa · ${PAUSE_PLACE_LABEL[p.place]} · ${fmtDate(p.paused_at)} · ${fmtNum(p.pause_odometer)} km`),
      photo(p.resume_photo, `Reanudó · ${fmtDate(p.resumed_at)} · ${fmtNum(p.resume_odometer)} km`),
    ]),
    photo(t.odo_end_photo, `Odómetro al entregar: ${fmtNum(t.odo_end)} km`),
    photo(t.odo_return_photo, `Odómetro al regresar: ${fmtNum(t.odo_return)} km`),
    photo(t.fuel_end_photo, `Combustible al regresar: ${fuelLabel(t.fuel_end)}`),
    ...t.fuel.map((f) => photo(f.photo, `Ticket ${fmtNum(f.liters, 1)} L`)),
  ].join('');

  const canEdit = t.status !== 'cancelado';
  const canCancel = ['asignado', 'en_recoleccion', 'cargado', 'en_ruta', 'en_destino'].includes(t.status);
  const tank = t.vehicle_tank_liters;
  const canReturnTrip = !t.return_trip_id && !['finalizado', 'cancelado'].includes(t.status);
  // Bitácora de pausas (hotel, domicilio, descansos).
  const hotelNights = t.pauses.filter((p) => p.place === 'hotel').length;
  const pausesHtml = t.pauses.length
    ? `<h3 style="margin-top:14px">🌙 Pausas y jornadas</h3>
      <p class="muted small">Pernocta autorizada: <b>${t.overnight_nights || 0}</b> noche(s)${t.lodging_notes ? ` · ${esc(t.lodging_notes)}` : ''} · Noches en hotel: <b>${hotelNights}</b>${
        hotelNights > (t.overnight_nights || 0) ? ' <span class="eta-warn">⚠ más de las autorizadas</span>' : ''
      }</p>
      <div class="table-wrap"><table class="list"><thead><tr><th>Lugar</th><th>Pausó</th><th>Reanudó</th><th class="num">Odómetro</th><th class="num">Se movió</th></tr></thead><tbody>
      ${t.pauses
        .map((p) => {
          const moved = p.resume_odometer != null ? p.resume_odometer - p.pause_odometer : null;
          return `<tr><td>${esc(PAUSE_PLACE_LABEL[p.place])}${p.place_note ? `<div class="muted small">${esc(p.place_note)}</div>` : ''}</td>
            <td>${esc(fmtDate(p.paused_at))}${p.pause_lat != null ? ` · <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${p.pause_lat},${p.pause_lng}">mapa</a>` : ''}</td>
            <td>${p.resumed_at ? esc(fmtDate(p.resumed_at)) : `<b>En pausa</b>${p.resume_planned_at ? `<div class="muted small">reanuda ${esc(fmtDate(p.resume_planned_at))}</div>` : ''}`}</td>
            <td class="num">${fmtNum(p.pause_odometer)}${p.resume_odometer != null ? ` → ${fmtNum(p.resume_odometer)}` : ''}</td>
            <td class="num">${moved == null ? '—' : moved > 5 ? `<span class="eta-warn">⚠ ${fmtNum(moved, 1)} km</span>` : `${fmtNum(moved, 1)} km`}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '';
  const loc = t.last_location;
  const locationHtml =
    loc || !['asignado', 'cancelado'].includes(t.status)
      ? `<h3 style="margin-top:14px">📍 Ubicación del chofer</h3>
        ${
          loc
            ? `<p class="small">Último punto: <b>${esc(fmtAgo(loc.at))}</b> (${esc(fmtUtc(loc.at.replace('T', ' ').slice(0, 19)))}) ·
                <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${loc.lat},${loc.lng}">Ver en Google Maps</a>
                ${loc.accuracy ? `<span class="muted"> · precisión ±${fmtNum(loc.accuracy)} m</span>` : ''}</p>
               <button class="btn-sm" data-show-track>🗺️ Ver recorrido</button><div id="track-box"></div>`
            : '<p class="muted small">Aún no hay puntos. Se registran cada cierto tiempo mientras el chofer tiene la app abierta y el viaje activo.</p>'
        }`
      : '';

  $('#detail-body').innerHTML = `
    <div class="card-head">
      <div><h2>Viaje #${t.id}${t.name ? ` · ${esc(t.name)}` : ''}</h2>${statusBadge(t.status)}${t.paused ? ' <span class="badge st-pausa">⏸ En pausa</span>' : ''}
        ${t.parent_trip_id ? `<button class="btn-sm" data-open-trip="${t.parent_trip_id}">↩ Viaje de ida #${t.parent_trip_id}</button>` : ''}
        ${t.return_trip_id ? `<button class="btn-sm" data-open-trip="${t.return_trip_id}">↪ Viaje de regreso #${t.return_trip_id}</button>` : ''}</div>
      <button data-close-detail>✕</button>
    </div>
    <div class="eta-box" style="margin-top:6px">
      <div class="eta-grid">
        <div>
          <div class="muted small">Llegada estimada${t.eta_live_at ? ' (con la hora real de salida)' : ''}</div>
          <b style="font-size:1.2rem">${t.eta ? esc(fmtDate(t.eta, true)) : t.arrived_at ? `Llegó ${esc(fmtDate(t.arrived_at, true))}` : '—'}</b>
          <div class="muted small">${[t.route_km != null ? `${fmtNum(t.route_km)} km` : '', fmtDuration(t.route_minutes)].filter(Boolean).join(' · ')}${
            t.eta_at && t.delivery_at && t.eta_at > t.delivery_at ? ' · <span class="eta-warn">⚠ después de la entrega pactada</span>' : ''
          }</div>
        </div>
        <div>
          <div class="muted small">Enlace de seguimiento para el cliente</div>
          <div class="row" style="margin-top:4px">
            <button class="btn-sm" data-copy-track>📋 Copiar</button>
            <a class="btn btn-sm" target="_blank" rel="noopener" data-wa-track>WhatsApp</a>
            <a class="btn btn-sm" target="_blank" rel="noopener" data-open-track>Abrir</a>
          </div>
          ${t.notify_emails ? `<div class="muted small" style="margin-top:4px">✉️ Avisos a: ${esc(t.notify_emails)}</div>` : ''}
        </div>
      </div>
    </div>
    <div class="grid-2">
      <div>
        ${t.prepickup_address ? `<div class="stop pre"><div class="dot">📦</div><div class="body"><div class="muted small">Recolección anticipada · ${esc(fmtDate(t.prepickup_at, true))}</div><div class="addr">${esc(t.prepickup_address)}</div></div>
          <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.prepickup_address, t.prepickup_lat, t.prepickup_lng))}">Mapa</a></div>` : ''}
        <div class="stop"><div class="dot">📍</div><div class="body"><div class="muted small">Inicio · ${esc(fmtDate(t.pickup_at, true))}</div><div class="addr">${esc(t.pickup_address)}</div></div>
          <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.pickup_address, t.pickup_lat, t.pickup_lng))}">Mapa</a></div>
        <div class="stop"><div class="dot">🏁</div><div class="body"><div class="muted small">Destino${t.delivery_at ? ` · entrega pactada ${esc(fmtDate(t.delivery_at, true))}` : ''}</div><div class="addr">${esc(t.dest_address)}</div></div>
          <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.dest_address, t.dest_lat, t.dest_lng))}">Mapa</a></div>
        <dl class="kv" style="margin-top:8px">
          <dt>Chofer</dt><dd>${esc(t.driver_name || '—')}${t.driver_phone ? ` · <a href="tel:${esc(t.driver_phone)}">${esc(t.driver_phone)}</a>` : ''}</dd>
          <dt>Vehículo</dt><dd>${esc(t.vehicle_name || '—')}${t.vehicle_plate ? ` · ${esc(t.vehicle_plate)}` : ''}</dd>
          ${t.client ? `<dt>Cliente</dt><dd>${esc(t.client)}${t.client_id ? ` · <span class="muted small">con acceso: ${esc(t.client_email || '')}</span>` : ''}</dd>` : ''}
          ${t.cargo ? `<dt>Carga</dt><dd>${esc(t.cargo)}</dd>` : ''}
          ${t.notes ? `<dt>Notas</dt><dd>${esc(t.notes)}</dd>` : ''}
          <dt>Inició</dt><dd>${esc(fmtDate(t.started_at, true))}</dd>
          <dt>Cargado</dt><dd>${esc(fmtDate(t.loaded_at, true))}</dd>
          <dt>Salió a destino</dt><dd>${esc(fmtDate(t.departed_at, true))}</dd>
          <dt>Llegó a entregar</dt><dd>${esc(fmtDate(t.arrived_at, true))}</dd>
          <dt>Entregado</dt><dd>${esc(fmtDate(t.finished_at, true))}</dd>
          ${t.received_by ? `<dt>Recibió</dt><dd><b>${esc(t.received_by)}</b></dd>` : ''}
          <dt>Regresó a base</dt><dd>${esc(fmtDate(t.returned_at, true))}</dd>
        </dl>
      </div>
      <div>
        <h3>Combustible y rendimiento</h3>
        <table class="list trace">
          <thead><tr><th></th><th class="num">Odómetro</th><th>Combustible</th></tr></thead>
          <tbody>
            <tr><td>Al salir</td><td class="num">${fmtNum(t.odo_start)}</td><td>${esc(fuelLabel(t.fuel_start))}</td></tr>
            <tr><td>Al entregar</td><td class="num">${fmtNum(t.odo_end)}</td><td class="muted">—</td></tr>
            <tr><td>Al regresar</td><td class="num">${fmtNum(t.odo_return)}</td><td>${esc(fuelLabel(t.fuel_end))}</td></tr>
          </tbody>
        </table>
        <p class="muted small">
          km a la entrega: <b>${fmtNum(t.km_delivery)}</b> · km de regreso: <b>${fmtNum(t.km_return)}</b>
          · Litros cargados: <b>${fmtNum(t.fuel_liters, 1)}</b>
          ${t.fuel_level_liters != null ? ` · Por nivel del tanque: <b>${fmtNum(t.fuel_level_liters, 1)}</b> L` : ''}
          ${t.fuel_start != null && t.fuel_end != null && !(tank > 0) ? '<br>⚠ Registra la capacidad del tanque del vehículo para convertir el nivel de la aguja a litros.' : ''}
        </p>
        <div class="row">
          <div class="metric"><b>${fmtNum(t.km)}</b><span>km totales</span></div>
          <div class="metric"><b>${fmtNum(t.fuel_used, 1)}</b><span>litros usados</span></div>
          <div class="metric"><b>${t.km_per_liter ? fmtNum(t.km_per_liter, 2) : '—'}</b><span>km/L</span></div>
          <div class="metric"><b>${t.liters_per_100km ? fmtNum(t.liters_per_100km, 1) : '—'}</b><span>L/100 km</span></div>
          ${t.fuel_amount ? `<div class="metric"><b>$${fmtNum(t.fuel_amount, 2)}</b><span>gasto</span></div>` : ''}
        </div>
        ${
          t.fuel.length
            ? `<table class="list" style="margin-top:8px"><thead><tr><th>Fecha</th><th class="num">Litros</th><th class="num">$</th><th class="num">Odómetro</th><th></th></tr></thead><tbody>
                ${t.fuel
                  .map(
                    (f) => `<tr><td>${esc(fmtUtc(f.created_at))}</td><td class="num">${fmtNum(f.liters, 2)}</td><td class="num">${f.amount != null ? fmtNum(f.amount, 2) : '—'}</td><td class="num">${f.odometer != null ? fmtNum(f.odometer) : '—'}</td>
                      <td><button class="btn-sm btn-danger" data-del-fuel="${f.id}" title="Eliminar carga">✕</button></td></tr>`
                  )
                  .join('')}
              </tbody></table>`
            : '<p class="muted small">Sin cargas de combustible registradas.</p>'
        }
        <form id="admin-fuel" class="row" style="margin-top:8px">
          <input name="liters" type="number" step="0.01" min="0.1" placeholder="Litros" required style="width:110px">
          <input name="amount" type="number" step="0.01" min="0" placeholder="Importe $" style="width:120px">
          <button class="btn-sm">＋ Agregar carga</button>
        </form>
        ${photos ? `<h3 style="margin-top:14px">Fotos</h3><div class="photos">${photos}</div>` : ''}
      </div>
    </div>
    ${pausesHtml}
    ${locationHtml}
    <h3 style="margin-top:14px">Historial</h3>
    <ul class="timeline">
      ${t.events
        .map(
          (ev) => `<li><b>${esc(ev.note || ev.type)}</b><div class="muted small">${esc(fmtUtc(ev.created_at))} · ${esc(ev.user_name || '')}
            ${ev.lat != null ? ` · <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${ev.lat},${ev.lng}">ubicación</a>` : ''}</div></li>`
        )
        .join('')}
    </ul>
    <div class="dialog-actions">
      ${t.status === 'cancelado' ? `<button class="btn-danger" data-delete>Borrar viaje</button>` : ''}
      ${canCancel ? `<button class="btn-danger" data-cancel>Cancelar viaje</button>` : ''}
      ${canReturnTrip ? `<button data-return-trip>↪ Crear viaje de regreso</button>` : ''}
      ${canEdit ? `<button data-edit>Editar</button>` : ''}
      <button class="btn-primary" data-close-detail>Cerrar</button>
    </div>`;

  const dlg = $('#detail-dialog');
  const body = $('#detail-body');
  $$('[data-close-detail]', body).forEach((b) => (b.onclick = () => dlg.close()));
  // Enlace público de seguimiento (el cliente no necesita cuenta).
  const trackLink = `${location.origin}/seguimiento.html?t=${t.track_token}`;
  body.querySelector('[data-open-track]').href = trackLink;
  body.querySelector('[data-wa-track]').href = `https://wa.me/?text=${encodeURIComponent(`Sigue tu envío${t.name ? ` "${t.name}"` : ''} con ${cfg.companyName}: ${trackLink}`)}`;
  body.querySelector('[data-copy-track]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(trackLink);
      toast('Enlace copiado');
    } catch {
      prompt('Copia el enlace:', trackLink);
    }
  };
  body.querySelector('[data-edit]')?.addEventListener('click', () => {
    dlg.close();
    openTripForm(t);
  });
  body.querySelector('[data-return-trip]')?.addEventListener('click', () => {
    dlg.close();
    openTripForm(null, t);
  });
  $$('[data-open-trip]', body).forEach((b) => (b.onclick = () => openDetail(Number(b.dataset.openTrip))));
  body.querySelector('[data-show-track]')?.addEventListener('click', () => showTrack(t));
  body.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    const reason = prompt('Motivo de la cancelación (se avisará al chofer):', '');
    if (reason === null) return;
    try {
      await api(`/trips/${t.id}/cancel`, { method: 'POST', body: { reason } });
      toast('Viaje cancelado');
      dlg.close();
      loadTrips();
    } catch (err) {
      toast(err.message);
    }
  });
  body.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar definitivamente este viaje cancelado?')) return;
    try {
      await api(`/trips/${t.id}`, { method: 'DELETE' });
      dlg.close();
      loadTrips();
    } catch (err) {
      toast(err.message);
    }
  });
  $$('[data-del-fuel]', body).forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm('¿Eliminar esta carga de combustible?')) return;
        await api(`/fuel/${b.dataset.delFuel}`, { method: 'DELETE' }).catch((err) => toast(err.message));
        openDetail(t.id);
        loadTrips();
      })
  );
  body.querySelector('#admin-fuel').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/trips/${t.id}/fuel`, { method: 'POST', body: fd });
      openDetail(t.id);
      loadTrips();
    } catch (err) {
      toast(err.message);
    }
  });
  if (!dlg.open) dlg.showModal();
}
$('#detail-dialog').addEventListener('close', () => {
  if (location.hash) history.replaceState(null, '', location.pathname);
});

// ---------- Usuarios: superadministrador, personal de AN, choferes y clientes ----------
const ROLE_HELP = {
  superadmin: 'Dueño de la cuenta: controla todo, incluido el personal, los datos de la empresa y las tarifas.',
  admin: 'Personal de AN: viajes, choferes, clientes, vehículos, pagos y cotizaciones.',
  driver: 'Chofer: ve sus viajes y registra cada etapa con fotos.',
  client: 'Cliente: sigue sus envíos y ve las fotos y la prueba de entrega.',
};

async function loadUsers() {
  users = await api('/users');
  fillSelects();
  const filter = $('#u-role').value;
  const rows = users.filter((u) => !filter || u.role === filter);
  $('#users-body').innerHTML = rows.length
    ? rows
        .map(
          (u) => `
      <tr class="clickable" data-id="${u.id}">
        <td><b>${esc(u.name)}</b>${u.company ? `<div class="muted small">${esc(u.company)}</div>` : ''}</td>
        <td>${esc(u.email)}</td>
        <td>${u.phone ? `<a href="tel:${esc(u.phone)}">${esc(u.phone)}</a>` : '—'}</td>
        <td><span class="badge role-${u.role}">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
        <td>${u.push_devices ? `🔔 ${u.push_devices} dispositivo(s)` : '<span class="muted">Solo correo</span>'}</td>
        <td class="num">${u.open_trips}</td>
        <td>${u.active ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="empty">No hay usuarios con este perfil.</td></tr>';
}
$('#u-role').onchange = loadUsers;

$('#users-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const user = users.find((u) => u.id === Number(row.dataset.id));
  const self = user.id === me.id;
  if (!self && (user.role === 'superadmin' || (user.role === 'admin' && me.role !== 'superadmin'))) {
    toast('Solo el superadministrador puede modificar al personal de AN.');
    return;
  }
  openUserForm(user);
});
$('#new-user').onclick = () => openUserForm(null);

function syncRoleFields() {
  const form = $('#user-form');
  const role = form.role.value;
  $('#user-company-row').classList.toggle('hidden', role !== 'client');
  // Los choferes reciben sus propios avisos de viajes asignados, no el estatus.
  $('#user-notify-row').classList.toggle('hidden', role === 'driver');
  $('#user-role-help').textContent = ROLE_HELP[role] || '';
}
$('#user-form [name=role]').addEventListener('change', syncRoleFields);

function openUserForm(user) {
  editingUser = user;
  const form = $('#user-form');
  form.reset();
  form.querySelector('.msg').innerHTML = '';
  $('#user-form-title').textContent = user ? `Editar ${user.name}` : 'Nuevo usuario';
  const self = user && user.id === me.id;
  // El propio perfil (y el del superadministrador) no se cambia desde aquí.
  const roleSelect = form.role;
  roleSelect.querySelector('option[value=superadmin]')?.remove();
  if (user?.role === 'superadmin') roleSelect.add(new Option(ROLE_LABEL.superadmin, 'superadmin'));
  roleSelect.value = user?.role || 'driver';
  roleSelect.disabled = Boolean(self);
  form.elements.name.value = user?.name || '';
  form.company.value = user?.company || '';
  form.email.value = user?.email || '';
  form.phone.value = user?.phone || '';
  form.password.value = user ? '' : randomPassword();
  form.password.required = !user;
  $('#user-password-label').textContent = user ? 'Nueva contraseña (déjala vacía para no cambiarla)' : 'Contraseña inicial (mínimo 8 caracteres)';
  $('#user-welcome-row').classList.toggle('hidden', Boolean(user));
  $('#user-active-row').classList.toggle('hidden', !user || self);
  form.active.checked = user ? Boolean(user.active) : true;
  form.notify_email.checked = user ? Boolean(user.notify_email) : true;
  syncRoleFields();
  $('#user-dialog').showModal();
}

// Contraseña inicial fácil de dictar por teléfono (sin 0/O ni 1/l).
function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(10))].map((n) => chars[n % chars.length]).join('');
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.elements.name.value,
    email: form.email.value,
    phone: form.phone.value,
    company: form.company.value,
    password: form.password.value || undefined,
    notify_email: form.notify_email.checked,
  };
  if (!form.role.disabled) body.role = form.role.value;
  try {
    if (editingUser) {
      if (editingUser.id !== me.id) body.active = form.active.checked;
      await api(`/users/${editingUser.id}`, { method: 'PUT', body });
    } else {
      body.sendWelcome = form.sendWelcome.checked;
      await api('/users', { method: 'POST', body });
    }
    $('#user-dialog').close();
    toast('Guardado');
    loadUsers();
  } catch (err) {
    showError(form.querySelector('.msg'), err);
  }
});

// ---------- Vehículos ----------
async function loadVehicles() {
  vehicles = await api('/vehicles');
  fillSelects();
  $('#vehicles-body').innerHTML = vehicles.length
    ? vehicles
        .map(
          (v) => `
      <tr class="clickable" data-id="${v.id}">
        <td><b>${esc(v.name)}</b></td>
        <td>${esc(v.plate || '—')}</td>
        <td>${esc(v.fuel_type || '—')}</td>
        <td class="num">${v.tank_liters != null ? fmtNum(v.tank_liters) : '—'}</td>
        <td class="num">${v.last_odometer != null ? fmtNum(v.last_odometer) : '—'}</td>
        <td>${v.active ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">Agrega tus vehículos para medir el rendimiento de cada uno.</td></tr>';
}

$('#vehicles-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) openVehicleForm(vehicles.find((v) => v.id === Number(row.dataset.id)));
});
$('#new-vehicle').onclick = () => openVehicleForm(null);

function openVehicleForm(v) {
  editingVehicle = v;
  const form = $('#vehicle-form');
  form.reset();
  form.querySelector('.msg').innerHTML = '';
  $('#vehicle-form-title').textContent = v ? `Editar ${v.name}` : 'Nuevo vehículo';
  form.elements.name.value = v?.name || '';
  form.plate.value = v?.plate || '';
  form.fuel_type.value = v?.fuel_type || 'Diésel';
  form.last_odometer.value = v?.last_odometer ?? '';
  form.tank_liters.value = v?.tank_liters ?? '';
  form.active.checked = v ? Boolean(v.active) : true;
  $('#vehicle-active-row').classList.toggle('hidden', !v);
  $('#vehicle-dialog').showModal();
}

$('#vehicle-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.elements.name.value,
    plate: form.plate.value,
    fuel_type: form.fuel_type.value,
    last_odometer: form.last_odometer.value,
    tank_liters: form.tank_liters.value,
  };
  try {
    if (editingVehicle) {
      body.active = form.active.checked;
      await api(`/vehicles/${editingVehicle.id}`, { method: 'PUT', body });
    } else {
      await api('/vehicles', { method: 'POST', body });
    }
    $('#vehicle-dialog').close();
    toast('Guardado');
    loadVehicles();
  } catch (err) {
    showError(form.querySelector('.msg'), err);
  }
});

// ---------- Rendimiento ----------
async function loadReport() {
  const params = new URLSearchParams();
  if ($('#r-from').value) params.set('from', $('#r-from').value);
  if ($('#r-to').value) params.set('to', $('#r-to').value);
  let data;
  try {
    data = await api(`/reports/fuel?${params}`);
  } catch (err) {
    showError($('#r-trips'), err);
    return;
  }
  const groupTable = (rows) =>
    rows.length
      ? `<table class="list"><thead><tr><th></th><th class="num">Viajes</th><th class="num">km</th><th class="num">Litros</th><th class="num">km/L</th><th class="num">$/km</th></tr></thead><tbody>
        ${rows
          .map(
            (g) => `<tr><td>${esc(g.label)}</td><td class="num">${g.trips}</td><td class="num">${fmtNum(g.km)}</td><td class="num">${fmtNum(g.liters, 1)}</td>
              <td class="num"><b>${g.km_per_liter ? fmtNum(g.km_per_liter, 2) : '—'}</b></td><td class="num">${g.cost_per_km ? fmtNum(g.cost_per_km, 2) : '—'}</td></tr>`
          )
          .join('')}</tbody></table>`
      : '<p class="muted">Sin datos en este periodo.</p>';
  $('#r-vehicles').innerHTML = groupTable(data.byVehicle);
  $('#r-drivers').innerHTML = groupTable(data.byDriver);
  $('#r-trips').innerHTML = data.trips.length
    ? `<table class="list"><thead><tr><th>#</th><th>Finalizó</th><th>Chofer</th><th>Vehículo</th><th class="num">Odóm. salida</th><th class="num">Odóm. regreso</th><th class="num">km</th><th class="num">Litros</th><th class="num">km/L</th></tr></thead><tbody>
      ${data.trips
        .map(
          (t) => `<tr class="clickable" data-id="${t.id}"><td>${t.id}</td><td>${esc(fmtDate(t.finished_at, true))}</td><td>${esc(t.driver_name || '—')}</td><td>${esc(t.vehicle_name || '—')}</td>
            <td class="num">${fmtNum(t.odo_start)}</td><td class="num">${fmtNum(t.odo_return ?? t.odo_end)}</td><td class="num">${fmtNum(t.km)}</td><td class="num">${fmtNum(t.fuel_used, 1)}</td>
            <td class="num"><b>${t.km_per_liter ? fmtNum(t.km_per_liter, 2) : '—'}</b></td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="muted">Aún no hay viajes finalizados en este periodo.</p>';
}
$('#r-apply').onclick = loadReport;
$('#r-trips').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) openDetail(Number(row.dataset.id));
});

// ---------- Avisos, menú ----------
async function renderBanners() {
  const state = await pushState().catch(() => 'unsupported');
  $('#banners').innerHTML =
    state === 'off'
      ? `<div class="alert alert-info row"><span class="grow">🔔 Activa las notificaciones para saber cuándo un chofer inicia o termina un viaje.</span><button class="btn-sm btn-primary" id="banner-push">Activar</button></div>`
      : '';
  $('#banner-push')?.addEventListener('click', turnOnPush);
  $('#menu-push').textContent = state === 'on' ? '🔔 Probar notificación' : '🔔 Activar notificaciones';
}
async function turnOnPush() {
  try {
    await enablePush(cfg.vapidPublicKey);
    toast('Notificaciones activadas');
  } catch (err) {
    toast(err.message);
  }
  renderBanners();
}

document.addEventListener('installable', () => $('#menu-install').classList.remove('hidden'));
$('#menu-install').onclick = async () => {
  if (await promptInstall()) $('#menu-install').classList.add('hidden');
};
$('#btn-menu').onclick = () => $('#menu').showModal();
$('#menu-push').onclick = turnOnPush;
$('#menu-password').onclick = () => {
  $('#menu').close();
  openPasswordDialog();
};
$('#menu-logout').onclick = logout;
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

init().catch((err) => showError($('#banners'), err));
