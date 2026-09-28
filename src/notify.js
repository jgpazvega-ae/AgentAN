// Avisos a los usuarios: correo electrónico (SMTP) y notificaciones push (tipo Uber).
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const config = require('./config');
const { get, all, run, getSetting, setSetting } = require('./db');
const { getSite } = require('./site');
const eta = require('./eta');

// ---------- Correo ----------
let transporter = null;
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

function emailEnabled() {
  return Boolean(transporter);
}

// Sin SMTP configurado los correos solo se muestran en la consola y se guardan
// aquí (sirve para las pruebas automáticas).
const outbox = [];

async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!transporter) {
    console.log(`[correo desactivado] Para: ${to} | ${subject}\n${text}\n`);
    outbox.push({ to, subject, text, html });
    if (outbox.length > 200) outbox.shift();
    return { skipped: true };
  }
  return transporter.sendMail({ from: config.smtp.from, to, subject, text, html, replyTo });
}

// ---------- Push ----------
// Las llaves VAPID identifican a este servidor ante Google/Apple/Mozilla. Si no
// vienen en el entorno se generan una sola vez y se guardan en la base de datos.
let vapidKeys = { publicKey: config.vapid.publicKey, privateKey: config.vapid.privateKey };
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  const saved = getSetting('vapid_keys');
  if (saved) {
    vapidKeys = JSON.parse(saved);
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    setSetting('vapid_keys', JSON.stringify(vapidKeys));
  }
}
webpush.setVapidDetails(config.vapid.subject, vapidKeys.publicKey, vapidKeys.privateKey);

function vapidPublicKey() {
  return vapidKeys.publicKey;
}

async function sendPush(userId, payload) {
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { TTL: 24 * 60 * 60, urgency: 'high' }
        );
      } catch (err) {
        // 404/410: el celular ya no acepta esta suscripción (app desinstalada, permiso retirado).
        if (err.statusCode === 404 || err.statusCode === 410) {
          run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
        } else {
          console.error('Error al enviar push:', err.statusCode || '', err.body || err.message);
        }
      }
    })
  );
  return subs.length;
}

// ---------- Mensajes de viajes ----------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Las fechas se guardan tal como las escribe el administrador ("2026-10-01T08:30").
function formatLocal(value) {
  if (!value) return '';
  const [date, time = ''] = String(value).split('T');
  const [y, m, d] = date.split('-').map(Number);
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const weekday = days[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} ${months[m - 1]} ${y}${time ? `, ${time.slice(0, 5)} h` : ''}`;
}

function mapsLink(address, lat, lng) {
  const destination = lat != null && lng != null ? `${lat},${lng}` : address;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

function tripTitle(trip) {
  return `#${trip.id}${trip.name ? ` · ${trip.name}` : ''}`;
}

// Renglones con los datos del viaje (lugares, horarios y ETA).
function tripRows(trip, { internal = false } = {}) {
  const route = [trip.route_km != null ? `${Math.round(trip.route_km)} km` : '', eta.durationText(trip.route_minutes)].filter(Boolean).join(' · ');
  return [
    ['Viaje', trip.name],
    ['Recolección anticipada', trip.prepickup_address && `${trip.prepickup_address} · ${formatLocal(trip.prepickup_at)}`],
    ['Punto de inicio', trip.pickup_address],
    ['Fecha y hora de inicio', formatLocal(trip.pickup_at)],
    ['Destino final', trip.dest_address],
    ['Entrega pactada', formatLocal(trip.delivery_at)],
    [trip.eta_live_at ? 'Llegada estimada (en ruta)' : 'Llegada estimada (ETA)', trip.eta ? formatLocal(trip.eta) : ''],
    ['Distancia y tiempo de manejo', route],
    ['Cliente', internal ? trip.client : ''],
    ['Carga', trip.cargo],
    ['Chofer', trip.driver_name],
    ['Vehículo', [trip.vehicle_name, trip.vehicle_plate].filter(Boolean).join(' · ')],
    ['Recibió', trip.received_by],
  ].filter(([, v]) => v);
}

