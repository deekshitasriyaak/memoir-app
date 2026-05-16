// ── CONFIG ───────────────────────────────────────────────────────
const GITHUB_API  = 'https://api.github.com';
const MAX_MEDIA   = 10;
const MAX_FILE_MB = 24;

const DISC_COLORS = [
  ['#c8a46a','#7a5030'], ['#6a8ac8','#304080'],
  ['#c86a8a','#803060'], ['#6ac88a','#305040'],
  ['#c8c86a','#807030'], ['#8a6ac8','#403080'],
  ['#c88a6a','#805030'], ['#6ac8c8','#306060'],
];

// ── STATE ────────────────────────────────────────────────────────
const state = {
  auth:           null,
  posts:          [],
  filteredPosts:  [],
  musicIndex:     [],
  currentPost:    null,
  currentSlide:   0,
  pendingMedia:   [],
  navHistory:     ['screen-setup'],
  activeTab:      'feed',
  selectedSongId: null,          // create form
  editPost:       null,
  reorderOriginal: [],
  reorderCurrent:  [],
  editFolderUrls:  {},
  feedDateFilter:     null,
  feedLocationFilter: null,
  musicQuery:         '',
  // Clip sheet state
  songPausedByVideo: false,
  clipSheet: {
    mode:          null,
    songId:        null,
    startTime:     0,
    endTime:       null,
    duration:      null,
    previewAudio:  null,
    trimConfirmed: false,
  },
};

// ── CRYPTO ───────────────────────────────────────────────────────
async function deriveKey() {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode('memoir-key-2024'), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('memoir-salt'), iterations: 100000, hash: 'SHA-256' }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptText(text) {
  const key = await deriveKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));
}
async function decryptText(b64) {
  try {
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const key = await deriveKey();
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return new TextDecoder().decode(dec);
  } catch { return null; }
}
async function saveAuth(auth) {
  const enc = await encryptText(auth.token);
  localStorage.setItem('memoir_auth', JSON.stringify({ username: auth.username, repo: auth.repo, tokenEnc: enc }));
}
async function loadAuth() {
  const raw = localStorage.getItem('memoir_auth');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const token  = await decryptText(parsed.tokenEnc);
    if (!token) return null;
    return { ...parsed, token };
  } catch { return null; }
}

