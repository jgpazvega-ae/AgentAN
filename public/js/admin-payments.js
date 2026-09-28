// Panel del administrador: recibos de pago semanal (destajo) y bonos.
let paymentKind = 'semanal';
let payments = [];
let weekTrips = [];

// Texto que se propone cuando la semana no tiene viajes: deja claro que es un
// pago a cuenta de servicios por destajo (no un sueldo fijo). Se puede editar.
const NOTE_NO_TRIPS = 'Pago a cuenta de servicios de flete por destajo. Sin viajes finalizados registrados en la semana.';
const noteWithTrips = (n, label) => `Pago por destajo de ${n} viaje${n === 1 ? '' : 's'} realizado${n === 1 ? '' : 's'} en la semana ${label}.`;

const money = (n) => `$${fmtNum(n, 2)}`;
const cw = (week) => `CW${String(week).padStart(2, '0')}`;
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDay(ymd) {
  return ymd ? fmtDate(ymd, true) : '';
}

function fillYearSelect(select, selected) {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now + 1; y >= now - 5; y--) years.push(y);
  select.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  select.value = String(selected || now);
}

function driverOptions(select) {
  select.innerHTML =
    '<option value="">— Selecciona —</option>' +
    users.filter((u) => u.active || u.role === 'driver').map((u) => `<option value="${u.id}">${esc(u.name)}${u.active ? '' : ' (inactivo)'}</option>`).join('');
}

