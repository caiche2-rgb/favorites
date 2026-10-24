'use strict';
const TYPES = ['地點', '影片文章', '軟體', '其他'];
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('favorites', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('items', { keyPath: 'id' });
      r.result.createObjectStore('folders', { keyPath: 'id' });
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode);
  const req = fn(t.objectStore(store));
  t.oncomplete = () => res(req && req.result);
  t.onerror = () => rej(t.error);
});
const getAll = s => tx(s, 'readonly', o => o.getAll());
const put = (s, v) => tx(s, 'readwrite', o => o.put(v));
const del = (s, id) => tx(s, 'readwrite', o => o.delete(id));

/* ---------- 設定 ---------- */
const cfg = {
  get key() { return localStorage.getItem('apiKey') || ''; },
  get model() { return localStorage.getItem('model') || 'gpt-4o-mini'; },
};

/* ---------- UI 工具 ---------- */
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
const firstUrl = s => (String(s || '').match(/https?:\/\/[^\s]+/) || [''])[0];

/* ---------- 分類 ---------- */
function ruleClassify(url) {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch { }
  const p = url.toLowerCase();
  if (/youtube\.com|youtu\.be/.test(h)) return '影片文章';
  if (/maps\.google|maps\.app\.goo\.gl|goo\.gl\/maps/.test(p) || (h.includes('google.') && p.includes('/maps'))) return '地點';
  if (/apps\.apple\.com|play\.google\.com|github\.com/.test(h)) return '軟體';
  return '';
}

// 抓得到的公開資訊：目前支援 YouTube（oEmbed，免 key）
async function fetchMeta(url) {
  try {
    if (/youtube\.com|youtu\.be/i.test(new URL(url).hostname)) {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
      if (r.ok) { const j = await r.json(); return `YouTube 影片標題「${j.title}」，頻道「${j.author_name}」`; }
    }
  } catch { }
  return '';
}

const PLACEHOLDERS = ['簡短標題', '一句話摘要', '標籤', '建議收藏夾名稱', '店名', '地址', '城市', '平台', '用途'];
const clean = s => { s = String(s ?? '').trim(); return PLACEHOLDERS.includes(s) ? '' : s; };

async function aiClassify(url, text, folders) {
  const sys = `你是收藏整理助手。根據使用者給的連結與文字內容，整理出一筆收藏，只回傳 JSON 物件。
欄位：type（只能是 地點、影片文章、軟體、其他 之一）、title（用內容寫出的標題，約 20 字內）、summary（用內容寫出的一句話摘要）、
tags（2 到 5 個關鍵字陣列）、folder（建議收藏夾名稱）、place、software。
place 只在 type 是地點時填，是物件，含 name、city、address、lat、lng；software 只在 type 是軟體時填，是物件，含 platform、purpose；不適用就填 null。
規則：
- 全部用繁體中文，title 和 summary 必須是根據實際內容寫的句子，不能是空泛的占位文字。
- 資訊不足以判斷的欄位，填空字串或 null，不要編造；經緯度不確定一律填 null。
- folder 優先從現有收藏夾挑選：${folders.map(f => f.name).join('、') || '（目前沒有）'}；沒有合適的才建議一個新的具體名稱，也可以填空字串。
- IG、TikTok 連結無法讀取，主要依據使用者附的文字判斷。`;
  const ctx = await fetchMeta(url);
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({
      model: cfg.model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `連結：${url || '(無)'}\n${ctx ? '網頁資訊：' + ctx + '\n' : ''}使用者附的文字：${text || '(無)'}` }],
    }),
  });
  if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