// ── GITHUB API ────────────────────────────────────────────────────
async function ghFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${state.auth.token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.message || `GitHub ${res.status}`), { status: res.status });
  }
  return res;
}
async function ghGet(path) {
  const res = await ghFetch(path);
  if (res.status === 404) return null;
  return res.json();
}
async function ghGetFile(path) {
  const res = await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`);
  if (res.status === 404) return null;
  const data = await res.json();
  return { content: JSON.parse(atob(data.content.replace(/\n/g, ''))), sha: data.sha };
}
async function ghPutFile(path, content, sha = null, message = null) {
  const body = { message: message || `memoir: update ${path}`, content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))), ...(sha ? { sha } : {}) };
  const res = await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  return res.json();
}
async function ghPutBinary(path, arrayBuffer, sha = null, message = null) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary  = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const body = { message: message || `memoir: add ${path}`, content: btoa(binary), ...(sha ? { sha } : {}) };
  const res = await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  return res.json();
}
async function ghUpdateIndexRetry(path, updateFn, message, maxRetries = 3) {
  let updatedContent;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const file = await ghGetFile(path);
    updatedContent = updateFn(file?.content || []);
    const body = {
      message: message || `memoir: update ${path}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(updatedContent, null, 2)))),
      ...(file?.sha ? { sha: file.sha } : {})
    };
    const res = await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`, {
      method: 'PUT', body: JSON.stringify(body)
    });
    if (res.status === 200 || res.status === 201) return updatedContent;
    if ((res.status === 409 || res.status === 422) && attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return updatedContent;
}
async function ghDeleteFile(path, sha, message = null) {
  const res = await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`, { method: 'DELETE', body: JSON.stringify({ message: message || `memoir: delete ${path}`, sha }) });
  return res.json();
}
async function ghFolderUrls(folderPath) {
  try {
    const items = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/${folderPath}`);
    const map = {};
    if (Array.isArray(items)) items.forEach(f => { if (f.download_url) map[f.name] = f.download_url; });
    return map;
  } catch { return {}; }
}

// Fetch a file from the private repo as an authenticated blob URL.
// Uses the Git Data API (/git/blobs/{sha}) which supports files up to 100MB.
// Cache stores Promises so concurrent callers share one fetch (no race condition).
const _blobCache = new Map();
const _MIME = { mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', mp4:'video/mp4', mov:'video/quicktime', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };

function ghBlobUrl(filePath) {
  if (!_blobCache.has(filePath)) _blobCache.set(filePath, _fetchBlobUrl(filePath));
  return _blobCache.get(filePath);
}
async function _fetchBlobUrl(filePath) {
  try {
    const info = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/${filePath}`);
    if (!info?.sha) return null;
    const res = await fetch(`${GITHUB_API}/repos/${state.auth.username}/${state.auth.repo}/git/blobs/${info.sha}`, {
      headers: { Authorization: `Bearer ${state.auth.token}`, Accept: 'application/vnd.github.v3.raw' }
    });
    if (!res.ok) return null;
    const ext      = filePath.split('.').pop().toLowerCase();
    const mimeType = _MIME[ext] || 'application/octet-stream';
    const blob     = new Blob([await res.arrayBuffer()], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch { return null; }
}
function ghBlobCacheClear() {
  _blobCache.forEach(async p => { const u = await p; if (u) URL.revokeObjectURL(u); });
  _blobCache.clear();
}

// ── LOGGING ───────────────────────────────────────────────────────
async function logEvent(op, status, detail = '') {
  const entry = { ts: new Date().toISOString(), op, status, detail };
  const stored = JSON.parse(localStorage.getItem('memoir_logs') || '[]');
  stored.unshift(entry);
  localStorage.setItem('memoir_logs', JSON.stringify(stored.slice(0, 100)));
  if (status === 'error' && state.auth) {
    try {
      const file = await ghGetFile('logs/errors.json').catch(() => null);
      const current = file ? file.content : [];
      await ghPutFile('logs/errors.json', [entry, ...current].slice(0, 500), file?.sha, `memoir: log error - ${op}`);
    } catch {}
  }
}

// ── TOASTS ────────────────────────────────────────────────────────
function showToast(title, msg = '', type = 'info', duration = 4000) {
  const icons = { error: '✗', success: '✓', info: '·', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><div class="toast-body"><div class="toast-title">${title}</div>${msg ? `<div class="toast-msg">${msg}</div>` : ''}</div><button class="toast-close" onclick="this.parentElement.remove()">✕</button>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}
function showError(title, err) {
  const detail = err?.message || String(err);
  showToast(title, detail, 'error', 6000);
  logEvent(title, 'error', detail);
}

// ── NAVIGATION ────────────────────────────────────────────────────
function setFeedTabActive() {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('nav-feed')?.classList.add('active');
}
function navigateTo(screenId, addHistory = true) {
  const current = document.querySelector('.screen.active');
  if (current?.id === screenId) return;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const next = document.getElementById(screenId);
  next.classList.add('active', 'slide-in');
  setTimeout(() => next.classList.remove('slide-in'), 300);
  if (addHistory) state.navHistory.push(screenId);
  if (screenId === 'screen-settings') loadSettings();
  if (screenId === 'screen-music')    loadMusicLibrary();
  if (screenId === 'screen-create')   loadMusicForCreate();
  if (screenId === 'screen-reorder')  loadReorderScreen();
}
function goBack() {
  if (state.navHistory.length <= 1) return;
  const leaving = state.navHistory[state.navHistory.length - 1];
  if (leaving === 'screen-post') {
    const audio = document.getElementById('audio-player');
    audio.pause(); audio.removeAttribute('src'); audio.load(); audio._eventsSet = false;
    state.songPausedByVideo = false;
    hideVideoAudioToggle();
  }
  if (leaving === 'screen-music') {
    if (previewAudio) { previewAudio.pause(); previewAudio.src = ''; previewAudio = null; }
    const _a = document.getElementById('audio-player');
    if (_a) { _a.pause(); _a.removeAttribute('src'); _a.load(); _a._eventsSet = false; }
    state.songPausedByVideo = false;
    hideVideoAudioToggle();
    if (previewingId) {
      document.getElementById(`disc-${previewingId}`)?.classList.remove('playing');
      const pb = document.getElementById(`play-${previewingId}`);
      if (pb) pb.textContent = '▶';
      previewingId = null;
    }
  }
  if (leaving === 'screen-create' || leaving === 'screen-edit') {
    stopClipPreviewAudio();
  }
  state.navHistory.pop();
  const prev = state.navHistory[state.navHistory.length - 1];
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(prev).classList.add('active');
  if (prev === 'screen-feed') setFeedTabActive();
}
function switchTab(tab, evt) {
  state.activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  if (evt?.currentTarget) evt.currentTarget.classList.add('active');
  const map    = { feed: 'screen-feed', music: 'screen-music', settings: 'screen-settings' };
  const target = map[tab];
  state.navHistory = tab === 'feed' ? ['screen-feed'] : ['screen-feed', target];
  navigateTo(target, false);
}

// ── SHEETS ────────────────────────────────────────────────────────
function closeSheet(id) { document.getElementById(id).classList.remove('open'); }
function openSheet(id)  { document.getElementById(id).classList.add('open'); }
function openDeleteSheet() { openSheet('sheet-delete'); }

// ── SETUP & AUTH ─────────────────────────────────────────────────
async function handleConnect() {
  const username = document.getElementById('input-username').value.trim();
  const repo     = document.getElementById('input-repo').value.trim() || 'memoir-data';
  const token    = document.getElementById('input-token').value.trim();
  const errEl    = document.getElementById('setup-error');
  errEl.style.display = 'none';
  if (!username || !token) { errEl.textContent = 'Username and token are required.'; errEl.style.display = 'block'; return; }
  document.getElementById('setup-form').style.display    = 'none';
  document.getElementById('connecting-state').style.display = 'flex';
  const steps  = ['step-1','step-2','step-3','step-4','step-5'];
  let stepIdx  = 0;
  function advanceStep() { document.getElementById(steps[stepIdx]).classList.remove('active'); document.getElementById(steps[stepIdx]).classList.add('done'); stepIdx++; if (stepIdx < steps.length) document.getElementById(steps[stepIdx]).classList.add('active'); }
  function failStep(msg) { document.getElementById('connecting-state').style.display = 'none'; document.getElementById('setup-form').style.display = 'block'; errEl.textContent = msg; errEl.style.display = 'block'; }
  try {
    document.getElementById(steps[0]).classList.add('active');
    state.auth = { username, repo, token };
    const user = await ghGet('/user');
    if (!user) throw new Error('Invalid token — could not authenticate.');
    advanceStep();
    const repoData = await ghGet(`/repos/${username}/${repo}`);
    advanceStep();
    await initRepoStructure(repoData === null);
    advanceStep();
    await initWorkflows();
    advanceStep();
    await saveAuth(state.auth);
    advanceStep();
    await new Promise(r => setTimeout(r, 400));
    launchApp();
  } catch (err) {
    failStep(err.message || 'Connection failed. Check your token and username.');
    state.auth = null;
  }
}
async function initRepoStructure(isNew) {
  if (isNew) {
    await ghFetch('/user/repos', { method: 'POST', body: JSON.stringify({ name: state.auth.repo, private: true, description: 'Memoir private archive', auto_init: true }) });
    await new Promise(r => setTimeout(r, 1500));
  }
  const files = [['posts-index.json', []], ['music/music-index.json', []], ['logs/errors.json', []], ['profile.json', { username: state.auth.username, joinedAt: new Date().toISOString() }]];
  for (const [path, def] of files) {
    try {
      const res = await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`);
      if (res.status === 404) await ghPutFile(path, def, null, `memoir: initialize ${path}`);
    } catch {}
  }
}
async function initWorkflows() {
  const alertEmail = 'aelin15000@gmail.com';
  const emailYml = `name: Email Error Alerts\non:\n  push:\n    paths: ['logs/errors.json']\njobs:\n  notify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: dawidd6/action-send-mail@v3\n        with:\n          server_address: smtp.gmail.com\n          server_port: 465\n          secure: true\n          username: \${{secrets.GMAIL_USER}}\n          password: \${{secrets.GMAIL_APP_PASSWORD}}\n          to: ${alertEmail}\n          subject: "Memoir Error Alert"\n          html_body: "<h3>Memoir error — check logs/errors.json in your memoir-data repo</h3>"\n`;
  const cleanupYml = `name: Monthly Log Cleanup\non:\n  schedule:\n    - cron: '0 0 1 * *'\njobs:\n  cleanup:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "[]" > logs/errors.json\n      - uses: stefanzweifel/git-auto-commit-action@v5\n        with:\n          commit_message: 'memoir: monthly log cleanup'\n`;
  for (const [path, content] of [['.github/workflows/email-errors.yml', emailYml], ['.github/workflows/cleanup-logs.yml', cleanupYml]]) {
    try {
      const getRes = await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`);
      let sha = null;
      if (getRes.status === 200) { const d = await getRes.json(); sha = d.sha; }
      const body = { message: `memoir: setup ${path}`, content: btoa(unescape(encodeURIComponent(content))) };
      if (sha) body.sha = sha;
      await ghFetch(`/repos/${state.auth.username}/${state.auth.repo}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
    } catch {}
  }
}
async function launchApp() {
  navigateTo('screen-feed', false);
  state.navHistory = ['screen-feed'];
  setFeedTabActive();
  showInstallNudge();
  await loadFeed();
}

// ── FEED ─────────────────────────────────────────────────────────
async function loadFeed() {
  const container = document.getElementById('feed-content');
  // Skeleton grid
  container.innerHTML = `<div class="feed-skeleton-grid">${Array(6).fill(0).map(() => `<div class="feed-skeleton-cell skeleton"></div>`).join('')}</div>`;
  try {
    const file  = await ghGetFile('posts-index.json');
    state.posts = file ? (Array.isArray(file.content) ? file.content : []) : [];
    state.filteredPosts = [...state.posts];
    renderFeedFilters();
    renderFeed(state.filteredPosts);
    logEvent('loadFeed', 'success', `${state.posts.length} posts`);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠</div><div class="empty-title">Couldn't load feed</div><div class="empty-sub">${err.message}</div></div>`;
    showError('Feed load failed', err);
  }
}

function renderFeed(posts) {
  const container = document.getElementById('feed-content');
  if (!posts.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">✦</div><div class="empty-title">No memories yet</div><div class="empty-sub">Tap + to create your first post</div></div>`;
    return;
  }
  container.innerHTML = `<div class="feed-grid">${posts.map(renderPostCard).join('')}</div>`;
  lazyLoadVideoThumbs();
}

function renderPostCard(post) {
  const date     = formatDate(post.date);
  const hasThumb = post.thumbnail_b64 || post.thumbnail;

  let thumbHtml;
  if (post.thumbnail_b64) {
    thumbHtml = `<img src="${post.thumbnail_b64}" alt="">`;
  } else if (post.thumbnail) {
    const rawUrl = `https://raw.githubusercontent.com/${state.auth.username}/${state.auth.repo}/main/${post.thumbnail}`;
    thumbHtml = `<img src="${rawUrl}" alt="" onerror="feedThumbFallback(this,'${post.thumbnail}')">`;
  } else {
    thumbHtml = post.hasVideo
      ? `<div class="feed-card-no-thumb feed-card-vid-pending" data-vid-post="${post.id}"></div>`
      : `<div class="feed-card-no-thumb"></div>`;
  }

  return `<div class="feed-card" onclick="openPost('${post.id}')">
    <div class="feed-card-photo">
      ${thumbHtml}
      <div class="feed-card-badges">
        ${post.mediaCount > 1 ? `<div class="feed-badge">1/${post.mediaCount}</div>` : ''}
        ${post.hasVideo     ? `<div class="feed-badge feed-badge-video">▶</div>` : ''}
        ${post.songTitle    ? `<div class="feed-badge feed-badge-music">♫</div>` : ''}
      </div>
    </div>
    <div class="feed-card-info">
      ${post.captionPreview ? `<div class="feed-card-caption">${esc(post.captionPreview)}</div>` : ''}
      <div class="feed-card-date">${date}</div>
      ${post.location ? `<div class="feed-card-location">📍 ${esc(post.location)}</div>` : ''}
    </div>
  </div>`;
}

async function lazyLoadVideoThumbs() {
  const els = Array.from(document.querySelectorAll('.feed-card-vid-pending'));
  for (const el of els) {
    const postId = el.dataset.vidPost;
    if (!postId) continue;
    try {
      const meta = await ghGetFile(`posts/${postId}/meta.json`);
      const firstVid = meta?.content?.media?.find(m => m.type === 'video');
      if (!firstVid) continue;
      const videoUrl = await ghBlobUrl(`posts/${postId}/${firstVid.filename}`);
      if (!videoUrl) continue;
      const thumb = await generateVideoThumbnailFromUrl(videoUrl);
      if (!thumb || !document.body.contains(el)) continue;
      const img = document.createElement('img');
      img.src = thumb; img.alt = '';
      el.replaceWith(img);
    } catch {}
  }
}
async function generateVideoThumbnailFromUrl(url, maxW = 320, maxH = 240) {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.preload = 'metadata'; video.muted = true; video.playsInline = true;
    video.src = url;
    video.onseeked = () => {
      try {
        const ratio = Math.min(maxW / video.videoWidth, maxH / video.videoHeight, 1);
        const w = Math.round(video.videoWidth * ratio);
        const h = Math.round(video.videoHeight * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.35));
      } catch { resolve(null); }
    };
    video.onloadedmetadata = () => { video.currentTime = 0.5; };
    video.onerror = () => resolve(null);
  });
}
async function feedThumbFallback(img, thumbPath) {
  if (img.dataset.tried) return;
  img.dataset.tried = '1';
  try {
    const url = await ghBlobUrl(thumbPath);
    if (url) img.src = url;
    else img.style.display = 'none';
  } catch { img.style.display = 'none'; }
}

function handleSearch(query) {
  applyFeedFilters();
}

function applyFeedFilters() {
  const q = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  state.filteredPosts = state.posts.filter(p => {
    if (q && !(p.captionPreview || '').toLowerCase().includes(q) && !(p.location || '').toLowerCase().includes(q)) return false;
    if (state.feedDateFilter) {
      const d = new Date(p.date);
      const ms = isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      if (ms !== state.feedDateFilter) return false;
    }
    if (state.feedLocationFilter && (p.location || '') !== state.feedLocationFilter) return false;
    return true;
  });
  renderFeed(state.filteredPosts);
}