function rowsHtml(rows) {
  return `<table style="border-collapse:collapse;width:100%">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(v)}</td></tr>`
    )
    .join('')}</table>`;
}

function button(href, label) {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 18px;background:#13294b;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a>`;
}

function tripEmail(trip, kind) {
  const titles = {
    assigned: `Nuevo viaje asignado ${tripTitle(trip)}`,
    updated: `Cambios en tu viaje ${tripTitle(trip)}`,
    cancelled: `Viaje ${tripTitle(trip)} cancelado`,
  };
  const intro = {
    assigned: 'Se te asignó un nuevo viaje.',
    updated: 'Se modificaron los datos de tu viaje. Revisa la información actualizada.',
    cancelled: 'Este viaje fue cancelado. Ya no es necesario realizarlo.',
  };
  const link = `${config.appUrl}/chofer.html#viaje-${trip.id}`;
  const rows = [...tripRows({ ...trip, driver_name: null }, { internal: true }), ['Notas', trip.notes]].filter(([, v]) => v);
  // Primera parada: la recolección anticipada si la hay; si no, el punto de inicio.
  const first = trip.prepickup_address
    ? mapsLink(trip.prepickup_address, trip.prepickup_lat, trip.prepickup_lng)
    : mapsLink(trip.pickup_address, trip.pickup_lat, trip.pickup_lng);

  const text = [
    `Hola ${trip.driver_name || ''},`,
    '',
    intro[kind],
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    kind !== 'cancelled' ? `Cómo llegar a la primera parada: ${first}` : '',
    kind !== 'cancelled' ? `Cómo llegar al destino: ${mapsLink(trip.dest_address, trip.dest_lat, trip.dest_lng)}` : '',
    '',
    `Ver el viaje: ${link}`,
    '',
    getSite().name,
  ].join('\n');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
    <h2 style="color:#13294b;margin-bottom:4px">${escapeHtml(titles[kind])}</h2>
    <p>Hola ${escapeHtml(trip.driver_name || '')}, ${escapeHtml(intro[kind].charAt(0).toLowerCase() + intro[kind].slice(1))}</p>
    <table style="border-collapse:collapse;width:100%">
      ${rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(v)}</td></tr>`
        )
        .join('')}
    </table>
    ${
      kind !== 'cancelled'
        ? `<p style="margin-top:16px">
      <a href="${escapeHtml(first)}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 14px;background:#e6f4ea;color:#1f5f35;border-radius:8px;text-decoration:none">📍 Ir a ${trip.prepickup_address ? 'recolección anticipada' : 'punto de inicio'}</a>
      <a href="${escapeHtml(mapsLink(trip.dest_address, trip.dest_lat, trip.dest_lng))}" style="display:inline-block;margin:4px 0;padding:10px 14px;background:#e6f4ea;color:#1f5f35;border-radius:8px;text-decoration:none">🏁 Ir a destino</a>
    </p>`
        : ''
    }
    <p style="margin-top:16px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;background:#13294b;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Abrir mi viaje</a></p>
    <p style="color:#9ca3af;font-size:12px">${escapeHtml(getSite().name)}</p>
  </div>`;

  return { subject: titles[kind], text, html, link };
}

// Avisa al chofer por correo y push. Nunca lanza error: un aviso fallido no
// debe impedir que el viaje se guarde.
async function notifyDriverAboutTrip(trip, kind) {
  if (!trip.driver_id || !trip.driver_email) return;
  const message = tripEmail(trip, kind);
  const results = await Promise.allSettled([
    sendEmail({ to: trip.driver_email, subject: message.subject, text: message.text, html: message.html }),
    sendPush(trip.driver_id, {
      title: message.subject,
      body: kind === 'cancelled' ? trip.dest_address : `${formatLocal(trip.prepickup_at || trip.pickup_at)} · ${trip.prepickup_address || trip.pickup_address} → ${trip.dest_address}`,
      url: `/chofer.html#viaje-${trip.id}`,
      tag: `viaje-${trip.id}`,
    }),
  ]);
  for (const r of results) if (r.status === 'rejected') console.error('Aviso al chofer falló:', r.reason?.message || r.reason);
}