// ---------- Lista ----------
async function loadPayments() {
  if (!$('#p-year').options.length) {
    fillYearSelect($('#p-year'));
    $('#p-year').insertAdjacentHTML('afterbegin', '<option value="">Todos</option>');
    $('#p-year').value = String(new Date().getFullYear());
  }
  const current = $('#p-driver').value;
  $('#p-driver').innerHTML = '<option value="">Todos</option>' + users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  $('#p-driver').value = current;

  const params = new URLSearchParams({ kind: paymentKind });
  if ($('#p-driver').value) params.set('driver_id', $('#p-driver').value);
  if ($('#p-year').value) params.set('year', $('#p-year').value);
  try {
    payments = await api(`/payments?${params}`);
  } catch (err) {
    $('#payments-body').innerHTML = `<tr><td colspan="7">${esc(err.message)}</td></tr>`;
    return;
  }
  $('#p-col-week').textContent = paymentKind === 'bono' ? 'Descripción' : 'Semana';
  $('#payments-body').innerHTML = payments.length
    ? payments
        .map(
          (p) => `
      <tr>
        <td><b>${esc(p.folio)}</b></td>
        <td>${
          paymentKind === 'bono'
            ? `${esc(p.description)}${p.week ? `<div class="muted small">${cw(p.week)} ${p.year}</div>` : ''}`
            : `<b>${cw(p.week)}</b> ${p.year}<div class="muted small">${esc(fmtDay(p.period_start))} – ${esc(fmtDay(p.period_end))}</div>`
        }${p.kind === 'semanal' ? `<div class="muted small">${p.items.filter((i) => i.trip_id).length} viaje(s)</div>` : ''}</td>
        <td>${esc(p.driver_name)}</td>
        <td>${esc(fmtDay(p.paid_at))}<div class="muted small">${esc(p.method || '')}</div></td>
        <td class="num"><b>${money(p.amount)}</b></td>
        <td>${
          p.status === 'cancelado'
            ? '<span class="badge st-cancelado">Cancelado</span>'
            : p.acknowledged_at
              ? '<span class="badge st-finalizado">✓ Recibido</span>'
              : '<span class="badge st-asignado">Por confirmar</span>'
        }</td>
        <td style="white-space:nowrap">
          <a class="btn btn-sm btn-soft" href="/api/payments/${p.id}/pdf" target="_blank" rel="noopener">PDF</a>
          ${p.status !== 'cancelado' ? `<button class="btn-sm btn-danger" data-cancel-payment="${p.id}">Cancelar</button>` : ''}
        </td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="7" class="empty">${paymentKind === 'bono' ? 'Aún no hay bonos registrados.' : 'Aún no hay pagos semanales registrados.'}</td></tr>`;
}

$$('.subtabs button').forEach(
  (b) =>
    (b.onclick = () => {
      paymentKind = b.dataset.kind;
      $$('.subtabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('#new-payment').textContent = paymentKind === 'bono' ? '＋ Nuevo bono' : '＋ Nuevo pago semanal';
      loadPayments();
    })
);
$('#p-driver').onchange = loadPayments;
$('#p-year').onchange = loadPayments;
$('#new-payment').onclick = () => (paymentKind === 'bono' ? openBonus() : openWeekly());

$('#payments-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel-payment]');
  if (!btn) return;
  const p = payments.find((x) => x.id === Number(btn.dataset.cancelPayment));
  const reason = prompt(`¿Cancelar el recibo ${p.folio} de ${p.driver_name} por ${money(p.amount)}?\nEscribe el motivo:`, '');
  if (reason === null) return;
  try {
    await api(`/payments/${p.id}/cancel`, { method: 'POST', body: { reason } });
    toast('Recibo cancelado');
    loadPayments();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Pago semanal ----------
async function openWeekly() {
  const form = $('#weekly-form');
  form.reset();
  form.querySelector('.msg').innerHTML = '';
  driverOptions(form.driver_id);
  const info = await api('/payments/week-info');
  // Por defecto se propone la semana anterior (la que normalmente se paga).
  let week = info.current.week - 1;
  let year = info.current.year;
  if (week < 1) {
    year -= 1;
    week = (await api(`/payments/week-info?year=${year}&week=1`)).weeksInYear;
  }
  fillYearSelect(form.year, year);
  form.week.value = week;
  form.paid_at.value = todayYmd();
  weekTrips = [];
  $('#weekly-trips').innerHTML = '<p class="muted small">Selecciona el chofer para ver sus viajes de la semana.</p>';
  $('#weekly-existing').innerHTML = '';
  await updateWeekRange();
  $('#weekly-dialog').showModal();
}

async function updateWeekRange() {
  const form = $('#weekly-form');
  if (!form.week.value || !form.year.value) return;
  try {
    const info = await api(`/payments/week-info?year=${form.year.value}&week=${form.week.value}`);
    form.week.max = info.weeksInYear;
    $('#weekly-range').textContent = `${cw(info.week)} ${info.year}: del ${fmtDay(info.start)} al ${fmtDay(info.end)}`;
  } catch (err) {
    $('#weekly-range').textContent = err.message;
  }
  await loadWeekTrips();
}

let weekTripsRequest = 0;
async function loadWeekTrips() {
  const form = $('#weekly-form');
  if (!form.driver_id.value || !form.week.value) return;
  // Si se cambia de chofer o semana rápido, solo cuenta la última respuesta.
  const request = ++weekTripsRequest;
  let data;
  try {
    data = await api(`/payments/week-trips?driver_id=${form.driver_id.value}&year=${form.year.value}&week=${form.week.value}`);
  } catch (err) {
    if (request === weekTripsRequest) showError($('#weekly-trips'), err);
    return;
  }
  if (request !== weekTripsRequest) return;
  weekTrips = data.trips.map((t) => ({
    trip_id: t.id,
    checked: !t.paid_in,
    paid_in: t.paid_in,
    description: `Viaje #${t.id} · ${fmtDate(t.finished_at)} · ${t.pickup_address} → ${t.dest_address}${t.client ? ` (${t.client})` : ''}`,
    amount: '',
  }));
  $('#weekly-existing').innerHTML = data.existing.length
    ? `<div class="alert alert-warn">Este chofer ya tiene recibo de esta semana: ${data.existing.map(esc).join(', ')}. Puedes generar otro si es un pago adicional.</div>`
    : '';
  renderWeekLines();
  const label = `${cw(data.week)} ${data.year}`;
  const selected = weekTrips.filter((l) => l.checked && l.trip_id).length;
  form.notes.value = selected ? noteWithTrips(selected, label) : NOTE_NO_TRIPS;
}

function renderWeekLines() {
  const box = $('#weekly-trips');
  if (!weekTrips.length) {
    box.innerHTML = '<p class="muted small">No hay viajes finalizados de este chofer en la semana. El recibo se generará con el concepto general de servicios por destajo.</p>';
    return;
  }
  box.innerHTML = weekTrips
    .map(
      (l, i) => `
      <div class="line-row">
        <input type="checkbox" data-i="${i}" data-field="checked" ${l.checked ? 'checked' : ''} aria-label="Incluir">
        ${
          l.trip_id
            ? `<span>${esc(l.description)}${l.paid_in ? `<div class="paid">Ya incluido en el recibo P-${String(l.paid_in).padStart(5, '0')}</div>` : ''}</span>`
            : `<input data-i="${i}" data-field="description" value="${esc(l.description)}" placeholder="Concepto (ej. maniobras, casetas)">`
        }
        <input type="number" step="0.01" min="0" inputmode="decimal" placeholder="$ opcional" data-i="${i}" data-field="amount" value="${esc(l.amount)}">
        ${l.trip_id ? '<span></span>' : `<button type="button" class="btn-sm btn-danger" data-remove="${i}">✕</button>`}
      </div>`
    )
    .join('');
}

$('#weekly-trips').addEventListener('input', (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  const line = weekTrips[Number(i)];
  line[e.target.dataset.field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  // El total se calcula con los importes capturados (se puede escribir otro a mano).
  const withAmount = weekTrips.filter((l) => l.checked && l.amount !== '');
  if (withAmount.length) $('#weekly-form').amount.value = withAmount.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
});
$('#weekly-trips').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  weekTrips.splice(Number(btn.dataset.remove), 1);
  renderWeekLines();
});
$('#weekly-add-line').onclick = () => {
  weekTrips.push({ trip_id: null, checked: true, description: '', amount: '' });
  renderWeekLines();
  $$('#weekly-trips input[data-field=description]').at(-1)?.focus();
};

$('#weekly-form').driver_id.addEventListener('change', loadWeekTrips);
$('#weekly-form').week.addEventListener('change', updateWeekRange);
$('#weekly-form').year.addEventListener('change', updateWeekRange);

$('#weekly-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const items = weekTrips
    .filter((l) => l.checked && l.description.trim())
    .map((l) => ({ trip_id: l.trip_id, description: l.description.trim(), amount: l.amount === '' ? null : l.amount }));
  await submitPayment(form, $('#weekly-dialog'), {
    kind: 'semanal',
    driver_id: form.driver_id.value,
    year: form.year.value,
    week: form.week.value,
    amount: form.amount.value,
    paid_at: form.paid_at.value,
    method: form.method.value,
    reference: form.reference.value,
    notes: form.notes.value,
    items,
  });
});

// ---------- Bono ----------
async function openBonus() {
  const form = $('#bonus-form');
  form.reset();
  form.querySelector('.msg').innerHTML = '';
  driverOptions(form.driver_id);
  const info = await api('/payments/week-info');
  fillYearSelect(form.year, info.current.year);
  form.week.value = info.current.week;
  form.paid_at.value = todayYmd();
  $('#bonus-week-row').classList.add('hidden');
  $('#bonus-dialog').showModal();
}
$('#bonus-form').with_week.addEventListener('change', (e) => $('#bonus-week-row').classList.toggle('hidden', !e.target.checked));

$('#bonus-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const withWeek = form.with_week.checked;
  await submitPayment(form, $('#bonus-dialog'), {
    kind: 'bono',
    driver_id: form.driver_id.value,
    year: withWeek ? form.year.value : null,
    week: withWeek ? form.week.value : null,
    description: form.description.value,
    amount: form.amount.value,
    paid_at: form.paid_at.value,
    method: form.method.value,
    reference: form.reference.value,
    notes: form.notes.value,
  });
});

async function submitPayment(form, dialog, body) {
  const btn = form.querySelector('.btn-primary');
  btn.disabled = true;
  try {
    const p = await api('/payments', { method: 'POST', body });
    dialog.close();
    toast(`Recibo ${p.folio} generado. Se avisó a ${p.driver_name}.`);
    window.open(`/api/payments/${p.id}/pdf`, '_blank', 'noopener');
    loadPayments();
  } catch (err) {
    showError(form.querySelector('.msg'), err);
  } finally {
    btn.disabled = false;
  }
}