function renderFeedFilters() {
  const el = document.getElementById('feed-filters');
  if (!el) return;
  const months = [...new Set(state.posts.map(p => {
    const d = new Date(p.date);
    return isNaN(d) ? null : d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  }).filter(Boolean))];
  const locs = [...new Set(state.posts.map(p => p.location).filter(Boolean))];
  if (!months.length && !locs.length) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const hasFilter = state.feedDateFilter || state.feedLocationFilter;
  el.innerHTML =
    (months.length ? `<select class="filter-pill" onchange="setFeedDateFilter(this.value)">
      <option value="">All dates</option>
      ${months.map(m => `<option value="${m}" ${state.feedDateFilter === m ? 'selected' : ''}>${m}</option>`).join('')}
    </select>` : '') +
    (locs.length ? `<select class="filter-pill" onchange="setFeedLocationFilter(this.value)">
      <option value="">All places</option>
      ${locs.map(l => `<option value="${l}" ${state.feedLocationFilter === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select>` : '') +
    (hasFilter ? `<button class="filter-clear" onclick="clearFeedFilters()">✕</button>` : '');
}

function setFeedDateFilter(val) {
  state.feedDateFilter = val || null;
  applyFeedFilters();
  renderFeedFilters();
}
function setFeedLocationFilter(val) {
  state.feedLocationFilter = val || null;
  applyFeedFilters();
  renderFeedFilters();
}
function clearFeedFilters() {
  state.feedDateFilter = null;
  state.feedLocationFilter = null;
  const si = document.getElementById('search-input');
  if (si) si.value = '';
  applyFeedFilters();
  renderFeedFilters();
}

// ── POST VIEW ─────────────────────────────────────────────────────
async function openPost(postId) {
  navigateTo('screen-post');
  state.currentSlide = 0;

  const audio = document.getElementById('audio-player');
  audio.pause(); audio.removeAttribute('src'); audio.load(); audio._eventsSet = false;
  state.songPausedByVideo = false;
  hideVideoAudioToggle();

  document.getElementById('post-slides').innerHTML = '';
  document.getElementById('post-slides').style.transform = '';
  document.getElementById('swipe-dots').innerHTML = '';
  document.getElementById('now-playing').style.display = 'none';
  document.getElementById('post-view-blur-bg').style.backgroundImage = '';
  const _playBtn = document.getElementById('np-play-btn');
  _playBtn.textContent = '▶';
  _playBtn.classList.remove('loading');
  _playBtn.disabled = false;
  _playBtn.title = '';
  document.getElementById('np-disc').classList.remove('playing');
  document.getElementById('np-progress').style.width = '0%';
  document.getElementById('np-current').textContent  = '0:00';
  document.getElementById('np-duration').textContent = '—:——';
  document.getElementById('post-view-caption').textContent = '';
  document.getElementById('post-view-date').textContent    = '';
  document.getElementById('post-view-location').style.display = 'none';

  try {
    const [metaFile, folderUrls] = await Promise.all([
      ghGetFile(`posts/${postId}/meta.json`),
      ghFolderUrls(`posts/${postId}`)
    ]);

    if (!metaFile) throw new Error('Post not found');
    const meta = metaFile.content;
    state.currentPost = { ...meta, id: postId, _sha: metaFile.sha };

    const sortedMedia = [...meta.media].sort((a, b) => a.order - b.order);
    const slides = document.getElementById('post-slides');
    const dots   = document.getElementById('swipe-dots');

    const firstImg = sortedMedia.find(m => m.type === 'image');
    if (firstImg) {
      const blurEl = document.getElementById('post-view-blur-bg');
      const blurUrl = folderUrls[firstImg.filename];
      if (blurUrl) blurEl.style.backgroundImage = `url(${blurUrl})`;
      ghBlobUrl(`posts/${postId}/${firstImg.filename}`).then(blobUrl => {
        if (blobUrl) blurEl.style.backgroundImage = `url(${blobUrl})`;
      });
    }

    for (let i = 0; i < sortedMedia.length; i++) {
      const m       = sortedMedia[i];
      const filePath = `posts/${postId}/${m.filename}`;
      const url      = folderUrls[m.filename];
      let el;
      if (m.type === 'video') {
        el = Object.assign(document.createElement('video'), { className: 'post-view-slide video', controls: true, playsInline: true });
        if (url) el.src = url;
        el.onerror = () => ghBlobUrl(filePath).then(b => { if (b) el.src = b; });
      } else {
        el = Object.assign(document.createElement('img'), { className: 'post-view-slide', alt: '' });
        // Load via blob URL immediately (avoids expiring signed tokens)
        ghBlobUrl(filePath).then(blobUrl => {
          if (blobUrl) el.src = blobUrl;
          else if (url) el.src = url;
        });
      }
      slides.appendChild(el);
      if (sortedMedia.length > 1) {
        const dot = document.createElement('div');
        dot.className = 'swipe-dot' + (i === 0 ? ' active' : '');
        dots.appendChild(dot);
      }
    }

    document.getElementById('post-view-date').textContent    = formatDate(meta.createdAt?.split('T')[0]);
    document.getElementById('post-view-caption').textContent = meta.caption || '';
    if (meta.location) {
      document.getElementById('post-view-location').style.display = 'flex';
      document.getElementById('post-view-location-text').textContent = meta.location;
    }

    // ── PRE-LOAD AUDIO via blob URL (avoids expiring tokens) ──
    if (meta.song?.filename) {
      setupAudioUI(meta.song.title, meta.song.artist);
      // Show loading state on play button until blob is ready
      const playBtn = document.getElementById('np-play-btn');
      playBtn.textContent = '…';
      playBtn.classList.add('loading');
      ghBlobUrl(`posts/${postId}/${meta.song.filename}`).then(songUrl => {
        playBtn.classList.remove('loading');
        playBtn.textContent = '▶';
        if (songUrl) {
          audio.src = songUrl;
          wireAudioEvents(audio, meta.song);
          audio.play().catch(() => {});
        } else {
          playBtn.disabled = true;
          playBtn.title = 'Could not load song';
        }
      });
    }

    logEvent('openPost', 'success', postId);
  } catch (err) {
    showError('Could not load post', err);
    goBack();
  }
}

function wireAudioEvents(audio, song) {
  if (audio._eventsSet) return;
  audio._eventsSet = true;
  const btn  = document.getElementById('np-play-btn');
  const disc = document.getElementById('np-disc');
  const endTime = song.endTime || null;
  audio.ontimeupdate = () => {
    if (!audio.duration) return;
    document.getElementById('np-progress').style.width = (audio.currentTime / audio.duration * 100) + '%';
    document.getElementById('np-current').textContent  = fmtTime(audio.currentTime);
    // Enforce clip end — loop back to start
    if (endTime && audio.currentTime >= endTime) {
      audio.currentTime = song.startTime || 0;
    }
  };
  audio.onloadedmetadata = () => {
    document.getElementById('np-duration').textContent = fmtTime(audio.duration);
    // Seek to clip start on load
    if (song.startTime > 0) audio.currentTime = song.startTime;
  };
  audio.onplay  = () => { disc.classList.add('playing');    btn.textContent = '⏸'; };
  audio.onpause = () => { disc.classList.remove('playing'); btn.textContent = '▶'; };
  audio.onended = () => {
    audio.currentTime = song.startTime || 0;
    disc.classList.remove('playing'); btn.textContent = '▶';
  };
  audio.onerror = () => {
    disc.classList.remove('playing'); btn.textContent = '▶';
    showToast('Could not play song', 'Try opening the post again', 'error');
  };
}

// Swipe
let touchX = 0;
function touchStart(e) { touchX = e.touches[0].clientX; }
function touchEnd(e) {
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) < 42) return;
  const meta = state.currentPost;
  if (!meta) return;
  const n = meta.media.length;
  if (dx < 0 && state.currentSlide < n - 1) goToSlide(state.currentSlide + 1);
  if (dx > 0 && state.currentSlide > 0)     goToSlide(state.currentSlide - 1);
}
function goToSlide(idx) {
  const prevIdx = state.currentSlide;
  state.currentSlide = idx;
  document.getElementById('post-slides').style.transform = `translateX(-${idx * 100}%)`;
  document.querySelectorAll('.swipe-dot').forEach((d, i) => d.classList.toggle('active', i === idx));

  const slides    = document.getElementById('post-slides').children;
  const prevSlide = slides[prevIdx];
  const newSlide  = slides[idx];
  const mainAudio = document.getElementById('audio-player');

  if (prevSlide?.tagName === 'VIDEO') prevSlide.pause();

  if (newSlide?.tagName === 'VIDEO') {
    if (!mainAudio.paused) {
      state.songPausedByVideo = true;
      mainAudio.pause();
    }
    const checkAudio = () => {
      const hasAudio = (newSlide.audioTracks && newSlide.audioTracks.length > 0) ||
                       newSlide.mozHasAudio === true ||
                       newSlide.webkitAudioDecodedByteCount > 0;
      if (!hasAudio && state.songPausedByVideo) {
        state.songPausedByVideo = false;
        mainAudio.play().catch(() => {});
      }
      showVideoAudioToggle(hasAudio);
    };
    if (newSlide.readyState >= 1) checkAudio();
    else newSlide.addEventListener('loadedmetadata', checkAudio, { once: true });
  } else {
    hideVideoAudioToggle();
    if (state.songPausedByVideo) {
      state.songPausedByVideo = false;
      mainAudio.play().catch(() => {});
    }
  }
}

function showVideoAudioToggle(videoHasAudio) {
  let btn = document.getElementById('video-audio-toggle');
  if (!videoHasAudio) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'video-audio-toggle';
    btn.className = 'video-audio-toggle';
    btn.onclick = toggleVideoAudioChoice;
    document.getElementById('screen-post').appendChild(btn);
  }
  updateVideoAudioToggleLabel();
}
function hideVideoAudioToggle() {
  document.getElementById('video-audio-toggle')?.remove();
}
function updateVideoAudioToggleLabel() {
  const btn = document.getElementById('video-audio-toggle');
  if (!btn) return;
  btn.textContent = state.songPausedByVideo ? '♫ play song' : '🎬 video audio';
}
function toggleVideoAudioChoice() {
  const mainAudio = document.getElementById('audio-player');
  const slides    = document.getElementById('post-slides').children;
  const curSlide  = slides[state.currentSlide];
  if (state.songPausedByVideo) {
    if (curSlide?.tagName === 'VIDEO') curSlide.muted = true;
    state.songPausedByVideo = false;
    mainAudio.play().catch(() => {});
  } else {
    if (curSlide?.tagName === 'VIDEO') { curSlide.muted = false; curSlide.play().catch(() => {}); }
    if (!mainAudio.paused) { state.songPausedByVideo = true; mainAudio.pause(); }
  }
  updateVideoAudioToggleLabel();
}

// ── AUDIO ─────────────────────────────────────────────────────────
function setupAudioUI(title, artist, colorKey) {
  document.getElementById('np-title').textContent  = title  || 'Unknown';
  document.getElementById('np-artist').textContent = artist || '';
  const [c1, c2] = discColor(colorKey || title || '');
  document.getElementById('np-disc').style.background = `radial-gradient(circle at 35% 35%, ${c1}, ${c2})`;
  document.getElementById('now-playing').style.display = 'flex';
}

// toggleAudio — plays synchronously (user gesture preserved).
// Audio src is pre-set in openPost() so no API call needed here.
function toggleAudio() {
  const audio = document.getElementById('audio-player');
  if (!audio.paused) { audio.pause(); return; }
  if (!audio.src || audio.src === window.location.href) {
    // Fallback: try refreshing the URL then tell user to tap again
    refreshAudioSrc();
    showToast('Loading song…', 'Tap ▶ once more when ready', 'info');
    return;
  }
  audio.play().catch(err => {
    if (err.name === 'NotSupportedError' || err.name === 'AbortError') {
      // URL likely expired — refresh and prompt
      refreshAudioSrc();
      showToast('Song reloading…', 'Tap ▶ again in a moment', 'info');
    }
  });
}

async function refreshAudioSrc() {
  const meta = state.currentPost;
  if (!meta?.song?.filename) return;
  try {
    const url = await ghBlobUrl(`posts/${meta.id}/${meta.song.filename}`);
    if (url) {
      const audio = document.getElementById('audio-player');
      audio._eventsSet = false;
      audio.src = url;
      wireAudioEvents(audio, meta.song);
    }
  } catch {}
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ── THUMBNAIL GENERATION ──────────────────────────────────────────
async function generateThumbnail(file, maxW = 320, maxH = 240) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
      const w = Math.round(img.naturalWidth  * ratio);
      const h = Math.round(img.naturalHeight * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.35));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function generateVideoThumbnail(file, maxW = 320, maxH = 240) {
  return new Promise(resolve => {
    const video  = document.createElement('video');
    const url    = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.muted   = true;
    video.playsInline = true;
    video.src = url;
    const capture = () => {
      try {
        const ratio  = Math.min(maxW / video.videoWidth, maxH / video.videoHeight, 1);
        const w = Math.round(video.videoWidth  * ratio);
        const h = Math.round(video.videoHeight * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.35));
      } catch { URL.revokeObjectURL(url); resolve(null); }
    };
    video.onseeked = capture;
    video.onloadedmetadata = () => { video.currentTime = 0.5; };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
  });
}

// ── DELETE POST ───────────────────────────────────────────────────
async function confirmDelete() {
  closeSheet('sheet-delete');
  const meta = state.currentPost;
  if (!meta) return;
  showToast('Deleting…', '', 'info', 10000);
  try {
    const folder = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/posts/${meta.id}`);
    if (Array.isArray(folder)) for (const file of folder) await ghDeleteFile(file.path, file.sha);
    const indexFile = await ghGetFile('posts-index.json');
    const updated   = (indexFile?.content || []).filter(p => p.id !== meta.id);
    await ghPutFile('posts-index.json', updated, indexFile?.sha, `memoir: delete post ${meta.id}`);
    state.posts = updated; state.filteredPosts = updated;
    showToast('Deleted', '', 'success');
    logEvent('deletePost', 'success', meta.id);
    goBack();
    renderFeed(state.filteredPosts);
  } catch (err) { showError('Delete failed', err); }
}