// Avisa al chofer que tiene un nuevo recibo de pago disponible.
async function notifyDriverAboutPayment(p) {
  const week = p.week ? ` CW${String(p.week).padStart(2, '0')} ${p.year}` : '';
  const amount = `$${Number(p.amount).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const what = p.kind === 'bono' ? `Bono: ${p.description}` : `Pago semanal${week}`;
  const link = `${config.appUrl}/chofer.html#pagos`;
  const subject = `Recibo de pago ${p.folio} · ${amount}`;
  const results = await Promise.allSettled([
    sendEmail({
      to: p.driver_email,
      subject,
      text: `Hola ${p.driver_name},\n\nSe registró un pago a tu nombre.\n\n${what}\nImporte: ${amount}\nFecha de pago: ${p.paid_at}\n${p.notes ? `Notas: ${p.notes}\n` : ''}\nPuedes ver y descargar tu recibo en: ${link}\n\n${getSite().name}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
        <h2 style="color:#13294b">${escapeHtml(subject)}</h2>
        <p>Hola ${escapeHtml(p.driver_name)}, se registró un pago a tu nombre.</p>
        <p><b>${escapeHtml(what)}</b><br>Importe: <b>${escapeHtml(amount)}</b><br>Fecha de pago: ${escapeHtml(p.paid_at)}</p>
        ${p.notes ? `<p style="color:#6b7280">${escapeHtml(p.notes)}</p>` : ''}
        <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;background:#13294b;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Ver mi recibo</a></p>
        <p style="color:#9ca3af;font-size:12px">${escapeHtml(getSite().name)}</p></div>`,
    }),
    sendPush(p.driver_id, { title: subject, body: what, url: '/chofer.html#pagos', tag: `pago-${p.id}` }),
  ]);
  for (const r of results) if (r.status === 'rejected') console.error('Aviso de pago falló:', r.reason?.message || r.reason);
}

