// Página del chofer: lista de viajes, pasos del viaje y fotos del odómetro.
let cfg = {};
let me = null;
let tab = 'open';
let trips = [];
let odoAction = null; // { trip, kind: 'start' | 'finish' }
let fuelTrip = null;
let noteTrip = null;

const ACTIONS = {
  asignado: { label: '▶ Iniciar viaje', cls: 'btn-primary', kind: 'start', help: 'Antes de arrancar hacia la recolección, toma la foto del odómetro.' },
  en_recoleccion: { label: '📦 Terminé de cargar', cls: 'btn-primary', kind: 'loaded', help: 'Presiona cuando la mercancía esté cargada. Si sales hasta otro día, el viaje quedará en espera.' },
  cargado: { label: '🚚 Salir rumbo al destino', cls: 'btn-primary', kind: 'depart', help: 'Presiona justo cuando arranques hacia el destino final.' },
  en_ruta: { label: '🏁 Finalizar viaje', cls: 'btn-ok', kind: 'finish', help: 'Al entregar, toma la foto del odómetro para cerrar el viaje.' },
};

async function init() {
  registerServiceWorker();
  [cfg, me] = await Promise.all([api('/config'), api('/me')]);
  if (me.role === 'admin') $('#brand').textContent = `${cfg.companyName} · vista chofer`;
  else $('#brand').textContent = cfg.companyName;
  $('#menu-name').textContent = me.name;
  $('#menu-email').textContent = me.email;
  document.title = `Mis viajes · ${cfg.companyName}`;
  syncPushSubscription();
  await renderBanners();
  await load();

  // Actualiza sola cada minuto y al volver a abrir la app.
  setInterval(() => document.visibilityState === 'visible' && load(true), 60000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load(true));
  navigator.serviceWorker?.addEventListener('message', (e) => e.data?.type === 'push' && load(true));
  window.addEventListener('hashchange', focusFromHash);
}

async function load(silent = false) {
  if (tab === 'payments') return loadPayments(silent);
  try {
    trips = await api(`/trips?scope=${tab}`);
    render();
    if (!silent) focusFromHash();
  } catch (err) {
    if (!silent) showError($('#list'), err);
  }
}

function render() {
  const list = $('#list');
  if (!trips.length) {
    list.innerHTML = `<div class="empty">${tab === 'open' ? '🎉 No tienes viajes pendientes.<br><span class="small">Te avisaremos cuando se te asigne uno.</span>' : 'Aún no hay viajes en tu historial.'}</div>`;
    return;
  }
  list.innerHTML = trips.map(tripCard).join('');
}

