/* ============================================
   Axolotl Pro — main script
   ============================================ */

/* ===== Config (single place for timeouts & limits) ===== */
const DEFAULT_PROXY = "https://tardigrade-proxy.arina-livanenkova.workers.dev/";
const PROXY_TIMEOUT_MS = 25000;       // timeout for main proxy link check
const FALLBACK_TIMEOUT_MS = 15000;   // timeout for fallback proxy / title fetch
const CONCURRENT_REQUESTS = 4;       // max parallel requests to proxy
const MAX_TITLE_FETCHES = 15;        // max extra requests for page titles when proxy didn't return one
const COPY_TIP_DURATION_MS = 1200;   // how long "Copied!" / "Copy failed" tooltip is shown

/* ===== DOM utils ===== */
const el = (s) => document.querySelector(s);

const progress = (n) => {
  const bar = el('#progressBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, n)) + '%';
  const pr = el('.progress');
  if (pr) pr.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, n))));
};

function updateProgressLabel(text) {
  const label = el('#progressLabel');
  if (label) label.textContent = text || 'Processing progress';
}

const escapeHtml = (s = '') =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hostnameOf = (u) => { try { return new URL(u).hostname } catch { return '' } };

const UTM = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id']);

function getQueryParam(name){
  try { return new URLSearchParams(location.search).get(name) || ''; }
  catch { return ''; }
}
function isHttpUrl(u){
  try { const x = new URL(u); return /^https?:$/.test(x.protocol); }
  catch { return false; }
}
function getProxyUrl(){
  const q = (getQueryParam('proxy') || '').trim();
  if (q && isHttpUrl(q)) return q.replace(/\/+$/, '') + '/'; // ensure trailing slash
  return DEFAULT_PROXY;
}

function updateCodeBox(id, content) {
  const elBox = document.getElementById(id);
  if (!elBox) return;
  elBox.textContent = content || '';
  if (content && content.trim() !== '') {
    elBox.classList.add('filled');
  } else {
    elBox.classList.remove('filled');
  }
}

function normalizeUrl(raw, baseUrl, stripUtm = true){
  try{
    const u = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    u.hash = '';
    if (stripUtm){
      for (const k of [...u.searchParams.keys()]) {
        if (UTM.has(k)) u.searchParams.delete(k);
      }
    }
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
    return u.toString();
  }catch{ return null }
}
function isExternal(url, baseHostname){
  if (!baseHostname) return true;
  try { return new URL(url).hostname !== baseHostname } catch { return true }
}

