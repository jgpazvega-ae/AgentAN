// Portal del cliente: sigue sus envíos, con las fotos de carga, llegada y
// prueba de entrega que toma el chofer.
let cfg = {};
let me = null;
let tab = 'open';
let trips = [];

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
    trips = all.filter((t) => (tab === 'open' ? CLIENT_OPEN.includes(t.status) : !CLIENT_OPEN.includes(t.status)));
    render();
    if (!silent) focusFromHash(all);
  } catch (err) {
    if (!silent) showError($('#list'), err);
  }
}

function card(t) {
  return shipmentCard(t, { photoSrc: (file) => `/api/photos/${encodeURIComponent(file)}` });
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
