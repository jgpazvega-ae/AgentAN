// Seguimiento público de un envío (enlace de los correos de estatus). No
// requiere iniciar sesión: el enlace lleva un código único del viaje.
const token = new URLSearchParams(location.search).get('t') || '';

async function load() {
  try {
    const res = await fetch(`/api/track/${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo cargar el envío.');
    document.title = `Envío #${data.id} · ${data.company}`;
    $('#list').innerHTML = shipmentCard(data, {
      photoSrc: (file) => `/api/track/${encodeURIComponent(token)}/photos/${encodeURIComponent(file)}`,
    });
    $('#updated').textContent = `Actualizado: ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (err) {
    $('#list').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

$('#btn-refresh').onclick = load;
load();
setInterval(() => document.visibilityState === 'visible' && load(), 60000);
