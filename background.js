// Service worker: Email Finder automatico + abrir/fechar painel pelo icone.
// Recebe {key, site} do content script conforme os leads chegam, visita a home
// e ate 3 paginas de contato de cada site, extrai e-mails, Instagram e Facebook
// e devolve por chrome.tabs.sendMessage. Fila unica, 3 sites em paralelo.
const CONCURRENCY = 3;
const TIMEOUT_MS = 12000;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|sentry|wixpress|example\.|domain\.com|email\.com|yourdomain|@2x|schema\.org|w3\.org|godaddy/i;
const CONTACT_LINK = /contat|contact|fale|atendimento|sobre|about|quem-somos|equipe|team/i;
// Plataformas de link/cardapio: o HTML traz os contatos DA PLATAFORMA, nao do negocio.
const PLATFORM_HOST = /linktr\.ee|linktree|beacons\.ai|bio\.link|taplink|lnk\.bio|wa\.link|accon\.ai|ifood|goomer|anota\.ai|cardapioweb|menudino|instabio|allmylinks|campsite\.bio|solo\.to|carrd\.co/i;
const PLATFORM_BRAND = /linktr|linktree|beacons|taplink|lnkbio|accon|ifood|goomer|anota|cardapioweb|menudino|instabio|allmylinks|campsite|carrd/i;

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'Accept': 'text/html,*/*' } });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !/html|text|xml/i.test(ct)) return '';
    return await res.text();
  } finally { clearTimeout(t); }
}

// Segue um redirect feito por JS ou meta refresh em pagina-casca
function shellRedirect(html, base) {
  if (!html || html.length > 3000) return '';
  const m = html.match(/location(?:\.href)?\s*=\s*["']([^"']+)["']/i) || html.match(/http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i);
  if (!m) return '';
  try { return new URL(m[1], base).href; } catch { return ''; }
}

function extract(html, base) {
  const emails = new Set();
  const decoded = html.replace(/&#64;|%40/g, '@').replace(/\[at\]|\(at\)/gi, '@');
  for (const m of decoded.match(EMAIL_RE) || []) {
    const e = m.toLowerCase();
    if (!BAD_EMAIL.test(e) && e.length < 80) emails.add(e);
  }
  const mailto = [...decoded.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => m[1].toLowerCase()).filter((e) => EMAIL_RE.test(e) && !BAD_EMAIL.test(e));
  let ordered = [...new Set([...mailto, ...emails])];

  let host = '';
  try { host = new URL(base).hostname; } catch { /* ignore */ }
  if (PLATFORM_HOST.test(host)) {
    const root = host.split('.').slice(-2).join('.');
    ordered = ordered.filter((e) => !e.endsWith('@' + root) && !PLATFORM_BRAND.test(e.split('@')[1] || ''));
  }

  const pickAll = (re) => [...html.matchAll(re)].map((m) => m[0].replace(/["'\\]/g, ''));
  const notBrand = (u) => !PLATFORM_BRAND.test((u.split('.com/')[1] || ''));
  const instagram = (pickAll(/https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore\/|accounts\/)[A-Za-z0-9_.]{2,40}\/?(?![\w/])/gi).filter(notBrand)[0] || '');
  const facebook = (pickAll(/https?:\/\/(?:www\.|m\.)?facebook\.com\/(?!sharer|share|plugins|tr\b|dialog)[A-Za-z0-9_.\-]{2,60}\/?/gi).filter(notBrand)[0] || '');

  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = m[1];
    if (!CONTACT_LINK.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.origin === new URL(base).origin && !/\.(pdf|jpg|png)$/i.test(u.pathname)) links.add(u.href);
    } catch { /* ignore */ }
    if (links.size >= 3) break;
  }
  return { emails: ordered, instagram, facebook, links: [...links] };
}

async function processSite(site) {
  let url = site;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let home = await fetchText(url);
  const jump = shellRedirect(home, url);
  if (jump) { url = jump; home = await fetchText(url); }
  if (!home) return { emails: [], error: 'sem resposta' };
  const r = extract(home, url);
  const emails = new Set(r.emails);
  let instagram = r.instagram, facebook = r.facebook;
  if (!emails.size) {
    for (const l of r.links) {
      const html = await fetchText(l).catch(() => '');
      if (!html) continue;
      const rr = extract(html, l);
      rr.emails.forEach((e) => emails.add(e));
      instagram = instagram || rr.instagram; facebook = facebook || rr.facebook;
      if (emails.size) break;
    }
  }
  return { emails: [...emails].slice(0, 5), instagram, facebook };
}

// Fila unica
const queue = [];
const queued = new Set();
let active = 0;

function enqueue(items, tabId) {
  for (const it of items || []) {
    if (!it || !it.key || !it.site || queued.has(it.key)) continue;
    queued.add(it.key);
    queue.push({ ...it, tabId });
  }
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const it = queue.shift();
    active++;
    (async () => {
      let result;
      try { result = await processSite(it.site); }
      catch (e) { result = { emails: [], error: String(e && e.message || e) }; }
      queued.delete(it.key);
      chrome.tabs.sendMessage(it.tabId, { type: 'emailResult', key: it.key, ...result }).catch(() => {});
    })().finally(() => { active--; pump(); });
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'findEmails' && sender.tab) enqueue(msg.items, sender.tab.id);
  if (msg.type === 'clearEmails') { queue.length = 0; queued.clear(); }
});

// Clique no icone da extensao: abre/fecha o painel flutuante na aba do Maps.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' }).catch(() => {});
});