function tripCard(t) {
  const step = STATUS[t.status]?.step ?? 0;
  const action = ACTIONS[t.status];
  const mapEmbed =
    cfg.googleMapsApiKey && t.status !== 'finalizado' && t.status !== 'cancelado'
      ? `<iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps/embed/v1/directions?key=${encodeURIComponent(cfg.googleMapsApiKey)}&origin=${encodeURIComponent(point(t, 'pickup'))}&destination=${encodeURIComponent(point(t, 'dest'))}&language=es&region=MX"></iframe>`
      : '';
  const details = [
    ['Cliente', t.client],
    ['Carga', t.cargo],
    ['Vehículo', t.vehicle_name && `${t.vehicle_name}${t.vehicle_plate ? ` · ${t.vehicle_plate}` : ''}`],
    ['Notas', t.notes],
  ].filter(([, v]) => v);

  const results =
    t.status === 'finalizado'
      ? `<div class="row" style="margin-top:8px">
          <div class="metric"><b>${fmtNum(t.km)}</b><span>km recorridos</span></div>
          <div class="metric"><b>${fmtNum(t.fuel_liters, 1)}</b><span>litros</span></div>
          <div class="metric"><b>${t.km_per_liter ? fmtNum(t.km_per_liter, 2) : '—'}</b><span>km por litro</span></div>
        </div>`
      : '';

  const isOpen = ['en_recoleccion', 'cargado', 'en_ruta'].includes(t.status);
  return `
  <article class="card" id="viaje-${t.id}">
    <div class="card-head">
      <div><h2>Viaje #${t.id}</h2>${statusBadge(t.status)}</div>
      <span class="muted small">${t.odo_start != null ? `Odómetro inicial: ${fmtNum(t.odo_start)} km` : ''}</span>
    </div>
    ${t.status !== 'cancelado' ? `<div class="steps">${[1, 2, 3, 4].map((i) => `<span class="${step >= i ? 'done' : ''}"></span>`).join('')}</div>` : ''}
    <div class="stop">
      <div class="dot">📍</div>
      <div class="body">
        <div class="muted small">Recolección · ${esc(fmtDate(t.pickup_at))}</div>
        <div class="addr">${esc(t.pickup_address)}</div>
      </div>
      <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.pickup_address, t.pickup_lat, t.pickup_lng))}">Navegar</a>
    </div>
    <div class="stop">
      <div class="dot">🏁</div>
      <div class="body">
        <div class="muted small">Destino${t.delivery_at ? ` · entrega ${esc(fmtDate(t.delivery_at))}` : ''}</div>
        <div class="addr">${esc(t.dest_address)}</div>
      </div>
      <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.dest_address, t.dest_lat, t.dest_lng))}">Navegar</a>
    </div>
    ${details.length ? `<dl class="kv">${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    ${mapEmbed}
    ${results}
    ${
      action
        ? `<p class="muted small" style="margin:12px 0 6px">${esc(action.help)}</p>
           <button class="${action.cls} btn-big" data-action="${action.kind}" data-id="${t.id}">${action.label}</button>`
        : ''
    }
    ${
      isOpen
        ? `<div class="row" style="margin-top:8px">
            <button class="grow" data-action="fuel" data-id="${t.id}">⛽ Cargué combustible</button>
            <button class="grow" data-action="note" data-id="${t.id}">💬 Enviar nota</button>
          </div>`
        : ''
    }
  </article>`;
}

function point(t, kind) {
  const lat = t[`${kind}_lat`];
  const lng = t[`${kind}_lng`];
  return lat != null && lng != null ? `${lat},${lng}` : t[`${kind}_address`];
}

function focusFromHash() {
  if (location.hash === '#pagos' && tab !== 'payments') return switchTab('payments');
  const m = location.hash.match(/viaje-(\d+)/);
  if (!m) return;
  const el = document.getElementById(`viaje-${m[1]}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.style.outline = '3px solid var(--primary)';
    setTimeout(() => (el.style.outline = ''), 2500);
  } else if (tab === 'open') {
    // Puede estar en el historial.
    switchTab('closed');
  }
}

function switchTab(name) {
  tab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  load();
}

