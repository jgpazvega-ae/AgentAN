// Página del chofer: lista de viajes, pasos del viaje con fotos (odómetro y
// combustible al salir y al regresar, llegada a cargar, unidad cargada, llegada
// y prueba de entrega), pausas (hotel, domicilio) y ubicación cada cierto tiempo.
let cfg = {};
let me = null;
let tab = 'open';
let trips = [];
let stepAction = null; // { trip, kind }
let fuelTrip = null;
let noteTrip = null;
let openTrips = []; // viajes abiertos (para saber si se comparte la ubicación)

const ACTIONS = {
  asignado: { label: '▶ Iniciar viaje', cls: 'btn-primary', kind: 'start', help: 'Antes de arrancar hacia donde vas a cargar, toma la foto del odómetro y del nivel de combustible.' },
  // en_recoleccion tiene dos pasos: llegar a cargar y terminar de cargar (ver actionFor).
  en_recoleccion: { label: '📦 Terminé de cargar', cls: 'btn-primary', kind: 'loaded', help: 'Con la mercancía ya acomodada, toma la foto de la unidad cargada. Si sales hasta otro día, usa “Pausar” al llegar a descansar.' },
  cargado: { label: '🚚 Salir rumbo al destino', cls: 'btn-primary', kind: 'depart', help: 'Presiona justo al arrancar hacia el destino.' },
  en_ruta: { label: '📍 Llegué al punto de entrega', cls: 'btn-primary', kind: 'arrive', help: 'Al llegar al destino, toma una foto del lugar.' },
  en_destino: { label: '✅ Entregar', cls: 'btn-ok', kind: 'finish', help: 'Toma las fotos de la prueba de entrega, anota quién recibe y la foto del odómetro.' },
  entregado: { label: '🏠 Llegué a mi domicilio / base', cls: 'btn-primary', kind: 'return', help: 'Al estacionar la unidad en tu domicilio o en la base, toma la foto del odómetro y del nivel de combustible para cerrar el viaje.' },
};

const AT_PICKUP = { label: '📍 Llegué a cargar', cls: 'btn-primary', kind: 'at-pickup', help: 'Al llegar al lugar donde vas a cargar, toma una foto.' };

// Acción principal según la etapa (y si el viaje está en pausa o tiene regreso).
function actionFor(t) {
  if (t.paused) return { label: '▶ Reanudar viaje', cls: 'btn-primary', kind: 'resume', help: 'Antes de arrancar, toma la foto del odómetro.' };
  if (t.status === 'en_recoleccion' && !t.at_pickup_at) return AT_PICKUP;
  if (t.status === 'asignado' && t.parent_trip_id && !['entregado', 'finalizado', 'cancelado'].includes(t.parent_status)) {
    return { disabled: true, label: '▶ Iniciar regreso', cls: 'btn-primary', kind: 'start', help: `Primero termina la entrega del viaje de ida #${t.parent_trip_id}.` };
  }
  if (t.status === 'entregado' && t.return_trip_id) {
    return { info: true, help: `Tu siguiente paso es el viaje de regreso #${t.return_trip_id}. Este viaje se cierra solo cuando inicies el regreso. Si la unidad se queda a dormir, usa “Pausar”.` };
  }
  return ACTIONS[t.status];
}

const PAUSABLE = ['en_recoleccion', 'cargado', 'en_ruta', 'en_destino', 'entregado'];
const TRACKED = PAUSABLE;
const PAUSE_PLACES = [
  ['hotel', '🏨 Hotel'],
  ['domicilio', '🏠 Mi domicilio'],
  ['base', '🏢 Base de AN'],
  ['cliente', '🏭 Instalaciones del cliente'],
  ['carretera', '🛣️ Descanso en carretera'],
  ['otro', '📍 Otro lugar'],
];
const pauseLabel = (place) => PAUSE_PLACES.find(([k]) => k === place)?.[1] || place;

// Última lectura de odómetro conocida del viaje (inicio, pausas o entrega).
function lastReading(t) {
  const list = [t.odo_start, t.odo_end, ...(t.pauses || []).flatMap((p) => [p.pause_odometer, p.resume_odometer])].filter((v) => v != null);
  return list.length ? Math.max(...list) : null;
}

