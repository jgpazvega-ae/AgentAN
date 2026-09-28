// Página del chofer: lista de viajes, pasos del viaje con fotos (odómetro y
// combustible al salir y al regresar, carga, llegada y prueba de entrega).
let cfg = {};
let me = null;
let tab = 'open';
let trips = [];
let stepAction = null; // { trip, kind }
let fuelTrip = null;
let noteTrip = null;

const ACTIONS = {
  asignado: { label: '▶ Iniciar viaje', cls: 'btn-primary', kind: 'start', help: 'Antes de arrancar hacia la recolección, toma la foto del odómetro y del nivel de combustible.' },
  en_recoleccion: { label: '📦 Terminé de cargar', cls: 'btn-primary', kind: 'loaded', help: 'Presiona cuando la mercancía esté cargada. Si sales hasta otro día, el viaje quedará en espera.' },
  cargado: { label: '🚚 Salir rumbo al destino', cls: 'btn-primary', kind: 'depart', help: 'Justo antes de arrancar hacia el destino, toma la foto de la carga.' },
  en_ruta: { label: '📍 Llegué al punto de entrega', cls: 'btn-primary', kind: 'arrive', help: 'Al llegar al destino, toma una foto del lugar.' },
  en_destino: { label: '✅ Entregar', cls: 'btn-ok', kind: 'finish', help: 'Toma las fotos de la prueba de entrega, anota quién recibe y la foto del odómetro.' },
  entregado: { label: '🏠 Llegué a mi domicilio / base', cls: 'btn-primary', kind: 'return', help: 'Al estacionar la unidad en tu domicilio o en la base, toma la foto del odómetro y del nivel de combustible para cerrar el viaje.' },
};

// Qué pide cada paso. Todas las fotos quedan guardadas en la plataforma.
const STEPS = {
  start: {
    title: 'Iniciar viaje',
    help: 'Antes de arrancar hacia la recolección: foto clara del odómetro (kilometraje) con su lectura y foto del tablero con el nivel de combustible.',
    photo: '📷 Foto del odómetro',
    odometer: 'start',
    fuel: true,
    done: 'Viaje iniciado. ¡Buen camino!',
  },
  depart: {
    title: 'Salir rumbo al destino',
    help: 'Toma una foto de la carga ya acomodada en la unidad, justo antes de salir.',
    photo: '📷 Foto de la carga',
    done: '¡Buen viaje! Maneja con cuidado',
  },
  arrive: {
    title: 'Llegué al punto de entrega',
    help: 'Toma una foto al llegar: fachada, andén o lugar de entrega.',
    photo: '📷 Foto de llegada',
    done: 'Llegada registrada',
  },
  finish: {
    title: 'Entregar',
    help: 'Prueba de entrega: fotos de la mercancía entregada o de la remisión firmada, nombre de quien recibe, su firma (opcional) y el odómetro final.',
    pod: 3,
    receivedBy: true,
    signature: true,
    photo: '📷 Foto del odómetro final',
    odometer: 'end',
    done: '¡Entrega registrada! Al llegar a tu domicilio o base, cierra el viaje.',
  },
  return: {
    title: 'Llegué a mi domicilio / base',
    help: 'Con la unidad ya estacionada: foto del odómetro con su lectura y foto del tablero con el nivel de combustible. Así cerramos los kilómetros y el combustible de todo el recorrido.',
    photo: '📷 Foto del odómetro',
    odometer: 'return',
    fuel: true,
    done: 'Viaje cerrado. ¡Gracias!',
  },
};

