// Funciones compartidas por las páginas del chofer y del administrador.

const ROLE_LABEL = { superadmin: 'Superadministrador', admin: 'Personal de AN', driver: 'Chofer', client: 'Cliente' };
const isStaffRole = (role) => role === 'admin' || role === 'superadmin';

// Tipos de foto de las etapas del viaje.
// Nivel del tanque (fracción) → texto, como lo marca el tablero.
const FUEL_LEVELS = [
  [1, 'Lleno (F)'], [0.875, '7/8'], [0.75, '3/4'], [0.625, '5/8'], [0.5, '1/2'],
  [0.375, '3/8'], [0.25, '1/4'], [0.125, '1/8'], [0, 'Reserva (E)'],
];
function fuelLabel(level) {
  if (level == null) return '—';
  const hit = FUEL_LEVELS.find(([v]) => Math.abs(v - level) < 0.01);
  return hit ? hit[1] : `${Math.round(level * 100)}%`;
}

const PHOTO_KIND = {
  llegada_carga: 'Llegada al punto de carga',
  carga: 'Unidad cargada',
  salida: 'Salida al destino',
  llegada: 'Llegada al punto de entrega',
  entrega: 'Prueba de entrega',
  firma: 'Firma de quien recibe',
};
const PHOTO_ORDER = Object.keys(PHOTO_KIND);
const PAUSE_PLACE_LABEL = { hotel: 'Hotel', domicilio: 'Domicilio del chofer', base: 'Base de AN', cliente: 'Instalaciones del cliente', carretera: 'Descanso en carretera', otro: 'Otro lugar' };

const STATUS = {
  asignado: { label: 'Asignado', step: 0 },
  en_recoleccion: { label: 'Rumbo a cargar / cargando', step: 1 },
  cargado: { label: 'Cargado, en espera de salir', step: 2 },
  en_ruta: { label: 'En ruta al destino', step: 3 },
  en_destino: { label: 'En el punto de entrega', step: 4 },
  entregado: { label: 'Entregado, regresando a base', step: 5 },
  finalizado: { label: 'Cerrado (regresó a base)', step: 6 },
  cancelado: { label: 'Cancelado', step: -1 },
};

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    throw new Error('Sin conexión. Revisa tu internet e inténtalo de nuevo.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/login')) {
    location.href = `/login.html?volver=${encodeURIComponent(location.pathname + location.hash)}`;
    throw new Error(data.error || 'Sesión expirada');
  }
  if (!res.ok) throw new Error(data.error || 'Ocurrió un error.');
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// "2026-10-01T08:30" → "mié 1 oct 2026, 08:30"
function fmtDate(value, withYear = false) {
  if (!value) return '—';
  const [date, time] = String(value).replace(' ', 'T').split('T');
  const [y, m, d] = date.split('-').map(Number);
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const days = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const wd = days[new Date(y, m - 1, d).getDay()];
  const showYear = withYear || y !== new Date().getFullYear();
  return `${wd} ${d} ${months[m - 1]}${showYear ? ` ${y}` : ''}${time ? `, ${time.slice(0, 5)}` : ''}`;
}