// ── CREATE POST ───────────────────────────────────────────────────
function openMediaPicker()     { const i = document.getElementById('media-file-input');     i.value = ''; i.click(); }
function openMediaPickerAdd(e) { e.stopPropagation(); const i = document.getElementById('media-file-input-add'); i.value = ''; i.click(); }

async function handleMediaFiles(files) {
  for (const f of Array.from(files)) {
    if (f.size / 1024 / 1024 > MAX_FILE_MB) showToast('Large file', `${f.name} exceeds 24MB`, 'warning');
  }
  state.pendingMedia = [...(state.pendingMedia || []), ...Array.from(files)].slice(0, MAX_MEDIA);
  renderMediaGrid();
  document.getElementById('btn-post').disabled = !state.pendingMedia.length;
}

function renderMediaGrid() {
  const grid   = document.getElementById('media-grid');
  const addBtn = document.getElementById('media-add-btn');
  const files  = state.pendingMedia;
  const iconEl = document.querySelector('#media-picker .media-picker-icon');
  const textEl = document.querySelector('#media-picker .media-picker-text');
  const subEl  = document.querySelector('#media-picker .media-picker-sub');
  if (!files.length) {
    grid.style.display = 'none'; addBtn.style.display = 'none';
    iconEl.style.display = ''; textEl.style.display = ''; subEl.style.display = '';
    return;
  }
  iconEl.style.display = 'none'; textEl.style.display = 'none'; subEl.style.display = 'none';
  grid.style.display = 'grid'; addBtn.style.display = 'flex';
  addBtn.onclick = openMediaPickerAdd;
  const show = files.slice(0, 3);
  const more = files.length - 3;
  grid.innerHTML = show.map((f, i) => {
    const url = URL.createObjectURL(f);
    const isVideo = f.type.startsWith('video/');
    return `<div class="media-grid-item"><${isVideo ? `video src="${url}" muted playsinline preload="metadata"` : `img src="${url}" alt=""`}><button class="media-remove-btn" onclick="event.stopPropagation();removeMedia(${i})">✕</button>${i === 2 && more > 0 ? `<div class="media-grid-more">+${more + 1}</div>` : ''}</div>`;
  }).join('');
}

function removeMedia(index) {
  state.pendingMedia.splice(index, 1);
  renderMediaGrid();
  document.getElementById('btn-post').disabled = !state.pendingMedia.length;
}

async function loadMusicForCreate() {
  const selector = document.getElementById('music-selector');
  if (!state.auth) return;
  try {
    const file = await ghGetFile('music/music-index.json');
    const newIndex = file?.content || [];
    if (JSON.stringify(newIndex) !== JSON.stringify(state.musicIndex)) state.musicIndex = newIndex;
    if (!state.musicIndex.length) {
      selector.innerHTML = `<div style="font-size:12px;color:var(--text-faint);padding:8px 0">No songs yet — add some in the Music tab</div>`;
      return;
    }
    state.selectedSongId = null;
    renderMusicSelector(selector, null, 'selectSong');
  } catch { selector.innerHTML = `<div style="font-size:12px;color:var(--rose)">Couldn't load library</div>`; }
}

function renderMusicSelector(container, selectedId, fnName) {
  container.innerHTML = state.musicIndex.map(song => {
    const [c1, c2] = discColor(song.id || song.title);
    const sel = selectedId === song.id;
    const clipInfo = sel ? getClipLabel('create') : '';
    return `<div class="music-option${sel ? ' selected' : ''}" onclick="${fnName}('${song.id}')" id="${fnName}-mo-${song.id}">
      <div class="mo-disc" style="background:radial-gradient(circle at 35% 35%,${c1},${c2})"></div>
      <div class="mo-info"><div class="mo-title">${esc(song.title)}</div><div class="mo-artist">${esc(song.artist)}</div></div>
      ${sel ? `<button class="mo-trim-btn" onclick="event.stopPropagation();openClipSheet('${fnName}')">✂ Trim</button>` : ''}
      <div class="mo-check" id="${fnName}-mc-${song.id}">${sel ? '✓' : ''}</div>
    </div>`;
  }).join('');
}

function getClipLabel(mode) {
  const cs = state.clipSheet;
  if (!cs.songId) return '';
  return `${fmtTime(cs.startTime)}–${fmtTime(cs.endTime)}`;
}

