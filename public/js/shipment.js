// Tarjeta de un envío como la ve el cliente: en su portal y en el enlace
// público de seguimiento. Sin datos internos (odómetro, combustible, notas).
const CLIENT_STATUS = {
  asignado: 'Programado',
  en_recoleccion: 'En recolección',
  cargado: 'Cargado, por salir',
  en_ruta: 'En camino',
  en_destino: 'En el punto de entrega',
  finalizado: 'Entregado',
  cancelado: 'Cancelado',
};
const CLIENT_OPEN = ['asignado', 'en_recoleccion', 'cargado', 'en_ruta', 'en_destino'];

// photoSrc(file) → URL de la foto (portal con sesión o enlace de seguimiento).
function shipmentCard(t, { photoSrc }) {
  const step = STATUS[t.status]?.step ?? 0;
  const figure = (p) =>
    `<figure><img data-zoom src="${esc(photoSrc(p.file))}" alt="${esc(PHOTO_KIND[p.kind])}" loading="lazy"><figcaption>${esc(fmtUtc(p.created_at))}</figcaption></figure>`;
  const open = CLIENT_OPEN.includes(t.status);
  const milestones = [
    ['Recolección anticipada', t.prepickup_at && fmtDate(t.prepickup_at, true)],
    ['Inicio programado', fmtDate(t.pickup_at, true)],
    ['Llegó a cargar', t.at_pickup_at && fmtDate(t.at_pickup_at, true)],
    ['Salió rumbo al destino', t.departed_at && fmtDate(t.departed_at, true)],
    ['Llegó al punto de entrega', t.arrived_at && fmtDate(t.arrived_at, true)],
    ['Entregado', t.finished_at && fmtDate(t.finished_at, true)],
    ['Recibió', t.received_by],
    ['Entrega pactada', !t.finished_at && t.delivery_at && fmtDate(t.delivery_at, true)],
    ['Unidad', t.vehicle_name && `${t.vehicle_name}${t.vehicle_plate ? ` · ${t.vehicle_plate}` : ''}`],
    ['Chofer', t.driver_name],
    ['Carga', t.cargo],
  ].filter(([, v]) => v);
  const groups = PHOTO_ORDER
    .map((kind) => {
      const list = t.photos.filter((p) => p.kind === kind);
      return list.length ? `<div class="photo-group"><h4>${esc(PHOTO_KIND[kind])}</h4><div class="photos">${list.map(figure).join('')}</div></div>` : '';
    })
    .join('');
  const etaBox =
    open && t.eta
      ? `<div class="eta-box" style="padding:10px 14px"><span class="muted small">Llegada estimada${t.eta_live_at ? ' (ya va en camino)' : ''}</span><br>
         <b style="font-size:1.2rem">${esc(fmtDate(t.eta, true))}</b>
         ${t.route_km != null ? `<span class="muted small"> · ${fmtNum(t.route_km)} km</span>` : ''}</div>`
      : '';
  const stop = (icon, label, address, cls = '') =>
    `<div class="stop ${cls}"><div class="dot">${icon}</div><div class="body"><div class="muted small">${esc(label)}</div><div class="addr">${esc(address)}</div></div></div>`;
  return `
  <article class="card" id="viaje-${t.id}">
    <div class="card-head">
      <div><h2>Envío #${t.id}${t.name ? ` · ${esc(t.name)}` : ''}</h2><span class="badge st-${esc(t.status)}">${esc(CLIENT_STATUS[t.status] || t.status)}</span>${
        t.paused && open ? ' <span class="badge st-pausa">⏸ En pausa</span>' : ''
      }</div>
      ${t.client ? `<span class="muted small">${esc(t.client)}</span>` : ''}
    </div>
    ${t.status !== 'cancelado' ? `<div class="steps">${[1, 2, 3, 4, 5].map((i) => `<span class="${step >= i ? 'done' : ''}"></span>`).join('')}</div>` : ''}
    ${t.paused && open ? `<div class="alert alert-info">⏸ El chofer hace una pausa por descanso.${t.pause_until ? ` Continúa aprox. el ${esc(fmtDate(t.pause_until, true))}.` : ''}</div>` : ''}
    ${etaBox}
    ${t.prepickup_address ? stop('📦', 'Recolección anticipada', t.prepickup_address, 'pre') : ''}
    ${stop('📍', 'Origen', t.pickup_address)}
    ${stop('🏁', 'Destino', t.dest_address)}
    <dl class="kv" style="margin-top:6px">${milestones.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${groups || (t.status === 'finalizado' ? '' : '<p class="muted small" style="margin-bottom:0">Aquí aparecerán las fotos de la carga, la llegada y la prueba de entrega.</p>')}
  </article>`;
}