async function pLimit(n, tasks){
  const out = []; let i = 0, active = 0;
  return await new Promise(res => {
    const next = () => {
      while(active < n && i < tasks.length){
        const fn = tasks[i++]; active++;
        fn().then(v => out.push(v)).catch(err => {
          console.warn('Link check request failed:', err);
        })
          .finally(() => { active--; if (i >= tasks.length && active === 0) res(out); else next(); });
      }
    };
    next();
  });
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

/* ===== Core: parse links ===== */
function extractLinksFromHtml(html, opts = {}){
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  if (opts.fixTwitter){
    doc.querySelectorAll('a[href*="x.com"]').forEach(a => { a.href = a.href.replace('x.com', 'twitter.com'); });
  }

  const baseUrl  = (opts.baseUrl || '').trim() || (typeof location !== 'undefined' ? location.origin : undefined);
  const baseHost = baseUrl ? new URL(baseUrl).hostname : undefined;

  const anchors = [...doc.querySelectorAll('a[href]')];
  const all = [];
  for (const a of anchors){
    const href = a.getAttribute('href'); if (!href) continue;
    const norm = normalizeUrl(href, baseUrl, opts.stripUtm !== false); if (!norm) continue;
    if (opts.externalOnly && !isExternal(norm, baseHost)) continue;
    const host = hostnameOf(norm);
    if (opts.exclude?.length && opts.exclude.some(x => host === x || host.endsWith('.' + x))) continue;
    all.push(norm);
  }
  const counts = new Map(); for (const u of all) counts.set(u, (counts.get(u) || 0) + 1);
  const unique = [...counts.keys()];
  return { counts, unique };
}

/* ===== Core: build References HTML ===== */
function buildReferencesHtml(items){
  const lines = items.map(it => {
    const label = escapeHtml(it.title || it.url);
    const url   = escapeHtml(it.finalUrl || it.url);
    const host  = escapeHtml(it.hostname || '');
    return `<li><a href="${url}" rel="nofollow noopener" target="_blank">${label}</a> (${host})</li>`;
  }).join('\n');
  return `\n[reference_content]\n<div class="reference-heading"><h2>References</h2></div>\n<div class="reference-body">\n  <ol>\n${lines}\n  </ol>\n</div>\n[/reference_content]\n`;
}

/* ===== Core: fetch status/title via proxy ===== */
async function enrichReferences(urls, { proxyUrl }){
  const proxy = (proxyUrl || '').trim() || DEFAULT_PROXY;

  const tasks = urls.map(u => async () => {
    const item = { url: u, hostname: hostnameOf(u), status: undefined, finalUrl: u, title: undefined };
    try{
      const r = await withTimeout(fetch(`${proxy}?url=${encodeURIComponent(u)}`), PROXY_TIMEOUT_MS);
      if (!r.ok){ item.status = r.status; return item; }
      const j = await r.json();
      item.status   = j.status ?? undefined;
      item.finalUrl = j.finalUrl || u;
      item.title    = j.title || j.ogTitle || j.h1 || undefined;
    }catch{
      item.status = 0; // network/timeout
    }
    return item;
  });

  const res = await pLimit(CONCURRENT_REQUESTS, tasks);
  const order = new Map(urls.map((u,i) => [u,i]));
  return res.sort((a,b) => order.get(a.url) - order.get(b.url));
}

/* ===== HTML Cleaner ===== */
function cleanHtml(html, opts = {}){
  const options = {
    unwrapTags: ['p','span'],
    removeInlineStyles: true,
    convertBToStrong: true,
    removeEmptyHeadings: true,
    normalizeNbsp: true,
    cleanAria: true,
    ...opts
  };

  const stats = {
    unwrapped: 0, removedStyles: 0, boldToStrong: 0, emptyHeadings: 0, ariaFixed: 0, nbspReplaced: 0
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  if (options.unwrapTags?.length){
    const sel = options.unwrapTags.join(',');
    doc.querySelectorAll(sel).forEach(node => {
      const parent = node.parentNode; if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
      stats.unwrapped++;
    });
  }

  if (options.removeInlineStyles){
    doc.querySelectorAll('[style]').forEach(elm => { elm.removeAttribute('style'); stats.removedStyles++; });
  }

  if (options.convertBToStrong){
    doc.querySelectorAll('b').forEach(b => {
      const strong = doc.createElement('strong');
      while (b.firstChild) strong.appendChild(b.firstChild);
      b.replaceWith(strong);
      stats.boldToStrong++;
    });
  }

  if (options.removeEmptyHeadings){
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      if (!h.textContent || !h.textContent.trim()){ h.remove(); stats.emptyHeadings++; }
    });
  }

  if (options.cleanAria){
    doc.querySelectorAll('ul[aria-label], ol[aria-label]').forEach(list => { list.removeAttribute('aria-label'); stats.ariaFixed++; });
    doc.querySelectorAll('li[aria-level]').forEach(li => { li.removeAttribute('aria-level'); stats.ariaFixed++; });
  }

  if (options.normalizeNbsp){
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())){
      const replaced = n.nodeValue.replace(/\u00A0/g, ' ');
      if (replaced !== n.nodeValue){ n.nodeValue = replaced; stats.nbspReplaced++; }
    }
    const before = doc.body.innerHTML;
    const after  = before.replace(/&nbsp;/g, ' ');
    if (after !== before){ doc.body.innerHTML = after; stats.nbspReplaced++; }
  }

  const cleaned = doc.body.innerHTML;
  return { html: cleaned, changed: cleaned !== html, stats };
}

/* ===== Headings & Twitter ===== */
(() => {
  const titleBox = el('#fixHeadingsTitleCase');
  const sentBox  = el('#fixHeadingsSentenceCase');
  if (titleBox && sentBox) {
    titleBox.addEventListener('change', () => { if (titleBox.checked) sentBox.checked = false; });
    sentBox.addEventListener('change',  () => { if (sentBox.checked)  titleBox.checked = false; });
  }
})();