// Qué pide cada paso. Todas las fotos quedan guardadas en la plataforma.
const STEPS = {
  'at-pickup': {
    title: 'Llegué a cargar',
    help: 'Toma una foto al llegar al punto de carga (fachada, andén o la unidad en el lugar).',
    photo: '📷 Foto de llegada a cargar',
    done: 'Llegada registrada. Avisa cuando termines de cargar.',
  },
  loaded: {
    title: 'Terminé de cargar',
    help: 'Toma una foto de la unidad ya cargada, con la mercancía acomodada.',
    photo: '📷 Foto de la unidad cargada',
    done: 'Carga registrada',
  },
  pause: {
    title: 'Pausar el viaje',
    help: 'Para descansar o dormir (hotel, tu domicilio, la base…). Toma una foto de la unidad estacionada y la lectura del odómetro. Al día siguiente presiona “Reanudar viaje”.',
    place: true,
    photo: '📷 Foto de la unidad estacionada',
    odometer: 'pause',
    resumePlanned: true,
    done: 'Viaje en pausa. ¡Descansa!',
  },
  resume: {
    title: 'Reanudar viaje',
    help: 'Antes de arrancar, toma la foto del odómetro con su lectura.',
    photo: '📷 Foto del odómetro',
    odometer: 'resume',
    done: 'Viaje reanudado. ¡Buen camino!',
  },
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
    help: 'Si pasaron más de 3 horas desde que cargaste o reanudaste, toma una foto de la unidad antes de salir.',
    photo: '📷 Foto de salida',
    photoOptional: true,
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
    if (tab === 'open') {
      openTrips = trips;
      updateTracking();
    }
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
  const action = actionFor(t);
  const pause = (t.pauses || []).find((p) => !p.resumed_at);
  const mapEmbed =
    cfg.googleMapsApiKey && t.status !== 'finalizado' && t.status !== 'cancelado'
      ? `<iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps/embed/v1/directions?key=${encodeURIComponent(cfg.googleMapsApiKey)}&origin=${encodeURIComponent(point(t, 'pickup'))}&destination=${encodeURIComponent(point(t, 'dest'))}&language=es&region=MX"></iframe>`
      : '';
  const details = [
    ['Cliente', t.client],
    ['Carga', t.cargo],
    ['Vehículo', t.vehicle_name && `${t.vehicle_name}${t.vehicle_plate ? ` · ${t.vehicle_plate}` : ''}`],
    ['Ruta', [t.route_km != null ? `${fmtNum(t.route_km)} km` : '', fmtDuration(t.route_minutes)].filter(Boolean).join(' · ')],
    ['Pernocta', t.overnight_nights ? `${t.overnight_nights} noche(s) autorizada(s)${t.lodging_notes ? ` · ${t.lodging_notes}` : ''}` : ''],
    ['Viaje de regreso', t.return_trip_id ? `#${t.return_trip_id}` : ''],
    ['Viaje de ida', t.parent_trip_id ? `#${t.parent_trip_id}` : ''],
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
      <div><h2>Viaje #${t.id}${t.name ? ` · ${esc(t.name)}` : ''}</h2>${statusBadge(t.status)}${pause ? ' <span class="badge st-pausa">⏸ En pausa</span>' : ''}</div>
      <span class="muted small">${t.odo_start != null ? `Odómetro inicial: ${fmtNum(t.odo_start)} km` : ''}</span>
    </div>
    ${t.status !== 'cancelado' ? `<div class="steps">${[1, 2, 3, 4, 5, 6].map((i) => `<span class="${step >= i ? 'done' : ''}"></span>`).join('')}</div>` : ''}
    ${
      t.prepickup_address
        ? `<div class="stop pre">
      <div class="dot">📦</div>
      <div class="body">
        <div class="muted small">1. Recolección anticipada · ${esc(fmtDate(t.prepickup_at))}</div>
        <div class="addr">${esc(t.prepickup_address)}</div>
      </div>
      <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.prepickup_address, t.prepickup_lat, t.prepickup_lng))}">Navegar</a>
    </div>`
        : ''
    }
    <div class="stop">
      <div class="dot">📍</div>
      <div class="body">
        <div class="muted small">${t.prepickup_address ? '2. Salida (inicio del viaje)' : 'Inicio y carga'} · ${esc(fmtDate(t.pickup_at))}</div>
        <div class="addr">${esc(t.pickup_address)}</div>
      </div>
      <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.pickup_address, t.pickup_lat, t.pickup_lng))}">Navegar</a>
    </div>
    <div class="stop">
      <div class="dot">🏁</div>
      <div class="body">
        <div class="muted small">Destino${t.delivery_at ? ` · entrega pactada ${esc(fmtDate(t.delivery_at))}` : ''}${t.eta ? ` · <span class="eta-chip">${esc(etaLabel(t))}</span>` : ''}</div>
        <div class="addr">${esc(t.dest_address)}</div>
      </div>
      <a class="btn btn-soft btn-sm" target="_blank" rel="noopener" href="${esc(mapsUrl(t.dest_address, t.dest_lat, t.dest_lng))}">Navegar</a>
    </div>
    ${details.length ? `<dl class="kv">${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    ${mapEmbed}
    ${results}
    ${
      pause
        ? `<div class="alert alert-info" style="margin-top:12px">⏸ En pausa desde ${esc(fmtDate(pause.paused_at))} · ${esc(pauseLabel(pause.place))}${
            pause.resume_planned_at ? `<br>Reanudas: <b>${esc(fmtDate(pause.resume_planned_at))}</b>` : ''
          }</div>`
        : ''
    }
    ${
      action
        ? `<p class="muted small" style="margin:12px 0 6px">${esc(action.help)}</p>
           ${action.info ? '' : `<button class="${action.cls} btn-big" data-action="${action.kind}" data-id="${t.id}" ${action.disabled ? 'disabled' : ''}>${action.label}</button>`}`
        : ''
    }
    ${
      isOpen
        ? `<div class="row" style="margin-top:8px">
            ${PAUSABLE.includes(t.status) && !pause ? `<button class="grow" data-action="pause" data-id="${t.id}">🌙 Pausar (descanso / hotel)</button>` : ''}
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
  if (cfgStep.place) {
    parts.push(`<label for="pause-place">¿Dónde haces la pausa?</label>
      <select id="pause-place" name="place" required>
        <option value="">Elige…</option>
        ${PAUSE_PLACES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}
      </select>
      <input name="place_note" maxlength="200" placeholder="Nombre del hotel o ciudad (opcional)" style="margin-top:6px">
      ${trip.overnight_nights ? `<p class="muted small">Pernocta autorizada: ${trip.overnight_nights} noche(s)${trip.lodging_notes ? ` · ${esc(trip.lodging_notes)}` : ''}</p>` : ''}`);
  }
  if (cfgStep.odometer) parts.push(`<h3 class="step-h">${cfgStep.place ? 'Unidad y odómetro' : 'Odómetro'}</h3>`);
  parts.push(photoSlot('photo', cfgStep.photo, !cfgStep.photoOptional));
  if (cfgStep.odometer) {
    const pause = (trip.pauses || []).find((p) => !p.resumed_at);
    const [ref, refLabel] = {
      start: [trip.parent_trip_id ? null : trip.vehicle_last_odometer, 'Última lectura registrada de este vehículo'],
      end: [lastReading(trip), 'Última lectura registrada'],
      return: [lastReading(trip), 'Última lectura registrada'],
      pause: [lastReading(trip), 'Última lectura registrada'],
      resume: [pause?.pause_odometer, 'Lectura al pausar'],
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
  if (cfgStep.resumePlanned) {
    parts.push(`<label for="resume-at">¿Cuándo reanudas? <small class="muted">(opcional, para avisar al cliente y recalcular la llegada)</small></label>
      <input id="resume-at" type="datetime-local" name="resume_planned_at">`);
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
  if (cfgStep.place && !form.place.value) return showError($('#step-msg'), 'Elige dónde haces la pausa.');
  if (!main && !cfgStep.photoOptional) return showError($('#step-msg'), `Falta: ${cfgStep.photo.replace('📷 ', '')}.`);
  if (cfgStep.odometer && !form.odometer.value) return showError($('#step-msg'), 'Escribe la lectura del odómetro.');
  const fuelFile = cfgStep.fuel ? form.querySelector('input[name=fuel]').files[0] : null;
  if (cfgStep.fuel && !fuelFile) return showError($('#step-msg'), 'Falta la foto del tablero con el nivel de combustible.');
  if (cfgStep.fuel && form.fuel_level.value === '') return showError($('#step-msg'), 'Elige cómo marca la aguja de combustible.');
  const btn = $('#step-submit');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const [photo, fuelBlob, pos, ...podBlobs] = await Promise.all([
      main ? shrinkPhoto(main) : null,
      fuelFile ? shrinkPhoto(fuelFile) : null,
      currentPosition(),
      ...pods.map((f) => shrinkPhoto(f)),
    ]);
    const body = new FormData();
    if (photo) body.append('photo', photo, 'foto.jpg');
    if (cfgStep.place) {
      body.append('place', form.place.value);
      body.append('place_note', form.place_note.value.trim());
    }
    if (cfgStep.resumePlanned && form.resume_planned_at.value) body.append('resume_planned_at', form.resume_planned_at.value);
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

// ---------- Ubicación cada cierto tiempo ----------
// Los navegadores solo permiten leer la ubicación con la app abierta (no en
// segundo plano). Para cuidar datos y batería:
// - una lectura cada N minutos (no seguimiento continuo del GPS);
// - si la unidad no se movió más de 150 m, no se envía (salvo cada 30 min);
// - sin señal, los puntos se guardan en el celular y se envían juntos después;
// - nada en pausa (hotel, domicilio) ni fuera de un viaje activo.
const QUEUE_KEY = 'fletes-ubicaciones';
let trackTimer = null;
let trackMinutes = 0;
let lastTick = 0;
let lastSent = null;

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-300)));
  } catch {}
}
function metersBetween(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// El viaje que se está haciendo ahora (si hay regreso en curso, ese).
function trackedTrip() {
  const active = openTrips.filter((t) => TRACKED.includes(t.status) && !t.paused);
  return active.find((t) => t.status !== 'entregado') || active[0] || null;
}

function updateTracking() {
  const minutes = Number(cfg.trackingMinutes) || 0;
  const trip = minutes && 'geolocation' in navigator ? trackedTrip() : null;
  let note = $('#tracking-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'tracking-note';
    note.className = 'muted small';
    $('#banners').after(note);
  }
  note.textContent = trip ? `📍 Compartiendo tu ubicación cada ${minutes} min mientras el viaje #${trip.id} está activo y esta app está abierta. En pausa no se comparte.` : '';
  if (!trip || minutes !== trackMinutes) {
    clearInterval(trackTimer);
    trackTimer = null;
  }
  trackMinutes = minutes;
  if (trip && !trackTimer) {
    trackTimer = setInterval(trackTick, minutes * 60000);
    if (Date.now() - lastTick > minutes * 60000) trackTick();
  }
}

function precisePosition() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 25000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, speed: p.coords.speed });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
    );
  });
}