// Las marcas de tiempo de la base de datos (datetime('now')) están en UTC.
function fmtUtc(value) {
  if (!value) return '—';
  const d = new Date(`${value.replace(' ', 'T')}Z`);
  return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtNum(n, digits = 0) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// "2026-10-01T08:30:00.000Z" → "hace 5 min"
function fmtAgo(iso) {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} días`;
}

// 330 → "5 h 30 min"
function fmtDuration(minutes) {
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// "2026-10-01T08:30" + 90 → "2026-10-01T10:00" (hora local, igual que el servidor).
function addMinutesLocal(local, minutes) {
  if (!local || minutes == null) return null;
  const [date, time = '00:00'] = String(local).split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + Math.round(minutes) * 60000);
  return t.toISOString().slice(0, 16);
}

// Estimación sin Google Maps (misma fórmula que el servidor): línea recta × 1.3 a 65 km/h.
function roughRoute(a, b) {
  if ([a?.lat, a?.lng, b?.lat, b?.lng].some((v) => v == null)) return null;
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  const km = Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 1.3);
  return { km, minutes: Math.max(10, Math.round((km / 65) * 60)) };
}

// Texto del ETA vigente de un viaje ("en ruta" si ya salió).
function etaLabel(t) {
  if (!t.eta) return '';
  return `${t.eta_live_at ? 'Llega aprox.' : 'ETA'} ${fmtDate(t.eta)}`;
}

function statusBadge(status) {
  return `<span class="badge st-${esc(status)}">${esc(STATUS[status]?.label || status)}</span>`;
}

function mapsUrl(address, lat, lng) {
  const destination = lat != null && lng != null ? `${lat},${lng}` : address;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

let toastTimer;
function toast(message) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function showError(target, err) {
  target.innerHTML = err ? `<div class="alert alert-error">${esc(err.message || err)}</div>` : '';
}

// Reduce la foto antes de subirla (ahorra datos del celular). Devuelve un Blob JPEG.
async function shrinkPhoto(file, maxSide = 1600) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // fondo blanco por si la imagen tiene transparencia (JPEG no la admite)
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.82));
  } catch {
    return file;
  }
}

// Ubicación aproximada del chofer al marcar un paso (opcional, no bloquea).
function currentPosition(timeout = 6000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    // El "timeout" del navegador no corre mientras el permiso está pendiente,
    // así que se pone un límite propio para no dejar al chofer esperando.
    const timer = setTimeout(() => resolve(null), timeout + 1000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout, maximumAge: 60000 }
    );
  });
}

// Lightbox para ver fotos en grande.
function openPhoto(src) {
  let dlg = $('#lightbox');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'lightbox';
    dlg.className = 'wide';
    dlg.innerHTML = '<div class="dialog-body"><img alt="Foto"><div class="dialog-actions"><a class="btn" target="_blank" rel="noopener">Abrir original</a><button class="btn-primary" value="close">Cerrar</button></div></div>';
    dlg.querySelector('button').onclick = () => dlg.close();
    document.body.append(dlg);
  }
  dlg.querySelector('img').src = src;
  dlg.querySelector('a').href = src;
  dlg.showModal();
}
document.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-zoom]');
  if (img) openPhoto(img.src);
});

// ---------- Aplicación instalable y notificaciones ----------
let swRegistration = null;
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    return swRegistration;
  } catch (err) {
    console.warn('Service worker no registrado', err);
    return null;
  }
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// Devuelve 'on' | 'off' | 'denied' | 'unsupported' | 'needs-install'
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  const reg = swRegistration || (await navigator.serviceWorker.ready);
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

async function enablePush(vapidPublicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('No se dio permiso para mostrar notificaciones.');
  const reg = swRegistration || (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
  }
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  await api('/push/test', { method: 'POST' });
}

// Mantiene al servidor al día si el navegador renovó la suscripción por su cuenta.
async function syncPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
  const reg = swRegistration || (await navigator.serviceWorker.ready);
  const sub = await reg.pushManager.getSubscription();
  if (sub) api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }).catch(() => {});
}

// Botón "Instalar app" (Android/Chrome). En iPhone se muestran instrucciones.
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  document.dispatchEvent(new Event('installable'));
});
async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  return true;
}

async function logout() {
  await api('/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login.html';
}

// Abre el diálogo de "Mi cuenta" para cambiar la contraseña.
function openPasswordDialog() {
  let dlg = $('#password-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'password-dialog';
    dlg.innerHTML = `
      <form method="dialog">
        <h2>Cambiar contraseña</h2>
        <label>Contraseña actual</label><input type="password" name="current" autocomplete="current-password" required>
        <label>Nueva contraseña (mínimo 8 caracteres)</label><input type="password" name="password" autocomplete="new-password" minlength="8" required>
        <div class="msg"></div>
        <div class="dialog-actions"><button type="button" data-close>Cancelar</button><button class="btn-primary">Guardar</button></div>
      </form>`;
    document.body.append(dlg);
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        await api('/me/password', { method: 'POST', body: { current: form.current.value, password: form.password.value } });
        dlg.close();
        form.reset();
        toast('Contraseña actualizada');
      } catch (err) {
        showError(form.querySelector('.msg'), err);
      }
    });
  }
  dlg.querySelector('.msg').innerHTML = '';
  dlg.showModal();
}