function toSentenceCase(s){
  s = (s||'').trim();
  if (!s) return s;
  s = s.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function toTitleCaseAPA(text){
  const minor = new Set(['and','but','for','nor','or','so','yet','a','an','the','as','at','by','in','of','off','on','per','to','up','via']);
  const parts = text.split(/(\s+)/);
  let afterPunct = true;
  return parts.map((w,i) => {
    if (!w.trim()) return w;
    const lw = w.toLowerCase();
    const isFirst = (i===0) || afterPunct;
    afterPunct = /[:—-]\s*$/.test(parts.slice(0,i+1).join(''));
    if (isFirst || lw.length >= 4 || !minor.has(lw)) return lw.charAt(0).toUpperCase()+lw.slice(1);
    return lw;
  }).join('');
}
function fixHeadingsCapitalization(doc, mode){
  const fn = mode === 'sentence' ? toSentenceCase : toTitleCaseAPA;
  doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    const t = (h.textContent||'').trim();
    if (t) h.textContent = fn(t);
  });
}

function replaceTextXtoTwitter(doc){
  if (!doc?.body) return;
  const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = walker.nextNode())){
    if (/https?:\/\/x\.com/gi.test(n.nodeValue)) {
      n.nodeValue = n.nodeValue.replace(/https?:\/\/x\.com/gi,'https://twitter.com');
    }
  }
}

/* ===== Fallback proxy & title fetch ===== */
async function checkLinksFallback(urls){
  const out = [];
  for (const u of urls){
    try{
      const r = await withTimeout(
        fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`),
        FALLBACK_TIMEOUT_MS
      );
      if (r instanceof Error || !r.ok) { out.push({url:u, status: r instanceof Error ? 0 : r.status}); continue; }
      const j = await r.json();
      const http = j?.status?.http_code ?? 200;
      out.push({url:u, status:http});
    }catch{ out.push({url:u, status:0}); }
  }
  return out;
}

async function fetchTitleViaProxy(u){
  try{
    const r = await withTimeout(
      fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`),
      FALLBACK_TIMEOUT_MS
    );
    if (r instanceof Error || !r.ok) return null;
    const html = await r.text();
    const doc  = new DOMParser().parseFromString(html,'text/html');
    return (doc.querySelector('title')?.textContent || doc.querySelector('h1')?.textContent || '').trim() || null;
  }catch{return null}
}

/* ===== Copy to clipboard with feedback ===== */
function showCopyTip(tipEl, success) {
  if (!tipEl) return;
  tipEl.textContent = success ? 'Copied!' : 'Copy failed';
  tipEl.classList.add('show');
  setTimeout(() => { tipEl.classList.remove('show'); tipEl.textContent = 'Copied!'; }, COPY_TIP_DURATION_MS);
}

function copyToClipboard(text, tipEl) {
  if (!text) { showCopyTip(tipEl, false); return; }
  navigator.clipboard.writeText(text).then(
    () => showCopyTip(tipEl, true),
    () => showCopyTip(tipEl, false)
  );
}

/* ===== UI bindings ===== */
(() => {
  el('#runBtn')?.addEventListener('click', run);

  const htmlInput = el('#htmlInput');
  if (htmlInput) {
    htmlInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    htmlInput.focus();
  }

  const copyRefsBtn = el('#copyRefsBtn');
  if (copyRefsBtn){
    copyRefsBtn.addEventListener('click', () => {
      copyToClipboard(el('#refsHtml')?.textContent || '', el('#copyRefsTip'));
    });
  }
  const copyCleanedBtn = el('#copyCleanedBtn');
  if (copyCleanedBtn){
    copyCleanedBtn.addEventListener('click', () => {
      copyToClipboard(el('#cleanedHtml')?.textContent || '', el('#copyCleanedTip'));
    });
  }
})();

/* ===== Main run ===== */
function formatCleanStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.unwrapped) parts.push(`${stats.unwrapped} unwrapped tag(s)`);
  if (stats.removedStyles) parts.push(`${stats.removedStyles} inline style(s) removed`);
  if (stats.boldToStrong) parts.push(`${stats.boldToStrong} <b>→<strong>`);
  if (stats.emptyHeadings) parts.push(`${stats.emptyHeadings} empty heading(s) removed`);
  if (stats.ariaFixed) parts.push(`${stats.ariaFixed} ARIA attribute(s) cleaned`);
  if (stats.nbspReplaced) parts.push(`${stats.nbspReplaced} NBSP normalized`);
  return parts.length ? parts.join(' · ') : '';
}

