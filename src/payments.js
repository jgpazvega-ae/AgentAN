// Recibos de pago a choferes: pago semanal por destajo (CW##) y bonos.
const express = require('express');
const { get, all, run, transaction } = require('./db');
const auth = require('./auth');
const notify = require('./notify');
const { HttpError, bad, h, str, num, nowLocal } = require('./http');
const { isoWeek, weeksInYear, weekRange } = require('./weeks');
const receipts = require('./receipts');

const router = express.Router();

const PAYMENT_SELECT = `
  SELECT p.*, u.name AS driver_name, u.email AS driver_email
    FROM payments p JOIN users u ON u.id = p.driver_id`;

function loadPayment(id) {
  const p = get(`${PAYMENT_SELECT} WHERE p.id = ?`, id);
  if (!p) return null;
  p.items = all('SELECT * FROM payment_items WHERE payment_id = ? ORDER BY id', id);
  p.folio = receipts.folio(p);
  return p;
}

function paymentForUser(req) {
  const p = loadPayment(Number(req.params.id));
  if (!p || (req.user.role !== 'admin' && p.driver_id !== req.user.id)) throw new HttpError(404, 'El recibo no existe.');
  return p;
}

function readWeek(body, required) {
  const year = num(body.year);
  const week = num(body.week);
  if (year == null && week == null && !required) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('El año no es válido.');
  if (!Number.isInteger(week) || week < 1 || week > weeksInYear(year)) throw bad(`La semana debe estar entre 1 y ${weeksInYear(year)}.`);
  return { year, week, ...weekRange(year, week) };
}

function ymd(value, field) {
  const s = str(value, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`La ${field} no es válida.`);
  return s;
}

// Semana actual (para prellenar el formulario).
router.get(
  '/payments/week-info',
  auth.requireAdmin,
  h((req, res) => {
    const today = nowLocal().slice(0, 10);
    const current = isoWeek(today);
    const year = num(req.query.year) || current.year;
    const week = num(req.query.week) || current.week;
    const w = readWeek({ year, week }, true);
    res.json({ current, ...w, weeksInYear: weeksInYear(year) });
  })
);

// Viajes finalizados del chofer en la semana, para incluirlos en el recibo.
router.get(
  '/payments/week-trips',
  auth.requireAdmin,
  h((req, res) => {
    const driverId = num(req.query.driver_id);
    if (!driverId) throw bad('Selecciona el chofer.');
    const w = readWeek(req.query, true);
    const trips = all(
      `SELECT t.id, t.pickup_address, t.dest_address, t.pickup_at, t.finished_at, t.client,
              (SELECT p.id FROM payment_items i JOIN payments p ON p.id = i.payment_id
                WHERE i.trip_id = t.id AND p.status = 'emitido' LIMIT 1) AS paid_in
         FROM trips t
        WHERE t.driver_id = ? AND t.status = 'finalizado'
          AND substr(t.finished_at, 1, 10) BETWEEN ? AND ?
        ORDER BY t.finished_at`,
      driverId,
      w.start,
      w.end
    );
    const existing = all(
      "SELECT id FROM payments WHERE driver_id = ? AND kind = 'semanal' AND year = ? AND week = ? AND status = 'emitido'",
      driverId,
      w.year,
      w.week
    ).map((p) => receipts.folio({ id: p.id, kind: 'semanal' }));
    res.json({ ...w, trips, existing });
  })
);

router.get(
  '/payments',
  auth.requireUser,
  h((req, res) => {
    const where = [];
    const params = [];
    if (req.user.role !== 'admin') {
      where.push('p.driver_id = ?');
      params.push(req.user.id);
    } else if (req.query.driver_id) {
      where.push('p.driver_id = ?');
      params.push(Number(req.query.driver_id));
    }
    if (req.query.kind) where.push('p.kind = ?'), params.push(String(req.query.kind));
    // Los bonos sin semana se ubican en el año de su fecha de pago.
    if (req.query.year) where.push('COALESCE(p.year, CAST(substr(p.paid_at, 1, 4) AS INTEGER)) = ?'), params.push(Number(req.query.year));
    const rows = all(
      `${PAYMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.paid_at DESC, p.id DESC LIMIT 500`,
      ...params
    );
    const items = all(
      `SELECT * FROM payment_items WHERE payment_id IN (${rows.map(() => '?').join(',') || 'NULL'}) ORDER BY id`,
      ...rows.map((r) => r.id)
    );
    for (const r of rows) {
      r.folio = receipts.folio(r);
      r.items = items.filter((i) => i.payment_id === r.id);
    }
    res.json(rows);
  })
);

