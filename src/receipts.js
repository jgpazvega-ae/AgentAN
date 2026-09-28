// Recibos de pago en PDF (pago semanal por destajo y bonos).
const path = require('node:path');
const PDFDocument = require('pdfkit');
const config = require('./config');
const { weekLabel } = require('./weeks');
const { getSite } = require('./site');

const LOGO = path.join(__dirname, '..', 'public', 'img', 'logo.png');

// ---------- Importe con letra: 2500.5 → "DOS MIL QUINIENTOS PESOS 50/100 M.N." ----------
const UNITS = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIÚN', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const TENS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const HUNDREDS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function below1000(n) {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let words = HUNDREDS[h];
  if (rest) {
    const part = rest < 30 ? UNITS[rest] : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? ` Y ${UNITS[rest % 10]}` : ''}`;
    words = words ? `${words} ${part}` : part;
  }
  return words;
}

function integerToWords(n) {
  if (n === 0) return 'CERO';
  const millions = Math.floor(n / 1e6);
  const thousands = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (millions) parts.push(millions === 1 ? 'UN MILLÓN' : `${below1000(millions)} MILLONES`);
  if (thousands) parts.push(thousands === 1 ? 'MIL' : `${below1000(thousands)} MIL`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

function amountInWords(amount) {
  const cents = Math.round(amount * 100);
  const pesos = Math.floor(cents / 100);
  const words = integerToWords(pesos);
  // "UN MILLÓN DE PESOS", "DOS MILLONES DE PESOS"
  const de = /MILL(ÓN|ONES)$/.test(words) ? ' DE' : '';
  return `${words}${de} ${pesos === 1 ? 'PESO' : 'PESOS'} ${String(cents % 100).padStart(2, '0')}/100 M.N.`;
}

// ---------- Formatos ----------
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function longDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return `${d} de ${MONTHS[m - 1]} de ${y}`;
}

function money(n) {
  return `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function folio(payment) {
  return `${payment.kind === 'bono' ? 'B' : 'P'}-${String(payment.id).padStart(5, '0')}`;
}

function periodText(p) {
  if (!p.week) return '';
  const range = p.period_start ? ` (del ${longDate(p.period_start)} al ${longDate(p.period_end)})` : '';
  return `${weekLabel(p.week)} ${p.year}${range}`;
}

// ---------- PDF ----------
// Las fuentes integradas del PDF solo tienen caracteres latinos (WinAnsi).
// Se sustituyen flechas y se quitan símbolos que saldrían como basura (emojis, etc.).
const WINANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
function pdfText(value) {
  return String(value ?? '')
    .replace(/[→⇒➔➜]/g, '-')
    .replace(/[←⇐]/g, '-')
    .replace(/[^\n\x20-\xff]/g, (c) => (WINANSI_EXTRA.has(c) ? c : ''));
}