// ---------- Recibos de pago ----------
let payments = [];
async function loadPayments(silent) {
  try {
    payments = await api('/payments');
  } catch (err) {
    if (!silent) showError($('#list'), err);
    return;
  }
  const money = (n) => `$${fmtNum(n, 2)}`;
  $('#list').innerHTML = payments.length
    ? payments
        .map((p) => {
          const week = p.week ? `CW${String(p.week).padStart(2, '0')} ${p.year}` : '';
          const title = p.kind === 'bono' ? `Bono${week ? ` · ${week}` : ''}` : `Pago semanal · ${week}`;
          const trips = p.items.filter((i) => i.trip_id).length;
          return `
      <article class="card">
        <div class="card-head">
          <div><h2>${esc(title)}</h2><span class="muted small">Folio ${esc(p.folio)} · pagado el ${esc(fmtDate(p.paid_at, true))}</span></div>
          <b style="font-size:1.3rem">${money(p.amount)}</b>
        </div>
        ${p.kind === 'bono' ? `<p>${esc(p.description)}</p>` : p.period_start ? `<p class="muted small">Del ${esc(fmtDate(p.period_start, true))} al ${esc(fmtDate(p.period_end, true))}${trips ? ` · ${trips} viaje(s)` : ''}</p>` : ''}
        ${p.notes ? `<p class="small">${esc(p.notes)}</p>` : ''}
        ${p.status === 'cancelado' ? '<div class="alert alert-error">Este recibo fue cancelado.</div>' : ''}
        <div class="row" style="margin-top:8px">
          <a class="btn btn-soft grow" href="/api/payments/${p.id}/pdf?download=1">⬇ Descargar recibo</a>
          <a class="btn grow" href="/api/payments/${p.id}/pdf" target="_blank" rel="noopener">Ver</a>
        </div>
        ${
          p.status === 'cancelado'
            ? ''
            : p.acknowledged_at
              ? `<p class="small" style="color:var(--ok);margin-bottom:0">✓ Confirmaste que lo recibiste el ${esc(fmtUtc(p.acknowledged_at))}</p>`
              : `<button class="btn-ok btn-big" style="margin-top:8px" data-ack="${p.id}">✓ Confirmo que recibí este pago</button>`
        }
      </article>`;
        })
        .join('')
    : '<div class="empty">Aquí aparecerán tus recibos de pago.</div>';
}

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ack]');
  if (!btn) return;
  if (!confirm('¿Confirmas que recibiste este pago?')) return;
  btn.disabled = true;
  try {
    await api(`/payments/${btn.dataset.ack}/ack`, { method: 'POST' });
    toast('¡Gracias! Pago confirmado');
    loadPayments(true);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

// ---------- Acciones ----------
$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const trip = trips.find((t) => t.id === Number(btn.dataset.id));
  const kind = btn.dataset.action;
  if (kind === 'start' || kind === 'finish') return openOdometer(trip, kind);
  if (kind === 'fuel') return openFuel(trip);
  if (kind === 'note') return openNote(trip);

  const question = kind === 'loaded' ? '¿Confirmas que ya terminaste de cargar?' : '¿Confirmas que ya vas saliendo rumbo al destino?';
  if (!confirm(question)) return;
  btn.disabled = true;
  try {
    const pos = await currentPosition();
    await api(`/trips/${trip.id}/${kind === 'loaded' ? 'loaded' : 'depart'}`, { method: 'POST', body: { ...(pos || {}) } });
    toast(kind === 'loaded' ? 'Carga registrada' : '¡Buen viaje! Maneja con cuidado');
    await load(true);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

function openOdometer(trip, kind) {
  odoAction = { trip, kind };
  const form = $('#odo-form');
  form.reset();
  $('#odo-preview').classList.add('hidden');
  $('#odo-photo-text').classList.remove('hidden');
  $('#odo-msg').innerHTML = '';
  $('#odo-title').textContent = kind === 'start' ? `Iniciar viaje #${trip.id}` : `Finalizar viaje #${trip.id}`;
  $('#odo-help').textContent =
    kind === 'start'
      ? 'Toma una foto clara del odómetro (kilometraje) antes de arrancar y escribe la lectura.'
      : 'Toma una foto clara del odómetro al llegar al destino y escribe la lectura.';
  const ref = kind === 'start' ? trip.vehicle_last_odometer : trip.odo_start;
  $('#odo-hint').textContent = ref != null ? `${kind === 'start' ? 'Última lectura registrada de este vehículo' : 'Lectura al iniciar'}: ${fmtNum(ref)} km` : '';
  $('#odo-reading').min = kind === 'finish' && trip.odo_start != null ? trip.odo_start : 0;
  $('#odo-dialog').showModal();
}

function bindPhotoPreview(input, img, text) {
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    img.src = URL.createObjectURL(file);
    img.classList.remove('hidden');
    text.classList.add('hidden');
  });
}
bindPhotoPreview($('#odo-form [name=photo]'), $('#odo-preview'), $('#odo-photo-text'));
bindPhotoPreview($('#fuel-form [name=photo]'), $('#fuel-form .preview'), $('#fuel-form .photo-text'));

