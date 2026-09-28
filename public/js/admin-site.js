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