/* ---------- 地點 / 地圖 ---------- */
const hasPos = it => it.place && it.place.lat != null && it.place.lng != null;
// 優先用「店名 + 地址」搜尋（Google 地圖會顯示真正的店家頁），沒有才用座標
function gmapsUrl(pl) {
  const q = [pl.name, pl.address].filter(Boolean).join(' ') || (pl.lat != null && pl.lng != null ? pl.lat + ',' + pl.lng : '');
  return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
}
// Google 地圖連結內含座標時直接讀出（短網址 maps.app.goo.gl 讀不到）
function coordsFromUrl(url) {
  const m = String(url).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || String(url).match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || String(url).match(/[?&](?:q|query|ll)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}
// 用 OpenStreetMap 的 Nominatim 把店名／地址轉成座標（免 key，請勿大量呼叫）
async function geocode(pl) {
  const tries = [[pl.name, pl.address], [pl.address], [pl.name]].map(a => a.filter(Boolean).join(' ')).filter((q, i, a) => q && a.indexOf(q) === i);
  for (const q of tries) {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-TW&q=' + encodeURIComponent(q));
    if (!r.ok) continue;
    const j = await r.json();
    if (j[0]) return { lat: +j[0].lat, lng: +j[0].lon };
  }
  return null;
}
let leafletP;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return leafletP || (leafletP = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.append(css);
    const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = res; s.onerror = () => { leafletP = null; rej(new Error('地圖載入失敗，請確認網路')); };
    document.head.append(s);
  }));
}
let mapFolder = '';
async function mapPage(v) {
  $('#title').textContent = '地圖';
  const [items, fs] = await Promise.all([getAll('items'), getAll('folders')]);
  const placed = items.filter(hasPos);
  const unplaced = items.filter(i => i.type === '地點' && !hasPos(i));
  const usable = fs.filter(f => placed.some(i => i.folderId === f.id));
  if (mapFolder && !usable.some(f => f.id === mapFolder)) mapFolder = '';
  v.innerHTML = `<div class="chips"><button data-f="" class="${mapFolder ? '' : 'on'}">全部 (${placed.length})</button>
    ${usable.map(f => `<button data-f="${f.id}" class="${mapFolder === f.id ? 'on' : ''}">${esc(f.name)}</button>`).join('')}</div>
  <div id="map"></div>
  ${placed.length ? '' : '<div class="empty">還沒有有座標的地點。<br>到收藏的詳情頁，按「用店名／地址查座標」。</div>'}
  ${unplaced.length ? `<h3>尚未定位 (${unplaced.length})</h3>${unplaced.map(i => `<a class="card" href="#/item/${i.id}"><b>${esc(i.place?.name || i.title || i.url)}</b><div class="sub">${esc(i.place?.address || '點進去補上地址並查座標')}</div></a>`).join('')}` : ''}`;
  v.querySelectorAll('.chips button').forEach(b => b.onclick = () => { mapFolder = b.dataset.f; mapPage(v); });
  try { await loadLeaflet(); } catch (e) { $('#map').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const map = L.map('map', { zoomControl: true }).setView([23.7, 121], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const pts = [];
  placed.filter(i => !mapFolder || i.folderId === mapFolder).forEach(i => {
    const pos = [i.place.lat, i.place.lng]; pts.push(pos);
    const g = gmapsUrl(i.place);
    L.marker(pos, { icon: L.divIcon({ className: 'pin', html: '📍', iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26] }) })
      .addTo(map).bindPopup(`<b>${esc(i.place.name || i.title)}</b><br>${esc(i.place.address)}<br><span style="color:#666">${esc(i.summary)}</span>
        <div style="margin-top:6px"><a href="#/item/${i.id}">詳情</a>　<a href="${g}" target="_blank" rel="noopener">在 Google 地圖開啟 ↗</a></div>`);
  });
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
}

/* ---------- 縮圖 / 平台圖示 ---------- */
function ytId(url) {
  try {
    const u = new URL(url), h = u.hostname.replace(/^www\.|^m\./, '');
    if (h === 'youtu.be') return u.pathname.slice(1, 12);
    if (h.endsWith('youtube.com')) return u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/) || [])[2] || '';
  } catch { }
  return '';
}
function platform(it) {
  const u = (it.url || '').toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return ['▶', '#e62117'];
  if (/instagram\.com/.test(u)) return ['📷', 'linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)'];
  if (/threads\.(net|com)/.test(u)) return ['@', '#111'];
  if (/tiktok\.com/.test(u)) return ['♪', '#010101'];
  if (/facebook\.com|fb\.watch/.test(u)) return ['f', '#1877f2'];
  if (/x\.com|twitter\.com/.test(u)) return ['𝕏', '#111'];
  if (/github\.com/.test(u)) return ['⌥', '#24292e'];
  if (/apps\.apple\.com|play\.google\.com/.test(u)) return ['📱', '#34a853'];
  if (/maps\.|goo\.gl\/maps/.test(u) || it.type === '地點') return ['📍', '#ea4335'];
  return [{ 影片文章: '🎬', 軟體: '💻' }[it.type] || '🔖', '#6b7280'];
}
function thumbHtml(it) {
  const src = it.thumb || (ytId(it.url) ? `https://i.ytimg.com/vi/${ytId(it.url)}/mqdefault.jpg` : '');
  const [ic, bg] = platform(it);
  return src ? `<img class="th" loading="lazy" src="${esc(src)}" alt="">`
    : `<div class="th ph" style="background:${bg}">${ic}</div>`;
}
// 把選的圖縮成寬 360px 的 JPEG（存在手機本機）
function shrinkImage(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const w = Math.min(360, img.width), h = Math.round(img.height * w / img.width);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => rej(new Error('無法讀取圖片'));
    img.src = url;
  });
}