async function run(){
  const runBtn = el('#runBtn');
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
  }

  const resultsSection = el('#resultsSection');
  if (resultsSection) resultsSection.setAttribute('aria-busy', 'true');
  updateProgressLabel('Processing…');

  try {
  progress(0);
  const linksList     = el('#linksList');
  const dupesList     = el('#dupesList');
  const statusList    = el('#statusList');
  const copyRefsBtn   = el('#copyRefsBtn');
  const copyCleanedBtn = el('#copyCleanedBtn');
  const cleanStatsEl  = el('#cleanStats');
  if (linksList)    linksList.innerHTML = '';
  if (dupesList)    dupesList.innerHTML = '';
  if (statusList)   statusList.innerHTML = '';
  if (cleanStatsEl) cleanStatsEl.textContent = '';
  if (copyRefsBtn)  copyRefsBtn.disabled = true;
  if (copyCleanedBtn) copyCleanedBtn.disabled = true;
  updateCodeBox('refsHtml','');
  updateCodeBox('cleanedHtml','');

  const rawInput = (el('#htmlInput')?.value || '').trim();
  if (!rawInput) {
    if (statusList) statusList.innerHTML = '<p class="muted" style="margin:0;padding:12px">Paste HTML content first, then click Start.</p>';
    return;
  }
  const useClean = el('#cleanHtml')?.checked ?? true;
  const opts = {
    externalOnly: el('#externalOnly')?.checked ?? true,
    stripUtm:     el('#stripUtm')?.checked ?? true,
    fixTwitter:   el('#fixTwitter')?.checked ?? false,
    exclude:      (el('#excludeHosts')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    baseUrl:      (el('#baseUrl')?.value || '').trim() || undefined,
  };
  const proxyUrl = getProxyUrl();
  const doCheck  = el('#checkStatus')?.checked ?? true;

  let workingHtml = rawInput;
  if (useClean){
    const { html: cleaned, stats } = cleanHtml(rawInput);
    workingHtml = cleaned;
    updateCodeBox('cleanedHtml', workingHtml);
    const statsText = formatCleanStats(stats);
    if (cleanStatsEl) cleanStatsEl.textContent = statsText ? `Cleanup: ${statsText}` : '';
  }

  if (el('#fixHeadingsTitleCase')?.checked || el('#fixHeadingsSentenceCase')?.checked) {
    const mode = el('#fixHeadingsSentenceCase')?.checked ? 'sentence' : 'title';
    const doc = new DOMParser().parseFromString(workingHtml,'text/html');
    if (doc.body) {
      fixHeadingsCapitalization(doc, mode);
      workingHtml = doc.body.innerHTML;
      updateCodeBox('cleanedHtml', workingHtml);
    }
  }

  const urlRegex = /\bhttps?:\/\/[^\s<>"']+/gi;
  if (!/<a\s/i.test(workingHtml) && urlRegex.test(workingHtml)){
    workingHtml = workingHtml.replace(urlRegex, m => `<a href="${m}">${m}</a>`);
    updateCodeBox('cleanedHtml', workingHtml);
  }

  if (opts.fixTwitter){
    const doc = new DOMParser().parseFromString(workingHtml,'text/html');
    replaceTextXtoTwitter(doc);
    if (doc.body) {
      workingHtml = doc.body.innerHTML;
      updateCodeBox('cleanedHtml', workingHtml);
    }
  }

  const { counts, unique } = extractLinksFromHtml(workingHtml, opts);
  const dupes = [...counts.entries()].filter(([, n]) => n > 1);

  if (linksList){
    linksList.innerHTML = unique.length
      ? unique.map(u => `<div><span class="pill">${escapeHtml(hostnameOf(u))}</span> <a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a></div>`).join('')
      : '<span class="muted">No links found in the pasted HTML.</span>';
  }
  const showDupes = el('#findDuplicates')?.checked ?? true;
  if (dupesList){
    dupesList.innerHTML = !showDupes
      ? '<span class="muted">Disabled in options</span>'
      : dupes.length
        ? dupes.map(([u, n]) => `<div><a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a> — ${n}×</div>`).join('')
        : '<span class="muted">No duplicates</span>';
  }

  progress(20);
  updateProgressLabel('Checking link statuses…');

  let items = unique.map(u => ({ url: u, hostname: hostnameOf(u) }));
  if (doCheck) {
    items = await enrichReferences(unique, { proxyUrl });
    let titleFetches = 0;
    for (const it of items){
      if (!it.title && titleFetches < MAX_TITLE_FETCHES) {
        titleFetches++;
        const t = await fetchTitleViaProxy(it.finalUrl || it.url);
        if (t) it.title = t;
      }
    }
  } else if (el('#check404')?.checked) {
    const fb = await checkLinksFallback(unique);
    const map = new Map(fb.map(x => [x.url, x.status]));
    items = unique.map(u => ({
      url: u,
      hostname: hostnameOf(u),
      status: map.get(u) ?? undefined,
      finalUrl: u
    }));
    let titleFetches = 0;
    for (const it of items){
      if (titleFetches < MAX_TITLE_FETCHES) {
        titleFetches++;
        const t = await fetchTitleViaProxy(it.finalUrl || it.url);
        if (t) it.title = t;
      }
    }
  }

  const groups = { ok: [], redirect: [], client: [], server: [], net: [] };
  for (const it of items){
    const s = Number(it.status || 0);
    if (s === 0) groups.net.push(it);
    else if (s >= 200 && s < 300) groups.ok.push(it);
    else if (s >= 300 && s < 400) groups.redirect.push(it);
    else if (s >= 400 && s < 500) groups.client.push(it);
    else if (s >= 500) groups.server.push(it);
  }

  const total = items.length || 1;
  const percent = (count) => ((count / total * 100).toFixed(0)) + '%';
  const labelOf   = it => (Number(it.status || 0) === 0 ? 'TIMEOUT/NETWORK' : String(it.status));
  const codeClass = s  => { const n = Number(s || 0); if (n === 0) return 'net'; if (n >= 200 && n < 300) return 'ok'; if (n >= 300 && n < 400) return 'redirect'; return 'err'; };

  const line = it => {
    const c = codeClass(it.status);
    const title = it.title ? ` — <span class="muted">${escapeHtml(it.title)}</span>` : '';
    return `<div class="status-item">
      <span class="pill">${escapeHtml(it.hostname || '')}</span>
      <a href="${escapeHtml(it.finalUrl || it.url)}" target="_blank" rel="noopener">${escapeHtml(it.url)}</a>
      — status: <span class="status-code ${c}">${escapeHtml(labelOf(it))}</span>${title}
    </div>`;
  };
  const section = (title, arr, cls, icon) =>
    arr.length
      ? `<div class="status-group ${cls}">
           <div class="status-title">${icon} ${title} — ${arr.length} (${percent(arr.length)})</div>
           ${arr.map(line).join('')}
         </div>`
      : '';

  const totalLinks = items.length;
  const totalDupes = dupes.length;
  const errors     = groups.client.length + groups.server.length + groups.net.length;
  const summary = `<div class="status-summary">
    <strong>Total links:</strong> ${totalLinks} |
    <strong>Unique:</strong> ${unique.length} |
    <strong>Duplicates:</strong> ${totalDupes} |
    <strong>Errors:</strong> ${errors}
  </div>`;

  if (statusList){
    statusList.innerHTML = items.length
      ? summary + `<div class="status-section">
           ${section('OK (2xx)',            groups.ok,       'ok',       '✅')}
           ${section('Redirect (3xx)',      groups.redirect, 'redirect', '↪️')}
           ${section('Client Error (4xx)',  groups.client,   'client',   '❌')}
           ${section('Server Error (5xx)',  groups.server,   'server',   '🛑')}
           ${section('Network/Timeout (0)', groups.net,      'net',      '🌐')}
         </div>`
      : '<span class="muted">No links</span>';
  }

  progress(70);
  updateProgressLabel('Building references…');

  const refs = buildReferencesHtml(items);
  updateCodeBox('refsHtml', refs);
  if (copyRefsBtn) copyRefsBtn.disabled = false;
  const cleanedContent = el('#cleanedHtml')?.textContent?.trim() || '';
  if (copyCleanedBtn) copyCleanedBtn.disabled = !cleanedContent;

  if (el('#appendReferences')?.checked) {
    updateCodeBox('cleanedHtml', (workingHtml + '\n\n' + refs));
  }

  progress(100);
  updateProgressLabel('Done');

  el('#linksHeading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (copyRefsBtn && !copyRefsBtn.disabled) copyRefsBtn.focus();

  } finally {
    if (resultsSection) resultsSection.setAttribute('aria-busy', 'false');
    updateProgressLabel('Processing progress');
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = 'Start';
    }
  }
}
