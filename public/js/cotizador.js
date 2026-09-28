// Cotizador de la página pública: precio estimado según unidad y destino, y
// envío de la solicitud (al servidor, o por WhatsApp/correo en la versión estática).
(() => {
  const data = JSON.parse(document.getElementById('page-data').textContent);
  const P = data.pricing;
  const $ = (id) => document.getElementById(id);
  const money = (n) => `$${Math.round(n).toLocaleString('es-MX')}`;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let service = P.services[0];
  let vehicle = service.vehicles[0];
  let clientType = 'fisica';

  // Impuestos según el tipo de cliente (misma regla que src/pricing.js).
  const round2 = (n) => Math.round(n * 100) / 100;
  function taxBreakdown(subtotal) {
    const t = P.taxes;
    const rule = t.rules[clientType];
    const lines = [];
    if (rule.iva) lines.push({ label: `IVA ${t.iva}%`, amount: round2((subtotal * t.iva) / 100) });
    if (rule.ret_iva && t.ret_iva_services.includes(service.id)) lines.push({ label: `Retención de IVA ${t.ret_iva}%`, amount: -round2((subtotal * t.ret_iva) / 100) });
    if (rule.ret_isr) lines.push({ label: `Retención de ISR ${t.ret_isr}%`, amount: -round2((subtotal * t.ret_isr) / 100) });
    return { lines, total: round2(subtotal + lines.reduce((sum, l) => sum + l.amount, 0)) };
  }
  const money2 = (n) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  $('client-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-client]');
    if (!b) return;
    clientType = b.dataset.client;
    render();
  });
  const methods = P.payment_methods || [];
  $('pay-methods').innerHTML = methods.length ? `<b>Aceptamos:</b> ${methods.map(esc).join(' · ')}` : '';
  $('pay-select').innerHTML = '<option value="">— Elige —</option>' + methods.map((m) => `<option>${esc(m)}</option>`).join('');

  // ---------- Tipo de servicio y unidad ----------
  $('svc-tabs').innerHTML = P.services
    .map((s) => `<button type="button" role="tab" data-svc="${esc(s.id)}">${esc(s.label)}</button>`)
    .join('');
  $('svc-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-svc]');
    if (!b) return;
    service = P.services.find((s) => s.id === b.dataset.svc);
    vehicle = service.vehicles[0];
    render();
  });
  $('vehicles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-veh]');
    if (!b) return;
    vehicle = service.vehicles.find((v) => v.id === b.dataset.veh);
    render();
  });

  // ---------- Destinos ----------
  $('dest-city').innerHTML =
    '<option value="">— Elige un destino —</option>' +
    P.cities.map((c, i) => `<option value="${i}">${esc(c.name)} (~${c.km} km)</option>`).join('') +
    '<option value="otro">Otro destino…</option>';
  $('dest-city').addEventListener('change', () => {
    const other = $('dest-city').value === 'otro';
    $('km-row').classList.toggle('hidden', !other);
    const city = P.cities[$('dest-city').value];
    // Se llena el destino del formulario, sin pisar lo que el cliente escribió.
    const destInput = document.querySelector('#quote-form [name=destination]');
    if (city && (!destInput.value || destInput.value === destInput.dataset.auto)) {
      destInput.value = city.name;
      destInput.dataset.auto = city.name;
    }
    render();
  });
  $('dest-km').addEventListener('input', render);

  function distance() {
    const v = $('dest-city').value;
    if (v === 'otro') {
      const km = Number($('dest-km').value);
      return $('dest-km').value !== '' && km >= 0 ? km : null;
    }
    return v === '' ? null : P.cities[Number(v)].km;
  }

  function estimate(km) {
    if (vehicle.special || km == null) return null;
    const extraKm = Math.max(0, km - P.included_km);
    const step = P.round_to || 1;
    return { total: Math.round((vehicle.base + extraKm * vehicle.per_km) / step) * step, extraKm };
  }

  let current = null;
  function render() {
    [...$('svc-tabs').children].forEach((b) => b.classList.toggle('active', b.dataset.svc === service.id));
    [...$('client-tabs').children].forEach((b) => b.classList.toggle('active', b.dataset.client === clientType));
    const companyInput = document.querySelector('#quote-form [name=company]');
    companyInput.previousSibling.textContent = clientType === 'moral' ? 'Razón social*' : 'Empresa';
    $('vehicles').innerHTML = service.vehicles
      .map(
        (v) => `<button type="button" data-veh="${esc(v.id)}" class="${v.id === vehicle.id ? 'active' : ''}">
          <b>${esc(v.label)}</b><span>${esc(v.note || '')}</span>
          <span class="rate">${v.special ? 'Cotización especial' : `Desde ${money(v.base)}`}</span></button>`
      )
      .join('');
    const isExec = service.id === 'ejecutivo';
    $('cargo-label').textContent = isExec ? 'Pasajeros' : 'Carga';
    $('cargo-input').placeholder = isExec ? 'Ej. 4 personas con equipaje' : 'Ej. 10 tarimas, 3 toneladas';

    const km = distance();
    const est = estimate(km);
    const taxes = est ? taxBreakdown(est.total) : null;
    current = { service: service.label, vehicle: vehicle.label, km, estimate: est ? est.total : null, client_type: clientType, total: taxes ? taxes.total : null };
    const box = $('estimate');
    if (vehicle.special) {
      box.innerHTML = `<div class="est-special">Las unidades grandes se cotizan según el volumen, peso y maniobras de la carga. Envíanos tu solicitud y te respondemos con el precio.</div>`;
    } else if (!est) {
      box.innerHTML = `<div class="est-empty">Elige el destino para ver el precio estimado.<br><small>Base ${money(vehicle.base)} hasta ${P.included_km} km desde ${esc(P.origin)}.</small></div>`;
    } else {
      box.innerHTML = `
        <div class="est-label">Precio estimado · ${esc(vehicle.label)}</div>
        <div class="est-detail">Base ${money(vehicle.base)} (hasta ${P.included_km} km)${
          est.extraKm ? ` + ${est.extraKm} km × ${money(vehicle.per_km)}` : ''
        }</div>
        <table class="est-table">
          <tr><td>Subtotal</td><td>${money2(est.total)}</td></tr>
          ${taxes.lines.map((l) => `<tr class="${l.amount < 0 ? 'minus' : ''}"><td>${esc(l.label)}</td><td>${money2(l.amount)}</td></tr>`).join('')}
          <tr class="grand"><td>Total a pagar</td><td>${money2(taxes.total)} <small>MXN</small></td></tr>
        </table>
        <div class="est-detail">${
          clientType === 'moral' && taxes.lines.some((l) => l.amount < 0)
            ? 'Las retenciones las entera tu empresa al SAT y se reflejan en la factura. '
            : ''
        }Casetas aparte.</div>`;
    }
  }

  $('calc-rule').textContent = `Tarifa base por unidad que incluye hasta ${P.included_km} km desde ${P.origin}. Cada km adicional (distancia por carretera, solo ida) se cobra según la unidad; la tarifa por km ya considera el regreso. Impuestos: IVA ${P.taxes.iva}%. Si eres empresa (persona moral) retienes ${P.taxes.ret_iva}% de IVA en fletes y ${P.taxes.ret_isr}% de ISR, según la ley.`;
  $('calc-extras').innerHTML = (P.extras || []).map((x) => `<li>${esc(x)}</li>`).join('');
  render();

  // ---------- Envío de la solicitud ----------
  const form = $('quote-form');
  const msg = $('quote-msg');
  if (data.static) $('quote-send').textContent = data.whatsapp ? 'Enviar por WhatsApp' : 'Enviar por correo';

  function summary(d) {
    return [
      `Solicitud de cotización · ${current.service}`,
      `Unidad: ${current.vehicle}`,
      current.estimate ? `Estimado en la página: subtotal ${money(current.estimate)}, total con impuestos ${money2(current.total)} (${current.km} km)` : '',
      `Cliente: ${clientType === 'moral' ? 'Persona moral (empresa)' : 'Persona física'}`,
      d.payment_method && `Forma de pago: ${d.payment_method}`,
      `Nombre: ${d.name}`,
      d.company && `Empresa: ${d.company}`,
      d.phone && `Teléfono: ${d.phone}`,
      d.email && `Correo: ${d.email}`,
      d.origin && `Origen: ${d.origin}`,
      d.destination && `Destino: ${d.destination}`,
      d.service_date && `Fecha: ${d.service_date}`,
      d.cargo && `${service.id === 'ejecutivo' ? 'Pasajeros' : 'Carga'}: ${d.cargo}`,
      d.message && `Comentarios: ${d.message}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    msg.className = 'err';
    if (!d.name.trim()) return (msg.textContent = 'Escribe tu nombre.');
    if (!d.phone.trim() && !d.email.trim()) return (msg.textContent = 'Déjanos un teléfono o correo para contactarte.');
    if (clientType === 'moral' && !d.company.trim()) return (msg.textContent = 'Escribe la razón social de tu empresa.');

    // Versión estática (GitHub Pages): no hay servidor, se envía por WhatsApp o correo.
    if (data.static) {
      const text = summary(d);
      if (data.whatsapp) window.open(`https://wa.me/${data.whatsapp}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      else if (data.email) location.href = `mailto:${data.email}?subject=${encodeURIComponent('Solicitud de cotización')}&body=${encodeURIComponent(text)}`;
      else return (msg.textContent = 'Por ahora escríbenos directamente; pronto estará disponible el envío en línea.');
      msg.className = 'ok';
      msg.textContent = 'Se abrió tu aplicación para enviarnos la solicitud.';
      return;
    }

    const btn = $('quote-send');
    btn.disabled = true;
    msg.className = '';
    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...d, service: current.service, vehicle: current.vehicle, km: current.km, estimate: current.estimate, client_type: clientType, total: current.total }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'No se pudo enviar. Inténtalo de nuevo.');
      form.reset();
      msg.className = 'ok';
      msg.textContent = '¡Gracias! Recibimos tu solicitud y te contactaremos pronto.';
    } catch (err) {
      msg.className = 'err';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
})();
