// Panel del administrador: solicitudes de cotización y datos de la empresa.
let quotes = [];

async function refreshQuotesCount() {
  try {
    quotes = await api('/quotes');
  } catch {
    return;
  }
  const pending = quotes.filter((q) => q.status === 'nueva').length;
  $('#quotes-count').textContent = pending;
  $('#quotes-count').classList.toggle('hidden', !pending);
}

async function loadQuotes() {
  await refreshQuotesCount();
  $('#quotes-list').innerHTML = quotes.length
    ? quotes
        .map((q) => {
          const wa = String(q.phone || '').replace(/\D/g, '');
          const rows = [
            ['Servicio', [q.service, q.vehicle].filter(Boolean).join(' · ')],
            ['Precio de lista', q.list_price != null && q.list_price !== q.estimate ? `$${fmtNum(q.list_price)}` : ''],
            ['Estimado mostrado', q.estimate != null ? `Subtotal $${fmtNum(q.estimate)} (${fmtNum(q.km)} km)${q.total != null ? ` · total con impuestos $${fmtNum(q.total, 2)}` : ''}` : ''],
            ['Tipo de cliente', q.client_type ? (q.client_type === 'moral' ? 'Persona moral (empresa)' : 'Persona física') : ''],
            ['Forma de pago', q.payment_method],
            ['Empresa', q.company],
            ['Origen', q.origin],
            ['Destino', q.destination],
            ['Fecha deseada', q.service_date && fmtDate(q.service_date, true)],
            ['Carga', q.cargo],
            ['Comentarios', q.message],
          ].filter(([, v]) => v);
          return `
      <article class="card" style="${q.status === 'atendida' ? 'opacity:.7' : ''}">
        <div class="card-head">
          <div><h3>#${q.id} · ${esc(q.name)}</h3><span class="muted small">${esc(fmtUtc(q.created_at))}</span></div>
          <span class="badge ${q.status === 'nueva' ? 'st-asignado' : 'st-finalizado'}">${q.status === 'nueva' ? 'Nueva' : 'Atendida'}</span>
        </div>
        ${rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
        <div class="row" style="margin-top:10px">
          ${q.phone ? `<a class="btn btn-sm btn-soft" href="tel:${esc(q.phone)}">📞 ${esc(q.phone)}</a>` : ''}
          ${wa ? `<a class="btn btn-sm btn-soft" target="_blank" rel="noopener" href="https://wa.me/${wa.length === 10 ? `52${wa}` : wa}">💬 WhatsApp</a>` : ''}
          ${q.email ? `<a class="btn btn-sm btn-soft" href="mailto:${esc(q.email)}">✉️ ${esc(q.email)}</a>` : ''}
          <div class="grow"></div>
          <button class="btn-sm" data-quote="${q.id}" data-status="${q.status === 'nueva' ? 'atendida' : 'nueva'}">${q.status === 'nueva' ? '✓ Marcar como atendida' : 'Marcar como nueva'}</button>
        </div>
      </article>`;
        })
        .join('')
    : '<div class="empty">Aún no hay solicitudes de cotización.</div>';
}

$('#quotes-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-quote]');
  if (!btn) return;
  await api(`/quotes/${btn.dataset.quote}`, { method: 'PUT', body: { status: btn.dataset.status } }).catch((err) => toast(err.message));
  loadQuotes();
});

async function loadCompany() {
  const s = await api('/site');
  const form = $('#company-form');
  for (const [k, v] of Object.entries(s)) if (form.elements[k]) form.elements[k].value = v || '';
  form.querySelector('.msg').innerHTML = '';
  loadPricing();
}

$('#company-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  try {
    await api('/site', { method: 'PUT', body });
    toast('Datos guardados. La página pública ya está actualizada.');
  } catch (err) {
    showError(form.querySelector('.msg'), err);
  }
});

// ---------- Tarifas del cotizador ----------
let pricing = null;

async function loadPricing() {
  pricing = await api('/pricing');
  const form = $('#pricing-form');
  form.included_km.value = pricing.included_km;
  form.cash_discount.value = pricing.cash_discount ?? 0;
  form.overnight_km.value = pricing.overnight_km ?? 0;
  form.overnight_cost.value = pricing.overnight_cost ?? 0;
  $('#pricing-origin').textContent = pricing.origin;
  $('#pricing-body').innerHTML = pricing.services
    .map(
      (s) =>
        `<tr><td colspan="4"><b>${esc(s.label)}</b></td></tr>` +
        s.vehicles
          .map(
            (v) => `<tr data-veh="${esc(v.id)}">
            <td><input type="checkbox" data-f="enabled" ${v.disabled ? '' : 'checked'} style="width:auto"></td>
            <td>${esc(v.label)}<div class="muted small">${esc(v.note || '')}</div></td>
            ${
              v.special
                ? '<td colspan="2" class="muted small">Cotización especial (sin precio automático)</td>'
                : `<td class="num"><input data-f="base" type="number" min="0" step="50" value="${v.base}" style="width:110px"></td>
                   <td class="num"><input data-f="per_km" type="number" min="0" step="0.5" value="${v.per_km}" style="width:90px"></td>`
            }</tr>`
          )
          .join('')
    )
    .join('');
  for (const input of $$('#tax-table [data-tax]')) input.value = pricing.taxes[input.dataset.tax];
  for (const box of $$('#tax-table [data-rule]')) {
    const [who, k] = box.dataset.rule.split('.');
    box.checked = Boolean(pricing.taxes.rules[who][k]);
  }
  form.querySelector('.msg').innerHTML = '';
  renderPricingExamples();
}