function selectSong(id) {
  const prev = state.selectedSongId;
  state.selectedSongId = prev === id ? null : id;
  if (!state.selectedSongId) {
    state.clipSheet = { mode: null, songId: null, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
  }
  updateSelectorUI('selectSong', state.selectedSongId);
  renderMusicSelector(document.getElementById('music-selector'), state.selectedSongId, 'selectSong');
}

function updateSelectorUI(fnName, selectedId) {
  document.querySelectorAll(`[id^="${fnName}-mo-"]`).forEach(el => el.classList.remove('selected'));
  document.querySelectorAll(`[id^="${fnName}-mc-"]`).forEach(el => el.textContent = '');
  if (selectedId) {
    document.getElementById(`${fnName}-mo-${selectedId}`)?.classList.add('selected');
    const check = document.getElementById(`${fnName}-mc-${selectedId}`);
    if (check) check.textContent = '✓';
  }
}

// ── CLIP PICKER SHEET ─────────────────────────────────────────────
function openClipSheet(fnName) {
  const mode   = fnName === 'selectSong' ? 'create' : 'edit';
  const songId = mode === 'create' ? state.selectedSongId : state.editPost?.selectedSongId;
  if (!songId) return;

  const song   = state.musicIndex.find(s => s.id === songId);
  if (!song) return;

  // Preserve existing clip times
  const cs = state.clipSheet;
  if (cs.songId !== songId) {
    state.clipSheet = { mode, songId, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
  } else {
    state.clipSheet.mode = mode;
  }

  document.getElementById('clip-sheet-song').textContent   = song.title;
  document.getElementById('clip-sheet-artist').textContent = song.artist || '';
  document.getElementById('clip-start-slider').value = state.clipSheet.startTime;
  const _endVal = state.clipSheet.endTime ?? (state.clipSheet.duration || 300);
  document.getElementById('clip-end-slider').value   = _endVal;
  document.getElementById('clip-start-time').textContent = fmtTime(state.clipSheet.startTime);
  document.getElementById('clip-end-time').textContent   = state.clipSheet.endTime === null ? 'full' : fmtTime(state.clipSheet.endTime);
  updateClipVisual();
  updateClipDurationLabel();
  openSheet('sheet-clip');
  loadClipDuration(songId);
}

async function loadClipDuration(songId) {
  const song = state.musicIndex.find(s => s.id === songId);
  if (!song) return;
  try {
    const url = await ghBlobUrl(`music/${song.filename}`);
    if (!url) return;
    const tmp = new Audio(url);
    state.clipSheet.previewAudio = tmp;
    tmp.addEventListener('loadedmetadata', () => {
      const dur = Math.floor(tmp.duration);
      state.clipSheet.duration = dur;
      document.getElementById('clip-start-slider').max = Math.max(0, dur - 2);
      document.getElementById('clip-end-slider').max   = dur;
      // Clamp values
      if (state.clipSheet.endTime === null || state.clipSheet.endTime > dur) {
        state.clipSheet.endTime = dur;
        document.getElementById('clip-end-slider').value = dur;
        document.getElementById('clip-end-time').textContent = fmtTime(dur);
      }
      updateClipVisual();
      updateClipDurationLabel();
    });
    tmp.load();
  } catch {}
}

function onClipStartChange(val) {
  val = parseInt(val);
  // End must be at least start + 2s
  if (val >= state.clipSheet.endTime) {
    state.clipSheet.endTime = Math.min(val + 2, state.clipSheet.duration || 300);
    document.getElementById('clip-end-slider').value = state.clipSheet.endTime;
    document.getElementById('clip-end-time').textContent = fmtTime(state.clipSheet.endTime);
  }
  state.clipSheet.startTime = val;
  document.getElementById('clip-start-time').textContent = fmtTime(val);
  updateClipVisual();
  updateClipDurationLabel();
  // Seek preview if playing
  const pa = state.clipSheet.previewAudio;
  if (pa && !pa.paused) pa.currentTime = val;
}

function onClipEndChange(val) {
  val = parseInt(val);
  // Start must be at most end - 2s
  if (val <= state.clipSheet.startTime) {
    state.clipSheet.startTime = Math.max(0, val - 2);
    document.getElementById('clip-start-slider').value = state.clipSheet.startTime;
    document.getElementById('clip-start-time').textContent = fmtTime(state.clipSheet.startTime);
  }
  state.clipSheet.endTime = val;
  document.getElementById('clip-end-time').textContent = fmtTime(val);
  updateClipVisual();
  updateClipDurationLabel();
}

function updateClipVisual() {
  const cs   = state.clipSheet;
  const dur  = cs.duration || 300;
  const pct  = (t) => (t / dur * 100).toFixed(1) + '%';
  const fill = document.getElementById('clip-visual-fill');
  if (!fill) return;
  fill.style.left  = pct(cs.startTime);
  fill.style.width = pct(cs.endTime - cs.startTime);
}

function updateClipDurationLabel() {
  const cs  = state.clipSheet;
  const len = Math.max(0, cs.endTime - cs.startTime);
  const el  = document.getElementById('clip-duration-val');
  if (el) el.textContent = `${len}s`;
}

async function toggleClipPreview() {
  const btn = document.getElementById('clip-preview-btn');
  let pa    = state.clipSheet.previewAudio;

  if (pa && !pa.paused) {
    pa.pause();
    btn.textContent = '▶ Preview clip';
    btn.classList.remove('playing');
    return;
  }

  if (!pa || !pa.src) {
    await loadClipDuration(state.clipSheet.songId);
    pa = state.clipSheet.previewAudio;
    if (!pa) { showToast('Could not load preview', '', 'warning'); return; }
    await new Promise(r => setTimeout(r, 300));
  }

  pa.currentTime = state.clipSheet.startTime || 0;

  const stopAt = state.clipSheet.endTime || pa.duration || 9999;
  pa.ontimeupdate = () => {
    updateClipPlayhead(pa.currentTime);
    if (pa.currentTime >= stopAt) {
      pa.pause();
      pa.currentTime = state.clipSheet.startTime || 0;
      updateClipPlayhead(state.clipSheet.startTime || 0);
      if (btn) { btn.textContent = '▶ Preview clip'; btn.classList.remove('playing'); }
    }
  };
  pa.onpause = pa.onended = () => {
    if (btn) { btn.textContent = '▶ Preview clip'; btn.classList.remove('playing'); }
    updateClipPlayhead(state.clipSheet.startTime || 0);
  };

  pa.play().then(() => {
    btn.textContent = '⏸ Stop preview';
    btn.classList.add('playing');
  }).catch(() => {
    showToast('Preview unavailable', '', 'warning');
  });
}

function stopClipPreviewAudio() {
  const pa = state.clipSheet.previewAudio;
  if (pa) { pa.pause(); pa.src = ''; state.clipSheet.previewAudio = null; }
}

function updateClipPlayhead(currentTime) {
  const cs  = state.clipSheet;
  const dur = cs.duration || 300;
  const ph  = document.getElementById('clip-playhead');
  if (ph) ph.style.left = (currentTime / dur * 100).toFixed(1) + '%';
}

function closeClipSheet() {
  stopClipPreviewAudio();
  updateClipPlayhead(0);
  closeSheet('sheet-clip');
}

function confirmClipSheet() {
  stopClipPreviewAudio();
  state.clipSheet.trimConfirmed = true;
  closeSheet('sheet-clip');
  // Refresh the selector to show updated clip times
  const mode = state.clipSheet.mode;
  if (mode === 'create') {
    renderMusicSelector(document.getElementById('music-selector'), state.selectedSongId, 'selectSong');
  } else if (mode === 'edit' && state.editPost) {
    state.editPost.songStartTime = state.clipSheet.startTime;
    state.editPost.songEndTime   = state.clipSheet.endTime;
    renderMusicSelector(document.getElementById('edit-music-selector'), state.editPost.selectedSongId, 'selectEditSong');
  }
}

// ── SUBMIT CREATE POST ────────────────────────────────────────────
async function submitPost() {
  if (!state.pendingMedia?.length) return;
  const btn = document.getElementById('btn-post');
  btn.disabled = true;
  const progress = document.getElementById('upload-progress');
  progress.classList.add('visible');

  const postId      = generatePostId();
  const caption     = document.getElementById('caption-input').value.trim();
  const location    = document.getElementById('location-input').value.trim();
  const selectedSong = state.selectedSongId ? state.musicIndex.find(s => s.id === state.selectedSongId) : null;

  try {
    const mediaEntries = [];
    const total = state.pendingMedia.length + (selectedSong ? 1 : 0) + 2;
    let done = 0;
    const upd = (label, file, pct) => {
      document.getElementById('upload-label').textContent = label;
      document.getElementById('upload-pct').textContent   = Math.round(pct) + '%';
      document.getElementById('upload-bar-fill').style.width = pct + '%';
      document.getElementById('upload-file').textContent  = file;
      document.getElementById('upload-count').textContent = `${done} / ${total}`;
    };

    let thumbnail_b64 = null;
    const firstImgFile = state.pendingMedia.find(f => f.type.startsWith('image/'));
    const firstVidFile = state.pendingMedia.find(f => f.type.startsWith('video/'));
    if (firstImgFile) thumbnail_b64 = await generateThumbnail(firstImgFile);
    else if (firstVidFile) thumbnail_b64 = await generateVideoThumbnail(firstVidFile);

    for (let i = 0; i < state.pendingMedia.length; i++) {
      const file    = state.pendingMedia[i];
      const isVideo = file.type.startsWith('video/');
      const ext     = file.name.split('.').pop().toLowerCase();
      const filename = `media_${i + 1}.${ext}`;
      upd(`Uploading ${isVideo ? 'video' : 'photo'} ${i + 1}…`, file.name, (done / total) * 100);
      await ghPutBinary(`posts/${postId}/${filename}`, await file.arrayBuffer(), null, `memoir: add media to ${postId}`);
      mediaEntries.push({ filename, type: isVideo ? 'video' : 'image', order: i + 1 });
      done++;
    }

    let songMeta = null;
    if (selectedSong) {
      upd('Adding music…', selectedSong.filename, (done / total) * 100);
      const fileInfo = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/music/${selectedSong.filename}`);
      let songBuffer;
      try {
        const r = await fetch(fileInfo?.download_url);
        if (!r.ok) throw new Error();
        songBuffer = await r.arrayBuffer();
      } catch {
        const b64 = fileInfo?.content?.replace(/\n/g, '');
        songBuffer = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
      }
      await ghPutBinary(`posts/${postId}/song.mp3`, songBuffer, null, `memoir: add song to ${postId}`);
      songMeta = { title: selectedSong.title, artist: selectedSong.artist, filename: 'song.mp3', startTime: state.clipSheet.trimConfirmed ? (state.clipSheet.startTime || 0) : 0, endTime: state.clipSheet.trimConfirmed ? state.clipSheet.endTime : null };
      done++;
    }

    upd('Saving post…', 'meta.json', (done / total) * 100);
    const meta = { id: postId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), caption, location, media: mediaEntries, song: songMeta };
    await ghPutFile(`posts/${postId}/meta.json`, meta, null, `memoir: create post ${postId}`);
    done++;

    upd('Updating feed…', 'posts-index.json', 95);
    const firstMedia = mediaEntries[0];
    const indexEntry = { id: postId, date: postId.split('-').slice(0,3).join('-'), captionPreview: caption.slice(0, 120), location, thumbnail: firstMedia?.type === 'image' ? `posts/${postId}/${firstMedia.filename}` : null, thumbnail_b64, songTitle: songMeta?.title || null, songArtist: songMeta?.artist || null, mediaCount: mediaEntries.length, hasVideo: mediaEntries.some(m => m.type === 'video') };
    const updatedIndex = await ghUpdateIndexRetry('posts-index.json', existing => [indexEntry, ...existing], `memoir: add post ${postId}`);

    state.posts = updatedIndex;
    state.filteredPosts = updatedIndex;
    showToast('Posted ✦', 'Memory saved to GitHub', 'success');
    logEvent('createPost', 'success', postId);

    // Reset
    state.pendingMedia   = [];
    state.selectedSongId = null;
    state.clipSheet      = { mode: null, songId: null, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
    document.getElementById('caption-input').value  = '';
    document.getElementById('location-input').value = '';
    const mp = document.getElementById('media-picker');
    document.getElementById('media-grid').style.display = 'none';
    document.getElementById('media-add-btn').style.display = 'none';
    mp.querySelector('.media-picker-icon').style.display = '';
    mp.querySelector('.media-picker-text').style.display = '';
    mp.querySelector('.media-picker-sub').style.display  = '';
    progress.classList.remove('visible');
    btn.disabled = false;
    renderFeed(state.filteredPosts);
    goBack();
  } catch (err) {
    showError('Post failed', err);
    btn.disabled = false;
    progress.classList.remove('visible');
  }
}

// ── EDIT POST ─────────────────────────────────────────────────────
async function openEditPost() {
  const meta = state.currentPost;
  if (!meta) return;
  const _audio = document.getElementById('audio-player');
  if (_audio) { _audio.pause(); _audio.removeAttribute('src'); _audio.load(); _audio._eventsSet = false; }
  state.songPausedByVideo = false;
  hideVideoAudioToggle();
  state.editPost = {
    postId: meta.id,
    originalCaption:  meta.caption  || '',
    originalLocation: meta.location || '',
    originalSong:     meta.song ? JSON.parse(JSON.stringify(meta.song)) : null,
    originalMedia:    [...meta.media].sort((a, b) => a.order - b.order),
    currentMedia:     [...meta.media].sort((a, b) => a.order - b.order).map(m => ({ ...m, _status: 'existing' })),
    selectedSongId:   null,
    songChanged:      false,
    songStartTime:    meta.song?.startTime || 0,
    songEndTime:      meta.song?.endTime   || null,
  };
  if (meta.song) {
    const match = state.musicIndex.find(s => s.title === meta.song.title && s.artist === meta.song.artist);
    if (match) state.editPost.selectedSongId = match.id;
  }
  state.editFolderUrls = await ghFolderUrls(`posts/${meta.id}`);
  document.getElementById('edit-date-value').textContent  = formatDate(meta.createdAt?.split('T')[0]);
  document.getElementById('edit-caption-input').value     = meta.caption  || '';
  document.getElementById('edit-location-input').value    = meta.location || '';
  renderEditMediaStrip();
  await loadMusicForEdit();
  navigateTo('screen-edit');
}

function renderEditMediaStrip() {
  const strip = document.getElementById('edit-media-strip');
  const ep    = state.editPost;
  strip.innerHTML = '';
  ep.currentMedia.forEach((m, i) => {
    const thumb = document.createElement('div');
    thumb.className  = 'edit-media-thumb' + (m._status === 'delete' ? ' to-delete' : '');
    thumb.dataset.index = i;
    let mediaEl;
    if (m._status === 'new') {
      const url = URL.createObjectURL(m._file);
      mediaEl   = m.type === 'video' ? Object.assign(document.createElement('video'), { src: url, muted: true }) : Object.assign(document.createElement('img'), { src: url, alt: '' });
    } else {
      mediaEl = m.type === 'video'
        ? Object.assign(document.createElement('video'), { muted: true })
        : Object.assign(document.createElement('img'), { alt: '' });
      ghBlobUrl(`posts/${ep.postId}/${m.filename}`).then(url => {
        if (url) mediaEl.src = url;
      });
    }
    const removeBtn = document.createElement('button');
    removeBtn.className   = 'media-remove-btn';
    removeBtn.textContent = m._status === 'delete' ? '↩' : '✕';
    removeBtn.onclick     = () => toggleEditMediaDelete(i);
    const handle = document.createElement('div');
    handle.className   = 'drag-handle';
    handle.textContent = '⠿';
    thumb.appendChild(mediaEl);
    thumb.appendChild(removeBtn);
    thumb.appendChild(handle);
    strip.appendChild(thumb);
    setupEditDragEvents(thumb, i);
  });
  const addBtn = document.createElement('div');
  addBtn.className = 'edit-add-more';
  addBtn.innerHTML = `+ <span>Add more</span>`;
  addBtn.onclick   = () => { const inp = document.getElementById('edit-media-input'); inp.value = ''; inp.click(); };
  strip.appendChild(addBtn);
}

function toggleEditMediaDelete(index) {
  const m = state.editPost.currentMedia[index];
  if (m._status === 'new')        state.editPost.currentMedia.splice(index, 1);
  else if (m._status === 'delete') m._status = 'existing';
  else                             m._status = 'delete';
  renderEditMediaStrip();
}

let editDragSrc = null;
function setupEditDragEvents(el, index) {
  el.addEventListener('dragstart', () => { editDragSrc = index; setTimeout(() => el.classList.add('dragging'), 0); });
  el.addEventListener('dragend',   () => { el.classList.remove('dragging'); document.querySelectorAll('.edit-media-thumb').forEach(t => t.classList.remove('drag-over')); });
  el.addEventListener('dragover',  e  => { e.preventDefault(); document.querySelectorAll('.edit-media-thumb').forEach(t => t.classList.remove('drag-over')); el.classList.add('drag-over'); });
  el.addEventListener('drop', e => {
    e.preventDefault();
    if (editDragSrc === null || editDragSrc === index) return;
    const items = state.editPost.currentMedia;
    const [moved] = items.splice(editDragSrc, 1);
    items.splice(index, 0, moved);
    editDragSrc = null;
    renderEditMediaStrip();
  });
  el.draggable = true;
}

function handleEditAddMedia(files) {
  const canAdd = MAX_MEDIA - state.editPost.currentMedia.length;
  if (canAdd <= 0) { showToast('Max media', 'Cannot exceed 10 items', 'warning'); return; }
  let orderMax = state.editPost.currentMedia.reduce((m, x) => Math.max(m, x.order || 0), 0);
  Array.from(files).slice(0, canAdd).forEach((file, i) => {
    const isVideo = file.type.startsWith('video/');
    const ext     = file.name.split('.').pop().toLowerCase();
    state.editPost.currentMedia.push({ filename: `media_new_${Date.now()}_${i}.${ext}`, type: isVideo ? 'video' : 'image', order: ++orderMax, _status: 'new', _file: file });
  });
  renderEditMediaStrip();
}

async function loadMusicForEdit() {
  const selector = document.getElementById('edit-music-selector');
  try {
    if (!state.musicIndex.length) {
      const file = await ghGetFile('music/music-index.json');
      state.musicIndex = file?.content || [];
    }
    if (!state.musicIndex.length) { selector.innerHTML = `<div style="font-size:12px;color:var(--text-faint);padding:8px 0">No songs yet</div>`; return; }
    renderMusicSelector(selector, state.editPost.selectedSongId, 'selectEditSong');
  } catch { selector.innerHTML = `<div style="font-size:12px;color:var(--rose)">Couldn't load library</div>`; }
}

function selectEditSong(id) {
  const prev = state.editPost.selectedSongId;
  state.editPost.selectedSongId = prev === id ? null : id;
  state.editPost.songChanged    = true;
  if (!state.editPost.selectedSongId) {
    state.clipSheet = { mode: null, songId: null, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
  }
  renderMusicSelector(document.getElementById('edit-music-selector'), state.editPost.selectedSongId, 'selectEditSong');
}

async function submitEdit() {
  const ep = state.editPost;
  if (!ep) return;
  const btn = document.getElementById('btn-save-edit');
  btn.disabled = true;
  const progress = document.getElementById('edit-upload-progress');
  progress.classList.add('visible');

  const newCaption  = document.getElementById('edit-caption-input').value.trim();
  const newLocation = document.getElementById('edit-location-input').value.trim();
  const postId      = ep.postId;
  const upd = (label, file, pct) => {
    document.getElementById('edit-upload-label').textContent = label;
    document.getElementById('edit-upload-pct').textContent   = Math.round(pct) + '%';
    document.getElementById('edit-upload-bar-fill').style.width = pct + '%';
    document.getElementById('edit-upload-file').textContent  = file || '';
  };

  try {
    const toDeleteItems = ep.currentMedia.filter(m => m._status === 'delete');
    const toAddItems    = ep.currentMedia.filter(m => m._status === 'new');
    const selectedSong  = ep.selectedSongId ? state.musicIndex.find(s => s.id === ep.selectedSongId) : null;
    const oldSong       = ep.originalSong;
    let step = 0, totalSteps = toDeleteItems.length + toAddItems.length + 2;

    for (const m of toDeleteItems) {
      upd(`Removing…`, m.filename, (step / totalSteps) * 90);
      try { const fi = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/posts/${postId}/${m.filename}`); if (fi?.sha) await ghDeleteFile(`posts/${postId}/${m.filename}`, fi.sha); } catch {}
      step++;
    }
    for (const m of toAddItems) {
      upd(`Uploading…`, m.filename, (step / totalSteps) * 90);
      await ghPutBinary(`posts/${postId}/${m.filename}`, await m._file.arrayBuffer(), null, `memoir: add media to ${postId}`);
      step++;
    }

    let newSongMeta = oldSong;
    if (ep.songChanged) {
      if (!selectedSong) {
        if (oldSong?.filename === 'song.mp3') {
          try { const fi = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/posts/${postId}/song.mp3`); if (fi?.sha) await ghDeleteFile(`posts/${postId}/song.mp3`, fi.sha); } catch {}
        }
        newSongMeta = null;
      } else if (!oldSong || selectedSong.title !== oldSong.title || selectedSong.artist !== oldSong.artist) {
        upd('Updating song…', selectedSong.filename, (step / totalSteps) * 90);
        if (oldSong?.filename === 'song.mp3') {
          try { const fi = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/posts/${postId}/song.mp3`); if (fi?.sha) await ghDeleteFile(`posts/${postId}/song.mp3`, fi.sha); } catch {}
        }
        const fileInfo = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/music/${selectedSong.filename}`);
        let songBuffer;
        try { const r = await fetch(fileInfo?.download_url); songBuffer = await r.arrayBuffer(); }
        catch { songBuffer = Uint8Array.from(atob(fileInfo?.content?.replace(/\n/g,'')), c => c.charCodeAt(0)).buffer; }
        await ghPutBinary(`posts/${postId}/song.mp3`, songBuffer, null, `memoir: update song in ${postId}`);
        newSongMeta = { title: selectedSong.title, artist: selectedSong.artist, filename: 'song.mp3', startTime: state.clipSheet.trimConfirmed ? (state.clipSheet.startTime || 0) : (ep.songStartTime || 0), endTime: state.clipSheet.trimConfirmed ? state.clipSheet.endTime : (ep.songEndTime || null) };
        step++;
      } else if (oldSong) {
        newSongMeta = { ...oldSong, startTime: ep.songStartTime || 0, endTime: ep.songEndTime || null };
      }
    }

    const finalMedia = ep.currentMedia.filter(m => m._status !== 'delete').map((m, i) => ({ filename: m.filename, type: m.type, order: i + 1 }));
    upd('Saving…', 'meta.json', 90);
    const metaFile    = await ghGetFile(`posts/${postId}/meta.json`);
    const updatedMeta = { ...metaFile.content, caption: newCaption, location: newLocation, media: finalMedia, song: newSongMeta, updatedAt: new Date().toISOString() };
    await ghPutFile(`posts/${postId}/meta.json`, updatedMeta, metaFile.sha, `memoir: edit post ${postId}`);

    const firstImage   = finalMedia.find(m => m.type === 'image');
    let new_thumbnail_b64 = null;
    const activeMedia  = ep.currentMedia.filter(m => m._status !== 'delete');
    const firstNewImg  = activeMedia.find(m => m._status === 'new' && m.type === 'image');
    const firstNewVid  = activeMedia.find(m => m._status === 'new' && m.type === 'video');
    const firstActive  = activeMedia[0];
    if (firstNewImg && firstActive === firstNewImg) {
      new_thumbnail_b64 = await generateThumbnail(firstNewImg._file);
    } else if (!firstImage && firstNewVid) {
      new_thumbnail_b64 = await generateVideoThumbnail(firstNewVid._file);
    }
    upd('Updating feed…', 'posts-index.json', 95);
    const updatedIndex = await ghUpdateIndexRetry('posts-index.json', existing => existing.map(p => {
      if (p.id !== postId) return p;
      return { ...p, captionPreview: newCaption.slice(0, 120), location: newLocation, thumbnail: firstImage ? `posts/${postId}/${firstImage.filename}` : null, thumbnail_b64: new_thumbnail_b64 || p.thumbnail_b64, songTitle: newSongMeta?.title || null, songArtist: newSongMeta?.artist || null, mediaCount: finalMedia.length, hasVideo: finalMedia.some(m => m.type === 'video') };
    }), `memoir: update index ${postId}`);
    state.posts = updatedIndex;
    state.filteredPosts = updatedIndex;
    renderFeed(state.filteredPosts);
    state.currentPost = updatedMeta;
    showToast('Saved ✦', 'Memory updated', 'success');
    logEvent('editPost', 'success', postId);
    stopClipPreviewAudio();
    progress.classList.remove('visible');
    btn.disabled = false;
    state.editPost = null;
    goBack();
    setTimeout(() => openPost(postId), 80);
  } catch (err) {
    showError('Save failed', err);
    btn.disabled = false;
    progress.classList.remove('visible');
  }
}

// ── MUSIC LIBRARY ─────────────────────────────────────────────────
async function loadMusicLibrary() {
  const list = document.getElementById('music-list');
  list.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:13px">Loading…</div>`;
  try {
    const file = await ghGetFile('music/music-index.json');
    state.musicIndex = file?.content || [];
    state.musicQuery = document.getElementById('music-search-input')?.value?.toLowerCase().trim() || '';
    if (!state.musicIndex.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">♫</div><div class="empty-title">No songs yet</div><div class="empty-sub">Tap + to add a song</div></div>`;
      document.getElementById('music-storage-bar').style.display = 'none';
      return;
    }
    renderMusicLibraryList();
    const totalBytes = state.musicIndex.reduce((s, m) => s + (m.sizeBytes || 0), 0);
    document.getElementById('msb-value').textContent = `${(totalBytes/1024/1024).toFixed(0)} MB / 1 GB`;
    document.getElementById('msb-fill').style.width  = Math.min((totalBytes/(1024*1024*1024))*100, 100) + '%';
    document.getElementById('music-storage-bar').style.display = 'block';
  } catch (err) {
    list.innerHTML = `<div style="padding:18px;color:var(--rose);font-size:13px">Failed: ${err.message}</div>`;
    showError('Music library failed', err);
  }
}

function filterMusicList(query) {
  state.musicQuery = query.toLowerCase().trim();
  renderMusicLibraryList();
}

function renderMusicLibraryList() {
  const list = document.getElementById('music-list');
  if (!list) return;
  const q = state.musicQuery;
  const filtered = q
    ? state.musicIndex.filter(s =>
        s.title.toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q))
    : state.musicIndex;
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">♫</div><div class="empty-title">${q ? 'No matches' : 'No songs yet'}</div><div class="empty-sub">${q ? 'Try a different search' : 'Tap + to add'}</div></div>`;
    return;
  }
  list.innerHTML = filtered.map(song => {
    const [c1, c2] = discColor(song.id || song.title);
    return `<div class="music-item">
      <div class="mi-disc" id="disc-${song.id}" style="background:radial-gradient(circle at 35% 35%,${c1},${c2})" onclick="previewSong('${song.id}')"></div>
      <div class="mi-info" onclick="previewSong('${song.id}')">
        <div class="mi-title">${esc(song.title)}</div>
        <div class="mi-artist">${esc(song.artist)}</div>
        <div class="mi-size">${((song.sizeBytes||0)/1024/1024).toFixed(1)} MB</div>
      </div>
      <button class="mi-play" id="play-${song.id}" onclick="previewSong('${song.id}')">▶</button>
      <button class="mi-delete" onclick="promptDeleteSong('${song.id}')" title="Delete song">✕</button>
    </div>`;
  }).join('');
}

let previewAudio = null, previewingId = null;

async function previewSong(id) {
  const song = state.musicIndex.find(s => s.id === id);
  if (!song) return;
  if (previewingId === id) {
    if (previewAudio?.paused === false) {
      previewAudio.pause();
      document.getElementById(`disc-${id}`)?.classList.remove('playing');
      document.getElementById(`play-${id}`).textContent = '▶';
    } else if (previewAudio) {
      previewAudio.play().catch(() => {});
      document.getElementById(`disc-${id}`)?.classList.add('playing');
      document.getElementById(`play-${id}`).textContent = '⏸';
    }
    return;
  }
  if (previewAudio) { previewAudio.pause(); previewAudio.src = ''; previewAudio = null; }
  if (previewingId) {
    document.getElementById(`disc-${previewingId}`)?.classList.remove('playing');
    const pb = document.getElementById(`play-${previewingId}`);
    if (pb) pb.textContent = '▶';
  }
  previewingId = id;
  const btn = document.getElementById(`play-${id}`);
  if (btn) btn.textContent = '…';
  try {
    const url = await ghBlobUrl(`music/${song.filename}`);
    if (!url) throw new Error('No URL');
    previewAudio = new Audio(url);
    previewAudio.addEventListener('play',  () => { document.getElementById(`disc-${id}`)?.classList.add('playing');    if (btn) btn.textContent = '⏸'; });
    previewAudio.addEventListener('pause', () => { document.getElementById(`disc-${id}`)?.classList.remove('playing'); if (btn) btn.textContent = '▶'; });
    previewAudio.addEventListener('ended', () => { document.getElementById(`disc-${id}`)?.classList.remove('playing'); if (btn) btn.textContent = '▶'; previewingId = null; previewAudio = null; });
    previewAudio.addEventListener('error', () => { if (btn) btn.textContent = '▶'; showToast('Playback error', '', 'error'); });
    await previewAudio.play();
  } catch (err) {
    if (btn) btn.textContent = '▶';
    showToast('Preview failed', err.message, 'error');
    previewingId = null;
  }
}

// ── DELETE SONG ───────────────────────────────────────────────────
let songToDelete = null;
function promptDeleteSong(songId) {
  songToDelete = songId;
  const song = state.musicIndex.find(s => s.id === songId);
  document.getElementById('delete-song-name').textContent = song?.title || 'this song';
  openSheet('sheet-delete-song');
}
async function confirmDeleteSong() {
  closeSheet('sheet-delete-song');
  const id   = songToDelete;
  songToDelete = null;
  if (!id) return;
  const song = state.musicIndex.find(s => s.id === id);
  if (!song) return;
  if (previewingId === id && previewAudio) { previewAudio.pause(); previewAudio.src = ''; previewAudio = null; previewingId = null; }
  showToast('Deleting song…', '', 'info', 10000);
  try {
    const fi = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/music/${song.filename}`);
    if (fi?.sha) await ghDeleteFile(`music/${song.filename}`, fi.sha, `memoir: delete song ${song.title}`);
    const indexFile = await ghGetFile('music/music-index.json');
    const updated   = (indexFile?.content || []).filter(s => s.id !== id);
    await ghPutFile('music/music-index.json', updated, indexFile?.sha, `memoir: remove ${song.title} from index`);
    state.musicIndex = updated;
    showToast('Song deleted', song.title, 'success');
    logEvent('deleteSong', 'success', song.title);
    loadMusicLibrary();
  } catch (err) { showError('Delete song failed', err); }
}

function openAddSong() { document.getElementById('song-file-input').click(); }

async function handleSongFile(file) {
  if (!file) return;
  if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|m4a|wav)$/i)) { showToast('Invalid file', 'Only mp3, m4a, wav supported', 'error'); return; }
  if (file.size > 25 * 1024 * 1024) showToast('File too large', 'GitHub limit is 25MB', 'warning');
  state.pendingSong = { file };
  document.getElementById('song-title-input').value  = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  document.getElementById('song-artist-input').value = '';
  document.getElementById('sheet-song-filename').textContent = `File: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)`;
  openSheet('sheet-song-meta');
}

async function confirmAddSong() {
  const title  = document.getElementById('song-title-input').value.trim();
  const artist = document.getElementById('song-artist-input').value.trim();
  const file   = state.pendingSong?.file;
  if (!title || !file) { showToast('Title required', '', 'warning'); return; }
  closeSheet('sheet-song-meta');
  const ext      = file.name.split('.').pop().toLowerCase();
  const id       = slugify(`${title}-${artist}`);
  const filename = `${id}.${ext}`;
  if (state.musicIndex.find(s => s.filename === filename)) { showToast('Duplicate', `"${title}" already exists`, 'warning'); return; }
  showToast('Uploading song…', filename, 'info', 15000);
  try {
    await ghPutBinary(`music/${filename}`, await file.arrayBuffer(), null, `memoir: add song ${title}`);
    const indexFile = await ghGetFile('music/music-index.json');
    const newEntry  = { id, title, artist, filename, sizeBytes: file.size, addedOn: new Date().toISOString().split('T')[0] };
    const updated   = [...(indexFile?.content || []), newEntry];
    await ghPutFile('music/music-index.json', updated, indexFile?.sha, `memoir: add ${title} to index`);
    state.musicIndex = updated;
    showToast('Song added', `${title} is in your library`, 'success');
    logEvent('addSong', 'success', title);
    loadMusicLibrary();
    state.pendingSong = null;
  } catch (err) { showError('Upload failed', err); }
}

async function syncMusicLibrary() {
  showToast('Syncing…', '', 'info');
  try {
    const folder = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/music`);
    if (!Array.isArray(folder)) throw new Error('music/ folder not found');
    const audioFiles = folder.filter(f => /\.(mp3|m4a|wav)$/i.test(f.name));
    const indexFile  = await ghGetFile('music/music-index.json');
    const current    = indexFile?.content || [];
    let added = 0;
    for (const f of audioFiles) {
      if (!current.find(s => s.filename === f.name)) {
        const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        current.push({ id: slugify(name), title: name, artist: '', filename: f.name, sizeBytes: f.size, addedOn: new Date().toISOString().split('T')[0] });
        added++;
      }
    }
    await ghPutFile('music/music-index.json', current, indexFile?.sha, `memoir: sync music (+${added})`);
    state.musicIndex = current;
    showToast('Synced', `${added} new song${added !== 1 ? 's' : ''} added`, 'success');
    loadMusicLibrary();
  } catch (err) { showError('Sync failed', err); }
}