// ---------- Estatus del viaje: un correo por cada cambio ----------
// Destinatarios:
// - Personal de AN (superadministrador y personal) con "recibir correos" activo:
//   todos los cambios, con datos internos (odómetro, combustible, rendimiento).
// - Cliente con cuenta (si tiene "recibir correos" activo) y los correos
//   adicionales del viaje: los cambios que le importan al cliente, con el
//   enlace público de seguimiento.
// Quien hizo el cambio no recibe su propio aviso.
const CLIENT_STEPS = ['Programado', 'Recolección', 'Cargado', 'En camino', 'En punto de entrega', 'Entregado'];
const STATUS_STEP = { asignado: 0, en_recoleccion: 1, cargado: 2, en_ruta: 3, en_destino: 4, entregado: 5, finalizado: 5 };
const FUEL_LABELS = [[1, 'lleno'], [0.875, '7/8'], [0.75, '3/4'], [0.625, '5/8'], [0.5, '1/2'], [0.375, '3/8'], [0.25, '1/4'], [0.125, '1/8'], [0, 'reserva']];
const fuelText = (v) => (v == null ? '—' : FUEL_LABELS.find(([x]) => Math.abs(x - v) < 0.01)?.[1] || `${Math.round(v * 100)}%`);
const km = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('es-MX')} km`);
const etaText = (t) => (t.eta ? ` Llegada estimada: ${formatLocal(t.eta)}.` : '');

const STATUS_MESSAGES = {
  programado: {
    client: (t) => [`Tu envío ${tripTitle(t)} está programado`, `Programamos tu envío. Te avisaremos por correo de cada avance.${etaText(t)}`],
    staff: (t) => [`Viaje ${tripTitle(t)} programado`, `Asignado a ${t.driver_name || '—'}.${etaText(t)}`],
  },
  reprogramado: {
    client: (t) => [`Cambios en tu envío ${tripTitle(t)}`, `Actualizamos los datos de tu envío. Revisa los lugares y horarios.${etaText(t)}`],
  },
  iniciado: {
    client: (t) => [
      `Tu envío ${tripTitle(t)}: el chofer va por la carga`,
      t.prepickup_address ? `El chofer va rumbo a la recolección anticipada en ${t.prepickup_address}.` : `El chofer va rumbo al punto de carga: ${t.pickup_address}.`,
    ],
    staff: (t) => [`${t.driver_name} inició el viaje ${tripTitle(t)}`, `Odómetro al salir: ${km(t.odo_start)} · Combustible: ${fuelText(t.fuel_start)}.`],
  },
  cargado: {
    client: (t) => [
      `Tu envío ${tripTitle(t)}: carga lista en la unidad`,
      t.prepickup_address ? `La carga ya está en la unidad. La salida al destino está programada para el ${formatLocal(t.pickup_at)}.${etaText(t)}` : `La carga ya está en la unidad. En breve sale rumbo al destino.${etaText(t)}`,
    ],
    staff: (t) => [`${t.driver_name} terminó de cargar ${tripTitle(t)}`, `Salida programada: ${formatLocal(t.pickup_at)}.`],
  },
  en_ruta: {
    client: (t) => [`Tu envío ${tripTitle(t)} va en camino`, `Salió rumbo a ${t.dest_address}.${etaText(t)}`],
    staff: (t) => [`${t.driver_name} salió rumbo al destino ${tripTitle(t)}`, `Destino: ${t.dest_address}.${etaText(t)}`],
  },
  llegada: {
    client: (t) => [`Tu envío ${tripTitle(t)} llegó al punto de entrega`, `El chofer ya está en ${t.dest_address}.`],
    staff: (t) => [`${t.driver_name} llegó al punto de entrega ${tripTitle(t)}`, `${t.dest_address}.`],
  },
  entregado: {
    client: (t) => [`Tu envío ${tripTitle(t)} fue entregado`, `Recibió: ${t.received_by || '—'}. Puedes ver las fotos de la prueba de entrega en el enlace de seguimiento.`],
    staff: (t) => [`${t.driver_name} entregó ${tripTitle(t)}`, `Recibió: ${t.received_by || '—'} · km a la entrega: ${km(t.km_delivery)}.`],
  },
  finalizado: {
    staff: (t) => [
      `${t.driver_name} regresó a base · viaje ${tripTitle(t)} cerrado`,
      `km totales: ${km(t.km)} · Litros usados: ${t.fuel_used != null ? t.fuel_used : '—'} · Rendimiento: ${t.km_per_liter ? `${t.km_per_liter.toFixed(2)} km/L` : '—'} · Combustible al regresar: ${fuelText(t.fuel_end)}.`,
    ],
  },
  cancelado: {
    client: (t) => [`Tu envío ${tripTitle(t)} fue cancelado`, `${t.pickup_address} → ${t.dest_address}.`],
    staff: (t) => [`Viaje ${tripTitle(t)} cancelado`, `${t.pickup_address} → ${t.dest_address}.`],
  },
};

function progressHtml(trip) {
  if (trip.status === 'cancelado') return '<p style="color:#b91c1c;font-weight:bold">Cancelado</p>';
  const step = STATUS_STEP[trip.status] ?? 0;
  return `<table style="border-collapse:collapse;width:100%;margin:10px 0;table-layout:fixed"><tr>${CLIENT_STEPS.map(
    (label, i) =>
      `<td style="padding:6px 2px;text-align:center;font-size:11px;border-top:4px solid ${i <= step ? '#2e7d4f' : '#e5e7eb'};color:${i === step ? '#13294b' : '#6b7280'};${i === step ? 'font-weight:bold' : ''}">${escapeHtml(label)}</td>`
  ).join('')}</tr></table>`;
}

function statusEmail(trip, { subject, body, greeting, link, linkLabel, internal }) {
  const rows = tripRows(trip, { internal });
  const siteName = getSite().name;
  const text = [greeting, '', body, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `${linkLabel}: ${link}`, '', siteName].join('\n');
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
    <img src="${escapeHtml(config.appUrl)}/img/logo.png" alt="${escapeHtml(siteName)}" style="height:48px;margin:8px 0">
    <h2 style="color:#13294b;margin:4px 0 8px">${escapeHtml(subject)}</h2>
    <p>${escapeHtml(greeting)}</p>
    <p>${escapeHtml(body)}</p>
    ${progressHtml(trip)}
    ${rowsHtml(rows)}
    <p style="margin-top:16px">${button(link, linkLabel)}</p>
    <p style="color:#9ca3af;font-size:12px">${escapeHtml(siteName)}${getSite().phone ? ` · ${escapeHtml(getSite().phone)}` : ''}</p>
  </div>`;
  return { subject, text, html };
}