$('#odo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const file = form.photo.files[0];
  if (!file) return showError($('#odo-msg'), 'Toma la foto del odómetro.');
  const btn = $('#odo-submit');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const [photo, pos] = await Promise.all([shrinkPhoto(file), currentPosition()]);
    const body = new FormData();
    body.append('photo', photo, 'odometro.jpg');
    body.append('odometer', form.odometer.value);
    if (pos) {
      body.append('lat', pos.lat);
      body.append('lng', pos.lng);
    }
    const trip = await api(`/trips/${odoAction.trip.id}/${odoAction.kind}`, { method: 'POST', body });
    $('#odo-dialog').close();
    if (odoAction.kind === 'finish') {
      toast(`Viaje terminado: ${fmtNum(trip.km)} km${trip.km_per_liter ? ` · ${fmtNum(trip.km_per_liter, 2)} km/L` : ''}`);
    } else {
      toast('Viaje iniciado. ¡Buen camino!');
    }
    await load(true);
  } catch (err) {
    showError($('#odo-msg'), err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar';
  }
});

function openFuel(trip) {
  fuelTrip = trip;
  const form = $('#fuel-form');
  form.reset();
  form.querySelector('.preview').classList.add('hidden');
  form.querySelector('.photo-text').classList.remove('hidden');
  form.querySelector('.msg').innerHTML = '';
  $('#fuel-dialog').showModal();
}

$('#fuel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('.btn-primary');
  btn.disabled = true;
  try {
    const body = new FormData();
    body.append('liters', form.liters.value);
    body.append('amount', form.amount.value);
    body.append('odometer', form.odometer.value);
    if (form.photo.files[0]) body.append('photo', await shrinkPhoto(form.photo.files[0]), 'ticket.jpg');
    await api(`/trips/${fuelTrip.id}/fuel`, { method: 'POST', body });
    $('#fuel-dialog').close();
    toast('Carga de combustible guardada');
    await load(true);
  } catch (err) {
    showError(form.querySelector('.msg'), err);
  } finally {
    btn.disabled = false;
  }
});

function openNote(trip) {
  noteTrip = trip;
  $('#note-form').reset();
  $('#note-form .msg').innerHTML = '';
  $('#note-dialog').showModal();
}

$('#note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const pos = await currentPosition(3000);
    await api(`/trips/${noteTrip.id}/note`, { method: 'POST', body: { note: form.note.value, ...(pos || {}) } });
    $('#note-dialog').close();
    toast('Nota enviada');
  } catch (err) {
    showError(form.querySelector('.msg'), err);
  }
});

// ---------- Avisos de notificaciones e instalación ----------
async function renderBanners() {
  const state = await pushState().catch(() => 'unsupported');
  const box = $('#banners');
  const parts = [];
  if (state === 'off') {
    parts.push(`<div class="alert alert-warn row"><span class="grow">🔔 Activa las notificaciones para enterarte al momento de tus viajes nuevos.</span><button class="btn-sm btn-primary" id="banner-push">Activar</button></div>`);
  } else if (state === 'denied') {
    parts.push(`<div class="alert alert-warn">🔕 Las notificaciones están bloqueadas. Actívalas en los ajustes del navegador para este sitio. Mientras tanto, te llegarán los avisos por correo.</div>`);
  } else if (state === 'needs-install') {
    parts.push(`<div class="alert alert-info">📲 En iPhone: toca <b>Compartir</b> <span aria-hidden="true">⎋</span> y luego <b>“Agregar a pantalla de inicio”</b>. Abre la app desde ese ícono para poder recibir notificaciones.</div>`);
  }
  box.innerHTML = parts.join('');
  $('#menu-push').textContent = state === 'on' ? '🔔 Probar notificación' : '🔔 Activar notificaciones';
  $('#banner-push')?.addEventListener('click', turnOnPush);
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

// ---------- Menú y pestañas ----------
$('#btn-menu').onclick = () => $('#menu').showModal();
$('#btn-refresh').onclick = () => load().then(() => toast('Actualizado'));
$('#menu-push').onclick = turnOnPush;
$('#menu-password').onclick = () => {
  $('#menu').close();
  openPasswordDialog();
};
$('#menu-logout').onclick = logout;
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
$$('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

init().catch((err) => showError($('#list'), err));