// ── REORDER POSTS ─────────────────────────────────────────────────
function loadReorderScreen() {
  state.reorderOriginal = [...state.posts];
  state.reorderCurrent  = [...state.posts];
  renderReorderList();
}

function renderReorderList() {
  const list = document.getElementById('reorder-list');
  if (!state.reorderCurrent.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">⊟</div><div class="empty-title">No posts yet</div></div>`;
    return;
  }
  list.innerHTML = state.reorderCurrent.map((post, i) => {
    const thumbSrc = post.thumbnail_b64 || (post.thumbnail ? `https://raw.githubusercontent.com/${state.auth.username}/${state.auth.repo}/main/${post.thumbnail}` : null);
    return `<div class="reorder-card" data-index="${i}">
      <div class="reorder-handle" data-index="${i}">⠿</div>
      <div class="reorder-thumb">${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ''}</div>
      <div class="reorder-info">
        <div class="reorder-date">${formatDate(post.date)}</div>
        <div class="reorder-caption">${esc(post.captionPreview || '(no caption)')}</div>
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.reorder-handle').forEach(handle => setupReorderPointerDrag(handle));
}

function setupReorderPointerDrag(handle) {
  let ghost = null, dragIdx = null, offsetX = 0, offsetY = 0;
  function idxFromY(y) {
    const cards = [...document.querySelectorAll('.reorder-card')];
    for (let i = 0; i < cards.length; i++) { const r = cards[i].getBoundingClientRect(); if (y >= r.top && y <= r.bottom) return i; }
    return cards.length - 1;
  }
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragIdx = parseInt(handle.dataset.index);
    const card = document.querySelectorAll('.reorder-card')[dragIdx];
    const rect = card.getBoundingClientRect();
    offsetX = e.clientX - rect.left; offsetY = e.clientY - rect.top;
    ghost = document.createElement('div');
    ghost.className = 'reorder-ghost';
    ghost.style.width = rect.width + 'px';
    ghost.style.left  = rect.left  + 'px';
    ghost.style.top   = rect.top   + 'px';
    ghost.innerHTML   = card.innerHTML;
    document.body.appendChild(ghost);
    card.classList.add('dragging-source');
  });
  handle.addEventListener('pointermove', e => {
    if (dragIdx === null || !ghost) return;
    e.preventDefault();
    ghost.style.left = (e.clientX - offsetX) + 'px';
    ghost.style.top  = (e.clientY - offsetY) + 'px';
    const hoverIdx = idxFromY(e.clientY);
    document.querySelectorAll('.reorder-card').forEach((c, i) => c.classList.toggle('drag-over', i === hoverIdx && i !== dragIdx));
  });
  handle.addEventListener('pointerup', e => {
    if (dragIdx === null) return;
    const dropIdx = idxFromY(e.clientY);
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.reorder-card').forEach(c => c.classList.remove('dragging-source', 'drag-over'));
    if (dropIdx !== dragIdx) {
      const [moved] = state.reorderCurrent.splice(dragIdx, 1);
      state.reorderCurrent.splice(dropIdx, 0, moved);
      renderReorderList();
    }
    dragIdx = null;
  });
  handle.addEventListener('pointercancel', () => {
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.reorder-card').forEach(c => c.classList.remove('dragging-source', 'drag-over'));
    dragIdx = null;
  });
}

function cancelReorder() { state.reorderCurrent = [...state.reorderOriginal]; goBack(); }
async function saveReorder() {
  showToast('Saving order…', '', 'info', 8000);
  try {
    const indexFile = await ghGetFile('posts-index.json');
    await ghPutFile('posts-index.json', state.reorderCurrent, indexFile?.sha, 'memoir: reorder posts');
    state.posts = [...state.reorderCurrent];
    state.filteredPosts = [...state.reorderCurrent];
    renderFeed(state.filteredPosts);
    showToast('Order saved', '', 'success');
    logEvent('reorderPosts', 'success');
    goBack();
  } catch (err) { showError('Reorder failed', err); }
}

// ── SETTINGS ──────────────────────────────────────────────────────
async function loadSettings() {
  if (!state.auth) return;
  document.getElementById('si-username').textContent = state.auth.username;
  document.getElementById('si-repo').textContent     = state.auth.repo;
  ghGet(`/repos/${state.auth.username}/${state.auth.repo}`).then(d => {
    if (d?.size) document.getElementById('si-storage').textContent = `${(d.size/1024).toFixed(1)} MB`;
  }).catch(() => {});
}
function handleSignOut()  { openSheet('sheet-signout'); }
function confirmSignOut() {
  localStorage.removeItem('memoir_auth'); localStorage.removeItem('memoir_logs');
  state.auth = null; state.posts = []; state.selectedSongId = null; state.musicIndex = [];
  closeSheet('sheet-signout');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-setup').classList.add('active');
  state.navHistory = ['screen-setup'];
}

// ── INSTALL NUDGE ─────────────────────────────────────────────────
function showInstallNudge() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS && !isStandalone && !localStorage.getItem('memoir_nudge_dismissed')) {
    document.getElementById('ios-install-nudge').style.display = 'flex';
  }
}
function dismissInstallNudge() {
  document.getElementById('ios-install-nudge').style.display = 'none';
  localStorage.setItem('memoir_nudge_dismissed', '1');
}

// ── QR EXPORT ─────────────────────────────────────────────────────
function showQRExport() {
  if (!state.auth) return;
  const wrap = document.getElementById('qr-canvas-wrap');
  wrap.innerHTML = '';
  try {
    new QRCode(wrap, { text: JSON.stringify({ u: state.auth.username, r: state.auth.repo, t: state.auth.token, e: state.auth.email || '' }), width: 170, height: 170, colorDark: '#0e0c0a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  } catch { wrap.innerHTML = `<div style="color:var(--rose);font-size:11px;text-align:center">QR generation failed</div>`; }
  document.getElementById('qr-overlay').classList.add('open');
}
function closeQRExport() { document.getElementById('qr-overlay').classList.remove('open'); }

// ── HELPERS ───────────────────────────────────────────────────────
function esc(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatDate(dateStr) {
  if (!dateStr) return '';
  try { return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return dateStr; }
}
function generatePostId() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${Math.random().toString(36).slice(2,6)}`;
}
function slugify(str) { return str.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60); }
function discColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return DISC_COLORS[Math.abs(hash) % DISC_COLORS.length];
}

// ── BOOT ─────────────────────────────────────────────────────────
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  const auth = await loadAuth();
  if (auth) {
    state.auth = auth;
    navigateTo('screen-feed', false);
    state.navHistory = ['screen-feed'];
    setFeedTabActive();
    showInstallNudge();
    await loadFeed();
    try { const f = await ghGetFile('music/music-index.json'); state.musicIndex = f?.content || []; } catch {}
  } else {
    state.navHistory = ['screen-setup'];
  }
}

boot();
