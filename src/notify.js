// Avisos a los usuarios: correo electrónico (SMTP) y notificaciones push (tipo Uber).
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const config = require('./config');
const { all, run, getSetting, setSetting } = require('./db');
const { getSite } = require('./site');

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

async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!transporter) {
    console.log(`[correo desactivado] Para: ${to} | ${subject}\n${text}\n`);
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

function tripEmail(trip, kind) {
  const titles = {
    assigned: `Nuevo viaje asignado #${trip.id}`,
    updated: `Cambios en tu viaje #${trip.id}`,
    cancelled: `Viaje #${trip.id} cancelado`,
  };
  const intro = {
    assigned: 'Se te asignó un nuevo viaje.',
    updated: 'Se modificaron los datos de tu viaje. Revisa la información actualizada.',
    cancelled: 'Este viaje fue cancelado. Ya no es necesario realizarlo.',
  };
  const link = `${config.appUrl}/chofer.html#viaje-${trip.id}`;
  const rows = [
    ['Recolección', trip.pickup_address],
    ['Fecha de recolección', formatLocal(trip.pickup_at)],
    ['Destino', trip.dest_address],
    ['Entrega', formatLocal(trip.delivery_at)],
    ['Cliente', trip.client],
    ['Carga', trip.cargo],
    ['Vehículo', trip.vehicle_name],
    ['Notas', trip.notes],
  ].filter(([, v]) => v);

  const text = [
    `Hola ${trip.driver_name || ''},`,
    '',
    intro[kind],
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    kind !== 'cancelled' ? `Cómo llegar a la recolección: ${mapsLink(trip.pickup_address, trip.pickup_lat, trip.pickup_lng)}` : '',
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
      <a href="${escapeHtml(mapsLink(trip.pickup_address, trip.pickup_lat, trip.pickup_lng))}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 14px;background:#e6f4ea;color:#1f5f35;border-radius:8px;text-decoration:none">📍 Ir a recolección</a>
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
      body: kind === 'cancelled' ? trip.dest_address : `${formatLocal(trip.pickup_at)} · ${trip.pickup_address} → ${trip.dest_address}`,
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

// Avisa al cliente (correo y push) del avance de su envío.
const CLIENT_NOTICES = {
  programado: (t) => [`Tu envío #${t.id} está programado`, `Recolección: ${formatLocal(t.pickup_at)} en ${t.pickup_address}. Destino: ${t.dest_address}.`],
  en_camino: (t) => [`Tu envío #${t.id} va en camino`, `Salió rumbo a ${t.dest_address}${t.delivery_at ? `. Entrega programada: ${formatLocal(t.delivery_at)}` : ''}.`],
  llegada: (t) => [`Tu envío #${t.id} llegó al punto de entrega`, `El chofer ya está en ${t.dest_address}.`],
  entregado: (t) => [`Tu envío #${t.id} fue entregado`, `Recibió: ${t.received_by || '—'}. Puedes ver las fotos de la prueba de entrega en la plataforma.`],
  cancelado: (t) => [`Tu envío #${t.id} fue cancelado`, `${t.pickup_address} → ${t.dest_address}.`],
};

async function notifyClientAboutTrip(trip, kind) {
  if (!trip.client_id || !CLIENT_NOTICES[kind]) return;
  const [subject, body] = CLIENT_NOTICES[kind](trip);
  const link = `${config.appUrl}/cliente.html#viaje-${trip.id}`;
  const results = await Promise.allSettled([
    trip.client_email &&
      sendEmail({
        to: trip.client_email,
        subject,
        text: `Hola ${trip.client_name || ''},\n\n${body}\n\nSigue tu envío en: ${link}\n\n${getSite().name}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
          <h2 style="color:#13294b">${escapeHtml(subject)}</h2>
          <p>Hola ${escapeHtml(trip.client_name || '')},</p><p>${escapeHtml(body)}</p>
          <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;background:#13294b;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Ver mi envío</a></p>
          <p style="color:#9ca3af;font-size:12px">${escapeHtml(getSite().name)}</p></div>`,
      }),
    sendPush(trip.client_id, { title: subject, body, url: `/cliente.html#viaje-${trip.id}`, tag: `envio-${trip.id}` }),
  ]);
  for (const r of results) if (r.status === 'rejected') console.error('Aviso al cliente falló:', r.reason?.message || r.reason);
}

// Avisa a los administradores (solo push) cuando el chofer avanza el viaje.
async function notifyAdmins(title, body, url) {
  const admins = all("SELECT id FROM users WHERE role IN ('superadmin', 'admin') AND active = 1");
  await Promise.allSettled(admins.map((a) => sendPush(a.id, { title, body, url, tag: url })));
}

module.exports = {
  emailEnabled,
  sendEmail,
  sendPush,
  vapidPublicKey,
  notifyDriverAboutTrip,
  notifyDriverAboutPayment,
  notifyClientAboutTrip,
  notifyAdmins,
  formatLocal,
  mapsLink,
};
