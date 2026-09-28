// API de la página pública: datos de la empresa y solicitudes de cotización.
const express = require('express');
const { all, get, run } = require('./db');
const auth = require('./auth');
const notify = require('./notify');
const site = require('./site');
const { HttpError, bad, h, str, num } = require('./http');

const router = express.Router();

router.get('/site', (req, res) => res.json(req.user?.role === 'admin' ? site.getSite() : site.publicSite()));

router.put(
  '/site',
  auth.requireAdmin,
  h((req, res) => {
    const email = str(req.body.quotes_email, 200);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('El correo para cotizaciones no es válido.');
    res.json(site.updateSite(req.body));
  })
);

// Límite de solicitudes por IP para evitar spam.
const recent = new Map();
function quoteRateLimit(req, res, next) {
  const now = Date.now();
  const list = (recent.get(req.ip) || []).filter((t) => t > now - 60 * 60 * 1000);
  if (list.length >= 5) return res.status(429).json({ error: 'Ya recibimos tus solicitudes. Te contactaremos pronto.' });
  list.push(now);
  recent.set(req.ip, list);
  next();
}

router.post(
  '/quotes',
  quoteRateLimit,
  h(async (req, res) => {
    // Campo oculto: si viene lleno lo envió un robot. Se responde "ok" sin guardar.
    if (req.body.website) return res.json({ ok: true });
    const q = {
      name: str(req.body.name, 100),
      company: str(req.body.company, 150),
      phone: str(req.body.phone, 40),
      email: str(req.body.email, 200),
      origin: str(req.body.origin, 300),
      destination: str(req.body.destination, 300),
      service_date: str(req.body.service_date, 10),
      cargo: str(req.body.cargo, 500),
      message: str(req.body.message, 2000),
      service: str(req.body.service, 60),
      vehicle: str(req.body.vehicle, 80),
      km: num(req.body.km),
      estimate: num(req.body.estimate),
      client_type: req.body.client_type === 'moral' ? 'moral' : req.body.client_type === 'fisica' ? 'fisica' : null,
      payment_method: str(req.body.payment_method, 80),
      total: num(req.body.total),
      list_price: num(req.body.list_price),
    };
    if (!q.name) throw bad('Escribe tu nombre.');
    if (!q.phone && !q.email) throw bad('Déjanos un teléfono o correo para contactarte.');
    if (q.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q.email)) throw bad('El correo no es válido.');
    const id = Number(
      run(
        `INSERT INTO quote_requests (name, company, phone, email, origin, destination, service_date, cargo, message, service, vehicle, km, estimate, client_type, payment_method, total, list_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        q.name, q.company, q.phone, q.email, q.origin, q.destination, q.service_date, q.cargo, q.message, q.service, q.vehicle, q.km, q.estimate,
        q.client_type, q.payment_method, q.total, q.list_price
      ).lastInsertRowid
    );

    const s = site.getSite();
    const to = s.quotes_email || s.email || all("SELECT email FROM users WHERE role = 'admin' AND active = 1").map((u) => u.email).join(',');
    const lines = [
      ['Servicio', q.service],
      ['Unidad', q.vehicle],
      ['Precio de lista mostrado', q.list_price != null && q.list_price !== q.estimate ? `$${q.list_price.toLocaleString('es-MX')} + impuestos` : null],
      ['Estimado mostrado al cliente', q.estimate != null ? `Subtotal $${q.estimate.toLocaleString('es-MX')} (${q.km} km)${q.total != null ? ` · total con impuestos $${q.total.toLocaleString('es-MX', { minimumFractionDigits: 2 })}` : ''}` : null],
      ['Tipo de cliente', q.client_type && (q.client_type === 'moral' ? 'Persona moral (empresa)' : 'Persona física')],
      ['Forma de pago preferida', q.payment_method],
      ['Nombre', q.name],
      ['Empresa', q.company],
      ['Teléfono', q.phone],
      ['Correo', q.email],
      ['Origen', q.origin],
      ['Destino', q.destination],
      ['Fecha deseada', q.service_date],
      ['Carga', q.cargo],
      ['Mensaje', q.message],
    ].filter(([, v]) => v);
    if (to) {
      notify
        .sendEmail({
          to,
          subject: `Nueva solicitud de cotización #${id} · ${q.name}`,
          text: `${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nVer en el panel: ${require('./config').appUrl}/admin.html#cotizaciones`,
          replyTo: q.email || undefined,
        })
        .catch((err) => console.error('No se pudo enviar el aviso de cotización:', err.message));
    }
    notify.notifyAdmins(`Nueva cotización: ${q.name}`, [q.origin, q.destination].filter(Boolean).join(' → ') || q.cargo || '', '/admin.html#cotizaciones');
    res.status(201).json({ ok: true });
  })
);

// Tarifas del cotizador (el administrador las ajusta en el panel → Empresa).
router.get('/pricing', (req, res) => res.json(site.getPricing({ keepDisabled: req.user?.role === 'admin' })));
router.put(
  '/pricing',
  auth.requireAdmin,
  h((req, res) => {
    const km = num(req.body.included_km);
    if (km == null || km < 0 || km > 500) throw bad('Los km incluidos en la tarifa base no son válidos.');
    for (const [id, v] of Object.entries(req.body.vehicles || {})) {
      if (!(num(v.base) >= 0) || !(num(v.per_km) >= 0)) throw bad(`Revisa la tarifa de ${id}.`);
    }
    let taxes;
    if (req.body.taxes) {
      const t = req.body.taxes;
      for (const k of ['iva', 'ret_iva', 'ret_isr']) {
        if (!(num(t[k]) >= 0 && num(t[k]) <= 50)) throw bad('Revisa los porcentajes de impuestos.');
      }
      const flag = (who, k) => Boolean(t.rules?.[who]?.[k]);
      taxes = {
        iva: num(t.iva),
        ret_iva: num(t.ret_iva),
        ret_isr: num(t.ret_isr),
        rules: Object.fromEntries(['fisica', 'moral'].map((who) => [who, { iva: flag(who, 'iva'), ret_iva: flag(who, 'ret_iva'), ret_isr: flag(who, 'ret_isr') }])),
      };
    }
    let cashDiscount;
    if (req.body.cash_discount !== undefined) {
      cashDiscount = num(req.body.cash_discount);
      if (!(cashDiscount >= 0 && cashDiscount <= 20)) throw bad('El descuento por efectivo o transferencia debe estar entre 0 y 20%.');
    }
    site.updatePricing({ included_km: km, vehicles: req.body.vehicles, taxes, cash_discount: cashDiscount });
    res.json(site.getPricing({ keepDisabled: true }));
  })
);

router.get(
  '/quotes',
  auth.requireAdmin,
  h((req, res) => res.json(all('SELECT * FROM quote_requests ORDER BY id DESC LIMIT 300')))
);

router.put(
  '/quotes/:id',
  auth.requireAdmin,
  h((req, res) => {
    const q = get('SELECT id FROM quote_requests WHERE id = ?', Number(req.params.id));
    if (!q) throw new HttpError(404, 'La solicitud no existe.');
    run('UPDATE quote_requests SET status = ? WHERE id = ?', req.body.status === 'atendida' ? 'atendida' : 'nueva', q.id);
    res.json({ ok: true });
  })
);

module.exports = router;