async function init() {
  registerServiceWorker();
  [cfg, me] = await Promise.all([api('/config'), api('/me')]);
  if (me.role === 'client') return (location.href = '/cliente.html');
  $('#brand').textContent = isStaffRole(me.role) ? 'Vista chofer' : 'Mis viajes';
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
          <div class="metric"><b>${fmtNum(t.fuel_used, 1)}</b><span>litros</span></div>
          <div class="metric"><b>${t.km_per_liter ? fmtNum(t.km_per_liter, 2) : '—'}</b><span>km por litro</span></div>
        </div>`
      : '';

  const isOpen = ['en_recoleccion', 'cargado', 'en_ruta', 'en_destino', 'entregado'].includes(t.status);
  return `
  <article class="card" id="viaje-${t.id}">
    <div class="card-head">
      <div><h2>Viaje #${t.id}</h2>${statusBadge(t.status)}</div>
      <span class="muted small">${t.odo_start != null ? `Odómetro inicial: ${fmtNum(t.odo_start)} km` : ''}</span>
    </div>
    ${t.status !== 'cancelado' ? `<div class="steps">${[1, 2, 3, 4, 5, 6].map((i) => `<span class="${step >= i ? 'done' : ''}"></span>`).join('')}</div>` : ''}
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
  if (STEPS[kind]) return openStep(trip, kind);
  if (kind === 'fuel') return openFuel(trip);
  if (kind === 'note') return openNote(trip);

  if (kind !== 'loaded') return;
  if (!confirm('¿Confirmas que ya terminaste de cargar?')) return;
  btn.disabled = true;
  try {
    const pos = await currentPosition();
    await api(`/trips/${trip.id}/loaded`, { method: 'POST', body: { ...(pos || {}) } });
    toast('Carga registrada');
    await load(true);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

// ---------- Ventana de cada paso (fotos, quién recibe, firma, odómetro) ----------
function photoSlot(name, label, required) {
  return `<label class="photo-input">
      <span class="photo-text">${esc(label)}${required ? '' : ' <small>(opcional)</small>'}</span>
      <img class="hidden preview" alt="Vista previa">
      <input type="file" name="${name}" accept="image/*" capture="environment">
    </label>`;
}

function openStep(trip, kind) {
  const cfgStep = STEPS[kind];
  stepAction = { trip, kind };
  $('#step-title').textContent = `${cfgStep.title} · viaje #${trip.id}`;
  $('#step-help').textContent = cfgStep.help;
  const parts = [];
  if (cfgStep.pod) {
    parts.push('<h3 class="step-h">Prueba de entrega</h3><div class="pod-grid">');
    for (let i = 0; i < cfgStep.pod; i++) parts.push(photoSlot('pod', i === 0 ? '📷 Foto de entrega' : '📷 Otra foto', i === 0));
    parts.push('</div>');
  }
  if (cfgStep.receivedBy) {
    parts.push('<label for="received-by">Nombre de quien recibe</label><input id="received-by" name="received_by" maxlength="150" autocomplete="off" required>');
  }
  if (cfgStep.signature) {
    parts.push(`<label>Firma de quien recibe <small class="muted">(opcional)</small></label>
      <div class="sig-wrap"><canvas id="sig-pad" width="600" height="200"></canvas>
      <button type="button" class="btn-sm" id="sig-clear">Borrar firma</button></div>`);
  }
  if (cfgStep.odometer) parts.push('<h3 class="step-h">Odómetro</h3>');
  parts.push(photoSlot('photo', cfgStep.photo, true));
  if (cfgStep.odometer) {
    const [ref, refLabel] = {
      start: [trip.vehicle_last_odometer, 'Última lectura registrada de este vehículo'],
      end: [trip.odo_start, 'Lectura al iniciar'],
      return: [trip.odo_end ?? trip.odo_start, 'Lectura al entregar'],
    }[cfgStep.odometer];
    const min = cfgStep.odometer !== 'start' && ref != null ? ref : 0;
    parts.push(`<label for="odo-reading">Lectura del odómetro (km)</label>
      <input id="odo-reading" name="odometer" type="number" inputmode="decimal" step="0.1" min="${min}" required placeholder="Ej. 125430">
      ${ref != null ? `<p class="muted small">${refLabel}: ${fmtNum(ref)} km</p>` : ''}`);
  }
  if (cfgStep.fuel) {
    parts.push(`<h3 class="step-h">Combustible</h3>
      ${photoSlot('fuel', '📷 Foto del tablero (aguja de gasolina)', true)}
      <label for="fuel-level">¿Cómo marca la aguja?</label>
      <select id="fuel-level" name="fuel_level" required>
        <option value="">Elige el nivel…</option>
        ${FUEL_LEVELS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
      </select>
      ${cfgStep.odometer === 'return' && trip.fuel_start != null ? `<p class="muted small">Al iniciar marcaba: ${esc(fuelLabel(trip.fuel_start))}</p>` : ''}`);
  }
  $('#step-fields').innerHTML = parts.join('');
  $('#step-msg').innerHTML = '';
  for (const input of $$('#step-fields input[type=file]')) {
    const box = input.closest('.photo-input');
    bindPhotoPreview(input, box.querySelector('.preview'), box.querySelector('.photo-text'));
  }
  if (cfgStep.signature) setupSignature($('#sig-pad'));
  $('#step-dialog').showModal();
}

// Firma con el dedo sobre la pantalla.
let signed = false;
function setupSignature(canvas) {
  signed = false;
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111827';
  let drawing = false;
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  canvas.onpointerdown = (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.moveTo(...point(e));
  };
  canvas.onpointermove = (e) => {
    if (!drawing) return;
    ctx.lineTo(...point(e));
    ctx.stroke();
    signed = true;
  };
  canvas.onpointerup = () => (drawing = false);
  $('#sig-clear').onclick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    signed = false;
  };
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
bindPhotoPreview($('#fuel-form [name=photo]'), $('#fuel-form .preview'), $('#fuel-form .photo-text'));

$('#step-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const cfgStep = STEPS[stepAction.kind];
  const main = form.querySelector('input[name=photo]').files[0];
  const pods = [...form.querySelectorAll('input[name=pod]')].map((i) => i.files[0]).filter(Boolean);
  if (cfgStep.pod && !pods.length) return showError($('#step-msg'), 'Toma al menos una foto de la prueba de entrega.');
  if (cfgStep.receivedBy && !form.received_by.value.trim()) return showError($('#step-msg'), 'Escribe el nombre de quien recibe.');
  if (!main) return showError($('#step-msg'), `Falta: ${cfgStep.photo.replace('📷 ', '')}.`);
  if (cfgStep.odometer && !form.odometer.value) return showError($('#step-msg'), 'Escribe la lectura del odómetro.');
  const fuelFile = cfgStep.fuel ? form.querySelector('input[name=fuel]').files[0] : null;
  if (cfgStep.fuel && !fuelFile) return showError($('#step-msg'), 'Falta la foto del tablero con el nivel de combustible.');
  if (cfgStep.fuel && form.fuel_level.value === '') return showError($('#step-msg'), 'Elige cómo marca la aguja de combustible.');
  const btn = $('#step-submit');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const [photo, fuelBlob, pos, ...podBlobs] = await Promise.all([
      shrinkPhoto(main),
      fuelFile ? shrinkPhoto(fuelFile) : null,
      currentPosition(),
      ...pods.map((f) => shrinkPhoto(f)),
    ]);
    const body = new FormData();
    body.append('photo', photo, 'foto.jpg');
    if (fuelBlob) {
      body.append('fuel', fuelBlob, 'combustible.jpg');
      body.append('fuel_level', form.fuel_level.value);
    }
    podBlobs.forEach((b, i) => body.append('pod', b, `entrega-${i + 1}.jpg`));
    if (cfgStep.odometer) body.append('odometer', form.odometer.value);
    if (cfgStep.receivedBy) body.append('received_by', form.received_by.value.trim());
    if (cfgStep.signature && signed) {
      const sig = await new Promise((resolve) => $('#sig-pad').toBlob(resolve, 'image/png'));
      if (sig) body.append('signature', sig, 'firma.png');
    }
    if (pos) {
      body.append('lat', pos.lat);
      body.append('lng', pos.lng);
    }
    const trip = await api(`/trips/${stepAction.trip.id}/${stepAction.kind}`, { method: 'POST', body });
    $('#step-dialog').close();
    toast(stepAction.kind === 'return' && trip.km != null ? `${cfgStep.done} ${fmtNum(trip.km)} km recorridos.` : cfgStep.done);
    await load(true);
  } catch (err) {
    showError($('#step-msg'), err);
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
