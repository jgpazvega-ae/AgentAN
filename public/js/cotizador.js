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
    // Las retenciones (info) las entera el cliente al SAT: no cambian lo que se cobra (importe + IVA).
    if (rule.ret_iva && t.ret_iva_services.includes(service.id)) lines.push({ label: `Retención de IVA ${t.ret_iva}%`, amount: -round2((subtotal * t.ret_iva) / 100), info: true });
    if (rule.ret_isr) lines.push({ label: `Retención de ISR ${t.ret_isr}%`, amount: -round2((subtotal * t.ret_isr) / 100), info: true });
    return { lines, total: round2(subtotal + lines.filter((l) => !l.info).reduce((sum, l) => sum + l.amount, 0)) };
  }
  const money2 = (n) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  $('client-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-client]');
    if (!b) return;
    clientType = b.dataset.client;
    render();
  });
  const methods = P.payment_methods || [];
  const cashMethods = P.cash_methods || [];
  const discount = P.cash_discount || 0;
  let payMethod = methods.find((m) => cashMethods.includes(m)) || methods[0] || '';
  const shortName = (m) => (m.startsWith('Tarjeta') ? 'Tarjeta' : m);
  $('pay-tabs').innerHTML = methods.map((m) => `<button type="button" data-pay="${esc(m)}">${esc(shortName(m))}</button>`).join('');
  $('pay-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pay]');
    if (!b) return;
    payMethod = b.dataset.pay;
    render();
  });
  $('pay-methods').innerHTML = methods.length
    ? `<b>Aceptamos:</b> ${methods.map(esc).join(' · ')}.${
        discount ? ` Precio de lista válido para cualquier forma de pago; pagando en ${cashMethods.map((m) => m.toLowerCase()).join(' o ')} obtienes un descuento.` : ''
      }`
    : '';
  // Precio de lista: el descuento por efectivo/transferencia cubre la comisión de la terminal.
  const listPrice = (cash) => (discount ? Math.ceil(cash / (1 - discount / 100) / 10) * 10 : cash);

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

  // ---------- Ruta con origen y destino elegidos por el cliente (Google) ----------
  let routeMode = 'city';
  let customKm = null;
  const places = { origin: null, dest: null }; // { address, lat, lng }

  if (data.mapsKey) $('route-mode-wrap').classList.remove('hidden');
  $('route-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    routeMode = b.dataset.mode;
    [...$('route-mode').children].forEach((x) => x.classList.toggle('active', x === b));
    $('custom-route').classList.toggle('hidden', routeMode !== 'custom');
    $('city-route').classList.toggle('hidden', routeMode === 'custom');
    if (routeMode === 'custom') setupPlaceInputs();
    render();
  });

  // Campos de dirección: con Google Places si carga; si no, texto libre
  // (la API de rutas también entiende direcciones escritas).
  let placesReady = null;
  function setupPlaceInputs() {
    if (placesReady) return placesReady;
    for (const [key, box, ph] of [['origin', 'orig-ac', 'Ciudad, colonia o dirección de recolección'], ['dest', 'dest-ac', 'Ciudad, colonia o dirección de entrega']]) {
      const input = document.createElement('input');
      input.placeholder = ph;
      input.addEventListener('change', () => {
        places[key] = input.value.trim() ? { address: input.value.trim() } : null;
        computeRoute();
      });
      $(box).append(input);
    }
    placesReady = loadMaps()
      .then(async (google) => {
        if (!google) return;
        const lib = await google.maps.importLibrary('places');
        if (!lib.PlaceAutocompleteElement) return;
        for (const [key, box] of [['origin', 'orig-ac'], ['dest', 'dest-ac']]) {
          const ac = new lib.PlaceAutocompleteElement({ includedRegionCodes: ['mx'] });
          const onPlace = async (place) => {
            await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
            const name = place.displayName && !String(place.formattedAddress || '').startsWith(place.displayName) ? `${place.displayName}, ` : '';
            places[key] = { address: `${name}${place.formattedAddress || ''}`, lat: place.location.lat(), lng: place.location.lng() };
            computeRoute();
          };
          ac.addEventListener('gmp-select', (e) => onPlace(e.placePrediction.toPlace()));
          ac.addEventListener('gmp-placeselect', (e) => onPlace(e.place));
          $(box).replaceChildren(ac);
        }
      })
      .catch(() => {});
    return placesReady;
  }

  let mapsPromise = null;
  function loadMaps() {
    if (mapsPromise) return mapsPromise;
    mapsPromise = new Promise((resolve) => {
      window.__cotizadorMaps = () => resolve(window.google);
      const sc = document.createElement('script');
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(data.mapsKey)}&v=weekly&libraries=places&language=es&region=MX&loading=async&callback=__cotizadorMaps`;
      sc.async = true;
      sc.onerror = () => resolve(null);
      document.head.append(sc);
    });
    return mapsPromise;
  }

  // Distancia por carretera con la API de rutas de Google (Routes API).
  const waypoint = (p) => (p.lat != null ? { location: { latLng: { latitude: p.lat, longitude: p.lng } } } : { address: p.address });
  async function drivingKm(from, to) {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': data.mapsKey, 'X-Goog-FieldMask': 'routes.distanceMeters' },
      body: JSON.stringify({ origin: waypoint(from), destination: waypoint(to), travelMode: 'DRIVE', languageCode: 'es-MX', regionCode: 'MX' }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.routes?.length) throw new Error(out.error?.message || 'Sin ruta');
    return out.routes[0].distanceMeters / 1000;
  }

  let routeRequest = 0;
  async function computeRoute() {
    const info = $('route-info');
    customKm = null;
    if (!places.origin || !places.dest) {
      info.textContent = '';
      render();
      return;
    }
    const request = ++routeRequest;
    info.textContent = 'Calculando ruta…';
    render();
    const base = { lat: P.base_location.lat, lng: P.base_location.lng };
    try {
      const [a, b, c] = await Promise.all([drivingKm(base, places.origin), drivingKm(places.origin, places.dest), drivingKm(places.dest, base)]);
      if (request !== routeRequest) return;
      customKm = Math.round((a + b + c) / 2);
      info.innerHTML = `Querétaro → origen: <b>${Math.round(a)} km</b> · origen → destino: <b>${Math.round(b)} km</b> · regreso a Querétaro: <b>${Math.round(c)} km</b><br>Se cobran <b>${customKm} km</b> (la mitad del recorrido completo de la unidad).`;
      const form = document.getElementById('quote-form');
      form.origin.value = places.origin.address;
      form.destination.value = places.dest.address;
    } catch {
      if (request !== routeRequest) return;
      info.textContent = 'No pudimos calcular la ruta. Revisa las direcciones o elige un destino de la lista.';
    }
    render();
  }

  function distance() {
    if (routeMode === 'custom') return customKm;
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
    // Viáticos del chofer si el viaje obliga a pernoctar (misma regla que src/pricing.js).
    const nights = P.overnight_km > 0 ? Math.floor(km / P.overnight_km) : 0;
    const viaticos = nights * (P.overnight_cost || 0);
    return { total: Math.round((vehicle.base + extraKm * vehicle.per_km) / step) * step + viaticos, extraKm, nights, viaticos };
  }

  let current = null;
  function render() {
    [...$('svc-tabs').children].forEach((b) => b.classList.toggle('active', b.dataset.svc === service.id));
    [...$('client-tabs').children].forEach((b) => b.classList.toggle('active', b.dataset.client === clientType));
    [...$('pay-tabs').children].forEach((b) => b.classList.toggle('active', b.dataset.pay === payMethod));
    const companyInput = document.querySelector('#quote-form [name=company]');
    companyInput.previousSibling.textContent = clientType === 'moral' ? 'Razón social*' : 'Empresa';
    $('vehicles').innerHTML = service.vehicles
      .map(
        (v) => `<button type="button" data-veh="${esc(v.id)}" class="${v.id === vehicle.id ? 'active' : ''}">
          <b>${esc(v.label)}</b><span>${esc(v.note || '')}</span>
          <span class="rate">${
            v.special
              ? 'Cotización especial'
              : `Desde ${money(listPrice(v.base))}${discount ? `<small>${money(v.base)} en efectivo o transferencia</small>` : ''}`
          }</span></button>`
      )
      .join('');
    const isExec = service.id === 'ejecutivo';
    $('cargo-label').textContent = isExec ? 'Pasajeros' : 'Carga';
    $('cargo-input').placeholder = isExec ? 'Ej. 4 personas con equipaje' : 'Ej. 10 tarimas, 3 toneladas';

    const km = distance();
    const est = estimate(km);
    const list = est ? listPrice(est.total) : null;
    const withDiscount = cashMethods.includes(payMethod);
    const subtotal = est ? (withDiscount ? est.total : list) : null;
    const taxes = est ? taxBreakdown(subtotal) : null;
    current = { service: service.label, vehicle: vehicle.label, km, estimate: subtotal, list_price: list, client_type: clientType, total: taxes ? taxes.total : null, payment_method: payMethod };
    const box = $('estimate');
    if (vehicle.special) {
      box.innerHTML = `<div class="est-special">Las unidades grandes se cotizan según el volumen, peso y maniobras de la carga. Envíanos tu solicitud y te respondemos con el precio.</div>`;
    } else if (!est) {
      box.innerHTML = `<div class="est-empty">${routeMode === 'custom' ? 'Escribe de dónde sale y a dónde va para ver el precio estimado.' : 'Elige el destino para ver el precio estimado.'}<br><small>Base ${money(vehicle.base)} hasta ${P.included_km} km desde ${esc(P.origin)}.</small></div>`;
    } else {
      box.innerHTML = `
        <div class="est-label">Precio estimado · ${esc(vehicle.label)}</div>
        <div class="est-detail">${list !== est.total ? 'Tarifa con descuento: ' : ''}Base ${money(vehicle.base)} (hasta ${P.included_km} km)${
          (est.extraKm ? ` + ${est.extraKm} km × ${money(vehicle.per_km)}` : '') +
          (est.nights ? ` + viáticos del chofer (${est.nights} ${est.nights === 1 ? 'noche' : 'noches'} × ${money(P.overnight_cost)})` : '')
        }</div>
        <table class="est-table">
          ${
            list !== est.total
              ? `<tr><td>Precio de lista</td><td>${money2(list)}</td></tr>${
                  withDiscount ? `<tr class="save"><td>Descuento por pago en ${esc(payMethod.toLowerCase())}</td><td>${money2(est.total - list)}</td></tr>` : ''
                }`
              : ''
          }
          <tr><td>Subtotal</td><td>${money2(subtotal)}</td></tr>
          ${taxes.lines.filter((l) => !l.info).map((l) => `<tr><td>${esc(l.label)}</td><td>${money2(l.amount)}</td></tr>`).join('')}
          <tr class="grand"><td>Total a pagar</td><td>${money2(taxes.total)} <small>MXN</small></td></tr>
        </table>
        <div class="est-detail">${
          taxes.lines.some((l) => l.info)
            ? `Retenciones informativas que tu empresa entera al SAT (no se suman al cobro): ${taxes.lines.filter((l) => l.info).map((l) => `${esc(l.label)} ${money2(-l.amount)}`).join(' y ')}. `
            : ''
        }${!withDiscount && list !== est.total ? `Pagando en ${cashMethods.map((m) => m.toLowerCase()).join(' o ')} el total sería ${money2(taxBreakdown(est.total).total)}. ` : ''}Casetas aparte.</div>`;
    }
  }

  $('calc-rule').textContent = `Tarifa base por unidad que incluye hasta ${P.included_km} km desde ${P.origin}. Cada km adicional (distancia por carretera, solo ida) se cobra según la unidad; la tarifa por km ya considera el regreso. En viajes largos se suman viáticos del chofer (${money(P.overnight_cost)} por noche, una noche por cada ${P.overnight_km} km). Impuestos: IVA ${P.taxes.iva}%. Si eres empresa (persona moral) se cobra el importe más el IVA; las retenciones de la ley (${P.taxes.ret_iva}% de IVA en fletes y ${P.taxes.ret_isr}% de ISR) las entera tu empresa directamente al SAT.`;
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
      current.estimate ? `Estimado en la página: subtotal ${money(current.estimate)}${current.list_price !== current.estimate ? ` (precio de lista ${money(current.list_price)})` : ''}, total con impuestos ${money2(current.total)} (${current.km} km)` : '',
      `Cliente: ${clientType === 'moral' ? 'Persona moral (empresa)' : 'Persona física'}`,
      `Forma de pago: ${current.payment_method}`,
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
        body: JSON.stringify({ ...d, service: current.service, vehicle: current.vehicle, km: current.km, estimate: current.estimate, client_type: clientType, total: current.total, list_price: current.list_price, payment_method: current.payment_method }),
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

  // ---------- ¿Cuánto pagaré? (importe cotizado sin impuestos → total) ----------
  const pay = { service: 'flete', client: 'fisica' };
  function payBreakdown(subtotal) {
    const t = P.taxes;
    const rule = t.rules[pay.client];
    const lines = [];
    if (rule.iva) lines.push({ label: `IVA ${t.iva}%`, amount: round2((subtotal * t.iva) / 100) });
    if (rule.ret_iva && t.ret_iva_services.includes(pay.service)) lines.push({ label: `Retención de IVA ${t.ret_iva}%`, amount: -round2((subtotal * t.ret_iva) / 100), info: true });
    if (rule.ret_isr) lines.push({ label: `Retención de ISR ${t.ret_isr}%`, amount: -round2((subtotal * t.ret_isr) / 100), info: true });
    return { lines, total: round2(subtotal + lines.filter((l) => !l.info).reduce((sum, l) => sum + l.amount, 0)) };
  }
  function renderPay() {
    for (const [id, key] of [['pay-svc', 'service'], ['pay-client', 'client']]) {
      [...$(id).children].forEach((b) => b.classList.toggle('active', b.dataset.v === pay[key]));
    }
    const amount = Number($('pay-amount').value);
    const box = $('pay-result');
    if (!$('pay-amount').value || !(amount > 0)) {
      box.innerHTML = '<div class="est-empty">Escribe el importe de tu cotización para ver el total a pagar.</div>';
      return;
    }
    const subtotal = round2(amount);
    const b = payBreakdown(subtotal);
    const retentions = b.lines.filter((l) => l.info);
    const withheld = -retentions.reduce((sum, l) => sum + l.amount, 0);
    box.innerHTML = `
      <table class="est-table">
        <tr><td>Importe sin impuestos</td><td>${money2(subtotal)}</td></tr>
        ${b.lines.filter((l) => !l.info).map((l) => `<tr><td>${esc(l.label)}</td><td>${money2(l.amount)}</td></tr>`).join('')}
        <tr class="grand"><td>Total a pagar</td><td>${money2(b.total)} <small>MXN</small></td></tr>
      </table>
      ${
        retentions.length
          ? `<div class="est-detail">Tu factura será por ${money2(b.total)} (importe + IVA). Por ley, tu empresa entera directamente al SAT ${money2(withheld)} de retenciones (${retentions.map((l) => esc(l.label)).join(' y ')}); no se suman a lo que se cobra.</div>`
          : ''
      }`;
  }
  for (const [id, key] of [['pay-svc', 'service'], ['pay-client', 'client']]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      pay[key] = b.dataset.v;
      renderPay();
    });
  }
  $('pay-amount').addEventListener('input', renderPay);
  renderPay();
})();
