// Portal del cliente: sigue sus envíos, con las fotos de carga, llegada y
// prueba de entrega que toma el chofer.
let cfg = {};
let me = null;
let tab = 'open';
let trips = [];

const OPEN = ['asignado', 'en_recoleccion', 'cargado', 'en_ruta', 'en_destino'];
const CLIENT_STATUS = {
  asignado: 'Programado',
  en_recoleccion: 'En recolección',
  cargado: 'Cargado, por salir',
  en_ruta: 'En camino',
  en_destino: 'En el punto de entrega',
  finalizado: 'Entregado',
  cancelado: 'Cancelado',
};

async function init() {
  registerServiceWorker();
  [cfg, me] = await Promise.all([api('/config'), api('/me')]);
  if (me.role !== 'client') {
    location.href = me.home;
    return;
  }
  document.title = `Mis envíos · ${cfg.companyName}`;
  $('#menu-name').textContent = me.name;
  $('#menu-email').textContent = me.company ? `${me.company} · ${me.email}` : me.email;
  syncPushSubscription();
  renderBanners();
  await load();
  setInterval(() => document.visibilityState === 'visible' && load(true), 60000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load(true));
  navigator.serviceWorker?.addEventListener('message', (e) => e.data?.type === 'push' && load(true));
  window.addEventListener('hashchange', focusFromHash);
}

async function load(silent = false) {
  try {
    const all = await api('/trips');
    trips = all.filter((t) => (tab === 'open' ? OPEN.includes(t.status) : !OPEN.includes(t.status)));
    render();
    if (!silent) focusFromHash(all);
  } catch (err) {
    if (!silent) showError($('#list'), err);
  }
}

function photoFigure(p) {
  return `<figure><img data-zoom src="/api/photos/${encodeURIComponent(p.file)}" alt="${esc(PHOTO_KIND[p.kind])}" loading="lazy">
    <figcaption>${esc(fmtUtc(p.created_at))}</figcaption></figure>`;
}

function card(t) {
  const step = STATUS[t.status]?.step ?? 0;
  const milestones = [
    ['Recolección programada', fmtDate(t.pickup_at, true)],
    ['Salió rumbo al destino', t.departed_at && fmtDate(t.departed_at, true)],
    ['Llegó al punto de entrega', t.arrived_at && fmtDate(t.arrived_at, true)],
    ['Entregado', t.finished_at && fmtDate(t.finished_at, true)],
    ['Recibió', t.received_by],
    ['Entrega programada', !t.finished_at && t.delivery_at && fmtDate(t.delivery_at, true)],
    ['Unidad', t.vehicle_name && `${t.vehicle_name}${t.vehicle_plate ? ` · ${t.vehicle_plate}` : ''}`],
    ['Chofer', t.driver_name],
    ['Carga', t.cargo],
  ].filter(([, v]) => v);
  const groups = ['carga', 'llegada', 'entrega', 'firma']
    .map((kind) => {
      const list = t.photos.filter((p) => p.kind === kind);
      return list.length ? `<div class="photo-group"><h4>${esc(PHOTO_KIND[kind])}</h4><div class="photos">${list.map(photoFigure).join('')}</div></div>` : '';
    })
    .join('');
  return `
  <article class="card" id="viaje-${t.id}">
    <div class="card-head">
      <div><h2>Envío #${t.id}</h2><span class="badge st-${esc(t.status)}">${esc(CLIENT_STATUS[t.status] || t.status)}</span></div>
      ${t.client ? `<span class="muted small">${esc(t.client)}</span>` : ''}
    </div>
    ${t.status !== 'cancelado' ? `<div class="steps">${[1, 2, 3, 4, 5].map((i) => `<span class="${step >= i ? 'done' : ''}"></span>`).join('')}</div>` : ''}
    <div class="stop"><div class="dot">📍</div><div class="body"><div class="muted small">Origen</div><div class="addr">${esc(t.pickup_address)}</div></div></div>
    <div class="stop"><div class="dot">🏁</div><div class="body"><div class="muted small">Destino</div><div class="addr">${esc(t.dest_address)}</div></div></div>
    <dl class="kv" style="margin-top:6px">${milestones.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${groups || (t.status === 'finalizado' ? '' : '<p class="muted small" style="margin-bottom:0">Aquí aparecerán las fotos de la carga, la llegada y la prueba de entrega.</p>')}
  </article>`;
}

function render() {
  $('#list').innerHTML = trips.length
    ? trips.map(card).join('')
    : `<div class="empty">${tab === 'open' ? 'No tienes envíos en curso.' : 'Aún no hay envíos en tu historial.'}<br>
       <a class="btn btn-soft" style="margin-top:12px" href="/#cotizar">Solicitar un envío</a></div>`;
}

function focusFromHash(all) {
  const m = location.hash.match(/viaje-(\d+)/);
  if (!m) return;
  const el = document.getElementById(`viaje-${m[1]}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.style.outline = '3px solid var(--accent)';
    setTimeout(() => (el.style.outline = ''), 2500);
  } else if (all && all.some((t) => t.id === Number(m[1]))) {
    switchTab(tab === 'open' ? 'closed' : 'open');
  }
}

function switchTab(name) {
  tab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  load();
}

async function renderBanners() {
  const state = await pushState().catch(() => 'unsupported');
  $('#banners').innerHTML =
    state === 'off'
      ? `<div class="alert alert-info row"><span class="grow">🔔 Activa las notificaciones para saber cuándo sale, llega y se entrega tu envío.</span><button class="btn-sm btn-primary" id="banner-push">Activar</button></div>`
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
