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
            ['Estimado mostrado', q.estimate != null ? `$${fmtNum(q.estimate)} + IVA (${fmtNum(q.km)} km)` : ''],
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
  form.querySelector('.msg').innerHTML = '';
  renderPricingExamples();
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
  return { included_km: Number($('#pricing-form').included_km.value), vehicles };
}

function renderPricingExamples() {
  const input = readPricingForm();
  const cities = pricing.cities.filter((c) => ['Celaya', 'León', 'Ciudad de México', 'Puebla', 'Monterrey'].includes(c.name)).sort((a, b) => a.km - b.km);
  const vehicles = pricing.services.flatMap((s) => s.vehicles).filter((v) => !v.special && input.vehicles[v.id]?.enabled);
  const price = (v, km) => {
    const t = input.vehicles[v.id];
    const raw = t.base + Math.max(0, km - input.included_km) * t.per_km;
    return Math.round(raw / (pricing.round_to || 1)) * (pricing.round_to || 1);
  };
  $('#pricing-examples').innerHTML = `<table class="list"><thead><tr><th>Destino</th>${vehicles.map((v) => `<th class="num">${esc(v.label)}</th>`).join('')}</tr></thead><tbody>
    ${cities.map((c) => `<tr><td>${esc(c.name)} <span class="muted small">~${c.km} km</span></td>${vehicles.map((v) => `<td class="num">$${fmtNum(price(v, c.km))}</td>`).join('')}</tr>`).join('')}
  </tbody></table><p class="muted small">Más casetas, extras e IVA.</p>`;
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