router.get('/payments/:id', auth.requireUser, h((req, res) => res.json(paymentForUser(req))));

router.post(
  '/payments',
  auth.requireAdmin,
  h((req, res) => {
    const kind = req.body.kind === 'bono' ? 'bono' : 'semanal';
    const driverId = num(req.body.driver_id);
    if (!driverId || !get("SELECT id FROM users WHERE id = ?", driverId)) throw bad('Selecciona el chofer.');
    const week = readWeek(req.body, kind === 'semanal');
    const paidAt = ymd(req.body.paid_at, 'fecha de pago');
    const description = str(req.body.description, 1000);
    if (kind === 'bono' && !description) throw bad('Describe el motivo del bono.');

    // Renglones: viajes incluidos (con importe opcional) o conceptos libres.
    const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 200).map((it) => {
      const tripId = num(it.trip_id);
      if (tripId && !get('SELECT id FROM trips WHERE id = ? AND driver_id = ?', tripId, driverId)) {
        throw bad(`El viaje #${tripId} no pertenece a este chofer.`);
      }
      const amount = num(it.amount);
      if (amount != null && amount < 0) throw bad('Los importes no pueden ser negativos.');
      const text = str(it.description, 300);
      if (!text) throw bad('Cada renglón necesita una descripción.');
      return { trip_id: tripId, description: text, amount };
    });

    let amount = num(req.body.amount);
    const itemsTotal = items.reduce((sum, it) => sum + (it.amount || 0), 0);
    if (amount == null && items.some((it) => it.amount != null)) amount = itemsTotal;
    if (amount == null || amount < 0) throw bad('Escribe el importe pagado.');
    amount = Math.round(amount * 100) / 100;

    const id = transaction(() => {
      const newId = Number(
        run(
          `INSERT INTO payments (driver_id, kind, year, week, period_start, period_end, amount, paid_at, method, reference, description, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          driverId,
          kind,
          week?.year ?? null,
          week?.week ?? null,
          week?.start ?? null,
          week?.end ?? null,
          amount,
          paidAt,
          str(req.body.method, 60),
          str(req.body.reference, 120),
          description,
          str(req.body.notes, 2000),
          req.user.id
        ).lastInsertRowid
      );
      for (const it of items) {
        run('INSERT INTO payment_items (payment_id, trip_id, description, amount) VALUES (?, ?, ?, ?)', newId, it.trip_id, it.description, it.amount);
      }
      return newId;
    });

    const payment = loadPayment(id);
    notify.notifyDriverAboutPayment(payment);
    res.status(201).json(payment);
  })
);

router.post(
  '/payments/:id/cancel',
  auth.requireAdmin,
  h((req, res) => {
    const p = paymentForUser(req);
    if (p.status === 'cancelado') throw bad('El recibo ya está cancelado.');
    run(
      "UPDATE payments SET status = 'cancelado', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?",
      str(req.body.reason, 300),
      p.id
    );
    res.json(loadPayment(p.id));
  })
);

// El chofer confirma que recibió el pago.
router.post(
  '/payments/:id/ack',
  auth.requireUser,
  h((req, res) => {
    const p = paymentForUser(req);
    if (p.driver_id !== req.user.id) throw new HttpError(403, 'Solo el chofer puede confirmar su recibo.');
    if (p.status === 'cancelado') throw bad('Este recibo fue cancelado.');
    if (!p.acknowledged_at) {
      run("UPDATE payments SET acknowledged_at = datetime('now') WHERE id = ?", p.id);
      notify.notifyAdmins(`${p.driver_name} confirmó el recibo ${p.folio}`, `Importe: $${p.amount.toFixed(2)}`, '/admin.html#pagos');
    }
    res.json(loadPayment(p.id));
  })
);

router.get(
  '/payments/:id/pdf',
  auth.requireUser,
  h((req, res) => {
    const p = paymentForUser(req);
    const name = `Recibo-${p.folio}${p.week ? `-CW${String(p.week).padStart(2, '0')}-${p.year}` : ''}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-cache');
    receipts.renderPdf(p, res);
  })
);

module.exports = router;
