// Roda no MAIN world da pagina do Maps, antes de qualquer script do Google.
// Intercepta as respostas do endpoint interno /search?tbm=map (disparado a cada
// busca, pan ou zoom) e repassa o corpo bruto para o content script por
// postMessage (structured clone garantido entre mundos).
//
// O Maps consome essas respostas em streaming e o XHR nunca chega ao loadend
// (diagnostico de 2026-09-16). Cada chunk termina em /*""*/ ; quando o texto
// parcial do readyState 3 termina assim, o chunk esta completo e emitimos.
(function () {
  const EVENT = 'gmaps-leads:search';
  const isSearch = (u) => typeof u === 'string' && u.includes('/search?') && u.includes('tbm=map');
  let n = 0;

  function emit(url, body) {
    try { window.postMessage({ __gml: EVENT, url, body, n: ++n }, location.origin); }
    catch (e) { /* nunca quebrar o Maps */ }
  }

  // Le o corpo independente do responseType (text, '', json, arraybuffer, blob)
  function bodyOf(xhr, cb) {
    try {
      const rt = xhr.responseType;
      if (rt === '' || rt === 'text') return cb(xhr.responseText);
      const r = xhr.response;
      if (typeof r === 'string') return cb(r);
      if (r instanceof ArrayBuffer) return cb(new TextDecoder('utf-8').decode(r));
      if (r instanceof Blob) return r.text().then(cb);
      if (r && typeof r === 'object') return cb(JSON.stringify(r));
    } catch (e) { /* silencio */ }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const u = String(url);
      if (isSearch(u)) {
        let emitted = false;
        this.addEventListener('readystatechange', function () {
          if (this.readyState !== 3 || emitted) return;
          try {
            if (this.responseType !== '' && this.responseType !== 'text') return;
            const partial = this.responseText;
            if (/\/\*""\*\/\s*$/.test(partial)) { emitted = true; emit(this.responseURL || u, partial); }
          } catch (e) { /* silencio */ }
        });
        this.addEventListener('loadend', function () {
          if (emitted || this.status !== 200) return;
          bodyOf(this, (t) => { if (t) { emitted = true; emit(this.responseURL || u, t); } });
        });
      }
    } catch (e) { /* silencio */ }
    return origOpen.apply(this, arguments);
  };

  // fetch, caso o Maps mude de transporte
  const origFetch = window.fetch;
  window.fetch = function (input) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || ''); } catch (e) { /* silencio */ }
    const p = origFetch.apply(this, arguments);
    if (isSearch(url)) {
      p.then((res) => { if (res.ok) res.clone().text().then((t) => emit(res.url || url, t)).catch(() => {}); }).catch(() => {});
    }
    return p;
  };
})();