function trackUrl(trip) {
  return `${config.appUrl}/seguimiento.html?t=${trip.track_token}`;
}

async function notifyTripStatus(trip, event, actorId, { onlyClients = false } = {}) {
  const def = STATUS_MESSAGES[event];
  if (!trip || !def) return;
  const jobs = [];
  if (def.staff && !onlyClients) {
    const [subject, body] = def.staff(trip);
    const link = `${config.appUrl}/admin.html#viaje-${trip.id}`;
    const staff = all("SELECT id, name, email, notify_email FROM users WHERE role IN ('superadmin', 'admin') AND active = 1");
    for (const u of staff) {
      if (u.id === actorId) continue;
      if (u.notify_email) {
        const mail = statusEmail(trip, { subject, body, greeting: `Hola ${u.name},`, link, linkLabel: 'Ver el viaje en el panel', internal: true });
        jobs.push(sendEmail({ to: u.email, ...mail }));
      }
      jobs.push(sendPush(u.id, { title: subject, body, url: `/admin.html#viaje-${trip.id}`, tag: `viaje-${trip.id}` }));
    }
  }
  if (def.client) {
    const [subject, body] = def.client(trip);
    const recipients = new Map(); // correo → saludo
    if (trip.client_id && trip.client_id !== actorId) {
      const c = get('SELECT name, email, notify_email, active FROM users WHERE id = ?', trip.client_id);
      if (c?.active && c.notify_email) recipients.set(c.email.toLowerCase(), `Hola ${c.name},`);
      jobs.push(sendPush(trip.client_id, { title: subject, body, url: `/cliente.html#viaje-${trip.id}`, tag: `envio-${trip.id}` }));
    }
    for (const email of String(trip.notify_emails || '').split(',').map((e) => e.trim()).filter(Boolean)) {
      if (!recipients.has(email)) recipients.set(email, 'Hola,');
    }
    const replyTo = getSite().email || undefined;
    for (const [to, greeting] of recipients) {
      const mail = statusEmail(trip, { subject, body, greeting, link: trackUrl(trip), linkLabel: 'Seguir mi envío', internal: false });
      jobs.push(sendEmail({ to, replyTo, ...mail }));
    }
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error('Aviso de estatus falló:', r.reason?.message || r.reason);
}

// Avisa al personal de AN (push y, si se pide, correo).
async function notifyAdmins(title, body, url, { email = false } = {}) {
  const admins = all("SELECT id, name, email, notify_email FROM users WHERE role IN ('superadmin', 'admin') AND active = 1");
  const jobs = admins.map((a) => sendPush(a.id, { title, body, url, tag: url }));
  if (email) {
    const link = `${config.appUrl}${url}`;
    for (const a of admins.filter((x) => x.notify_email)) {
      jobs.push(
        sendEmail({
          to: a.email,
          subject: title,
          text: `Hola ${a.name},\n\n${body}\n\nVer: ${link}\n\n${getSite().name}`,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
            <h2 style="color:#13294b">${escapeHtml(title)}</h2><p>Hola ${escapeHtml(a.name)},</p><p>${escapeHtml(body)}</p>
            <p>${button(link, 'Ver en el panel')}</p><p style="color:#9ca3af;font-size:12px">${escapeHtml(getSite().name)}</p></div>`,
        })
      );
    }
  }
  await Promise.allSettled(jobs);
}

module.exports = {
  emailEnabled,
  sendEmail,
  sendPush,
  vapidPublicKey,
  notifyDriverAboutTrip,
  notifyDriverAboutPayment,
  notifyTripStatus,
  notifyAdmins,
  outbox,
  formatLocal,
  mapsLink,
};