function blankItem(url = '', text = '') {
  return { id: uid(), url, rawText: text, type: '其他', title: '', summary: '', tags: [], folderId: '', place: { name: '', address: '', lat: null, lng: null }, software: { platform: '', purpose: '' }, note: '', createdAt: Date.now() };
}

/* ---------- 路由 ---------- */
const routes = { '': home, add, folders, settings, map: mapPage, item: detail };
async function route() {
  const [, name = '', arg] = location.hash.replace('#', '').split('/');
  const tab = name === 'item' ? 'home' : (name || 'home');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.t === tab));
  const v = $('#view'); v.innerHTML = '';
  await (routes[name] || home)(v, arg);
  scrollTo(0, 0);
}

/* ---------- 首頁 ---------- */
let shared = null;
let filter = { q: '', type: '' };
async function home(v) {
  $('#title').textContent = '收藏整理';
  const [items, fs] = await Promise.all([getAll('items'), getAll('folders')]);
  const fname = id => (fs.find(f => f.id === id) || {}).name || '';
  v.innerHTML = `<input id="q" type="search" placeholder="搜尋標題、摘要、標籤、筆記…" value="${esc(filter.q)}">
  <div class="chips">${['', ...TYPES].map(t => `<button data-t="${t}" class="${filter.type === t ? 'on' : ''}">${t || '全部'}</button>`).join('')}</div>
  <div id="list"></div>`;
  const draw = () => {
    const q = filter.q.toLowerCase();
    const list = items.filter(i => (!filter.type || i.type === filter.type) &&
      (!q || [i.title, i.summary, i.note, i.url, i.rawText, ...(i.tags || [])].join('\n').toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt - a.createdAt);
    $('#list').innerHTML = list.length ? list.map(i => `<a class="card item" href="#/item/${i.id}">${thumbHtml(i)}
      <div class="body"><h3><span class="badge">${esc(i.type)}</span>${esc(i.title || i.url || '(無標題)')}</h3>
      <div class="sub">${esc(i.summary)}</div>
      <div>${fname(i.folderId) ? `<span class="tag">📁 ${esc(fname(i.folderId))}</span>` : ''}${(i.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div></div></a>`).join('')
      : `<div class="empty">${items.length ? '沒有符合的收藏' : '還沒有收藏，按下方「新增」開始'}</div>`;
  };
  draw();
  $('#q').oninput = e => { filter.q = e.target.value; draw(); };
  v.querySelectorAll('.chips button').forEach(b => b.onclick = () => { filter.type = b.dataset.t; home(v); });
}

/* ---------- 新增 ---------- */
async function add(v) {
  $('#title').textContent = '新增收藏';
  const p = shared || new URLSearchParams();
  shared = null;
  const sharedText = [p.get('title'), p.get('text')].filter(Boolean).join('\n');
  const sharedUrl = p.get('url') || firstUrl(sharedText);
  v.innerHTML = `<label>連結</label><input id="url" type="url" placeholder="https://…" value="${esc(sharedUrl)}">
  <label>貼文文字（選填，IG / TikTok 建議貼上）</label><textarea id="txt">${esc(sharedText.replace(sharedUrl, '').trim())}</textarea>
  <div class="row"><button id="go">分析並分類</button><button id="manual" class="sec">手動填寫</button></div><div id="out"></div>`;
  const folders = await getAll('folders');
  const start = it => { $('#out').innerHTML = ''; formView($('#out'), it, folders, true); };
  $('#manual').onclick = () => start(blankItem($('#url').value.trim(), $('#txt').value.trim()));
  $('#go').onclick = async () => {
    const url = $('#url').value.trim(), text = $('#txt').value.trim();
    if (!url && !text) return toast('請輸入連結或文字');
    if (/instagram\.com|tiktok\.com|threads\.(net|com)|facebook\.com|fb\.watch|x\.com|twitter\.com/i.test(url) && text.length < 10)
      return toast('IG／TikTok 這類連結讀不到內容，請先把貼文文字貼到下面的欄位，再按分析', 6000);
    const it = blankItem(url, text);
    const btn = $('#go'); btn.disabled = true; btn.textContent = '分析中…';
    let aiFolder = '';
    try {
      if (!cfg.key) throw new Error('沒有 API key');
      const a = await aiClassify(url, text, folders);
      it.type = TYPES.includes(a.type) ? a.type : '其他';
      it.title = clean(a.title); it.summary = clean(a.summary);
      it.tags = Array.isArray(a.tags) ? a.tags.map(clean).filter(Boolean) : [];
      if (a.place && it.type === '地點') {
        const pl = a.place, n = x => (x == null || x === '' || isNaN(+x)) ? null : +x;
        const addr = clean(pl.address), city = clean(pl.city);
        it.place = { name: clean(pl.name), address: city && !addr.includes(city) ? city + addr : addr, lat: n(pl.lat), lng: n(pl.lng) };
      }
      if (a.software && it.type === '軟體') it.software = { platform: clean(a.software.platform), purpose: clean(a.software.purpose) };
      aiFolder = clean(a.folder);
    } catch (e) {
      it.type = ruleClassify(url) || '其他';
      it.title = url;
      toast('AI 未使用（' + (cfg.key ? '呼叫失敗：' + e.message : '無 key') + '），改用網址規則' + (it.type === '其他' ? '，請手動選類型' : ''), 9000);
      console.warn(e);
    }
    const hit = folders.find(f => f.name === aiFolder);
    if (hit) it.folderId = hit.id;
    btn.disabled = false; btn.textContent = '分析並分類';
    if (!it.title) toast('AI 沒有產生標題，請自己填寫標題再儲存', 5000);
    formView($('#out'), it, folders, true, hit ? '' : aiFolder);
  };
  if ((sharedUrl || sharedText) && cfg.key) $('#go').click();
}

/* ---------- 表單（新增確認 / 編輯共用）---------- */
function formView(box, it, folders, isNew, newFolderName = '') {
  const showP = it.type === '地點', showS = it.type === '軟體';
  box.innerHTML = `<div class="card" style="margin-top:14px">
  <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px"><div id="f-th" style="flex:none">${thumbHtml(it)}</div>
    <div style="flex:1"><button type="button" class="sec" id="f-pick" style="width:100%">選擇縮圖圖片</button>
    <button type="button" class="sec" id="f-unpick" style="width:100%;margin-top:6px;display:${it.thumb ? 'block' : 'none'}">移除自選縮圖</button>
    <input id="f-file" type="file" accept="image/*" hidden></div></div>
  <label>類型</label><select id="f-type">${TYPES.map(t => `<option ${t === it.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
  <label>標題</label><input id="f-title" value="${esc(it.title)}">
  <label>摘要</label><textarea id="f-sum">${esc(it.summary)}</textarea>
  <label>標籤（用逗號分隔）</label><input id="f-tags" value="${esc((it.tags || []).join(', '))}">
  <label>收藏夾</label><select id="f-folder"><option value="">（未分類）</option>
    ${folders.map(f => `<option value="${f.id}" ${f.id === it.folderId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
    <option value="__new__" ${newFolderName ? 'selected' : ''}>＋ 新增收藏夾…</option></select>
  <input id="f-newf" placeholder="新收藏夾名稱" value="${esc(newFolderName)}" style="margin-top:6px;display:${newFolderName ? 'block' : 'none'}">
  <div id="f-place" style="display:${showP ? 'block' : 'none'}">
    <label>店名 / 地點名稱</label><input id="p-name" value="${esc(it.place?.name)}">
    <label>地址</label><input id="p-addr" value="${esc(it.place?.address)}">
    <label>緯度（可手動修正）</label><input id="p-lat" inputmode="decimal" value="${it.place?.lat ?? ''}">
    <label>經度</label><input id="p-lng" inputmode="decimal" value="${it.place?.lng ?? ''}">
    <div class="row"><button type="button" class="sec" id="p-geo">用店名／地址查座標</button><button type="button" class="sec" id="p-gmap">在 Google 地圖開啟 ↗</button></div>
    <div class="sub" id="p-msg"></div>
  </div>
  <div id="f-soft" style="display:${showS ? 'block' : 'none'}">
    <label>平台</label><input id="s-plat" value="${esc(it.software?.platform)}">
    <label>用途</label><input id="s-purp" value="${esc(it.software?.purpose)}">
  </div>
  <label>筆記</label><textarea id="f-note">${esc(it.note)}</textarea>
  <label>連結</label><input id="f-url" value="${esc(it.url)}">
  ${isNew ? '' : `<div class="sub" style="margin-top:6px">${it.url ? `<a class="link" href="${esc(it.url)}" target="_blank" rel="noopener">開啟連結 ↗</a>` : ''}</div>`}
  ${it.rawText ? `<label>原始文字</label><div class="sub" style="white-space:pre-wrap">${esc(it.rawText)}</div>` : ''}
  <div class="row"><button id="save" ${isNew ? '' : 'disabled'}>${isNew ? '儲存' : '儲存修改'}</button>${isNew ? '' : '<button id="del" class="danger">刪除</button>'}</div></div>`;
  const sync = () => {
    const t = $('#f-type', box).value;
    $('#f-place', box).style.display = t === '地點' ? 'block' : 'none';
    $('#f-soft', box).style.display = t === '軟體' ? 'block' : 'none';
  };
  if (!isNew) ['input', 'change'].forEach(ev => box.addEventListener(ev, e => { if (e.target.closest('.card') && e.target.id !== 'save') $('#save', box).disabled = false; }));
  const markDirty = () => $('#f-title', box).dispatchEvent(new Event('input', { bubbles: true }));
  const redrawTh = () => { $('#f-th', box).innerHTML = thumbHtml(it); $('#f-unpick', box).style.display = it.thumb ? 'block' : 'none'; };
  $('#f-pick', box).onclick = () => $('#f-file', box).click();
  $('#f-file', box).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { it.thumb = await shrinkImage(f); redrawTh(); markDirty(); } catch (err) { toast(err.message); }
  };
  $('#f-unpick', box).onclick = () => { delete it.thumb; redrawTh(); markDirty(); };
  const curPlace = () => ({ name: $('#p-name', box).value.trim(), address: $('#p-addr', box).value.trim(), lat: $('#p-lat', box).value.trim() === '' ? null : +$('#p-lat', box).value, lng: $('#p-lng', box).value.trim() === '' ? null : +$('#p-lng', box).value });
  $('#p-gmap', box).onclick = () => {
    const u = gmapsUrl(curPlace());
    if (u) window.open(u, '_blank'); else toast('請先填店名或地址');
  };
  $('#p-geo', box).onclick = async () => {
    const msg = $('#p-msg', box), pl = curPlace();
    if (!pl.name && !pl.address) return toast('請先填店名或地址');
    msg.textContent = '查詢中…';
    try {
      const c = coordsFromUrl($('#f-url', box).value) || await geocode(pl);
      if (!c) { msg.textContent = '查不到，請補上更完整的地址，或自己填經緯度'; return; }
      $('#p-lat', box).value = c.lat.toFixed(6); $('#p-lng', box).value = c.lng.toFixed(6);
      msg.textContent = '已填入座標，請確認位置後儲存（可到 Google 地圖開啟核對）'; markDirty();
    } catch { msg.textContent = '查詢失敗，請稍後再試'; }
  };
  $('#f-type', box).onchange = sync;
  $('#f-folder', box).onchange = e => { $('#f-newf', box).style.display = e.target.value === '__new__' ? 'block' : 'none'; };
  $('#save', box).onclick = async () => {
    let fid = $('#f-folder', box).value;
    if (fid === '__new__') {
      const name = $('#f-newf', box).value.trim();
      fid = '';
      if (name) {
        const ex = folders.find(f => f.name === name);
        if (ex) fid = ex.id; else { fid = uid(); await put('folders', { id: fid, name, createdAt: Date.now() }); }
      }
    }
    const num = s => { s = s.trim(); return s === '' || isNaN(+s) ? null : +s; };
    Object.assign(it, {
      type: $('#f-type', box).value, title: $('#f-title', box).value.trim(), summary: $('#f-sum', box).value.trim(),
      tags: $('#f-tags', box).value.split(/[,，、]/).map(s => s.trim().replace(/^#/, '')).filter(Boolean),
      folderId: fid, note: $('#f-note', box).value.trim(), url: $('#f-url', box).value.trim(),
      place: { name: $('#p-name', box).value.trim(), address: $('#p-addr', box).value.trim(), lat: num($('#p-lat', box).value), lng: num($('#p-lng', box).value) },
      software: { platform: $('#s-plat', box).value.trim(), purpose: $('#s-purp', box).value.trim() },
    });
    await put('items', it);
    toast('已儲存');
    location.hash = isNew ? '#/' : '#/item/' + it.id;
    if (!isNew) route();
  };
  if (!isNew) $('#del', box).onclick = async () => {
    if (!confirm('確定刪除這筆收藏？')) return;
    await del('items', it.id); toast('已刪除'); location.hash = '#/';
  };
}

/* ---------- 詳情 ---------- */
async function detail(v, id) {
  $('#title').textContent = '詳情';
  const [items, fs] = await Promise.all([getAll('items'), getAll('folders')]);
  const it = items.find(i => i.id === id);
  if (!it) { v.innerHTML = '<div class="empty">找不到這筆收藏</div>'; return; }
  v.innerHTML = '<button class="sec" onclick="history.back()">← 返回</button><div id="box"></div>';
  formView($('#box'), it, fs, false);
}

/* ---------- 收藏夾 ---------- */
async function folders(v) {
  $('#title').textContent = '收藏夾';
  const [fs, items] = await Promise.all([getAll('folders'), getAll('items')]);
  v.innerHTML = `<div class="row" style="margin:0 0 12px"><input id="nf" placeholder="新收藏夾名稱" style="flex:3"><button id="addf" style="flex:1">新增</button></div>
  ${fs.sort((a, b) => a.createdAt - b.createdAt).map(f => `<div class="card fr" data-id="${f.id}">
    <b>📁 ${esc(f.name)} <span class="sub">(${items.filter(i => i.folderId === f.id).length})</span></b>
    <button class="sec" data-a="view">查看</button><button class="sec" data-a="ren">改名</button><button class="sec" data-a="del">刪除</button></div>`).join('') || '<div class="empty">還沒有收藏夾</div>'}
  <div id="fitems"></div>`;
  $('#addf').onclick = async () => {
    const name = $('#nf').value.trim(); if (!name) return;
    if (fs.some(f => f.name === name)) return toast('名稱已存在');
    await put('folders', { id: uid(), name, createdAt: Date.now() }); folders(v);
  };
  v.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const f = fs.find(x => x.id === b.closest('.card').dataset.id), a = b.dataset.a;
    if (a === 'ren') {
      const n = prompt('新名稱', f.name)?.trim(); if (!n) return;
      f.name = n; await put('folders', f); folders(v);
    } else if (a === 'del') {
      if (!confirm(`刪除收藏夾「${f.name}」？裡面的收藏不會被刪除，會變成未分類。`)) return;
      for (const i of items.filter(i => i.folderId === f.id)) { i.folderId = ''; await put('items', i); }
      await del('folders', f.id); folders(v);
    } else {
      const list = items.filter(i => i.folderId === f.id).sort((a, b) => b.createdAt - a.createdAt);
      $('#fitems').innerHTML = `<h3>${esc(f.name)}</h3>` + (list.map(i => `<a class="card" href="#/item/${i.id}"><h3><span class="badge">${esc(i.type)}</span>${esc(i.title || i.url)}</h3><div class="sub">${esc(i.summary)}</div></a>`).join('') || '<div class="empty">空的</div>');
    }
  });
}

/* ---------- 設定 ---------- */
async function settings(v) {
  $('#title').textContent = '設定';
  v.innerHTML = `<div class="card"><b>OpenAI API key</b><div class="sub">只存在這支手機的瀏覽器，不會上傳到其他地方。</div>
  <label>API key</label><input id="key" type="password" autocomplete="off" placeholder="sk-…" value="${esc(cfg.key)}">
  <label>模型</label><input id="model" value="${esc(cfg.model)}">
  <div class="row"><button id="ss" disabled>儲存</button></div></div>
  <div class="card"><b>備份</b><div class="row"><button id="exp" class="sec">匯出 JSON</button><button id="imp" class="sec">匯入 JSON</button></div>
  <input id="file" type="file" accept="application/json,.json" hidden></div>`;
  const dirty = () => $('#key').value.trim() !== cfg.key || ($('#model').value.trim() || 'gpt-4o-mini') !== cfg.model;
  const refresh = () => { $('#ss').disabled = !dirty(); };
  $('#key').oninput = $('#model').oninput = refresh;
  $('#ss').onclick = () => {
    localStorage.setItem('apiKey', $('#key').value.trim());
    localStorage.setItem('model', $('#model').value.trim() || 'gpt-4o-mini');
    $('#model').value = cfg.model; refresh(); toast('已儲存');
  };
  $('#exp').onclick = async () => {
    const data = { version: 1, exportedAt: Date.now(), folders: await getAll('folders'), items: await getAll('items') };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `收藏備份-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  $('#imp').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(d.items) || !Array.isArray(d.folders)) throw 0;
      if (!confirm(`匯入 ${d.items.length} 筆收藏、${d.folders.length} 個收藏夾？相同 id 會被覆蓋。`)) return;
      for (const f of d.folders) await put('folders', f);
      for (const i of d.items) await put('items', i);
      toast('匯入完成');
    } catch { toast('檔案格式不正確'); }
  };
}

/* ---------- 啟動 ---------- */
openDB().then(async () => {
  // 清掉舊版 bug 存下來的占位文字
  for (const i of await getAll('items')) {
    const t = clean(i.title), s = clean(i.summary);
    if (t !== i.title || s !== i.summary) await put('items', { ...i, title: t, summary: s });
  }
  addEventListener('hashchange', route);
  // 分享進來：?url=…&text=… 直接去新增頁
  // 分享進來：先記下參數、清掉網址上的參數，只渲染一次新增頁
  if (/[?&](url|text|title)=/.test(location.search)) {
    shared = new URLSearchParams(location.search);
    history.replaceState(null, '', location.pathname + '#/add');
  }
  route();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
