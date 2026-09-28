// Panel del administrador: viajes, choferes, vehículos y rendimiento.
let cfg = {};
let me = null;
let users = [];
let vehicles = [];
let trips = [];
let editingTrip = null;
let editingUser = null;
let editingVehicle = null;
let pickupPicker;
let destPicker;

async function init() {
  registerServiceWorker();
  [cfg, me] = await Promise.all([api('/config'), api('/me')]);
  if (me.role !== 'admin') {
    location.href = '/chofer.html';
    return;
  }
  $('#brand').textContent = 'Administración';
  document.title = `Administración · ${cfg.companyName}`;
  $('#menu-name').textContent = me.name;
  $('#menu-email').textContent = me.email;
  $('#menu-email-status').textContent = cfg.emailEnabled
    ? '✉️ Envío de correos activo.'
    : '✉️ El envío de correos no está configurado (ver README: variables SMTP).';
  pickupPicker = new PlacePicker($('#pickup-picker'), { apiKey: cfg.googleMapsApiKey, placeholder: 'Dirección de recolección' });
  destPicker = new PlacePicker($('#dest-picker'), { apiKey: cfg.googleMapsApiKey, placeholder: 'Dirección de destino' });
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
    $('#trips-body').innerHTML = `<tr><td colspan="7">${esc(err.message)}</td></tr>`;
  }
}