function renderPdf(rawPayment, stream) {
  const site = getSite();
  const company = pdfText(site.name);
  const payment = { ...rawPayment };
  for (const k of ['driver_name', 'description', 'notes', 'method', 'reference', 'cancel_reason']) payment[k] = payment[k] && pdfText(payment[k]);
  payment.items = rawPayment.items.map((i) => ({ ...i, description: pdfText(i.description) }));
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: { Title: `Recibo ${folio(payment)}`, Author: company } });
  doc.pipe(stream);

  const blue = '#13294b';
  const green = '#3f9a5c';
  const gray = '#6b7280';
  const width = doc.page.width - 100;
  const left = 50;

  // Encabezado
  let headerY = 50;
  try {
    doc.image(LOGO, left, 44, { height: 46 });
    headerY = 96;
  } catch {
    doc.fillColor(blue).font('Helvetica-Bold').fontSize(18).text(company, left, 50, { width: width * 0.6 });
    headerY = doc.y;
  }
  doc.y = headerY;
  doc.fillColor(gray).font('Helvetica').fontSize(9);
  for (const line of [site.rfc && `RFC: ${site.rfc}`, site.address, site.phone && `Tel. ${site.phone}`].filter(Boolean)) {
    doc.text(pdfText(line), left, doc.y, { width: width * 0.6 });
  }
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(14).text('RECIBO DE PAGO', left, 50, { width, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(gray).text(`Folio ${folio(payment)}`, { width, align: 'right' });
  doc.text(`Fecha de pago: ${longDate(payment.paid_at)}`, { width, align: 'right' });
  if (payment.status === 'cancelado') {
    doc.fillColor('#b91c1c').font('Helvetica-Bold').text('CANCELADO', { width, align: 'right' });
  }

  const lineY = Math.max(doc.y + 8, 125);
  doc.moveTo(left, lineY).lineTo(left + width, lineY).strokeColor('#e5e7eb').stroke();

  // Datos principales
  let y = lineY + 15;
  const field = (label, value) => {
    if (!value) return;
    doc.font('Helvetica').fontSize(9).fillColor(gray).text(label.toUpperCase(), left, y, { width: 130 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(value, left + 135, y, { width: width - 135 });
    y = doc.y + 8;
  };
  field('Recibí de', company);
  field('Nombre de quien recibe', payment.driver_name);
  field('Tipo de pago', payment.kind === 'bono' ? 'Bono' : 'Pago semanal por servicios de flete (destajo)');
  field('Semana', periodText(payment));
  if (payment.kind === 'bono') field('Concepto del bono', payment.description);

  // Detalle
  y += 6;
  doc.rect(left, y, width, 22).fill('#eef2ff');
  doc.fillColor('#1e3a8a').font('Helvetica-Bold').fontSize(10);
  doc.text('CONCEPTO', left + 8, y + 7, { width: width - 130 });
  doc.text('IMPORTE', left + width - 120, y + 7, { width: 112, align: 'right' });
  y += 28;

  const lines = payment.items.length
    ? payment.items
    : [
        {
          description:
            payment.kind === 'bono'
              ? `Bono${payment.description ? `: ${payment.description}` : ''}`
              : `Servicios de flete por destajo${payment.week ? ` · ${weekLabel(payment.week)} ${payment.year}` : ''}`,
          amount: payment.amount,
        },
      ];
  const showLineAmounts = lines.some((l) => l.amount != null);
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  for (const line of lines) {
    if (y > doc.page.height - 220) {
      doc.addPage();
      y = 50;
    }
    doc.text(line.description, left + 8, y, { width: width - 140 });
    const rowEnd = doc.y;
    if (showLineAmounts) doc.text(line.amount != null ? money(line.amount) : '—', left + width - 120, y, { width: 112, align: 'right' });
    y = Math.max(rowEnd, doc.y) + 6;
    doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#f3f4f6').stroke();
  }

  // Total
  y += 4;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827');
  doc.text('TOTAL PAGADO', left + 8, y, { width: width - 140 });
  doc.text(money(payment.amount), left + width - 160, y, { width: 152, align: 'right' });
  y = doc.y + 4;
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(gray).text(`(${amountInWords(payment.amount)})`, left + 8, y, { width: width - 16, align: 'right' });
  y = doc.y + 14;

  const extra = [
    ['Forma de pago', payment.method],
    ['Referencia', payment.reference],
  ].filter(([, v]) => v);
  for (const [k, v] of extra) {
    doc.font('Helvetica').fontSize(10).fillColor(gray).text(`${k}: `, left, y, { continued: true }).fillColor('#111827').text(v);
    y = doc.y + 4;
  }
  if (payment.notes) {
    y += 6;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Notas', left, y);
    doc.font('Helvetica').fontSize(10).text(payment.notes, left, doc.y + 2, { width });
    y = doc.y + 6;
  }
  if (payment.status === 'cancelado' && payment.cancel_reason) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#b91c1c').text(`Motivo de cancelación: ${payment.cancel_reason}`, left, y + 6, { width });
    y = doc.y + 6;
  }

  // Firma / conformidad
  y = Math.max(y + 50, doc.page.height - 170);
  if (y > doc.page.height - 120) {
    doc.addPage();
    y = 120;
  }
  const sigWidth = 220;
  const sigLeft = left + (width - sigWidth) / 2;
  doc.moveTo(sigLeft, y).lineTo(sigLeft + sigWidth, y).strokeColor('#9ca3af').stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(payment.driver_name, sigLeft, y + 6, { width: sigWidth, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor(gray).text('Nombre y firma de conformidad', sigLeft, doc.y + 2, { width: sigWidth, align: 'center' });
  if (payment.acknowledged_at) {
    const when = new Date(`${payment.acknowledged_at.replace(' ', 'T')}Z`).toLocaleString('es-MX', { timeZone: config.timezone, dateStyle: 'long', timeStyle: 'short' });
    doc.fillColor('#047857').text(`Recibido y confirmado por el chofer en la plataforma el ${when}`, left, doc.y + 8, { width, align: 'center' });
  }

  doc.fontSize(8).fillColor(gray).text(`Comprobante interno de pago · ${company} · ${folio(payment)}`, left, doc.page.height - 60, { width, align: 'center' });
  doc.end();
}

module.exports = { renderPdf, amountInWords, folio, periodText };
