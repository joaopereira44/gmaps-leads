// Content script (isolated world). Recebe o JSON bruto do /search?tbm=map via
// hook.js (postMessage) ou pelo plano B (refetch da URL vista em
// PerformanceObserver), parseia os negocios, deduplica por place_id, persiste em
// chrome.storage.local, dispara o Email Finder e desenha o painel flutuante
// (escondido por padrao, abre/fecha pelo icone da extensao).
(() => {
  const STORAGE_KEY = 'gmapsLeads';
  const SETTINGS_KEY = 'gmapsLeadsSettings';
  const EVENT = 'gmaps-leads:search';
  const VERSION = chrome.runtime.getManifest().version;

  /** @type {Map<string, object>} */
  const leads = new Map();
  // capturing: desligado por padrao; quando ligado, persiste ate o usuario pausar.
  let settings = { capturing: false, panelVisible: false, started: false };

  // ---------- util ----------
  const g = (o, ...path) => {
    let cur = o;
    for (const k of path) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  };
  const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
  const queryFromUrl = () => {
    const m = location.pathname.match(/\/maps\/search\/([^/]+)/);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  };

  // ---------- parser ----------
  // Estrutura (set/2026): lista de resultados em d[64]; cada item e [meta, place];
  // place[11] = nome. Fallback para o formato antigo: d[0][1][i][14].
  function extractPlaces(d) {
    const out = [];
    const l64 = Array.isArray(d[64]) ? d[64] : [];
    for (const it of l64) {
      const p = g(it, 1);
      if (Array.isArray(p) && typeof p[11] === 'string') out.push(p);
    }
    if (!out.length) {
      const l = g(d, 0, 1);
      if (Array.isArray(l)) for (const it of l) {
        const p = g(it, 14);
        if (Array.isArray(p) && typeof p[11] === 'string') out.push(p);
      }
    }
    return out;
  }

  function toLead(p, busca) {
    // p[178] = [[exibicao, [[formatado,1],[internacional,2]], null, digitos, ...]]
    const phones = g(p, 178, 0, 1) || [];
    const intl = (phones.find((x) => Array.isArray(x) && x[1] === 2) || [])[0];
    const addr = g(p, 183, 1) || [];
    const placeId = clean(p[78]);
    const id10 = clean(p[10]);
    const key = placeId || id10 || clean(p[11]) + '|' + clean(p[39]);
    const site = clean(g(p, 7, 0));
    const siteIsIg = /instagram\.com\//i.test(site);
    const siteIsFb = /facebook\.com\//i.test(site);
    return {
      key,
      nome: clean(p[11]),
      categorias: Array.isArray(p[13]) ? p[13].map(clean).filter(Boolean).join(' | ') : '',
      telefone: clean(intl) || clean(g(p, 178, 0, 0)),
      email: '',
      instagram: siteIsIg ? site.split('?')[0] : '',
      facebook: siteIsFb ? site.split('?')[0] : '',
      site,
      nota: p[4] && p[4][7] != null ? p[4][7] : '',
      avaliacoes: p[4] && p[4][8] != null ? p[4][8] : '',
      reivindicado: g(p, 57, 2) ? 'sim' : 'nao',
      endereco: clean(p[39]),
      bairro: clean(addr[0]),
      cidade: clean(addr[3]),
      estado: clean(addr[5]),
      maps_url: placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : '',
      busca,
      // interno, nao exporta
      email_status: siteIsIg || siteIsFb ? 'pulado' : '',
    };
  }

  function parseSearch(body) {
    let txt = body.trim();
    // Formato B (pan/zoom): {"c":0,"d":")]}'\n[...]"}/*""*/  possivelmente varios chunks
    if (txt.startsWith('{')) {
      const docs = [];
      for (const part of txt.split(/\/\*""\*\//)) {
        const s = part.trim();
        if (!s) continue;
        let env;
        try { env = JSON.parse(s); }
        catch { try { env = JSON.parse(s.slice(0, s.lastIndexOf('}') + 1)); } catch { continue; } }
        if (env && typeof env.d === 'string') docs.push(env.d);
      }
      if (!docs.length) throw new Error('envelope sem campo d');
      const out = [];
      for (const doc of docs) {
        try { out.push(...extractPlaces(JSON.parse(doc.replace(/^\)\]\}'\n?/, '')))); } catch { /* chunk ruim */ }
      }
      return out;
    }
    // Formato A (carregamento inicial): )]}'\n[...]
    return extractPlaces(JSON.parse(txt.replace(/^\)\]\}'\n?/, '')));
  }

  // ---------- estado ----------
  // Decisao de JP (2026-09-16): nada sobrevive a F5. Leads e estado ficam so em
  // memoria; a lista acumula enquanto voce pesquisa e move o mapa na mesma aba
  // (o Maps e SPA, trocar a busca nao recarrega a pagina).
  function save() { /* sem persistencia */ }
  function saveSettings() { /* sem persistencia */ }
  async function load() {
    // limpa o que versoes anteriores gravaram e cancela fila de e-mails de sessao antiga
    try { await chrome.storage.local.remove([STORAGE_KEY, SETTINGS_KEY]); } catch { /* ignore */ }
    chrome.runtime.sendMessage({ type: 'clearEmails' }).catch(() => {});
  }

  // ---------- captura ----------
  const seenUrls = new Set();
  const seenN = new Set();

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m.__gml !== EVENT) return;
    if (seenN.has(m.n)) return;
    seenN.add(m.n);
    processBody(m.url, m.body);
  });

  function processBody(url, body) {
    if (!settings.capturing) return;
    let places;
    try { places = parseSearch(body || ''); }
    catch (e) { console.warn('[GMaps Leads] parse falhou', e); return; }
    // so marca a URL como atendida se o corpo parseou: corpo parcial deixa o plano B refazer
    if (url) seenUrls.add(url);
    const busca = queryFromUrl();
    const novos = [];
    for (const p of places) {
      const lead = toLead(p, busca);
      if (!lead.nome) continue;
      if (leads.has(lead.key)) {
        const old = leads.get(lead.key);
        for (const k of Object.keys(lead)) if (!old[k] && lead[k]) old[k] = lead[k];
      } else {
        leads.set(lead.key, lead);
        novos.push(lead);
      }
    }
    if (novos.length) { save(); enqueueEmails(novos); flash(`+${novos.length} nesta area`); }
    render();
  }

  // Plano B: se o hook nao entregar em 0,5 s, refaz o GET da mesma URL (mesma
  // origem, cookies vao junto). So roda com a captura ligada.
  const isSearchUrl = (u) => typeof u === 'string' && u.includes('/search?') && u.includes('tbm=map');
  async function refetch(url) {
    if (seenUrls.has(url) || !settings.capturing) return;
    seenUrls.add(url);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) processBody(null, await res.text());
    } catch (e) { console.warn('[GMaps Leads] plano B falhou', e); }
  }
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!isSearchUrl(e.name)) continue;
        const url = e.name;
        setTimeout(() => { if (!seenUrls.has(url)) refetch(url); }, 500);
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) { console.warn('[GMaps Leads] PerformanceObserver indisponivel', e); }

  // ---------- "Atualizar resultados ao mover o mapa" (so com captura ligada) ----------
  function ensureAutoRefresh() {
    if (!settings.capturing) return;
    const btn = [...document.querySelectorAll('button[role="checkbox"]')]
      .find((b) => /atualizar resultados|update results|search as i move/i.test((b.closest('label') || b.parentElement || b).innerText || ''));
    if (btn && btn.getAttribute('aria-checked') !== 'true') btn.click();
  }
  let arTimer = null;
  const ensureAutoRefreshDebounced = () => { clearTimeout(arTimer); arTimer = setTimeout(ensureAutoRefresh, 800); };
  new MutationObserver(() => { if (settings.capturing) ensureAutoRefreshDebounced(); })
    .observe(document.documentElement, { childList: true, subtree: true });

  // ---------- export ----------
  const COLS = ['nome','categorias','telefone','email','instagram','facebook','site','nota','avaliacoes','reivindicado','endereco','bairro','cidade','estado','maps_url','busca'];
  const rows = () => [...leads.values()].map((l) => Object.fromEntries(COLS.map((c) => [c, l[c] == null ? '' : l[c]])));
  const fileBase = () => `leads-${(queryFromUrl() || 'maps').replace(/[^\w\-]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}`;
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function exportCsv() {
    const rs = rows();
    if (!rs.length) return flash('nada para exportar');
    const esc = (v) => { const s = String(v); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [COLS.join(';'), ...rs.map((r) => COLS.map((c) => esc(r[c])).join(';'))];
    download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), fileBase() + '.csv');
    flash(`CSV com ${rs.length} empresas`);
  }
  function exportXlsx() {
    const rs = rows();
    if (!rs.length) return flash('nada para exportar');
    if (typeof XLSX === 'undefined') { flash('XLSX indisponivel, exportando CSV'); return exportCsv(); }
    const ws = XLSX.utils.json_to_sheet(rs, { header: COLS });
    ws['!cols'] = COLS.map((c) => ({ wch: Math.min(60, Math.max(c.length + 2, ...rs.slice(0, 200).map((r) => String(r[c]).length + 2))) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileBase() + '.xlsx');
    flash(`XLSX com ${rs.length} empresas`);
  }

  // ---------- Email Finder (automatico) ----------
  // email_status: '' -> 'fila' -> 'ok' | 'sem email' | 'erro' | 'pulado'
  function enqueueEmails(list) {
    const pend = list.filter((l) => l.site && !l.email_status);
    if (!pend.length) return;
    pend.forEach((l) => { l.email_status = 'fila'; });
    save();
    chrome.runtime.sendMessage({ type: 'findEmails', items: pend.map((l) => ({ key: l.key, site: l.site })) }).catch(() => {});
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'togglePanel') { settings.panelVisible = !settings.panelVisible; saveSettings(); render(); }
    if (msg.type === 'emailResult') {
      const l = leads.get(msg.key);
      if (l) {
        l.email = (msg.emails || []).join(' | ');
        l.instagram = l.instagram || msg.instagram || '';
        l.facebook = l.facebook || msg.facebook || '';
        l.email_status = msg.error ? 'erro' : (msg.emails && msg.emails.length ? 'ok' : 'sem email');
        save();
      }
      render();
    }
  });

  // ---------- acoes ----------
  function toggleCapture() {
    settings.capturing = !settings.capturing;
    if (settings.capturing) settings.started = true;
    saveSettings(); render(); ensureAutoRefresh();
    flash(settings.capturing ? 'mova o mapa para capturar' : 'pausado');
  }
  // Reiniciar so zera. Quem liga e o Iniciar.
  function restart() {
    if (leads.size && !confirm(`Reiniciar apaga as ${leads.size} empresas da lista. Exporte antes se precisar.\n\nZerar?`)) return;
    leads.clear(); seenUrls.clear();
    chrome.runtime.sendMessage({ type: 'clearEmails' }).catch(() => {});
    settings.capturing = false; settings.started = false;
    render();
    flash('lista zerada');
  }

  // ---------- painel ----------
  const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.1 7-12a7 7 0 1 0-14 0c0 4.9 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
  const ICON_RESTART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="M6 10l6 6 6-6"/><path d="M4 20h16"/></svg>';

  let panel, flashTimer;
  function flash(txt) {
    const el = panel && panel.querySelector('.gml-flash');
    if (!el) return;
    el.textContent = txt;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.textContent = ''; }, 2500);
  }
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'gml-panel';
    panel.innerHTML = `
      <div class="gml-head">${ICON_PIN}<span class="gml-title">GMaps Leads</span><button class="gml-close" title="fechar (reabre pelo icone da extensao)">×</button></div>
      <div class="gml-body">
        <div class="gml-count">0</div>
        <div class="gml-count-label">empresas encontradas</div>
        <div class="gml-status"><span class="gml-dot"></span><span class="gml-status-text"></span></div>
        <div class="gml-sub"></div>
        <button class="gml-primary"></button>
        <div class="gml-row">
          <button class="gml-restart">${ICON_RESTART}Reiniciar</button>
          <button class="gml-export">${ICON_DOWN}<span class="gml-export-label">Exportar</span><span class="gml-caret">▾</span></button>
          <div class="gml-menu">
            <button class="gml-xlsx">Exportar XLSX <small>Excel</small></button>
            <button class="gml-csv">Exportar CSV <small>texto</small></button>
          </div>
        </div>
        <div class="gml-flash"></div>
        <div class="gml-foot">GMaps Leads · v${VERSION}</div>
      </div>`;
    document.body.appendChild(panel);
    const $ = (s) => panel.querySelector(s);
    $('.gml-close').onclick = () => { settings.panelVisible = false; saveSettings(); render(); };
    $('.gml-primary').onclick = toggleCapture;
    $('.gml-restart').onclick = restart;
    const menu = $('.gml-menu');
    $('.gml-export').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('gml-open'); };
    $('.gml-xlsx').onclick = () => { menu.classList.remove('gml-open'); exportXlsx(); };
    $('.gml-csv').onclick = () => { menu.classList.remove('gml-open'); exportCsv(); };
    document.addEventListener('click', () => menu.classList.remove('gml-open'));

    // arrastar pelo cabecalho
    const head = $('.gml-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
      panel.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });
  }

  function render() {
    if (!panel) return;
    panel.classList.toggle('gml-hidden', !settings.panelVisible);
    const $ = (s) => panel.querySelector(s);
    const n = leads.size;
    $('.gml-count').textContent = n;
    $('.gml-count-label').textContent = n === 1 ? 'empresa encontrada' : 'empresas encontradas';

    const st = $('.gml-status');
    const txt = $('.gml-status-text');
    if (settings.capturing) { st.className = 'gml-status gml-on'; txt.textContent = 'Capturando... mova o mapa'; }
    else if (settings.started && n) { st.className = 'gml-status gml-paused'; txt.textContent = 'Pausado'; }
    else { st.className = 'gml-status'; txt.textContent = 'Pronto para comecar'; }

    const all = [...leads.values()];
    const comSite = all.filter((l) => l.site && l.email_status !== 'pulado').length;
    const fila = all.filter((l) => l.email_status === 'fila').length;
    const comEmail = all.filter((l) => l.email).length;
    $('.gml-sub').textContent = !n ? 'Pesquise algo no Maps e clique em Iniciar'
      : fila ? `Buscando e-mails: ${comSite - fila}/${comSite} sites visitados`
      : comSite ? `E-mails encontrados: ${comEmail} de ${comSite} sites`
      : 'Nenhum site para buscar e-mail';

    const pb = $('.gml-primary');
    pb.innerHTML = settings.capturing ? `${ICON_PAUSE}Pausar` : `${ICON_PLAY}Iniciar`;
    pb.classList.toggle('gml-pause', !!settings.capturing);
    $('.gml-export').disabled = !n;
    $('.gml-restart').disabled = !n;
  }

  // ---------- boot ----------
  load().then(() => {
    buildPanel();
    render();
    console.log(`[GMaps Leads v${VERSION}] pronto, captura desligada`);
  });
})();