async function trackTick() {
  lastTick = Date.now();
  const trip = trackedTrip();
  if (!trip) return updateTracking();
  const pos = await precisePosition();
  if (pos) {
    const now = Date.now();
    const moved = lastSent ? metersBetween(lastSent, pos) : Infinity;
    if (moved > 150 || now - lastSent.t > 30 * 60000) {
      const queue = readQueue();
      queue.push({ trip: trip.id, lat: Math.round(pos.lat * 1e5) / 1e5, lng: Math.round(pos.lng * 1e5) / 1e5, accuracy: Math.round(pos.accuracy || 0), speed: pos.speed, t: now });
      saveQueue(queue);
      lastSent = { lat: pos.lat, lng: pos.lng, t: now };
    }
  }
  flushLocations();
}

async function flushLocations() {
  const queue = readQueue();
  if (!queue.length || navigator.onLine === false) return;
  const byTrip = new Map();
  for (const p of queue) byTrip.set(p.trip, [...(byTrip.get(p.trip) || []), p]);
  let pending = queue;
  for (const [tripId, points] of byTrip) {
    try {
      await api(`/trips/${tripId}/locations`, { method: 'POST', body: { points: points.map(({ trip, ...p }) => p) } });
      pending = pending.filter((p) => p.trip !== tripId); // enviados (o ya no se necesitan)
    } catch (err) {
      // Sin conexión: se quedan guardados para el siguiente intento. Otro error
      // (viaje cerrado, sin permiso): se descartan.
      if (!/Sin conexión/.test(err.message)) pending = pending.filter((p) => p.trip !== tripId);
    }
  }
  saveQueue(pending);
}
window.addEventListener('online', flushLocations);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && trackTimer && Date.now() - lastTick > trackMinutes * 60000) trackTick();
});

init().catch((err) => showError($('#list'), err));