function readTaxes() {
  const taxes = { rules: { fisica: {}, moral: {} } };
  for (const input of $$('#tax-table [data-tax]')) taxes[input.dataset.tax] = Number(input.value);
  for (const box of $$('#tax-table [data-rule]')) {
    const [who, k] = box.dataset.rule.split('.');
    taxes.rules[who][k] = box.checked;
  }
  return taxes;
}

function readPricingForm() {
  const vehicles = {};
  for (const row of $$('#pricing-body tr[data-veh]')) {
    const get = (f) => row.querySelector(`[data-f=${f}]`);
    const v = pricing.services.flatMap((s) => s.vehicles).find((x) => x.id === row.dataset.veh);
    vehicles[row.dataset.veh] = {
      enabled: get('enabled').checked,
      base: get('base') ? Number(get('base').value) : v.base ?? 0,
      per_km: get('per_km') ? Number(get('per_km').value) : v.per_km ?? 0,
    };
  }
  return {
    included_km: Number($('#pricing-form').included_km.value),
    cash_discount: Number($('#pricing-form').cash_discount.value || 0),
    overnight_km: Number($('#pricing-form').overnight_km.value || 0),
    overnight_cost: Number($('#pricing-form').overnight_cost.value || 0),
    vehicles,
    taxes: readTaxes(),
  };
}

function renderPricingExamples() {
  const input = readPricingForm();
  const cities = pricing.cities.filter((c) => ['Celaya', 'León', 'Ciudad de México', 'Puebla', 'Monterrey'].includes(c.name)).sort((a, b) => a.km - b.km);
  const vehicles = pricing.services.flatMap((s) => s.vehicles).filter((v) => !v.special && input.vehicles[v.id]?.enabled);
  const price = (v, km) => {
    const t = input.vehicles[v.id];
    const raw = t.base + Math.max(0, km - input.included_km) * t.per_km;
    const nights = input.overnight_km > 0 ? Math.floor(km / input.overnight_km) : 0;
    return Math.round(raw / (pricing.round_to || 1)) * (pricing.round_to || 1) + nights * input.overnight_cost;
  };
  const d = input.cash_discount / 100;
  const list = (cash) => (d ? Math.ceil(cash / (1 - d) / 10) * 10 : cash);
  const cell = (v, km) => {
    const cash = price(v, km);
    return d ? `$${fmtNum(list(cash))}<div class="muted small">efectivo/transf. $${fmtNum(cash)}</div>` : `$${fmtNum(cash)}`;
  };
  $('#pricing-examples').innerHTML = `<table class="list"><thead><tr><th>Destino</th>${vehicles.map((v) => `<th class="num">${esc(v.label)}</th>`).join('')}</tr></thead><tbody>
    ${cities.map((c) => `<tr><td>${esc(c.name)} <span class="muted small">~${c.km} km</span></td>${vehicles.map((v) => `<td class="num">${cell(v, c.km)}</td>`).join('')}</tr>`).join('')}
  </tbody></table>${d ? '<p class="muted small">Arriba: precio de lista (tarjeta). Abajo: con descuento por efectivo o transferencia. Incluye viáticos si el viaje requiere pernoctar; sin impuestos ni casetas.</p>' : ''}${taxExample(input)}`;
}

// Ejemplo del desglose de impuestos con el flete a León en 3.5 t (o la primera unidad activa).
function taxExample(input) {
  const t = input.taxes;
  const v = pricing.services.flatMap((s) => s.vehicles).find((x) => !x.special && input.vehicles[x.id]?.enabled);
  const city = pricing.cities.find((c) => c.name === 'León');
  if (!v || !city) return '';
  const r = input.vehicles[v.id];
  const sub = Math.round((r.base + Math.max(0, city.km - input.included_km) * r.per_km) / (pricing.round_to || 1)) * (pricing.round_to || 1);
  const isFlete = pricing.services.find((s) => s.vehicles.includes(v)).id === 'flete';
  const calc = (who) => {
    const rule = t.rules[who];
    const parts = [['Subtotal', sub]];
    if (rule.iva) parts.push([`IVA ${t.iva}%`, (sub * t.iva) / 100]);
    const total = parts.reduce((a, [, n]) => a + n, 0); // lo que se cobra: importe + IVA
    const held = [];
    if (rule.ret_iva && isFlete) held.push(`Ret. IVA ${t.ret_iva}% $${fmtNum((sub * t.ret_iva) / 100, 2)}`);
    if (rule.ret_isr) held.push(`Ret. ISR ${t.ret_isr}% $${fmtNum((sub * t.ret_isr) / 100, 2)}`);
    return (
      parts.map(([k, n]) => `${k}: $${fmtNum(n, 2)}`).join(' · ') +
      ` → <b>$${fmtNum(total, 2)}</b>` +
      (held.length ? ` <span class="muted">(informativo, las entera el cliente al SAT: ${held.join(' · ')})</span>` : '')
    );
  };
  return `<p class="small" style="margin-top:8px"><b>${esc(v.label)} a León</b><br>Persona física: ${calc('fisica')}<br>Persona moral: ${calc('moral')}</p><p class="muted small">Casetas y extras aparte.</p>`;
}

$('#pricing-form').addEventListener('input', () => pricing && renderPricingExamples());
$('#pricing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    pricing = await api('/pricing', { method: 'PUT', body: readPricingForm() });
    toast('Tarifas guardadas. La página pública ya muestra los nuevos precios.');
  } catch (err) {
    showError($('#pricing-form .msg'), err);
  }
});