function renderTrips() {
  const body = $('#trips-body');
  if (!trips.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No hay viajes. Crea uno con “Nuevo viaje”.</td></tr>`;
    return;
  }
  body.innerHTML = trips
    .map(
      (t) => `
      <tr class="clickable" data-id="${t.id}">
        <td>${t.id}</td>
        <td>${statusBadge(t.status)}</td>
        <td style="white-space:nowrap">${esc(fmtDate(t.pickup_at))}</td>
        <td><div>${esc(t.pickup_address)}</div><div class="muted small">→ ${esc(t.dest_address)}</div></td>
        <td>${esc(t.driver_name || '—')}<div class="muted small">${esc(t.vehicle_name || '')}</div></td>
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
  const drivers = users.filter((u) => u.active);
  $('#trip-form [name=driver_id]').innerHTML =
    '<option value="">— Selecciona —</option>' +
    drivers.map((u) => `<option value="${u.id}">${esc(u.name)}${u.role === 'admin' ? ' (admin)' : ''}</option>`).join('');
  const current = $('#f-driver').value;
  $('#f-driver').innerHTML = '<option value="">Todos</option>' + users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  $('#f-driver').value = current;
  $('#trip-form [name=vehicle_id]').innerHTML =
    '<option value="">— Sin asignar —</option>' +
    vehicles.filter((v) => v.active).map((v) => `<option value="${v.id}">${esc(v.name)}${v.plate ? ` · ${esc(v.plate)}` : ''}</option>`).join('');
}

function openTripForm(trip) {
  editingTrip = trip || null;
  const form = $('#trip-form');
  form.reset();
  fillSelects();
  form.querySelector('.msg').innerHTML = '';
  $('#trip-form-title').textContent = trip ? `Editar viaje #${trip.id}` : 'Nuevo viaje';
  $('#trip-save').textContent = trip ? 'Guardar cambios' : 'Guardar y avisar al chofer';
  $('#odo-fix').classList.toggle('hidden', !trip || trip.odo_start == null);
  const t = trip || {};
  if (trip) {
    // Si el chofer o vehículo ya está inactivo, se agrega para no perderlo.
    for (const [sel, id, label] of [
      ['driver_id', t.driver_id, t.driver_name],
      ['vehicle_id', t.vehicle_id, t.vehicle_name],
    ]) {
      const select = form[sel];
      if (id && ![...select.options].some((o) => Number(o.value) === id)) select.add(new Option(label, id));
    }
  }
  form.driver_id.value = t.driver_id || '';
  form.driver_id.disabled = Boolean(trip && trip.status !== 'asignado');
  form.vehicle_id.value = t.vehicle_id || '';
  form.pickup_at.value = t.pickup_at || '';
  form.delivery_at.value = t.delivery_at || '';
  form.client.value = t.client || '';
  form.cargo.value = t.cargo || '';
  form.notes.value = t.notes || '';
  form.odo_start.value = t.odo_start ?? '';
  form.odo_end.value = t.odo_end ?? '';
  pickupPicker.setValue({ address: t.pickup_address, lat: t.pickup_lat, lng: t.pickup_lng });
  destPicker.setValue({ address: t.dest_address, lat: t.dest_lat, lng: t.dest_lng });
  $('#trip-dialog').showModal();
}
$('#new-trip').onclick = () => openTripForm(null);

$('#trip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const pickup = pickupPicker.getValue();
  const dest = destPicker.getValue();
  const body = {
    driver_id: form.driver_id.value,
    vehicle_id: form.vehicle_id.value,
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
  const photos = [
    photo(t.odo_start_photo, `Odómetro inicial: ${fmtNum(t.odo_start)} km`),
    photo(t.odo_end_photo, `Odómetro final: ${fmtNum(t.odo_end)} km`),
    ...t.fuel.map((f) => photo(f.photo, `Ticket ${fmtNum(f.liters, 1)} L`)),
  ].join('');

  const canEdit = t.status !== 'cancelado';
  const canCancel = ['asignado', 'en_recoleccion', 'cargado', 'en_ruta'].includes(t.status);

  $('#detail-body').innerHTML = `
    <div class="card-head">
      <div><h2>Viaje #${t.id}</h2>${statusBadge(t.status)}</div>
      <button data-close-detail>✕</button>
    </div>
    <div class="grid-2">
      <div>
        <div class="stop"><div class="dot">📍</div><div class="body"><div class="muted small">Recolección · ${esc(fmtDate(t.pickup_at, true))}</div><div class="addr">${esc(t.pickup_address)}</div></div>
          <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.pickup_address, t.pickup_lat, t.pickup_lng))}">Mapa</a></div>
        <div class="stop"><div class="dot">🏁</div><div class="body"><div class="muted small">Destino${t.delivery_at ? ` · entrega ${esc(fmtDate(t.delivery_at, true))}` : ''}</div><div class="addr">${esc(t.dest_address)}</div></div>
          <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.dest_address, t.dest_lat, t.dest_lng))}">Mapa</a></div>
        <dl class="kv" style="margin-top:8px">
          <dt>Chofer</dt><dd>${esc(t.driver_name || '—')}${t.driver_phone ? ` · <a href="tel:${esc(t.driver_phone)}">${esc(t.driver_phone)}</a>` : ''}</dd>
          <dt>Vehículo</dt><dd>${esc(t.vehicle_name || '—')}${t.vehicle_plate ? ` · ${esc(t.vehicle_plate)}` : ''}</dd>
          ${t.client ? `<dt>Cliente</dt><dd>${esc(t.client)}</dd>` : ''}
          ${t.cargo ? `<dt>Carga</dt><dd>${esc(t.cargo)}</dd>` : ''}
          ${t.notes ? `<dt>Notas</dt><dd>${esc(t.notes)}</dd>` : ''}
          <dt>Inició</dt><dd>${esc(fmtDate(t.started_at, true))}</dd>
          <dt>Cargado</dt><dd>${esc(fmtDate(t.loaded_at, true))}</dd>
          <dt>Salió a destino</dt><dd>${esc(fmtDate(t.departed_at, true))}</dd>
          <dt>Finalizó</dt><dd>${esc(fmtDate(t.finished_at, true))}</dd>
        </dl>
      </div>
      <div>
        <h3>Combustible y rendimiento</h3>
        <div class="row">
          <div class="metric"><b>${fmtNum(t.km)}</b><span>km</span></div>
          <div class="metric"><b>${fmtNum(t.fuel_liters, 1)}</b><span>litros</span></div>
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
      ${canEdit ? `<button data-edit>Editar</button>` : ''}
      <button class="btn-primary" data-close-detail>Cerrar</button>
    </div>`;

  const dlg = $('#detail-dialog');
  const body = $('#detail-body');
  $$('[data-close-detail]', body).forEach((b) => (b.onclick = () => dlg.close()));
  body.querySelector('[data-edit]')?.addEventListener('click', () => {
    dlg.close();
    openTripForm(t);
  });
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

// ---------- Choferes ----------
async function loadUsers() {
  users = await api('/users');
  fillSelects();
  $('#users-body').innerHTML = users
    .map(
      (u) => `
      <tr class="clickable" data-id="${u.id}">
        <td><b>${esc(u.name)}</b></td>
        <td>${esc(u.email)}</td>
        <td>${u.phone ? `<a href="tel:${esc(u.phone)}">${esc(u.phone)}</a>` : '—'}</td>
        <td>${u.role === 'admin' ? 'Administrador' : 'Chofer'}</td>
        <td>${u.push_devices ? `🔔 ${u.push_devices} dispositivo(s)` : '<span class="muted">Solo correo</span>'}</td>
        <td class="num">${u.open_trips}</td>
        <td>${u.active ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      </tr>`
    )
    .join('');
}

$('#users-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (row) openUserForm(users.find((u) => u.id === Number(row.dataset.id)));
});
$('#new-user').onclick = () => openUserForm(null);

function openUserForm(user) {
  editingUser = user;
  const form = $('#user-form');
  form.reset();
  form.querySelector('.msg').innerHTML = '';
  $('#user-form-title').textContent = user ? `Editar ${user.name}` : 'Nuevo chofer';
  form.elements.name.value = user?.name || '';
  form.email.value = user?.email || '';
  form.phone.value = user?.phone || '';
  form.role.value = user?.role || 'driver';
  form.password.value = user ? '' : randomPassword();
  form.password.required = !user;
  $('#user-password-label').textContent = user ? 'Nueva contraseña (déjala vacía para no cambiarla)' : 'Contraseña inicial (mínimo 8 caracteres)';
  $('#user-welcome-row').classList.toggle('hidden', Boolean(user));
  $('#user-active-row').classList.toggle('hidden', !user);
  form.active.checked = user ? Boolean(user.active) : true;
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
    role: form.role.value,
    password: form.password.value || undefined,
  };
  try {
    if (editingUser) {
      body.active = form.active.checked;
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
        <td class="num">${v.last_odometer != null ? fmtNum(v.last_odometer) : '—'}</td>
        <td>${v.active ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty">Agrega tus vehículos para medir el rendimiento de cada uno.</td></tr>';
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
    ? `<table class="list"><thead><tr><th>#</th><th>Finalizó</th><th>Chofer</th><th>Vehículo</th><th class="num">Odóm. inicial</th><th class="num">Odóm. final</th><th class="num">km</th><th class="num">Litros</th><th class="num">km/L</th></tr></thead><tbody>
      ${data.trips
        .map(
          (t) => `<tr class="clickable" data-id="${t.id}"><td>${t.id}</td><td>${esc(fmtDate(t.finished_at, true))}</td><td>${esc(t.driver_name || '—')}</td><td>${esc(t.vehicle_name || '—')}</td>
            <td class="num">${fmtNum(t.odo_start)}</td><td class="num">${fmtNum(t.odo_end)}</td><td class="num">${fmtNum(t.km)}</td><td class="num">${fmtNum(t.fuel_liters, 1)}</td>
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
