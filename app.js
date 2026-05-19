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
  auth:             null,   // { username, repo, email, networkOwner, networkRepo, token1, token2, token3, token }
  posts:            [],
  filteredPosts:    [],
  musicIndex:       [],
  currentPost:      null,
  currentPostSource:'personal', // 'personal' | 'friend:username'
  currentSlide:     0,
  pendingMedia:     [],
  navHistory:       ['screen-welcome'],
  activeTab:        'feed',
  selectedSongId:   null,
  editPost:         null,
  reorderOriginal:  [],
  reorderCurrent:   [],
  editFolderUrls:   {},
  feedDateFilter:       null,
  feedLocationFilter:   null,
  musicQuery:           '',
  friends:          {},   // { username: { username, repo, readToken, networkOwner, networkRepo, addedAt } }
  inboxByFriend:    {},   // { username: [shareEntry, ...] }
  lastSeen:         {},   // { username: ISO string } — persisted in localStorage
  personalFolders:  [],   // [{ id, name, color, postIds:[] }]
  sharedFolders:    [],   // from folders-index.json in network repo
  _createFolderCtx: null, // 'create' | 'edit' | 'feed' — which context opened the sheet
  _createFolderColor: 'gold',
  _createFolderType:  'personal',
  _createPostFolders: [],  // folder ids selected in create post
  _editPostFolders:   [],  // folder ids selected in edit post
  threadFriend:     null,
  tokenHealth:      {},   // { 1: 'ok'|'warn'|'bad', 2: ..., 3: ... }
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
  // Setup wizard temps
  _setupOwnerData:  {},
  _setupFriendData: {},
  _ownerLogoTaps:   0,
  _pendingInviteCode: null,
};

// ── DATASOURCE ───────────────────────────────────────────────────
// Multi-repo API abstraction. Sources: 'personal', 'network', 'friend:username'
const DataSource = {
  _blobCache: new Map(),
  sources: {},

  resolve(source) {
    if (source === 'personal') return this.sources.personal;
    if (source === 'network')  return this.sources.network;
    if (source && source.startsWith('friend:')) {
      const name = source.slice(7);
      const f    = this.sources.friends && this.sources.friends[name];
      if (!f) throw Object.assign(new Error(`Unknown friend source: ${name}`), { status: 404 });
      return f;
    }
    throw new Error(`Unknown DataSource: ${source}`);
  },

  async fetch(source, path, options = {}) {
    const src = this.resolve(source);
    if (!src || !src.token) throw Object.assign(new Error(`No token for ${source}`), { status: 401 });
    const { owner, repo, token } = src;
    const url = path.startsWith('http') ? path
      : `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.message || `GitHub ${res.status}`), { status: res.status });
    }
    return res;
  },

  // Returns parsed JSON content of a file, or null if 404.
  async get(source, filePath) {
    try {
      const res = await this.fetch(source, filePath);
      if (res.status === 404) return null;
      const data = await res.json();
      if (!data.content) return null;
      return JSON.parse(atob(data.content.replace(/\n/g, '')));
    } catch { return null; }
  },

  // Returns raw GitHub file object { sha, name, size, ... } or null.
  async getRaw(source, filePath) {
    try {
      const res = await this.fetch(source, filePath);
      if (res.status === 404) return null;
      return res.json();
    } catch { return null; }
  },

  // Writes a JSON file to the given source repo.
  async put(source, filePath, content, message) {
    const existing = await this.getRaw(source, filePath);
    const sha = existing?.sha || null;
    const body = {
      message: message || `memoir: update ${filePath}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
      ...(sha ? { sha } : {}),
    };
    const res = await this.fetch(source, filePath, { method: 'PUT', body: JSON.stringify(body) });
    return res.json();
  },

  // Writes a binary file.
  async putBinary(source, filePath, arrayBuffer, message) {
    const existing = await this.getRaw(source, filePath);
    const sha = existing?.sha || null;
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const body = {
      message: message || `memoir: add ${filePath}`,
      content: btoa(binary),
      ...(sha ? { sha } : {}),
    };
    const res = await this.fetch(source, filePath, { method: 'PUT', body: JSON.stringify(body) });
    return res.json();
  },

  // Lists a folder.
  async listFolder(source, folderPath) {
    try {
      const res = await this.fetch(source, folderPath);
      if (res.status === 404) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  },

  // Returns a blob URL for a binary file (cached by source+path).
  async getBlobUrl(source, filePath) {
    const cacheKey = `${source}::${filePath}`;
    if (!this._blobCache.has(cacheKey)) this._blobCache.set(cacheKey, this._fetchBlobUrl(source, filePath));
    return this._blobCache.get(cacheKey);
  },

  async _fetchBlobUrl(source, filePath) {
    try {
      const buf = await this.getBuffer(source, filePath);
      if (!buf) return null;
      const ext      = filePath.split('.').pop().toLowerCase();
      const mimeType = _MIME[ext] || 'application/octet-stream';
      return URL.createObjectURL(new Blob([buf], { type: mimeType }));
    } catch { return null; }
  },

  // Downloads a file as ArrayBuffer via the Git Blobs API.
  async getBuffer(source, filePath) {
    try {
      const src = this.resolve(source);
      if (!src?.token) return null;
      const { owner, repo, token } = src;
      const info = await this.getRaw(source, filePath);
      if (!info?.sha) return null;
      const res = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${info.sha}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3.raw' } }
      );
      if (!res.ok) return null;
      return res.arrayBuffer();
    } catch { return null; }
  },

  clearBlobCache() {
    this._blobCache.forEach(async p => { const u = await p; if (u) URL.revokeObjectURL(u); });
    this._blobCache.clear();
  },
};

// Music source helpers — routes to network repo if configured, else personal.
function musicSource() {
  return (state.auth?.token3 && state.auth?.networkOwner) ? 'network' : 'personal';
}
async function musicBlobUrl(filename) {
  return DataSource.getBlobUrl(musicSource(), `music/${filename}`);
}
async function musicFetchBuffer(filename) {
  return DataSource.getBuffer(musicSource(), `music/${filename}`);
}

// ── CRYPTO ───────────────────────────────────────────────────────
async function deriveKey() {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode('memoir-key-2024'), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('memoir-salt'), iterations: 100000, hash: 'SHA-256' }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptText(text) {
  if (!text) return '';
  const key = await deriveKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));
}
async function decryptText(b64) {
  if (!b64) return '';
  try {
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const key = await deriveKey();
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return new TextDecoder().decode(dec);
  } catch { return null; }
}

async function saveAuth(auth) {
  const t1Enc = await encryptText(auth.token1 || auth.token || '');
  const t2Enc = await encryptText(auth.token2 || '');
  const t3Enc = await encryptText(auth.token3 || '');
  localStorage.setItem('memoir_auth', JSON.stringify({
    username:     auth.username,
    repo:         auth.repo         || 'memoir-data',
    email:        auth.email        || '',
    networkOwner: auth.networkOwner || '',
    networkRepo:  auth.networkRepo  || '',
    token1Enc: t1Enc,
    token2Enc: t2Enc,
    token3Enc: t3Enc,
  }));
}

async function loadAuth() {
  const raw = localStorage.getItem('memoir_auth');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Backward compat: old single-token format
    if (parsed.tokenEnc && !parsed.token1Enc) {
      const token = await decryptText(parsed.tokenEnc);
      if (!token) return null;
      return {
        username: parsed.username, repo: parsed.repo || 'memoir-data',
        email: parsed.email || '', networkOwner: '', networkRepo: '',
        token1: token, token2: '', token3: '', token: token,
      };
    }
    const token1 = await decryptText(parsed.token1Enc);
    if (!token1) return null;
    const token2 = await decryptText(parsed.token2Enc) || '';
    const token3 = await decryptText(parsed.token3Enc) || '';
    return {
      username:     parsed.username,
      repo:         parsed.repo         || 'memoir-data',
      email:        parsed.email        || '',
      networkOwner: parsed.networkOwner || '',
      networkRepo:  parsed.networkRepo  || '',
      token1, token2, token3,
      token: token1,  // backward compat alias
    };
  } catch { return null; }
}

function initDataSource() {
  DataSource.sources = {};
  DataSource.sources.personal = {
    owner: state.auth.username,
    repo:  state.auth.repo || 'memoir-data',
    token: state.auth.token1 || state.auth.token,
  };
  if (state.auth.token3 && state.auth.networkOwner) {
    DataSource.sources.network = {
      owner: state.auth.networkOwner,
      repo:  state.auth.networkRepo || 'memoir-shared',
      token: state.auth.token3,
    };
  }
  DataSource.sources.friends = {};
  Object.values(state.friends).forEach(f => {
    if (f.username && f.readToken) {
      DataSource.sources.friends[f.username] = {
        owner: f.repoOwner || f.username,
        repo:  f.repo || 'memoir-data',
        token: f.readToken,
      };
    }
  });
}

// ── GITHUB API (personal repo helpers — unchanged for backward compat) ──
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

// Personal-repo blob URL cache (unchanged)
const _blobCache = new Map();
const _MIME = { mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', mp4:'video/mp4', mov:'video/quicktime', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };

function ghBlobUrl(filePath) {
  if (!_blobCache.has(filePath)) _blobCache.set(filePath, _fetchBlobUrl(filePath));
  return _blobCache.get(filePath);
}
async function _fetchBlobUrl(filePath) {
  try {
    const buf = await ghFetchBuffer(filePath);
    if (!buf) return null;
    const ext      = filePath.split('.').pop().toLowerCase();
    const mimeType = _MIME[ext] || 'application/octet-stream';
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  } catch { return null; }
}
async function ghFetchBuffer(filePath) {
  const info = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/${filePath}`);
  if (!info?.sha) return null;
  const res = await fetch(`${GITHUB_API}/repos/${state.auth.username}/${state.auth.repo}/git/blobs/${info.sha}`, {
    headers: { Authorization: `Bearer ${state.auth.token}`, Accept: 'application/vnd.github.v3.raw' }
  });
  if (!res.ok) return null;
  return res.arrayBuffer();
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

// ── TOKEN HEALTH BANNERS ──────────────────────────────────────────
function showBanner(id, msg, type = 'warn') {
  const container = document.getElementById('token-banners');
  if (!container) return;
  if (document.getElementById('banner-' + id)) return; // already shown
  const el = document.createElement('div');
  el.id = 'banner-' + id;
  el.className = `token-banner token-banner-${type}`;
  el.innerHTML = `<span>${msg}</span><button onclick="dismissBanner('${id}')">✕</button>`;
  container.appendChild(el);
}
function dismissBanner(id) {
  document.getElementById('banner-' + id)?.remove();
}

async function checkTokenHealth() {
  if (!state.auth) return;
  // Check token1
  try {
    const res = await fetch(`${GITHUB_API}/user`, { headers: { Authorization: `Bearer ${state.auth.token1}` } });
    state.tokenHealth[1] = res.ok ? 'ok' : 'bad';
    if (!res.ok) showBanner('token1', '⚠ Token 1 (full access) appears expired — update it in Settings.', 'error');
  } catch { state.tokenHealth[1] = 'warn'; }

  // Check token2
  if (state.auth.token2) {
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${state.auth.username}/${state.auth.repo}`,
        { headers: { Authorization: `Bearer ${state.auth.token2}` } }
      );
      state.tokenHealth[2] = res.ok ? 'ok' : 'bad';
      if (!res.ok) showBanner('token2', '⚠ Token 2 (read-only) is expired — friends cannot see your shares. Update in Settings.', 'warn');
    } catch { state.tokenHealth[2] = 'warn'; }
  }

  // Check token3
  if (state.auth.token3 && state.auth.networkOwner) {
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${state.auth.networkOwner}/${state.auth.networkRepo || 'memoir-shared'}`,
        { headers: { Authorization: `Bearer ${state.auth.token3}` } }
      );
      state.tokenHealth[3] = res.ok ? 'ok' : 'bad';
      if (!res.ok) showBanner('token3', '⚠ Token 3 (network) is expired — music and sharing unavailable. Update in Settings.', 'warn');
    } catch { state.tokenHealth[3] = 'warn'; }
  }

  updateTokenStatusUI();
}

function updateTokenStatusUI() {
  const statusText = h => h === 'ok' ? '✓ OK' : h === 'bad' ? '✗ Expired' : '– Not set';
  const el1 = document.getElementById('si-token1-status');
  const el2 = document.getElementById('si-token2-status');
  const el3 = document.getElementById('si-token3-status');
  if (el1) el1.textContent = statusText(state.tokenHealth[1] || (state.auth?.token1 ? 'ok' : ''));
  if (el2) el2.textContent = statusText(state.tokenHealth[2] || (state.auth?.token2 ? 'ok' : '– Not set'));
  if (el3) el3.textContent = statusText(state.tokenHealth[3] || (state.auth?.token3 ? 'ok' : '– Not set'));
  // Token 3 is only relevant for network owners — hide for users who joined via invite
  const isOwner = !state.auth?.networkOwner || state.auth.networkOwner === state.auth?.username;
  const token3Row = el3?.closest('.settings-item');
  if (token3Row) token3Row.style.display = isOwner ? '' : 'none';
}

// ── NAVIGATION ────────────────────────────────────────────────────
function setFeedTabActive() {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('nav-feed')?.classList.add('active');
}
function setChatsTabActive() {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  ['nav-chats','nav-chats-c','nav-chats-s'].forEach(id => document.getElementById(id)?.classList.add('active'));
}
function setMusicTabActive() {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  ['nav-music','nav-music-c','nav-music-m','nav-music-s'].forEach(id => document.getElementById(id)?.classList.add('active'));
}
function setSettingsTabActive() {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  ['nav-settings','nav-settings-c','nav-settings-s'].forEach(id => document.getElementById(id)?.classList.add('active'));
}

function navigateTo(screenId, addHistory = true) {
  const current = document.querySelector('.screen.active');
  if (current?.id === screenId) return;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const next = document.getElementById(screenId);
  if (!next) return;
  next.classList.add('active', 'slide-in');
  setTimeout(() => next.classList.remove('slide-in'), 300);
  if (addHistory) state.navHistory.push(screenId);
  if (screenId === 'screen-settings') loadSettings();
  if (screenId === 'screen-music')    loadMusicLibrary();
  if (screenId === 'screen-create')   { loadMusicForCreate(); initFolderChips('create'); }
  if (screenId === 'screen-edit')     initFolderChips('edit');
  if (screenId === 'screen-reorder')  loadReorderScreen();
  if (screenId === 'screen-chats')    loadChats();
  if (screenId === 'screen-folders')  loadFoldersScreen();
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
  const prevEl = document.getElementById(prev);
  if (prevEl) prevEl.classList.add('active');
  if (prev === 'screen-feed')     setFeedTabActive();
  if (prev === 'screen-chats')    setChatsTabActive();
  if (prev === 'screen-settings') setSettingsTabActive();
}

function switchTab(tab, evt) {
  state.activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const tabMap = { feed: 'screen-feed', music: 'screen-music', chats: 'screen-chats', settings: 'screen-settings' };
  const target = tabMap[tab];
  state.navHistory = (tab === 'feed') ? ['screen-feed'] : ['screen-feed', target];
  navigateTo(target, false);
  if (tab === 'feed')     setFeedTabActive();
  if (tab === 'music')    setMusicTabActive();
  if (tab === 'chats')    setChatsTabActive();
  if (tab === 'settings') setSettingsTabActive();
}

// ── SHEETS ────────────────────────────────────────────────────────
function closeSheet(id) { document.getElementById(id).classList.remove('open'); }
function openSheet(id)  { document.getElementById(id).classList.add('open'); }
function openDeleteSheet() { openSheet('sheet-delete'); }

// ── WELCOME SCREEN ────────────────────────────────────────────────
let _logoTapTimer = null;
function welcomeLogoTap() {
  state._ownerLogoTaps = (state._ownerLogoTaps || 0) + 1;
  clearTimeout(_logoTapTimer);
  _logoTapTimer = setTimeout(() => { state._ownerLogoTaps = 0; }, 2000);
  if (state._ownerLogoTaps >= 7) {
    state._ownerLogoTaps = 0;
    document.getElementById('btn-owner-setup').style.display = '';
  }
}

// ── INVITE / CONNECT CODES ───────────────────────────────────────
function encodeCode(obj) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/=/g, ''); }
  catch { return ''; }
}
function decodeCode(str) {
  try {
    const padded = str + '==='.slice((str.length + 3) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch { return null; }
}

function buildInviteCode() {
  if (!state.auth?.networkOwner) return '';
  return encodeCode({
    networkOwner: state.auth.networkOwner,
    networkRepo:  state.auth.networkRepo || 'memoir-shared',
    invitedBy:    state.auth.username,
    ts:           Date.now(),
  });
}

function buildConnectCode() {
  if (!state.auth?.token2) return '';
  return encodeCode({
    username:  state.auth.username,
    repo:      state.auth.repo,
    readToken: state.auth.token2,
    ts:        Date.now(),
  });
}

function copyOwnerInviteCode() {
  const code = document.getElementById('owner-invite-code')?.textContent;
  if (code && code !== '—') {
    navigator.clipboard.writeText(code).then(() => showToast('Copied', 'Invite code copied to clipboard', 'success'));
  }
}
function copyFriendConnectCode() {
  const code = document.getElementById('friend-connect-code')?.textContent;
  if (code && code !== '—') {
    navigator.clipboard.writeText(code).then(() => showToast('Copied', 'Connect code copied to clipboard', 'success'));
  }
}
function copySettingsInviteCode() {
  const code = buildInviteCode();
  if (code) navigator.clipboard.writeText(code).then(() => showToast('Copied', 'Invite code copied', 'success'));
}

// ── SETUP — OWNER FLOW ───────────────────────────────────────────
function showSetupOwner() {
  state._setupOwnerData = {};
  ownerStep(1);
  navigateTo('screen-setup-owner');
}

function ownerGoBack() {
  const cur = state._setupOwnerData._currentStep || 1;
  if (cur <= 1) { goBack(); return; }
  ownerStep(cur - 1);
}

function ownerStep(n) {
  state._setupOwnerData._currentStep = n;
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`owner-step-${i}`);
    if (el) el.style.display = (i === n) ? '' : 'none';
  }
  const label = document.getElementById('owner-step-label');
  if (label) label.textContent = `Step ${n} of 5`;
  // Hide errors
  for (let i = 1; i <= 4; i++) {
    const err = document.getElementById(`owner-error-${i}`);
    if (err) err.style.display = 'none';
  }
}

function ownerShowError(n, msg) {
  const el = document.getElementById(`owner-error-${n}`);
  if (el) { el.textContent = msg; el.style.display = 'block'; }
  const conn = document.getElementById(`owner-connecting-${n}`);
  if (conn) conn.style.display = 'none';
  const form = document.getElementById(`owner-step-${n}`);
  if (form) {
    form.querySelectorAll('button, input').forEach(e => e.disabled = false);
  }
}

async function ownerStep1Next() {
  const username = document.getElementById('owner-username').value.trim();
  const repo     = document.getElementById('owner-repo').value.trim() || 'memoir-data';
  const token1   = document.getElementById('owner-token1').value.trim();
  if (!username || !token1) { ownerShowError(1, 'Username and token are required.'); return; }

  // Disable inputs
  document.querySelectorAll('#owner-step-1 button, #owner-step-1 input').forEach(e => e.disabled = true);
  document.getElementById('owner-connecting-1').style.display = 'flex';

  const steps = ['os-1a','os-1b','os-1c'];
  let si = 0;
  const adv = () => {
    document.getElementById(steps[si]).classList.add('done');
    si++;
    if (si < steps.length) document.getElementById(steps[si]).classList.add('active');
  };

  try {
    document.getElementById(steps[0]).classList.add('active');
    const tmpAuth = { token: token1, token1, username, repo };
    // Validate token
    const userRes = await fetch(`${GITHUB_API}/user`, { headers: { Authorization: `Bearer ${token1}` } });
    if (!userRes.ok) throw new Error('Invalid token — could not authenticate.');
    adv();

    // Check/create repo
    const tmpState = state.auth;
    state.auth = tmpAuth;
    const repoData = await ghGet(`/repos/${username}/${repo}`);
    adv();

    // Init structure
    await initRepoStructure(repoData === null, username, repo, token1);
    adv();
    await new Promise(r => setTimeout(r, 300));

    state.auth = tmpState;
    state._setupOwnerData = { ...state._setupOwnerData, username, repo, token1 };
    document.getElementById('s2-repo-hint').textContent = repo;
    document.getElementById('owner-connecting-1').style.display = 'none';
    ownerStep(2);
  } catch (err) {
    state.auth = null;
    ownerShowError(1, err.message || 'Connection failed.');
  }
}

async function ownerStep2Next() {
  const token2 = document.getElementById('owner-token2').value.trim();
  if (!token2) { ownerShowError(2, 'Token 2 is required for sharing.'); return; }
  state._setupOwnerData.token2 = token2;
  // Pre-fill network username with personal username
  const netU = document.getElementById('owner-network-username');
  if (netU && !netU.value) netU.value = state._setupOwnerData.username || '';
  ownerStep(3);
}

async function ownerStep3Next() {
  const networkOwner = document.getElementById('owner-network-username').value.trim();
  const networkRepo  = document.getElementById('owner-network-repo').value.trim() || 'memoir-shared';
  const token3       = document.getElementById('owner-token3').value.trim();
  if (!networkOwner || !token3) { ownerShowError(3, 'Network owner and token are required.'); return; }

  document.querySelectorAll('#owner-step-3 button, #owner-step-3 input').forEach(e => e.disabled = true);
  document.getElementById('owner-connecting-3').style.display = 'flex';

  const steps = ['os-3a','os-3b','os-3c'];
  let si = 0;
  const adv = () => { document.getElementById(steps[si]).classList.add('done'); si++; if (si < steps.length) document.getElementById(steps[si]).classList.add('active'); };

  try {
    document.getElementById(steps[0]).classList.add('active');
    // Verify token3
    const res = await fetch(`${GITHUB_API}/user`, { headers: { Authorization: `Bearer ${token3}` } });
    if (!res.ok) throw new Error('Invalid network token.');
    adv();

    // Check/create network repo
    const repoRes = await fetch(`${GITHUB_API}/repos/${networkOwner}/${networkRepo}`, { headers: { Authorization: `Bearer ${token3}` } });
    adv();
    const isNew = repoRes.status === 404;
    await initNetworkStructure(networkOwner, networkRepo, token3, isNew);
    adv();
    await new Promise(r => setTimeout(r, 300));

    state._setupOwnerData = { ...state._setupOwnerData, networkOwner, networkRepo, token3 };
    document.getElementById('owner-connecting-3').style.display = 'none';
    ownerStep(4);
  } catch (err) {
    ownerShowError(3, err.message || 'Network setup failed.');
  }
}

async function ownerStep4Next() {
  const email = document.getElementById('owner-email').value.trim();
  state._setupOwnerData.email = email;
  ownerStep(5);

  // Build and display invite code
  const d = state._setupOwnerData;
  const code = encodeCode({ networkOwner: d.networkOwner, networkRepo: d.networkRepo, invitedBy: d.username, ts: Date.now() });
  document.getElementById('owner-invite-code').textContent = code;

  // Finalize auth and save
  state.auth = {
    username: d.username, repo: d.repo, email,
    networkOwner: d.networkOwner, networkRepo: d.networkRepo,
    token1: d.token1, token2: d.token2, token3: d.token3,
    token: d.token1,
  };
  initDataSource();
  await saveAuth(state.auth);

  // Write public-card.json with token2
  try {
    await ghPutFile('public-card.json', {
      username: d.username, repo: d.repo, readToken: d.token2,
      networkOwner: d.networkOwner, networkRepo: d.networkRepo,
      updatedAt: new Date().toISOString(),
    }, null, 'memoir: publish public card');
  } catch {}

  // Setup GitHub Actions workflows
  await initWorkflows();
}

async function ownerStep5Launch() {
  launchApp();
}

// ── SETUP — FRIEND FLOW ───────────────────────────────────────────
function showSetupFriend(inviteCode) {
  state._setupFriendData = {};
  if (inviteCode) {
    document.getElementById('friend-invite-code').value = inviteCode;
    state._setupFriendData._prefillCode = inviteCode;
  }
  friendStep(1);
  navigateTo('screen-setup-friend');
}

function friendGoBack() {
  const cur = state._setupFriendData._currentStep || 1;
  if (cur <= 1) { goBack(); return; }
  friendStep(cur - 1);
}

function friendStep(n) {
  state._setupFriendData._currentStep = n;
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`friend-step-${i}`);
    if (el) el.style.display = (i === n) ? '' : 'none';
  }
  const label = document.getElementById('friend-step-label');
  if (label) label.textContent = `Step ${n} of 4`;
  for (let i = 1; i <= 3; i++) {
    const err = document.getElementById(`friend-error-${i}`);
    if (err) err.style.display = 'none';
  }
}

function friendShowError(n, msg) {
  const el = document.getElementById(`friend-error-${n}`);
  if (el) { el.textContent = msg; el.style.display = 'block'; }
  const conn = document.getElementById(`friend-connecting-${n}`);
  if (conn) conn.style.display = 'none';
  const form = document.getElementById(`friend-step-${n}`);
  if (form) form.querySelectorAll('button, input, textarea').forEach(e => e.disabled = false);
}

async function friendStep1Next() {
  const rawCode = document.getElementById('friend-invite-code').value.trim();
  const username = document.getElementById('friend-username').value.trim();
  const repo     = document.getElementById('friend-repo').value.trim() || 'memoir-data';
  const token1   = document.getElementById('friend-token1').value.trim();

  if (!rawCode)   { friendShowError(1, 'Invite code is required.'); return; }
  if (!username)  { friendShowError(1, 'Username is required.'); return; }
  if (!token1)    { friendShowError(1, 'Token 1 is required.'); return; }

  const invite = decodeCode(rawCode);
  if (!invite?.networkOwner || !invite?.invitedBy) { friendShowError(1, 'Invalid invite code. Ask your friend to share it again.'); return; }

  document.querySelectorAll('#friend-step-1 button, #friend-step-1 input').forEach(e => e.disabled = true);
  document.getElementById('friend-connecting-1').style.display = 'flex';

  const steps = ['fs-1a','fs-1b','fs-1c'];
  let si = 0;
  const adv = () => { document.getElementById(steps[si]).classList.add('done'); si++; if (si < steps.length) document.getElementById(steps[si]).classList.add('active'); };

  try {
    document.getElementById(steps[0]).classList.add('active');
    adv(); // decode done

    // Validate token
    const userRes = await fetch(`${GITHUB_API}/user`, { headers: { Authorization: `Bearer ${token1}` } });
    if (!userRes.ok) throw new Error('Invalid token.');
    adv();

    // Init repo
    const tmpPrev = state.auth;
    state.auth = { token: token1, token1, username, repo };
    const repoData = await ghGet(`/repos/${username}/${repo}`);
    await initRepoStructure(repoData === null, username, repo, token1);
    state.auth = tmpPrev;
    adv();
    await new Promise(r => setTimeout(r, 300));

    state._setupFriendData = { ...state._setupFriendData, username, repo, token1, invite };
    document.getElementById('f-inviter-name').textContent = invite.invitedBy;
    document.getElementById('f-repo-hint').textContent    = repo;
    document.getElementById('friend-connecting-1').style.display = 'none';
    friendStep(2);
  } catch (err) {
    friendShowError(1, err.message || 'Setup failed.');
  }
}

async function friendStep2Next() {
  const token2 = document.getElementById('friend-token2').value.trim();
  if (!token2) { friendShowError(2, 'Token 2 is required.'); return; }
  state._setupFriendData.token2 = token2;
  friendStep(3);
}

async function friendStep3Next() {
  const email = document.getElementById('friend-email').value.trim();
  state._setupFriendData.email = email;

  const d      = state._setupFriendData;
  const invite = d.invite;

  // Finalize auth
  state.auth = {
    username: d.username, repo: d.repo, email,
    networkOwner: invite.networkOwner, networkRepo: invite.networkRepo,
    token1: d.token1, token2: d.token2, token3: '',
    token: d.token1,
  };
  initDataSource();
  await saveAuth(state.auth);

  // Write own public-card
  try {
    await ghPutFile('public-card.json', {
      username: d.username, repo: d.repo, readToken: d.token2,
      networkOwner: invite.networkOwner, networkRepo: invite.networkRepo,
      updatedAt: new Date().toISOString(),
    }, null, 'memoir: publish public card');
  } catch {}

  // Build connect code
  const connectCode = encodeCode({ username: d.username, repo: d.repo, readToken: d.token2, ts: Date.now() });

  // Update UI for step 4
  document.getElementById('f-final-inviter').textContent = invite.invitedBy;
  document.getElementById('friend-connect-code').textContent = connectCode;
  friendStep(4);
}

async function friendStep4Launch() {
  launchApp();
}

// ── SETUP — RESTORE ───────────────────────────────────────────────
function showSetupRestore() {
  navigateTo('screen-setup-restore');
}

async function handleRestore() {
  const username = document.getElementById('restore-username').value.trim();
  const repo     = document.getElementById('restore-repo').value.trim() || 'memoir-data';
  const token1   = document.getElementById('restore-token1').value.trim();
  const errEl    = document.getElementById('restore-error');
  errEl.style.display = 'none';
  if (!username || !token1) { errEl.textContent = 'Username and token are required.'; errEl.style.display = 'block'; return; }

  document.querySelectorAll('#screen-setup-restore button, #screen-setup-restore input').forEach(e => e.disabled = true);
  document.getElementById('restore-connecting').style.display = 'flex';

  const steps = ['rs-1','rs-2','rs-3'];
  let si = 0;
  const adv = () => { document.getElementById(steps[si]).classList.add('done'); si++; if (si < steps.length) document.getElementById(steps[si]).classList.add('active'); };

  try {
    document.getElementById(steps[0]).classList.add('active');
    const userRes = await fetch(`${GITHUB_API}/user`, { headers: { Authorization: `Bearer ${token1}` } });
    if (!userRes.ok) throw new Error('Invalid token.');
    adv();

    // Temp auth to load profile
    state.auth = { token: token1, token1, username, repo, token2: '', token3: '', networkOwner: '', networkRepo: '', email: '' };
    initDataSource();

    // Try to load public-card.json for token2 / network info
    let email = '', token2 = '', token3 = '', networkOwner = '', networkRepo = '';
    try {
      const card = await ghGetFile('public-card.json');
      if (card?.content) {
        networkOwner = card.content.networkOwner || '';
        networkRepo  = card.content.networkRepo  || '';
      }
    } catch {}
    adv();

    // Load friends
    await loadFriends();
    adv();
    await new Promise(r => setTimeout(r, 300));

    state.auth = { username, repo, email, networkOwner, networkRepo, token1, token2, token3, token: token1 };
    initDataSource();
    await saveAuth(state.auth);
    await initWorkflows();
    launchApp();
  } catch (err) {
    document.getElementById('restore-connecting').style.display = 'none';
    document.querySelectorAll('#screen-setup-restore button, #screen-setup-restore input').forEach(e => e.disabled = false);
    errEl.textContent = err.message || 'Restore failed.';
    errEl.style.display = 'block';
  }
}

// ── REPO STRUCTURE ────────────────────────────────────────────────
async function initRepoStructure(isNew, username, repo, token) {
  const u = username || state.auth.username;
  const r = repo     || state.auth.repo;
  const t = token    || state.auth.token;
  if (isNew) {
    await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: r, private: true, description: 'Memoir private archive', auto_init: true })
    });
    await new Promise(r => setTimeout(r, 1500));
  }
  const files = [
    ['posts-index.json', []],
    ['logs/errors.json', []],
    ['profile.json', { username: u, joinedAt: new Date().toISOString() }],
  ];
  for (const [path, def] of files) {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${u}/${r}/contents/${path}`, {
        headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github.v3+json' }
      });
      if (res.status === 404) {
        await fetch(`${GITHUB_API}/repos/${u}/${r}/contents/${path}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `memoir: initialize ${path}`, content: btoa(unescape(encodeURIComponent(JSON.stringify(def, null, 2)))) })
        });
      }
    } catch {}
  }
}

async function initNetworkStructure(networkOwner, networkRepo, token3, isNew) {
  if (isNew) {
    await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token3}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: networkRepo, private: true, description: 'Memoir shared network', auto_init: true })
    });
    await new Promise(r => setTimeout(r, 1500));
  }
  const files = [['music/music-index.json', []]];
  for (const [path, def] of files) {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${networkOwner}/${networkRepo}/contents/${path}`, {
        headers: { Authorization: `Bearer ${token3}`, Accept: 'application/vnd.github.v3+json' }
      });
      if (res.status === 404) {
        await fetch(`${GITHUB_API}/repos/${networkOwner}/${networkRepo}/contents/${path}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token3}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'memoir: initialize music index', content: btoa('[]') })
        });
      }
    } catch {}
  }
}

async function initWorkflows() {
  const alertEmail = state.auth?.email || 'noreply@example.com';
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
  await Promise.allSettled([
    loadFeed(),
    loadPersonalFolders(),
    loadSharedFolders(),
  ]);
  renderFolderRow();
}

// ── FRIENDS ───────────────────────────────────────────────────────
async function loadFriends() {
  try {
    const files = await DataSource.listFolder('personal', 'friends');
    for (const f of files) {
      if (!f.name.endsWith('.json')) continue;
      const data = await DataSource.get('personal', `friends/${f.name}`);
      if (!data?.username) continue;
      state.friends[data.username] = data;
      if (DataSource.sources.friends) {
        DataSource.sources.friends[data.username] = {
          owner: data.repoOwner || data.username,
          repo:  data.repo || 'memoir-data',
          token: data.readToken,
        };
      }
    }
  } catch {}
}

async function saveFriend(friendData) {
  const { username } = friendData;
  state.friends[username] = friendData;
  if (!DataSource.sources.friends) DataSource.sources.friends = {};
  DataSource.sources.friends[username] = {
    owner: friendData.repoOwner || username,
    repo:  friendData.repo || 'memoir-data',
    token: friendData.readToken,
  };
  try {
    await ghPutFile(`friends/${username}.json`, friendData, null, `memoir: add friend ${username}`);
  } catch (err) { showError('Could not save friend', err); }
}

async function removeFriend(username) {
  try {
    const fi = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/friends/${username}.json`);
    if (fi?.sha) await ghDeleteFile(`friends/${username}.json`, fi.sha, `memoir: remove friend ${username}`);
    delete state.friends[username];
    if (DataSource.sources.friends) delete DataSource.sources.friends[username];
    delete state.inboxByFriend[username];
  } catch {}
}

// ── ADD FRIEND (from connect code) ───────────────────────────────
function openAddFriendSheet() {
  document.getElementById('connect-code-input').value = '';
  document.getElementById('add-friend-error').style.display = 'none';
  openSheet('sheet-add-friend');
}

async function confirmAddFriend() {
  const raw = document.getElementById('connect-code-input').value.trim();
  const errEl = document.getElementById('add-friend-error');
  errEl.style.display = 'none';
  if (!raw) { errEl.textContent = 'Paste a connect code first.'; errEl.style.display = 'block'; return; }

  const card = decodeCode(raw);
  if (!card?.username || !card?.readToken) {
    errEl.textContent = 'Invalid connect code. Ask your friend to share it again.';
    errEl.style.display = 'block'; return;
  }
  if (card.username === state.auth.username) {
    errEl.textContent = 'That\'s your own code.';
    errEl.style.display = 'block'; return;
  }

  closeSheet('sheet-add-friend');
  showToast('Adding friend…', card.username, 'info');
  const friendData = {
    username:   card.username,
    repo:       card.repo || 'memoir-data',
    repoOwner:  card.username,
    readToken:  card.readToken,
    addedAt:    new Date().toISOString(),
  };
  await saveFriend(friendData);
  showToast('Friend added', `${card.username} is now in your Chats`, 'success');
  updateChatsBadge();
  if (document.getElementById('screen-chats').classList.contains('active')) loadChats();
  if (document.getElementById('screen-settings').classList.contains('active')) loadSettings();
}

// ── INBOX (friend shares) ─────────────────────────────────────────
async function checkFriendOutboxes() {
  const friends = Object.values(state.friends);
  if (!friends.length) return;
  let totalUnread = 0;
  for (const friend of friends) {
    try {
      const src = `friend:${friend.username}`;
      const folder = `outbox/to-${state.auth.username}`;
      const files = await DataSource.listFolder(src, folder);
      const shares = [];
      for (const f of files) {
        if (!f.name.endsWith('.json')) continue;
        const data = await DataSource.get(src, `${folder}/${f.name}`);
        if (data) shares.push({ ...data, _from: friend.username, _file: f.name });
      }
      shares.sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));
      state.inboxByFriend[friend.username] = shares;

      const lastSeen = state.lastSeen[friend.username] || 0;
      const unread   = shares.filter(s => new Date(s.sharedAt) > new Date(lastSeen)).length;
      if (unread > 0) totalUnread += unread;
    } catch {}
  }
  updateChatsBadge(totalUnread);
}

function updateChatsBadge(count) {
  if (count === undefined) {
    count = 0;
    Object.entries(state.inboxByFriend).forEach(([username, shares]) => {
      const lastSeen = state.lastSeen[username] || 0;
      count += shares.filter(s => new Date(s.sharedAt) > new Date(lastSeen)).length;
    });
  }
  const badges = ['nav-chats-badge'];
  badges.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = count > 0 ? 'flex' : 'none';
    el.textContent   = count > 0 ? count : '';
  });
}

// ── SHARE POST ────────────────────────────────────────────────────
function openShareSheet() {
  const meta = state.currentPost;
  if (!meta || state.currentPostSource !== 'personal') return;

  const friends = Object.values(state.friends);
  const list    = document.getElementById('share-friend-list');

  if (!friends.length) {
    list.innerHTML = `<div class="empty-state" style="padding:16px 0"><div class="empty-icon">◈</div><div class="empty-title">No friends yet</div><div class="empty-sub">Add friends in the Chats tab first</div></div>`;
  } else {
    list.innerHTML = friends.map(f => `
      <div class="share-friend-item" onclick="sharePost('${f.username}')">
        <div class="sfi-avatar">${f.username.charAt(0).toUpperCase()}</div>
        <div class="sfi-name">${esc(f.username)}</div>
        <span class="sfi-arrow">›</span>
      </div>`).join('');
  }
  openSheet('sheet-share');
}

async function sharePost(friendUsername) {
  closeSheet('sheet-share');
  const meta = state.currentPost;
  if (!meta) return;

  showToast('Sharing…', `Sending to ${friendUsername}`, 'info');
  try {
    const shareId    = `share-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const shareEntry = {
      id:           shareId,
      postId:       meta.id,
      sharedAt:     new Date().toISOString(),
      sharedBy:     state.auth.username,
      captionPreview: (meta.caption || '').slice(0, 120),
      date:         meta.createdAt?.split('T')[0] || '',
      thumbnail_b64: meta._indexEntry?.thumbnail_b64 || null,
      location:     meta.location || '',
      songTitle:    meta.song?.title  || null,
      mediaCount:   meta.media?.length || 1,
      hasVideo:     meta.media?.some(m => m.type === 'video') || false,
    };
    await ghPutFile(`outbox/to-${friendUsername}/${shareId}.json`, shareEntry, null,
      `memoir: share post ${meta.id} with ${friendUsername}`);
    showToast('Shared ✦', `Memory sent to ${friendUsername}`, 'success');
    logEvent('sharePost', 'success', `${meta.id} → ${friendUsername}`);
  } catch (err) { showError('Share failed', err); }
}

// ── CHATS SCREEN ─────────────────────────────────────────────────
async function loadChats() {
  const list    = document.getElementById('chats-list');
  const friends = Object.values(state.friends);

  if (!friends.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">◈</div>
      <div class="empty-title">No friends yet</div>
      <div class="empty-sub">Share your invite code or paste a connect code</div>
      <button class="btn btn-outline-teal" style="margin-top:16px;width:auto;padding:8px 20px" onclick="openAddFriendSheet()">Add friend</button>
    </div>`;
    return;
  }

  list.innerHTML = `<div style="padding:8px 0">${friends.map(f => renderChatRow(f)).join('')}</div>`;
  // Kick off inbox refresh in background
  checkFriendOutboxes().then(() => {
    // Re-render with fresh data
    list.innerHTML = `<div style="padding:8px 0">${friends.map(f => renderChatRow(f)).join('')}</div>`;
    updateChatsBadge();
  });
}

function renderChatRow(friend) {
  const shares   = state.inboxByFriend[friend.username] || [];
  const lastSeen = state.lastSeen[friend.username] || 0;
  const unread   = shares.filter(s => new Date(s.sharedAt) > new Date(lastSeen)).length;
  const latest   = shares[0];
  const sub      = latest
    ? `${latest.captionPreview || 'Shared a memory'} · ${formatDate(latest.sharedAt?.split('T')[0])}`
    : 'No shares yet';
  return `<div class="chat-row" onclick="openThread('${friend.username}')">
    <div class="chat-avatar">${friend.username.charAt(0).toUpperCase()}</div>
    <div class="chat-info">
      <div class="chat-name">${esc(friend.username)}</div>
      <div class="chat-preview">${esc(sub)}</div>
    </div>
    ${unread > 0 ? `<div class="chat-badge">${unread}</div>` : ''}
  </div>`;
}

async function openThread(friendUsername) {
  state.threadFriend = friendUsername;
  const friend = state.friends[friendUsername];
  if (!friend) return;

  navigateTo('screen-thread');
  document.getElementById('thread-friend-name').textContent = friendUsername;
  document.getElementById('thread-list').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:13px">Loading…</div>`;

  // Mark as seen
  state.lastSeen[friendUsername] = new Date().toISOString();
  localStorage.setItem('memoir_last_seen', JSON.stringify(state.lastSeen));
  updateChatsBadge();

  // Refresh shares
  try {
    const src    = `friend:${friendUsername}`;
    const folder = `outbox/to-${state.auth.username}`;
    const files  = await DataSource.listFolder(src, folder);
    const shares = [];
    for (const f of files) {
      if (!f.name.endsWith('.json')) continue;
      const data = await DataSource.get(src, `${folder}/${f.name}`);
      if (data) shares.push({ ...data, _from: friendUsername });
    }
    shares.sort((a, b) => new Date(b.sharedAt) - new Date(a.sharedAt));
    state.inboxByFriend[friendUsername] = shares;
    renderThread(friendUsername, shares);
  } catch (err) {
    document.getElementById('thread-list').innerHTML =
      `<div class="empty-state"><div class="empty-icon">⊘</div><div class="empty-title">Couldn't load shares</div><div class="empty-sub">${esc(err.message)}</div></div>`;
  }
}

function renderThread(friendUsername, shares) {
  const list = document.getElementById('thread-list');
  if (!shares.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">◈</div><div class="empty-title">Nothing shared yet</div><div class="empty-sub">${esc(friendUsername)} hasn't shared anything with you</div></div>`;
    return;
  }
  list.innerHTML = `<div class="thread-list">${shares.map(s => renderThreadCard(s)).join('')}</div>`;
}

function renderThreadCard(share) {
  const thumb = share.thumbnail_b64
    ? `<img src="${share.thumbnail_b64}" alt="">`
    : `<div class="thread-card-no-thumb">✦</div>`;
  return `<div class="thread-card" onclick="openFriendPost('${share._from}','${share.postId}','${share.id}')">
    <div class="thread-card-thumb">${thumb}</div>
    <div class="thread-card-info">
      <div class="thread-card-date">${formatDate(share.date)}</div>
      ${share.captionPreview ? `<div class="thread-card-caption">${esc(share.captionPreview)}</div>` : ''}
      ${share.location ? `<div class="thread-card-location">📍 ${esc(share.location)}</div>` : ''}
      <div class="thread-card-meta">
        ${share.mediaCount > 1 ? `<span class="feed-badge">1/${share.mediaCount}</span>` : ''}
        ${share.hasVideo ? `<span class="feed-badge feed-badge-video">▶</span>` : ''}
        ${share.songTitle ? `<span class="feed-badge feed-badge-music">♫</span>` : ''}
      </div>
    </div>
    <div class="thread-card-shared">Shared ${formatDate(share.sharedAt?.split('T')[0])}</div>
  </div>`;
}

// ── OPEN FRIEND'S POST ────────────────────────────────────────────
async function openFriendPost(friendUsername, postId, shareId) {
  navigateTo('screen-post');
  state.currentPostSource = `friend:${friendUsername}`;
  state.currentSlide = 0;

  const audio = document.getElementById('audio-player');
  audio.pause(); audio.removeAttribute('src'); audio.load(); audio._eventsSet = false;
  state.songPausedByVideo = false;
  hideVideoAudioToggle();

  // Hide owner-only actions, show source badge
  document.getElementById('post-view-actions').style.display = 'none';
  const badge = document.getElementById('post-source-badge');
  badge.style.display = 'flex';
  badge.textContent   = `✦ from ${friendUsername}`;

  document.getElementById('post-slides').innerHTML = '';
  document.getElementById('post-slides').style.transform = '';
  document.getElementById('swipe-dots').innerHTML = '';
  document.getElementById('now-playing').style.display = 'none';
  document.getElementById('post-view-blur-bg').style.backgroundImage = '';
  document.getElementById('np-play-btn').textContent = '▶';
  document.getElementById('np-disc').classList.remove('playing');
  document.getElementById('np-progress').style.width = '0%';
  document.getElementById('np-current').textContent  = '0:00';
  document.getElementById('np-duration').textContent = '—:——';
  document.getElementById('post-view-caption').textContent = '';
  document.getElementById('post-view-date').textContent    = '';
  document.getElementById('post-view-location').style.display = 'none';

  const src = `friend:${friendUsername}`;

  try {
    const meta = await DataSource.get(src, `posts/${postId}/meta.json`);
    if (!meta) throw new Error('Post not found');
    state.currentPost = { ...meta, id: postId };

    const sortedMedia = [...meta.media].sort((a, b) => a.order - b.order);
    const slides = document.getElementById('post-slides');
    const dots   = document.getElementById('swipe-dots');

    for (let i = 0; i < sortedMedia.length; i++) {
      const m        = sortedMedia[i];
      const filePath = `posts/${postId}/${m.filename}`;
      let el;
      if (m.type === 'video') {
        el = Object.assign(document.createElement('video'), { className: 'post-view-slide video', controls: true, playsInline: true });
        DataSource.getBlobUrl(src, filePath).then(u => { if (u) el.src = u; });
      } else {
        el = Object.assign(document.createElement('img'), { className: 'post-view-slide', alt: '' });
        DataSource.getBlobUrl(src, filePath).then(u => { if (u) el.src = u; });
      }
      slides.appendChild(el);
      if (sortedMedia.length > 1) {
        const dot = document.createElement('div');
        dot.className = 'swipe-dot' + (i === 0 ? ' active' : '');
        dots.appendChild(dot);
      }
    }

    const firstImg = sortedMedia.find(m => m.type === 'image');
    if (firstImg) {
      DataSource.getBlobUrl(src, `posts/${postId}/${firstImg.filename}`).then(u => {
        if (u) document.getElementById('post-view-blur-bg').style.backgroundImage = `url(${u})`;
      });
    }

    document.getElementById('post-view-date').textContent    = formatDate(meta.createdAt?.split('T')[0]);
    document.getElementById('post-view-caption').textContent = meta.caption || '';
    if (meta.location) {
      document.getElementById('post-view-location').style.display = 'flex';
      document.getElementById('post-view-location-text').textContent = meta.location;
    }

    if (meta.song?.filename) {
      setupAudioUI(meta.song.title, meta.song.artist);
      const playBtn = document.getElementById('np-play-btn');
      playBtn.textContent = '…'; playBtn.classList.add('loading');
      DataSource.getBlobUrl(src, `posts/${postId}/${meta.song.filename}`).then(songUrl => {
        playBtn.classList.remove('loading'); playBtn.textContent = '▶';
        if (songUrl) {
          audio.src = songUrl;
          wireAudioEvents(audio, meta.song);
          audio.play().catch(() => {});
        } else { playBtn.disabled = true; playBtn.title = 'Could not load song'; }
      });
    }
  } catch (err) {
    showError('Could not load post', err);
    goBack();
  }
}

// ── FEED ─────────────────────────────────────────────────────────
async function loadFeed() {
  const container = document.getElementById('feed-content');
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

// Deterministic decoration per card — stable across renders, based on post id hash
const _DECO_TYPES = ['none','f1','f2','f3','leaf','tape','star','none','f1','none'];
function cardDecoData(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0x7fff;
  const type = _DECO_TYPES[h % _DECO_TYPES.length];
  const rots = [-14, -8, -3, 5, 10, 16, -10, 7];
  const rot  = rots[(h >> 4) % rots.length];
  return { type, rot };
}

function renderPostCard(post) {
  const date = formatDate(post.date);
  const deco = cardDecoData(post.id);
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
  const decoAttr  = deco.type !== 'none' ? ` data-deco="${deco.type}"` : '';
  const decoStyle = ` style="--dr:${deco.rot}deg"`;
  const tapeEl    = deco.type === 'tape' ? `<div class="card-tape"></div>` : '';
  return `<div class="feed-card" onclick="openPost('${post.id}')">
    <div class="feed-card-photo"${decoAttr}${decoStyle}>
      ${tapeEl}
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
        const w = Math.round(video.videoWidth * ratio); const h = Math.round(video.videoHeight * ratio);
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

function handleSearch(query) { applyFeedFilters(); }
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
function setFeedDateFilter(val)     { state.feedDateFilter = val || null; applyFeedFilters(); renderFeedFilters(); }
function setFeedLocationFilter(val) { state.feedLocationFilter = val || null; applyFeedFilters(); renderFeedFilters(); }
function clearFeedFilters() {
  state.feedDateFilter = null; state.feedLocationFilter = null;
  const si = document.getElementById('search-input'); if (si) si.value = '';
  applyFeedFilters(); renderFeedFilters();
}

// ── POST VIEW ─────────────────────────────────────────────────────
async function openPost(postId) {
  navigateTo('screen-post');
  state.currentPostSource = 'personal';
  state.currentSlide = 0;

  const audio = document.getElementById('audio-player');
  audio.pause(); audio.removeAttribute('src'); audio.load(); audio._eventsSet = false;
  state.songPausedByVideo = false;
  hideVideoAudioToggle();

  // Restore owner actions & hide friend badge
  document.getElementById('post-view-actions').style.display = '';
  document.getElementById('post-source-badge').style.display = 'none';

  document.getElementById('post-slides').innerHTML = '';
  document.getElementById('post-slides').style.transform = '';
  document.getElementById('swipe-dots').innerHTML = '';
  document.getElementById('now-playing').style.display = 'none';
  document.getElementById('post-view-blur-bg').style.backgroundImage = '';
  const _playBtn = document.getElementById('np-play-btn');
  _playBtn.textContent = '▶'; _playBtn.classList.remove('loading');
  _playBtn.disabled = false; _playBtn.title = '';
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
      const blurEl  = document.getElementById('post-view-blur-bg');
      const blurUrl = folderUrls[firstImg.filename];
      if (blurUrl) blurEl.style.backgroundImage = `url(${blurUrl})`;
      ghBlobUrl(`posts/${postId}/${firstImg.filename}`).then(b => { if (b) blurEl.style.backgroundImage = `url(${b})`; });
    }

    for (let i = 0; i < sortedMedia.length; i++) {
      const m = sortedMedia[i]; const filePath = `posts/${postId}/${m.filename}`; const url = folderUrls[m.filename];
      let el;
      if (m.type === 'video') {
        el = Object.assign(document.createElement('video'), { className: 'post-view-slide video', controls: true, playsInline: true });
        if (url) el.src = url;
        el.onerror = () => ghBlobUrl(filePath).then(b => { if (b) el.src = b; });
      } else {
        el = Object.assign(document.createElement('img'), { className: 'post-view-slide', alt: '' });
        ghBlobUrl(filePath).then(blobUrl => { if (blobUrl) el.src = blobUrl; else if (url) el.src = url; });
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

    if (meta.song?.filename) {
      setupAudioUI(meta.song.title, meta.song.artist);
      const playBtn = document.getElementById('np-play-btn');
      playBtn.textContent = '…'; playBtn.classList.add('loading');
      ghBlobUrl(`posts/${postId}/${meta.song.filename}`).then(songUrl => {
        playBtn.classList.remove('loading'); playBtn.textContent = '▶';
        if (songUrl) { audio.src = songUrl; wireAudioEvents(audio, meta.song); audio.play().catch(() => {}); }
        else { playBtn.disabled = true; playBtn.title = 'Could not load song'; }
      });
    }
    logEvent('openPost', 'success', postId);
  } catch (err) { showError('Could not load post', err); goBack(); }
}

function wireAudioEvents(audio, song) {
  if (audio._eventsSet) return;
  audio._eventsSet = true;
  const btn = document.getElementById('np-play-btn'); const disc = document.getElementById('np-disc');
  const endTime = song.endTime || null;
  audio.ontimeupdate = () => {
    if (!audio.duration) return;
    document.getElementById('np-progress').style.width = (audio.currentTime / audio.duration * 100) + '%';
    document.getElementById('np-current').textContent  = fmtTime(audio.currentTime);
    if (endTime && audio.currentTime >= endTime) audio.currentTime = song.startTime || 0;
  };
  audio.onloadedmetadata = () => {
    document.getElementById('np-duration').textContent = fmtTime(audio.duration);
    if (song.startTime > 0) audio.currentTime = song.startTime;
  };
  audio.onplay  = () => { disc.classList.add('playing');    btn.textContent = '⏸'; };
  audio.onpause = () => { disc.classList.remove('playing'); btn.textContent = '▶'; };
  audio.onended = () => { audio.currentTime = song.startTime || 0; disc.classList.remove('playing'); btn.textContent = '▶'; };
  audio.onerror = () => { disc.classList.remove('playing'); btn.textContent = '▶'; showToast('Could not play song', 'Try opening the post again', 'error'); };
}

// Swipe
let touchX = 0;
function touchStart(e) { touchX = e.touches[0].clientX; }
function touchEnd(e) {
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) < 42) return;
  const meta = state.currentPost; if (!meta) return;
  const n = meta.media.length;
  if (dx < 0 && state.currentSlide < n - 1) goToSlide(state.currentSlide + 1);
  if (dx > 0 && state.currentSlide > 0)     goToSlide(state.currentSlide - 1);
}
function goToSlide(idx) {
  const prevIdx = state.currentSlide; state.currentSlide = idx;
  document.getElementById('post-slides').style.transform = `translateX(-${idx * 100}%)`;
  document.querySelectorAll('.swipe-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
  const slides = document.getElementById('post-slides').children;
  const prevSlide = slides[prevIdx]; const newSlide = slides[idx];
  const mainAudio = document.getElementById('audio-player');
  if (prevSlide?.tagName === 'VIDEO') prevSlide.pause();
  if (newSlide?.tagName === 'VIDEO') {
    if (!mainAudio.paused) { state.songPausedByVideo = true; mainAudio.pause(); }
    const checkAudio = () => {
      const hasAudio = (newSlide.audioTracks && newSlide.audioTracks.length > 0) || newSlide.mozHasAudio === true || newSlide.webkitAudioDecodedByteCount > 0;
      if (!hasAudio && state.songPausedByVideo) { state.songPausedByVideo = false; mainAudio.play().catch(() => {}); }
      showVideoAudioToggle(hasAudio);
    };
    if (newSlide.readyState >= 1) checkAudio();
    else newSlide.addEventListener('loadedmetadata', checkAudio, { once: true });
  } else {
    hideVideoAudioToggle();
    if (state.songPausedByVideo) { state.songPausedByVideo = false; mainAudio.play().catch(() => {}); }
  }
}

function showVideoAudioToggle(videoHasAudio) {
  let btn = document.getElementById('video-audio-toggle');
  if (!videoHasAudio) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement('button'); btn.id = 'video-audio-toggle'; btn.className = 'video-audio-toggle';
    btn.onclick = toggleVideoAudioChoice; document.getElementById('screen-post').appendChild(btn);
  }
  updateVideoAudioToggleLabel();
}
function hideVideoAudioToggle() { document.getElementById('video-audio-toggle')?.remove(); }
function updateVideoAudioToggleLabel() {
  const btn = document.getElementById('video-audio-toggle'); if (!btn) return;
  btn.textContent = state.songPausedByVideo ? '♫ play song' : '🎬 video audio';
}
function toggleVideoAudioChoice() {
  const mainAudio = document.getElementById('audio-player');
  const slides    = document.getElementById('post-slides').children;
  const curSlide  = slides[state.currentSlide];
  if (state.songPausedByVideo) {
    if (curSlide?.tagName === 'VIDEO') curSlide.muted = true;
    state.songPausedByVideo = false; mainAudio.play().catch(() => {});
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
function toggleAudio() {
  const audio = document.getElementById('audio-player');
  if (!audio.paused) { audio.pause(); return; }
  if (!audio.src || audio.src === window.location.href) { refreshAudioSrc(); showToast('Loading song…', 'Tap ▶ once more when ready', 'info'); return; }
  audio.play().catch(err => {
    if (err.name === 'NotSupportedError' || err.name === 'AbortError') { refreshAudioSrc(); showToast('Song reloading…', 'Tap ▶ again in a moment', 'info'); }
  });
}
async function refreshAudioSrc() {
  const meta = state.currentPost; if (!meta?.song?.filename) return;
  try {
    const src = state.currentPostSource;
    const url = src === 'personal'
      ? await ghBlobUrl(`posts/${meta.id}/${meta.song.filename}`)
      : await DataSource.getBlobUrl(src, `posts/${meta.id}/${meta.song.filename}`);
    if (url) {
      const audio = document.getElementById('audio-player');
      audio._eventsSet = false; audio.src = url; wireAudioEvents(audio, meta.song);
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
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
      const w = Math.round(img.naturalWidth * ratio); const h = Math.round(img.naturalHeight * ratio);
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url); resolve(canvas.toDataURL('image/jpeg', 0.35));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
async function generateVideoThumbnail(file, maxW = 320, maxH = 240) {
  return new Promise(resolve => {
    const video = document.createElement('video'); const url = URL.createObjectURL(file);
    video.preload = 'metadata'; video.muted = true; video.playsInline = true; video.src = url;
    const capture = () => {
      try {
        const ratio = Math.min(maxW / video.videoWidth, maxH / video.videoHeight, 1);
        const w = Math.round(video.videoWidth * ratio); const h = Math.round(video.videoHeight * ratio);
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        URL.revokeObjectURL(url); resolve(canvas.toDataURL('image/jpeg', 0.35));
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
  const meta = state.currentPost; if (!meta) return;
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
    goBack(); renderFeed(state.filteredPosts);
  } catch (err) { showError('Delete failed', err); }
}

// ── CREATE POST ───────────────────────────────────────────────────
function openMediaPicker()     { const i = document.getElementById('media-file-input');     i.value = ''; i.click(); }
function openMediaPickerAdd(e) { e.stopPropagation(); const i = document.getElementById('media-file-input-add'); i.value = ''; i.click(); }

async function handleMediaFiles(files) {
  for (const f of Array.from(files)) { if (f.size / 1024 / 1024 > MAX_FILE_MB) showToast('Large file', `${f.name} exceeds 24MB`, 'warning'); }
  state.pendingMedia = [...(state.pendingMedia || []), ...Array.from(files)].slice(0, MAX_MEDIA);
  renderMediaGrid();
  document.getElementById('btn-post').disabled = !state.pendingMedia.length;
}

function renderMediaGrid() {
  const grid = document.getElementById('media-grid'); const addBtn = document.getElementById('media-add-btn');
  const files = state.pendingMedia;
  const iconEl = document.querySelector('#media-picker .media-picker-icon');
  const textEl = document.querySelector('#media-picker .media-picker-text');
  const subEl  = document.querySelector('#media-picker .media-picker-sub');
  if (!files.length) {
    grid.style.display = 'none'; addBtn.style.display = 'none';
    iconEl.style.display = ''; textEl.style.display = ''; subEl.style.display = ''; return;
  }
  iconEl.style.display = 'none'; textEl.style.display = 'none'; subEl.style.display = 'none';
  grid.style.display = 'grid'; addBtn.style.display = 'flex'; addBtn.onclick = openMediaPickerAdd;
  const show = files.slice(0, 3); const more = files.length - 3;
  grid.innerHTML = show.map((f, i) => {
    const url = URL.createObjectURL(f); const isVideo = f.type.startsWith('video/');
    return `<div class="media-grid-item"><${isVideo ? `video src="${url}" muted playsinline preload="metadata"` : `img src="${url}" alt=""`}><button class="media-remove-btn" onclick="event.stopPropagation();removeMedia(${i})">✕</button>${i === 2 && more > 0 ? `<div class="media-grid-more">+${more + 1}</div>` : ''}</div>`;
  }).join('');
}

function removeMedia(index) {
  state.pendingMedia.splice(index, 1); renderMediaGrid();
  document.getElementById('btn-post').disabled = !state.pendingMedia.length;
}

async function loadMusicForCreate() {
  const selector = document.getElementById('music-selector');
  if (!state.auth) return;
  try {
    const src  = musicSource();
    const file = await DataSource.get(src, 'music/music-index.json');
    const newIndex = Array.isArray(file) ? file : [];
    if (JSON.stringify(newIndex) !== JSON.stringify(state.musicIndex)) state.musicIndex = newIndex;
    const badge = document.getElementById('music-source-badge');
    if (badge) {
      badge.style.display = src === 'network' ? 'inline' : 'none';
      badge.textContent   = 'shared library';
    }
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
    return `<div class="music-option${sel ? ' selected' : ''}" onclick="${fnName}('${song.id}')" id="${fnName}-mo-${song.id}">
      <div class="mo-disc" style="background:radial-gradient(circle at 35% 35%,${c1},${c2})"></div>
      <div class="mo-info"><div class="mo-title">${esc(song.title)}</div><div class="mo-artist">${esc(song.artist)}</div></div>
      ${sel ? `<button class="mo-trim-btn" onclick="event.stopPropagation();openClipSheet('${fnName}')">✂ Trim</button>` : ''}
      <div class="mo-check" id="${fnName}-mc-${song.id}">${sel ? '✓' : ''}</div>
    </div>`;
  }).join('');
}

function getClipLabel(mode) { const cs = state.clipSheet; if (!cs.songId) return ''; return `${fmtTime(cs.startTime)}–${fmtTime(cs.endTime)}`; }

function selectSong(id) {
  const prev = state.selectedSongId;
  state.selectedSongId = prev === id ? null : id;
  if (!state.selectedSongId) state.clipSheet = { mode: null, songId: null, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
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
  const song = state.musicIndex.find(s => s.id === songId); if (!song) return;
  const cs = state.clipSheet;
  if (cs.songId !== songId) state.clipSheet = { mode, songId, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
  else state.clipSheet.mode = mode;
  document.getElementById('clip-sheet-song').textContent   = song.title;
  document.getElementById('clip-sheet-artist').textContent = song.artist || '';
  document.getElementById('clip-start-slider').value = state.clipSheet.startTime;
  const _endVal = state.clipSheet.endTime ?? (state.clipSheet.duration || 300);
  document.getElementById('clip-end-slider').value   = _endVal;
  document.getElementById('clip-start-time').textContent = fmtTime(state.clipSheet.startTime);
  document.getElementById('clip-end-time').textContent   = state.clipSheet.endTime === null ? 'full' : fmtTime(state.clipSheet.endTime);
  updateClipVisual(); updateClipDurationLabel();
  openSheet('sheet-clip'); loadClipDuration(songId);
}
async function loadClipDuration(songId) {
  const song = state.musicIndex.find(s => s.id === songId); if (!song) return;
  try {
    const url = await musicBlobUrl(song.filename);
    if (!url) return;
    const tmp = new Audio(url); state.clipSheet.previewAudio = tmp;
    tmp.addEventListener('loadedmetadata', () => {
      const dur = Math.floor(tmp.duration); state.clipSheet.duration = dur;
      document.getElementById('clip-start-slider').max = Math.max(0, dur - 2);
      document.getElementById('clip-end-slider').max   = dur;
      if (state.clipSheet.endTime === null || state.clipSheet.endTime > dur) {
        state.clipSheet.endTime = dur;
        document.getElementById('clip-end-slider').value   = dur;
        document.getElementById('clip-end-time').textContent = fmtTime(dur);
      }
      updateClipVisual(); updateClipDurationLabel();
    });
    tmp.load();
  } catch {}
}
function onClipStartChange(val) {
  val = parseInt(val);
  if (val >= state.clipSheet.endTime) {
    state.clipSheet.endTime = Math.min(val + 2, state.clipSheet.duration || 300);
    document.getElementById('clip-end-slider').value = state.clipSheet.endTime;
    document.getElementById('clip-end-time').textContent = fmtTime(state.clipSheet.endTime);
  }
  state.clipSheet.startTime = val;
  document.getElementById('clip-start-time').textContent = fmtTime(val);
  updateClipVisual(); updateClipDurationLabel();
  const pa = state.clipSheet.previewAudio; if (pa && !pa.paused) pa.currentTime = val;
}
function onClipEndChange(val) {
  val = parseInt(val);
  if (val <= state.clipSheet.startTime) {
    state.clipSheet.startTime = Math.max(0, val - 2);
    document.getElementById('clip-start-slider').value = state.clipSheet.startTime;
    document.getElementById('clip-start-time').textContent = fmtTime(state.clipSheet.startTime);
  }
  state.clipSheet.endTime = val;
  document.getElementById('clip-end-time').textContent = fmtTime(val);
  updateClipVisual(); updateClipDurationLabel();
}
function updateClipVisual() {
  const cs = state.clipSheet; const dur = cs.duration || 300;
  const pct  = (t) => (t / dur * 100).toFixed(1) + '%';
  const fill = document.getElementById('clip-visual-fill'); if (!fill) return;
  fill.style.left = pct(cs.startTime); fill.style.width = pct(cs.endTime - cs.startTime);
}
function updateClipDurationLabel() {
  const cs = state.clipSheet; const len = Math.max(0, cs.endTime - cs.startTime);
  const el = document.getElementById('clip-duration-val'); if (el) el.textContent = `${len}s`;
}
async function toggleClipPreview() {
  const btn = document.getElementById('clip-preview-btn');
  let pa = state.clipSheet.previewAudio;
  if (pa && !pa.paused) { pa.pause(); btn.textContent = '▶ Preview clip'; btn.classList.remove('playing'); return; }
  if (!pa || !pa.src) {
    await loadClipDuration(state.clipSheet.songId); pa = state.clipSheet.previewAudio;
    if (!pa) { showToast('Could not load preview', '', 'warning'); return; }
    await new Promise(r => setTimeout(r, 300));
  }
  pa.currentTime = state.clipSheet.startTime || 0;
  const stopAt = state.clipSheet.endTime || pa.duration || 9999;
  pa.ontimeupdate = () => {
    updateClipPlayhead(pa.currentTime);
    if (pa.currentTime >= stopAt) { pa.pause(); pa.currentTime = state.clipSheet.startTime || 0; updateClipPlayhead(state.clipSheet.startTime || 0); if (btn) { btn.textContent = '▶ Preview clip'; btn.classList.remove('playing'); } }
  };
  pa.onpause = pa.onended = () => { if (btn) { btn.textContent = '▶ Preview clip'; btn.classList.remove('playing'); } updateClipPlayhead(state.clipSheet.startTime || 0); };
  pa.play().then(() => { btn.textContent = '⏸ Stop preview'; btn.classList.add('playing'); }).catch(() => { showToast('Preview unavailable', '', 'warning'); });
}
function stopClipPreviewAudio() { const pa = state.clipSheet.previewAudio; if (pa) { pa.pause(); pa.src = ''; state.clipSheet.previewAudio = null; } }
function updateClipPlayhead(currentTime) { const cs = state.clipSheet; const dur = cs.duration || 300; const ph = document.getElementById('clip-playhead'); if (ph) ph.style.left = (currentTime / dur * 100).toFixed(1) + '%'; }
function closeClipSheet() { stopClipPreviewAudio(); updateClipPlayhead(0); closeSheet('sheet-clip'); }
function confirmClipSheet() {
  stopClipPreviewAudio(); state.clipSheet.trimConfirmed = true; closeSheet('sheet-clip');
  const mode = state.clipSheet.mode;
  if (mode === 'create') renderMusicSelector(document.getElementById('music-selector'), state.selectedSongId, 'selectSong');
  else if (mode === 'edit' && state.editPost) {
    state.editPost.songStartTime = state.clipSheet.startTime;
    state.editPost.songEndTime   = state.clipSheet.endTime;
    renderMusicSelector(document.getElementById('edit-music-selector'), state.editPost.selectedSongId, 'selectEditSong');
  }
}

// ── SUBMIT CREATE POST ────────────────────────────────────────────
async function submitPost() {
  if (!state.pendingMedia?.length) return;
  const btn = document.getElementById('btn-post'); btn.disabled = true;
  const progress = document.getElementById('upload-progress'); progress.classList.add('visible');
  const postId   = generatePostId();
  const caption  = document.getElementById('caption-input').value.trim();
  const location = document.getElementById('location-input').value.trim();
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
      const file = state.pendingMedia[i]; const isVideo = file.type.startsWith('video/');
      const ext = file.name.split('.').pop().toLowerCase(); const filename = `media_${i + 1}.${ext}`;
      upd(`Uploading ${isVideo ? 'video' : 'photo'} ${i + 1}…`, file.name, (done / total) * 100);
      await ghPutBinary(`posts/${postId}/${filename}`, await file.arrayBuffer(), null, `memoir: add media to ${postId}`);
      mediaEntries.push({ filename, type: isVideo ? 'video' : 'image', order: i + 1 }); done++;
    }
    let songMeta = null;
    if (selectedSong) {
      upd('Adding music…', selectedSong.filename, (done / total) * 100);
      const songBuffer = await musicFetchBuffer(selectedSong.filename);
      if (!songBuffer) throw new Error('Could not download song from library');
      await ghPutBinary(`posts/${postId}/song.mp3`, songBuffer, null, `memoir: add song to ${postId}`);
      songMeta = { title: selectedSong.title, artist: selectedSong.artist, filename: 'song.mp3',
        startTime: state.clipSheet.trimConfirmed ? (state.clipSheet.startTime || 0) : 0,
        endTime:   state.clipSheet.trimConfirmed ? state.clipSheet.endTime : null }; done++;
    }
    upd('Saving post…', 'meta.json', (done / total) * 100);
    const meta = { id: postId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), caption, location, media: mediaEntries, song: songMeta };
    await ghPutFile(`posts/${postId}/meta.json`, meta, null, `memoir: create post ${postId}`); done++;
    upd('Updating feed…', 'posts-index.json', 95);
    const firstMedia = mediaEntries[0];
    const indexEntry = { id: postId, date: postId.split('-').slice(0,3).join('-'), captionPreview: caption.slice(0, 120), location,
      thumbnail: firstMedia?.type === 'image' ? `posts/${postId}/${firstMedia.filename}` : null, thumbnail_b64,
      songTitle: songMeta?.title || null, songArtist: songMeta?.artist || null, mediaCount: mediaEntries.length, hasVideo: mediaEntries.some(m => m.type === 'video') };
    const updatedIndex = await ghUpdateIndexRetry('posts-index.json', existing => [indexEntry, ...existing], `memoir: add post ${postId}`);
    state.posts = updatedIndex; state.filteredPosts = updatedIndex;
    showToast('Posted ✦', 'Memory saved to GitHub', 'success');
    logEvent('createPost', 'success', postId);
    // Save folder selections after post is created
    if (state._createPostFolders?.length) await applyFolderSelections(postId, 'create');
    state.pendingMedia = []; state.selectedSongId = null;
    state.clipSheet = { mode: null, songId: null, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
    document.getElementById('caption-input').value = ''; document.getElementById('location-input').value = '';
    const mp = document.getElementById('media-picker');
    document.getElementById('media-grid').style.display = 'none'; document.getElementById('media-add-btn').style.display = 'none';
    mp.querySelector('.media-picker-icon').style.display = '';
    mp.querySelector('.media-picker-text').style.display = '';
    mp.querySelector('.media-picker-sub').style.display  = '';
    progress.classList.remove('visible'); btn.disabled = false;
    renderFeed(state.filteredPosts); goBack();
  } catch (err) { showError('Post failed', err); btn.disabled = false; progress.classList.remove('visible'); }
}

// ── EDIT POST ─────────────────────────────────────────────────────
async function openEditPost() {
  const meta = state.currentPost; if (!meta) return;
  const _audio = document.getElementById('audio-player');
  if (_audio) { _audio.pause(); _audio.removeAttribute('src'); _audio.load(); _audio._eventsSet = false; }
  state.songPausedByVideo = false; hideVideoAudioToggle();
  state.editPost = {
    postId: meta.id, originalCaption: meta.caption || '', originalLocation: meta.location || '',
    originalSong: meta.song ? JSON.parse(JSON.stringify(meta.song)) : null,
    originalMedia: [...meta.media].sort((a, b) => a.order - b.order),
    currentMedia:  [...meta.media].sort((a, b) => a.order - b.order).map(m => ({ ...m, _status: 'existing' })),
    selectedSongId: null, songChanged: false,
    songStartTime: meta.song?.startTime || 0, songEndTime: meta.song?.endTime || null,
  };
  if (meta.song) {
    const match = state.musicIndex.find(s => s.title === meta.song.title && s.artist === meta.song.artist);
    if (match) state.editPost.selectedSongId = match.id;
  }
  state.editFolderUrls = await ghFolderUrls(`posts/${meta.id}`);
  document.getElementById('edit-date-value').textContent   = formatDate(meta.createdAt?.split('T')[0]);
  document.getElementById('edit-caption-input').value      = meta.caption  || '';
  document.getElementById('edit-location-input').value     = meta.location || '';
  renderEditMediaStrip(); await loadMusicForEdit();
  navigateTo('screen-edit');
}

function renderEditMediaStrip() {
  const strip = document.getElementById('edit-media-strip'); const ep = state.editPost; strip.innerHTML = '';
  ep.currentMedia.forEach((m, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'edit-media-thumb' + (m._status === 'delete' ? ' to-delete' : '');
    thumb.dataset.index = i;
    let mediaEl;
    if (m._status === 'new') {
      const url = URL.createObjectURL(m._file);
      mediaEl = m.type === 'video' ? Object.assign(document.createElement('video'), { src: url, muted: true }) : Object.assign(document.createElement('img'), { src: url, alt: '' });
    } else {
      mediaEl = m.type === 'video' ? Object.assign(document.createElement('video'), { muted: true }) : Object.assign(document.createElement('img'), { alt: '' });
      ghBlobUrl(`posts/${ep.postId}/${m.filename}`).then(url => { if (url) mediaEl.src = url; });
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'media-remove-btn'; removeBtn.textContent = m._status === 'delete' ? '↩' : '✕';
    removeBtn.onclick = () => toggleEditMediaDelete(i);
    const handle = document.createElement('div'); handle.className = 'drag-handle'; handle.textContent = '⠿';
    thumb.appendChild(mediaEl); thumb.appendChild(removeBtn); thumb.appendChild(handle);
    strip.appendChild(thumb); setupEditDragEvents(thumb, i);
  });
  const addBtn = document.createElement('div'); addBtn.className = 'edit-add-more'; addBtn.innerHTML = `+ <span>Add more</span>`;
  addBtn.onclick = () => { const inp = document.getElementById('edit-media-input'); inp.value = ''; inp.click(); };
  strip.appendChild(addBtn);
}
function toggleEditMediaDelete(index) {
  const m = state.editPost.currentMedia[index];
  if (m._status === 'new') state.editPost.currentMedia.splice(index, 1);
  else if (m._status === 'delete') m._status = 'existing';
  else m._status = 'delete';
  renderEditMediaStrip();
}
let editDragSrc = null;
function setupEditDragEvents(el, index) {
  el.addEventListener('dragstart', () => { editDragSrc = index; setTimeout(() => el.classList.add('dragging'), 0); });
  el.addEventListener('dragend',   () => { el.classList.remove('dragging'); document.querySelectorAll('.edit-media-thumb').forEach(t => t.classList.remove('drag-over')); });
  el.addEventListener('dragover',  e  => { e.preventDefault(); document.querySelectorAll('.edit-media-thumb').forEach(t => t.classList.remove('drag-over')); el.classList.add('drag-over'); });
  el.addEventListener('drop', e => {
    e.preventDefault(); if (editDragSrc === null || editDragSrc === index) return;
    const items = state.editPost.currentMedia; const [moved] = items.splice(editDragSrc, 1); items.splice(index, 0, moved); editDragSrc = null; renderEditMediaStrip();
  });
  el.draggable = true;
}
function handleEditAddMedia(files) {
  const canAdd = MAX_MEDIA - state.editPost.currentMedia.length;
  if (canAdd <= 0) { showToast('Max media', 'Cannot exceed 10 items', 'warning'); return; }
  let orderMax = state.editPost.currentMedia.reduce((m, x) => Math.max(m, x.order || 0), 0);
  Array.from(files).slice(0, canAdd).forEach((file, i) => {
    const isVideo = file.type.startsWith('video/'); const ext = file.name.split('.').pop().toLowerCase();
    state.editPost.currentMedia.push({ filename: `media_new_${Date.now()}_${i}.${ext}`, type: isVideo ? 'video' : 'image', order: ++orderMax, _status: 'new', _file: file });
  });
  renderEditMediaStrip();
}
async function loadMusicForEdit() {
  const selector = document.getElementById('edit-music-selector');
  try {
    if (!state.musicIndex.length) {
      const idx = await DataSource.get(musicSource(), 'music/music-index.json');
      state.musicIndex = Array.isArray(idx) ? idx : [];
    }
    if (!state.musicIndex.length) { selector.innerHTML = `<div style="font-size:12px;color:var(--text-faint);padding:8px 0">No songs yet</div>`; return; }
    renderMusicSelector(selector, state.editPost.selectedSongId, 'selectEditSong');
  } catch { selector.innerHTML = `<div style="font-size:12px;color:var(--rose)">Couldn't load library</div>`; }
}
function selectEditSong(id) {
  const prev = state.editPost.selectedSongId;
  state.editPost.selectedSongId = prev === id ? null : id;
  state.editPost.songChanged    = true;
  if (!state.editPost.selectedSongId) state.clipSheet = { mode: null, songId: null, startTime: 0, endTime: null, duration: null, previewAudio: null, trimConfirmed: false };
  renderMusicSelector(document.getElementById('edit-music-selector'), state.editPost.selectedSongId, 'selectEditSong');
}
async function submitEdit() {
  const ep = state.editPost; if (!ep) return;
  const btn = document.getElementById('btn-save-edit'); btn.disabled = true;
  const progress = document.getElementById('edit-upload-progress'); progress.classList.add('visible');
  const newCaption = document.getElementById('edit-caption-input').value.trim();
  const newLocation = document.getElementById('edit-location-input').value.trim();
  const postId = ep.postId;
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
    const oldSong = ep.originalSong;
    let step = 0, totalSteps = toDeleteItems.length + toAddItems.length + 2;
    for (const m of toDeleteItems) {
      upd('Removing…', m.filename, (step / totalSteps) * 90);
      try { const fi = await ghGet(`/repos/${state.auth.username}/${state.auth.repo}/contents/posts/${postId}/${m.filename}`); if (fi?.sha) await ghDeleteFile(`posts/${postId}/${m.filename}`, fi.sha); } catch {}
      step++;
    }
    for (const m of toAddItems) {
      upd('Uploading…', m.filename, (step / totalSteps) * 90);
      await ghPutBinary(`posts/${postId}/${m.filename}`, await m._file.arrayBuffer(), null, `memoir: add media to ${postId}`); step++;
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
        const songBuffer = await musicFetchBuffer(selectedSong.filename);
        if (!songBuffer) throw new Error('Could not download song from library');
        await ghPutBinary(`posts/${postId}/song.mp3`, songBuffer, null, `memoir: update song in ${postId}`);
        newSongMeta = { title: selectedSong.title, artist: selectedSong.artist, filename: 'song.mp3',
          startTime: state.clipSheet.trimConfirmed ? (state.clipSheet.startTime || 0) : (ep.songStartTime || 0),
          endTime:   state.clipSheet.trimConfirmed ? state.clipSheet.endTime : (ep.songEndTime || null) };
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
    const firstImage  = finalMedia.find(m => m.type === 'image');
    let new_thumbnail_b64 = null;
    const activeMedia = ep.currentMedia.filter(m => m._status !== 'delete');
    const firstNewImg = activeMedia.find(m => m._status === 'new' && m.type === 'image');
    const firstNewVid = activeMedia.find(m => m._status === 'new' && m.type === 'video');
    const firstActive = activeMedia[0];
    if (firstNewImg && firstActive === firstNewImg) new_thumbnail_b64 = await generateThumbnail(firstNewImg._file);
    else if (!firstImage && firstNewVid) new_thumbnail_b64 = await generateVideoThumbnail(firstNewVid._file);
    upd('Updating feed…', 'posts-index.json', 95);
    const updatedIndex = await ghUpdateIndexRetry('posts-index.json', existing => existing.map(p => {
      if (p.id !== postId) return p;
      return { ...p, captionPreview: newCaption.slice(0, 120), location: newLocation,
        thumbnail: firstImage ? `posts/${postId}/${firstImage.filename}` : null,
        thumbnail_b64: new_thumbnail_b64 || p.thumbnail_b64,
        songTitle: newSongMeta?.title || null, songArtist: newSongMeta?.artist || null,
        mediaCount: finalMedia.length, hasVideo: finalMedia.some(m => m.type === 'video') };
    }), `memoir: update index ${postId}`);
    state.posts = updatedIndex; state.filteredPosts = updatedIndex;
    renderFeed(state.filteredPosts); state.currentPost = updatedMeta;
    showToast('Saved ✦', 'Memory updated', 'success');
    logEvent('editPost', 'success', postId);
    stopClipPreviewAudio(); progress.classList.remove('visible'); btn.disabled = false;
    state.editPost = null; goBack();
    setTimeout(() => openPost(postId), 80);
  } catch (err) { showError('Save failed', err); btn.disabled = false; progress.classList.remove('visible'); }
}

// ── MUSIC LIBRARY ─────────────────────────────────────────────────
async function loadMusicLibrary() {
  const list = document.getElementById('music-list');
  list.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:13px">Loading…</div>`;
  const src = musicSource();
  try {
    // Network badge — hidden, no label shown
    const banner = document.getElementById('music-network-banner');
    if (banner) banner.style.display = 'none';
    const idx = await DataSource.get(src, 'music/music-index.json');
    state.musicIndex = Array.isArray(idx) ? idx : [];
    state.musicQuery = document.getElementById('music-search-input')?.value?.toLowerCase().trim() || '';
    if (!state.musicIndex.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">♫</div><div class="empty-title">No songs yet</div><div class="empty-sub">Tap + to add a song</div></div>`;
      document.getElementById('music-storage-bar').style.display = 'none'; return;
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

function filterMusicList(query) { state.musicQuery = query.toLowerCase().trim(); renderMusicLibraryList(); }

function renderMusicLibraryList() {
  const list = document.getElementById('music-list'); if (!list) return;
  const q = state.musicQuery;
  const filtered = q ? state.musicIndex.filter(s => s.title.toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q)) : state.musicIndex;
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
  const song = state.musicIndex.find(s => s.id === id); if (!song) return;
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
    const pb = document.getElementById(`play-${previewingId}`); if (pb) pb.textContent = '▶';
  }
  previewingId = id;
  const btn = document.getElementById(`play-${id}`); if (btn) btn.textContent = '…';
  try {
    const url = await musicBlobUrl(song.filename);
    if (!url) throw new Error('No URL');
    previewAudio = new Audio(url);
    previewAudio.addEventListener('play',  () => { document.getElementById(`disc-${id}`)?.classList.add('playing');    if (btn) btn.textContent = '⏸'; });
    previewAudio.addEventListener('pause', () => { document.getElementById(`disc-${id}`)?.classList.remove('playing'); if (btn) btn.textContent = '▶'; });
    previewAudio.addEventListener('ended', () => { document.getElementById(`disc-${id}`)?.classList.remove('playing'); if (btn) btn.textContent = '▶'; previewingId = null; previewAudio = null; });
    previewAudio.addEventListener('error', () => { if (btn) btn.textContent = '▶'; showToast('Playback error', '', 'error'); });
    await previewAudio.play();
  } catch (err) { if (btn) btn.textContent = '▶'; showToast('Preview failed', err.message, 'error'); previewingId = null; }
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
  closeSheet('sheet-delete-song'); const id = songToDelete; songToDelete = null; if (!id) return;
  const song = state.musicIndex.find(s => s.id === id); if (!song) return;
  if (previewingId === id && previewAudio) { previewAudio.pause(); previewAudio.src = ''; previewAudio = null; previewingId = null; }
  showToast('Deleting song…', '', 'info', 10000);
  try {
    const src     = musicSource();
    const rawFile = await DataSource.getRaw(src, `music/${song.filename}`);
    if (rawFile?.sha) {
      const existing = await DataSource.getRaw(src, `music/${song.filename}`);
      const { owner, repo, token } = DataSource.resolve(src);
      await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/music/${song.filename}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `memoir: delete song ${song.title}`, sha: existing.sha })
      });
    }
    const currentIdx = await DataSource.get(src, 'music/music-index.json') || [];
    const updated    = currentIdx.filter(s => s.id !== id);
    await DataSource.put(src, 'music/music-index.json', updated, `memoir: remove ${song.title} from index`);
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
  const src      = musicSource();
  if (state.musicIndex.find(s => s.filename === filename)) { showToast('Duplicate', `"${title}" already exists`, 'warning'); return; }
  showToast('Uploading song…', filename, 'info', 15000);
  try {
    await DataSource.putBinary(src, `music/${filename}`, await file.arrayBuffer(), `memoir: add song ${title}`);
    const currentIdx = await DataSource.get(src, 'music/music-index.json') || [];
    const newEntry   = { id, title, artist, filename, sizeBytes: file.size, addedOn: new Date().toISOString().split('T')[0] };
    const updated    = [...currentIdx, newEntry];
    await DataSource.put(src, 'music/music-index.json', updated, `memoir: add ${title} to index`);
    state.musicIndex = updated;
    showToast('Song added', `${title} is in your library`, 'success');
    logEvent('addSong', 'success', title);
    loadMusicLibrary(); state.pendingSong = null;
  } catch (err) { showError('Upload failed', err); }
}

async function syncMusicLibrary() {
  showToast('Syncing…', '', 'info');
  const src = musicSource();
  try {
    const folder = await DataSource.listFolder(src, 'music');
    const audioFiles = folder.filter(f => /\.(mp3|m4a|wav)$/i.test(f.name));
    const current    = await DataSource.get(src, 'music/music-index.json') || [];
    let added = 0;
    for (const f of audioFiles) {
      if (!current.find(s => s.filename === f.name)) {
        const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        current.push({ id: slugify(name), title: name, artist: '', filename: f.name, sizeBytes: f.size, addedOn: new Date().toISOString().split('T')[0] });
        added++;
      }
    }
    await DataSource.put(src, 'music/music-index.json', current, `memoir: sync music (+${added})`);
    state.musicIndex = current;
    showToast('Synced', `${added} new song${added !== 1 ? 's' : ''} added`, 'success');
    loadMusicLibrary();
  } catch (err) { showError('Sync failed', err); }
}

// ── REORDER POSTS ─────────────────────────────────────────────────
function loadReorderScreen() {
  state.reorderOriginal = [...state.posts]; state.reorderCurrent = [...state.posts]; renderReorderList();
}
function renderReorderList() {
  const list = document.getElementById('reorder-list');
  if (!state.reorderCurrent.length) { list.innerHTML = `<div class="empty-state"><div class="empty-icon">⊟</div><div class="empty-title">No posts yet</div></div>`; return; }
  list.innerHTML = state.reorderCurrent.map((post, i) => {
    const thumbSrc = post.thumbnail_b64 || (post.thumbnail ? `https://raw.githubusercontent.com/${state.auth.username}/${state.auth.repo}/main/${post.thumbnail}` : null);
    return `<div class="reorder-card" data-index="${i}">
      <div class="reorder-handle" data-index="${i}">⠿</div>
      <div class="reorder-thumb">${thumbSrc ? `<img src="${thumbSrc}" alt="">` : ''}</div>
      <div class="reorder-info"><div class="reorder-date">${formatDate(post.date)}</div><div class="reorder-caption">${esc(post.captionPreview || '(no caption)')}</div></div>
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
    e.preventDefault(); handle.setPointerCapture(e.pointerId); dragIdx = parseInt(handle.dataset.index);
    const card = document.querySelectorAll('.reorder-card')[dragIdx]; const rect = card.getBoundingClientRect();
    offsetX = e.clientX - rect.left; offsetY = e.clientY - rect.top;
    ghost = document.createElement('div'); ghost.className = 'reorder-ghost';
    ghost.style.width = rect.width + 'px'; ghost.style.left = rect.left + 'px'; ghost.style.top = rect.top + 'px';
    ghost.innerHTML = card.innerHTML; document.body.appendChild(ghost); card.classList.add('dragging-source');
  });
  handle.addEventListener('pointermove', e => {
    if (dragIdx === null || !ghost) return; e.preventDefault();
    ghost.style.left = (e.clientX - offsetX) + 'px'; ghost.style.top = (e.clientY - offsetY) + 'px';
    const hoverIdx = idxFromY(e.clientY);
    document.querySelectorAll('.reorder-card').forEach((c, i) => c.classList.toggle('drag-over', i === hoverIdx && i !== dragIdx));
  });
  handle.addEventListener('pointerup', e => {
    if (dragIdx === null) return; const dropIdx = idxFromY(e.clientY);
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.reorder-card').forEach(c => c.classList.remove('dragging-source', 'drag-over'));
    if (dropIdx !== dragIdx) { const [moved] = state.reorderCurrent.splice(dragIdx, 1); state.reorderCurrent.splice(dropIdx, 0, moved); renderReorderList(); }
    dragIdx = null;
  });
  handle.addEventListener('pointercancel', () => {
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.reorder-card').forEach(c => c.classList.remove('dragging-source', 'drag-over')); dragIdx = null;
  });
}
function cancelReorder() { state.reorderCurrent = [...state.reorderOriginal]; goBack(); }
async function saveReorder() {
  showToast('Saving order…', '', 'info', 8000);
  try {
    const indexFile = await ghGetFile('posts-index.json');
    await ghPutFile('posts-index.json', state.reorderCurrent, indexFile?.sha, 'memoir: reorder posts');
    state.posts = [...state.reorderCurrent]; state.filteredPosts = [...state.reorderCurrent];
    renderFeed(state.filteredPosts); showToast('Order saved', '', 'success'); logEvent('reorderPosts', 'success'); goBack();
  } catch (err) { showError('Reorder failed', err); }
}

// ── SETTINGS ──────────────────────────────────────────────────────
async function loadSettings() {
  if (!state.auth) return;
  document.getElementById('si-username').textContent = state.auth.username;
  document.getElementById('si-repo').textContent     = state.auth.repo;

  // Network section
  const netSection = document.getElementById('settings-network-section');
  if (state.auth.networkOwner) {
    netSection.style.display = '';
    document.getElementById('si-network-repo').textContent = `${state.auth.networkOwner}/${state.auth.networkRepo || 'memoir-shared'}`;
  } else {
    netSection.style.display = 'none';
  }

  // Friends section
  const frSection = document.getElementById('settings-friends-section');
  const friends   = Object.values(state.friends);
  if (friends.length) {
    frSection.style.display = '';
    document.getElementById('settings-friends-row').innerHTML = friends.map(f => `
      <div class="settings-item">
        <span class="si-label">${esc(f.username)}</span>
        <button class="si-action-btn si-danger-btn" onclick="confirmRemoveFriend('${f.username}')">Remove</button>
      </div>`).join('');
  } else {
    frSection.style.display = 'none';
  }

  updateTokenStatusUI();

  ghGet(`/repos/${state.auth.username}/${state.auth.repo}`).then(d => {
    if (d?.size) document.getElementById('si-storage').textContent = `${(d.size/1024).toFixed(1)} MB`;
  }).catch(() => {});
}

function confirmRemoveFriend(username) {
  if (!confirm(`Remove ${username} as a friend? This won't delete any shared posts.`)) return;
  removeFriend(username).then(() => { showToast('Removed', username, 'success'); loadSettings(); });
}

let _updateTokenN = 0;
function openUpdateToken(n) {
  _updateTokenN = n;
  const titles = { 2: 'Update Read-Only Token', 3: 'Update Network Token' };
  const msgs   = { 2: 'Your read-only token lets friends view your shared posts.', 3: 'Your network token enables the music library and shared folders.' };
  const instructions = {
    2: `<ol class="token-steps">
      <li>Open <strong>github.com</strong> → your profile → <strong>Settings</strong></li>
      <li>Scroll to <strong>Developer settings</strong> → <strong>Personal access tokens</strong> → <strong>Fine-grained tokens</strong></li>
      <li>Click <strong>Generate new token</strong></li>
      <li>Under <strong>Repository access</strong>, select your memoir repo only</li>
      <li>Under <strong>Permissions → Repository permissions → Contents</strong>, choose <strong>Read-only</strong></li>
      <li>Click <strong>Generate token</strong>, copy it and paste below</li>
    </ol>`,
    3: `<ol class="token-steps">
      <li>Open <strong>github.com</strong> → your profile → <strong>Settings</strong></li>
      <li>Scroll to <strong>Developer settings</strong> → <strong>Personal access tokens</strong> → <strong>Fine-grained tokens</strong></li>
      <li>Click <strong>Generate new token</strong></li>
      <li>Under <strong>Repository access</strong>, select your <em>shared / network</em> repo</li>
      <li>Under <strong>Permissions → Repository permissions → Contents</strong>, choose <strong>Read and write</strong></li>
      <li>Click <strong>Generate token</strong>, copy it and paste below</li>
    </ol>`
  };
  document.getElementById('update-token-title').textContent         = titles[n] || `Update Token ${n}`;
  document.getElementById('update-token-msg').textContent           = msgs[n] || '';
  document.getElementById('update-token-instructions').innerHTML    = instructions[n] || '';
  document.getElementById('update-token-input').value               = '';
  openSheet('sheet-update-token');
}
async function confirmUpdateToken() {
  const newToken = document.getElementById('update-token-input').value.trim();
  if (!newToken) { showToast('Token required', '', 'warning'); return; }
  closeSheet('sheet-update-token');
  const n = _updateTokenN;
  if (n === 2) state.auth.token2 = newToken;
  if (n === 3) { state.auth.token3 = newToken; initDataSource(); }
  await saveAuth(state.auth);
  if (n === 2) {
    // Update public-card.json with new read token
    try {
      const card = await ghGetFile('public-card.json');
      const updated = { ...(card?.content || {}), readToken: newToken, updatedAt: new Date().toISOString() };
      await ghPutFile('public-card.json', updated, card?.sha, 'memoir: update public card');
    } catch {}
  }
  showToast(`Token ${n} updated`, '', 'success');
  state.tokenHealth[n] = 'ok';
  updateTokenStatusUI();
  dismissBanner(`token${n}`);
}

function handleSignOut()  { openSheet('sheet-signout'); }
function confirmSignOut() {
  localStorage.removeItem('memoir_auth');
  localStorage.removeItem('memoir_logs');
  localStorage.removeItem('memoir_last_seen');
  state.auth = null; state.posts = []; state.selectedSongId = null; state.musicIndex = [];
  state.friends = {}; state.inboxByFriend = {}; state.lastSeen = {};
  DataSource.sources = {}; DataSource.clearBlobCache(); ghBlobCacheClear();
  closeSheet('sheet-signout');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-welcome').classList.add('active');
  state.navHistory = ['screen-welcome'];
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
  const wrap = document.getElementById('qr-canvas-wrap'); wrap.innerHTML = '';
  try {
    // Encode credentials as base64 in a URL so scanners open the app, not mail
    const payload = btoa(JSON.stringify({ u: state.auth.username, r: state.auth.repo, t: state.auth.token1 || state.auth.token }));
    const url = `${location.origin}/#restore?d=${encodeURIComponent(payload)}`;
    new QRCode(wrap, { text: url, width: 170, height: 170, colorDark: '#0e0c0a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
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

  // Load lastSeen from localStorage
  state.lastSeen = JSON.parse(localStorage.getItem('memoir_last_seen') || '{}');

  // Handle URL hash for invite links and QR restore
  const hash = window.location.hash.slice(1);
  if (hash.startsWith('invite=')) {
    state._pendingInviteCode = decodeURIComponent(hash.slice(7));
    history.replaceState(null, '', window.location.pathname);
  }
  // QR code deep-link: #restore?d=BASE64
  if (hash.startsWith('restore?d=')) {
    try {
      const parsed = JSON.parse(atob(decodeURIComponent(hash.slice(10))));
      showSetupRestore();
      if (parsed.u) document.getElementById('restore-username').value = parsed.u;
      if (parsed.r) document.getElementById('restore-repo').value   = parsed.r;
      if (parsed.t) document.getElementById('restore-token1').value = parsed.t;
      history.replaceState(null, '', window.location.pathname);
      return;
    } catch { /* bad QR data, fall through */ }
  }

  const auth = await loadAuth();

  if (!auth) {
    // New user — show welcome or appropriate setup
    if (state._pendingInviteCode) {
      showSetupFriend(state._pendingInviteCode);
    } else if (hash === 'owner') {
      showSetupOwner();
      document.getElementById('btn-owner-setup').style.display = '';
    } else {
      if (hash === 'owner') document.getElementById('btn-owner-setup').style.display = '';
      // screen-welcome is already active
    }
    return;
  }

  // Existing user — boot the app
  state.auth = auth;
  initDataSource();
  state.friends = {};

  await loadFriends();
  initDataSource(); // reinit with friends loaded

  navigateTo('screen-feed', false);
  state.navHistory = ['screen-feed'];
  setFeedTabActive();
  showInstallNudge();

  // Parallel load
  await Promise.allSettled([
    loadFeed(),
    loadMusicIndexBackground(),
    checkFriendOutboxes(),
    checkTokenHealth(),
    loadPersonalFolders(),
    loadSharedFolders(),
  ]);
  renderFolderRow();
}

// ══════════════════════════════════════════════════════════════════
// FOLDERS
// ══════════════════════════════════════════════════════════════════

const FOLDER_COLORS = {
  gold:   { bg:'#c8a46a', light:'rgba(200,164,106,0.13)', border:'rgba(200,164,106,0.35)' },
  teal:   { bg:'#2db4b4', light:'rgba(45,180,180,0.13)',  border:'rgba(45,180,180,0.35)'  },
  rose:   { bg:'#c07060', light:'rgba(192,112,96,0.13)',  border:'rgba(192,112,96,0.35)'  },
  purple: { bg:'#7b5ea7', light:'rgba(123,94,167,0.13)',  border:'rgba(123,94,167,0.35)'  },
  green:  { bg:'#5a9e78', light:'rgba(90,158,120,0.13)',  border:'rgba(90,158,120,0.35)'  },
};

async function loadPersonalFolders() {
  try {
    const data = await DataSource.get('personal', 'folders-personal.json');
    state.personalFolders = Array.isArray(data) ? data : [];
  } catch { state.personalFolders = []; }
}

async function savePersonalFolders() {
  try {
    await ghPutFile('folders-personal.json', state.personalFolders, null, 'memoir: update personal folders');
  } catch (err) { showError('Could not save folders', err); }
}

async function loadSharedFolders() {
  if (!state.auth?.networkOwner || !state.auth?.networkRepo || !state.auth?.token3) return;
  try {
    const index = await DataSource.get('network', 'folders-index.json');
    state.sharedFolders = Array.isArray(index)
      ? index.filter(f => f.members?.includes(state.auth.username))
      : [];
  } catch { state.sharedFolders = []; }
}

function renderFolderRow() {
  const allFolders = [
    ...state.personalFolders.map(f => ({ ...f, kind: 'personal' })),
    ...state.sharedFolders.map(f => ({ ...f, kind: 'shared' })),
  ];
  const wrap = document.getElementById('folder-row-wrap');
  const row  = document.getElementById('folder-row');
  if (!wrap || !row) return;
  // Always show the row so users can create their first folder
  wrap.style.display = '';
  const allCount = (state.posts || []).length;
  row.innerHTML = `
    <div class="folder-card folder-card-all active" onclick="filterByFolder(null)" data-fid="__all">
      <div class="fc-pin"></div>
      <div class="fc-name">All Memories</div>
      <div class="fc-count">${allCount}</div>
    </div>
    ${allFolders.map(f => {
      const c = FOLDER_COLORS[f.color] || FOLDER_COLORS.gold;
      const count = f.kind === 'personal'
        ? (f.postIds || []).length
        : (f.postCount ?? 0);
      return `<div class="folder-card" onclick="filterByFolder('${esc(f.id)}')" data-fid="${esc(f.id)}"
                   style="--fc-light:${c.light};--fc-border:${c.border};--fc-dot:${c.bg}">
        <div class="fc-dot"></div>
        <div class="fc-icon">${f.kind === 'shared' ? '◈' : '⊟'}</div>
        <div class="fc-name">${esc(f.name)}</div>
        <div class="fc-count">${count}</div>
      </div>`;
    }).join('')}
    <div class="folder-card folder-card-new" onclick="openCreateFolderSheet('feed')">
      <div class="fc-new-icon">+</div>
      <div class="fc-name" style="color:var(--text-muted)">New folder</div>
    </div>
  `;
}

function filterByFolder(folderId) {
  // highlight selected card
  document.querySelectorAll('.folder-card').forEach(c => c.classList.remove('active'));
  const card = folderId
    ? document.querySelector(`.folder-card[data-fid="${folderId}"]`)
    : document.querySelector('.folder-card[data-fid="__all"]');
  card?.classList.add('active');

  if (!folderId) {
    state.filteredPosts = state.posts;
    renderFeed(state.filteredPosts);
    return;
  }
  // personal folder filter
  const personal = state.personalFolders.find(f => f.id === folderId);
  if (personal) {
    const ids = new Set(personal.postIds || []);
    state.filteredPosts = state.posts.filter(p => ids.has(p.id));
    renderFeed(state.filteredPosts);
    return;
  }
  // shared folder — load from network and render
  loadSharedFolderPosts(folderId).then(posts => {
    state.filteredPosts = posts;
    renderFeed(posts);
  });
}

async function loadSharedFolderPosts(folderId) {
  try {
    const entries = await DataSource.get('network', `folders/${folderId}/posts.json`) || [];
    const results = await Promise.allSettled(
      entries.map(async entry => {
        const source = entry.owner === state.auth.username ? 'personal' : `friend:${entry.owner}`;
        const meta = await DataSource.get(source, `posts/${entry.postId}/meta.json`);
        if (!meta) return null;
        return { ...meta, id: entry.postId, owner: entry.owner, addedAt: entry.addedAt };
      })
    );
    return results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .sort((a, b) => new Date(b.addedAt || b.createdAt) - new Date(a.addedAt || a.createdAt));
  } catch { return []; }
}

function initFolderChips(context) {
  const allFolders = [
    ...state.personalFolders.map(f => ({ ...f, kind:'personal' })),
    ...state.sharedFolders.map(f => ({ ...f, kind:'shared' })),
  ];
  const sectionId = context === 'create' ? 'create-folder-section' : 'edit-folder-section';
  const chipsId   = context === 'create' ? 'create-folder-chips'   : 'edit-folder-chips';
  const section   = document.getElementById(sectionId);
  const chipsEl   = document.getElementById(chipsId);
  if (!section || !chipsEl) return;
  if (!allFolders.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  if (context === 'create') {
    state._createPostFolders = [];
  } else {
    // Pre-select folders this post already belongs to
    const postId = state.editPost?.postId;
    state._editPostFolders = postId
      ? state.personalFolders.filter(f => (f.postIds || []).includes(postId)).map(f => f.id)
      : [];
  }
  renderFolderChips(context, chipsEl, allFolders);
}

function renderFolderChips(context, chipsEl, allFolders) {
  if (!chipsEl) return;
  const selected = context === 'create' ? state._createPostFolders : state._editPostFolders;
  chipsEl.innerHTML = allFolders.map(f => {
    const c = FOLDER_COLORS[f.color] || FOLDER_COLORS.gold;
    const sel = selected.includes(f.id);
    return `<button class="folder-chip${sel ? ' selected' : ''}"
              onclick="togglePostFolder('${esc(f.id)}','${context}')"
              style="--chip-bg:${c.light};--chip-border:${c.border};--chip-dot:${c.bg}">
      <span class="chip-dot"></span>${esc(f.name)}
      ${f.kind === 'shared' ? '<span class="chip-shared-icon">◈</span>' : ''}
    </button>`;
  }).join('');
}

function togglePostFolder(folderId, context) {
  const arr = context === 'create' ? state._createPostFolders : state._editPostFolders;
  const idx = arr.indexOf(folderId);
  if (idx === -1) arr.push(folderId); else arr.splice(idx, 1);
  const allFolders = [
    ...state.personalFolders.map(f => ({ ...f, kind:'personal' })),
    ...state.sharedFolders.map(f => ({ ...f, kind:'shared' })),
  ];
  const chipsId = context === 'create' ? 'create-folder-chips' : 'edit-folder-chips';
  renderFolderChips(context, document.getElementById(chipsId), allFolders);
}

// ── ADD EXISTING POST TO FOLDER ───────────────────────────────────
let _addToFolderPostId  = null;
let _addToFolderSelected = [];

function openAddToFolderSheet() {
  const meta = state.currentPost; if (!meta) return;
  const allFolders = [
    ...state.personalFolders.map(f => ({ ...f, kind: 'personal' })),
    ...state.sharedFolders.map(f => ({ ...f, kind: 'shared' })),
  ];
  if (!allFolders.length) {
    showToast('No folders yet', 'Create a folder first from the feed', 'info'); return;
  }
  _addToFolderPostId   = meta.id;
  _addToFolderSelected = state.personalFolders
    .filter(f => (f.postIds || []).includes(meta.id))
    .map(f => f.id);
  renderAddToFolderChips(allFolders);
  openSheet('sheet-add-to-folder');
}

function renderAddToFolderChips(allFolders) {
  const el = document.getElementById('add-to-folder-chips'); if (!el) return;
  el.innerHTML = allFolders.map(f => {
    const c   = FOLDER_COLORS[f.color] || FOLDER_COLORS.gold;
    const sel = _addToFolderSelected.includes(f.id);
    return `<button class="folder-chip${sel ? ' selected' : ''}"
              onclick="toggleAddToFolderChip('${esc(f.id)}')"
              style="--chip-bg:${c.light};--chip-border:${c.border};--chip-dot:${c.bg}">
      <span class="chip-dot"></span>${esc(f.name)}
      ${f.kind === 'shared' ? '<span class="chip-shared-icon">◈</span>' : ''}
    </button>`;
  }).join('');
}

function toggleAddToFolderChip(folderId) {
  const idx = _addToFolderSelected.indexOf(folderId);
  if (idx === -1) _addToFolderSelected.push(folderId); else _addToFolderSelected.splice(idx, 1);
  const allFolders = [
    ...state.personalFolders.map(f => ({ ...f, kind: 'personal' })),
    ...state.sharedFolders.map(f => ({ ...f, kind: 'shared' })),
  ];
  renderAddToFolderChips(allFolders);
}

async function confirmAddToFolder() {
  if (!_addToFolderPostId) return;
  closeSheet('sheet-add-to-folder');
  let personalChanged = false;
  for (const fid of _addToFolderSelected) {
    const personal = state.personalFolders.find(f => f.id === fid);
    if (personal) {
      if (!personal.postIds) personal.postIds = [];
      if (!personal.postIds.includes(_addToFolderPostId)) {
        personal.postIds.push(_addToFolderPostId); personalChanged = true;
      }
    } else {
      await addPostToSharedFolder(fid, _addToFolderPostId);
    }
  }
  if (personalChanged) await savePersonalFolders();
  showToast('Saved to folder', '', 'success');
  renderFolderRow();
}

async function applyFolderSelections(postId, context) {
  const selected = context === 'create' ? state._createPostFolders : state._editPostFolders;
  for (const fid of selected) {
    const personal = state.personalFolders.find(f => f.id === fid);
    if (personal) {
      if (!personal.postIds) personal.postIds = [];
      if (!personal.postIds.includes(postId)) {
        personal.postIds.push(postId);
      }
    } else {
      await addPostToSharedFolder(fid, postId);
    }
  }
  if (selected.some(fid => state.personalFolders.find(f => f.id === fid))) {
    await savePersonalFolders();
  }
  if (context === 'create') state._createPostFolders = [];
  else state._editPostFolders = [];
}

async function addPostToSharedFolder(folderId, postId) {
  let retries = 3;
  while (retries > 0) {
    try {
      const current = await DataSource.get('network', `folders/${folderId}/posts.json`) || [];
      if (current.some(p => p.postId === postId && p.owner === state.auth.username)) return;
      await DataSource.put('network', `folders/${folderId}/posts.json`, [
        ...current,
        { postId, owner: state.auth.username, addedAt: new Date().toISOString(), addedBy: state.auth.username }
      ]);
      await updateFoldersIndex(folderId, null, current.length + 1);
      return;
    } catch (err) {
      if (err?.status === 409) { retries--; await new Promise(r => setTimeout(r, 300 + Math.random()*200)); }
      else throw err;
    }
  }
  showToast('Conflict saving to folder', 'Try again in a moment', 'warning');
}

async function updateFoldersIndex(folderId, metaOverride, newPostCount) {
  let retries = 3;
  while (retries > 0) {
    try {
      const index = await DataSource.get('network', 'folders-index.json') || [];
      const existing = index.find(f => f.id === folderId);
      if (existing) {
        if (metaOverride) Object.assign(existing, { name: metaOverride.name, members: metaOverride.members, color: metaOverride.color });
        if (newPostCount !== null && newPostCount !== undefined) existing.postCount = newPostCount;
        existing.lastUpdated = new Date().toISOString();
      } else if (metaOverride) {
        index.push({ ...metaOverride, postCount: 0, lastUpdated: new Date().toISOString() });
      }
      await DataSource.put('network', 'folders-index.json', index);
      return;
    } catch (err) {
      if (err?.status === 409) { retries--; await new Promise(r => setTimeout(r, 300 + Math.random()*200)); }
      else throw err;
    }
  }
}

async function createPersonalFolder(name, color) {
  const id = `pfolder-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const folder = { id, name, color, postIds: [], createdAt: new Date().toISOString() };
  state.personalFolders.push(folder);
  await savePersonalFolders();
  return id;
}

async function createSharedFolder(name, color) {
  if (!state.auth?.networkOwner || !state.auth?.token3) throw new Error('Network repo not set up');
  const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const meta = { id, name, color, createdBy: state.auth.username, createdAt: new Date().toISOString(), members: [state.auth.username] };
  await Promise.all([
    DataSource.put('network', `folders/${id}/meta.json`, meta),
    DataSource.put('network', `folders/${id}/posts.json`, []),
  ]);
  await updateFoldersIndex(id, meta, 0);
  state.sharedFolders.push({ ...meta, postCount: 0 });
  return id;
}

function openFoldersScreen() {
  navigateTo('screen-folders');
}

function loadFoldersScreen() {
  const grid = document.getElementById('folders-grid');
  if (!grid) return;
  const allFolders = [
    ...state.personalFolders.map(f => ({ ...f, kind:'personal' })),
    ...state.sharedFolders.map(f => ({ ...f, kind:'shared' })),
  ];
  if (!allFolders.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⊟</div><div class="empty-title">No folders yet</div><div class="empty-sub">Tap + to create your first folder</div></div>`;
    return;
  }
  grid.innerHTML = allFolders.map(f => {
    const c = FOLDER_COLORS[f.color] || FOLDER_COLORS.gold;
    const count = f.kind === 'personal' ? (f.postIds || []).length : (f.postCount ?? 0);
    const icon  = f.kind === 'shared' ? '◈' : '⊟';
    return `<div class="folder-grid-card" onclick="filterByFolder('${esc(f.id)}');goBack()"
                 style="--fgc-light:${c.light};--fgc-border:${c.border};--fgc-dot:${c.bg}">
      <div class="fgc-icon">${icon}</div>
      <div class="fgc-dot"></div>
      <div class="fgc-name">${esc(f.name)}</div>
      <div class="fgc-count">${count} ${count === 1 ? 'memory' : 'memories'}</div>
      <div class="fgc-type">${f.kind === 'shared' ? 'shared' : 'personal'}</div>
    </div>`;
  }).join('');
}

function openCreateFolderSheet(context) {
  state._createFolderCtx   = context;
  state._createFolderColor = 'gold';
  state._createFolderType  = 'personal';
  const nameEl = document.getElementById('new-folder-name');
  if (nameEl) nameEl.value = '';
  const errEl = document.getElementById('create-folder-error');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  // reset color dots
  document.querySelectorAll('.folder-color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === 'gold');
  });
  // reset type buttons
  document.querySelectorAll('.folder-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === 'personal');
  });
  const hint = document.getElementById('folder-type-hint');
  if (hint) hint.textContent = 'Stored in your private repo only.';
  // hide shared option if no network repo
  const sharedBtn = document.getElementById('folder-type-shared');
  if (sharedBtn) sharedBtn.style.display = (state.auth?.token3) ? '' : 'none';
  openSheet('sheet-create-folder');
}

function selectFolderType(type) {
  state._createFolderType = type;
  document.querySelectorAll('.folder-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  const hint = document.getElementById('folder-type-hint');
  if (hint) hint.textContent = type === 'shared'
    ? 'Visible to all friends in your network.'
    : 'Stored in your private repo only.';
}

function selectFolderColor(color) {
  state._createFolderColor = color;
  document.querySelectorAll('.folder-color-dot').forEach(d => d.classList.toggle('active', d.dataset.color === color));
}

async function confirmCreateFolder() {
  const name  = document.getElementById('new-folder-name')?.value.trim();
  const errEl = document.getElementById('create-folder-error');
  if (!name) { errEl.textContent = 'Please enter a folder name.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  const btn = document.querySelector('#sheet-create-folder .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    let id;
    if (state._createFolderType === 'shared') {
      id = await createSharedFolder(name, state._createFolderColor);
    } else {
      id = await createPersonalFolder(name, state._createFolderColor);
    }
    closeSheet('sheet-create-folder');
    showToast(`Folder created`, name, 'success');
    renderFolderRow();
    // If opened from create/edit context, re-init chips
    if (state._createFolderCtx === 'create') initFolderChips('create');
    if (state._createFolderCtx === 'edit')   initFolderChips('edit');
    if (state._createFolderCtx === 'feed')   loadFoldersScreen();
  } catch (err) {
    errEl.textContent = err.message || 'Could not create folder.';
    errEl.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create Folder'; }
  }
}

async function handleFolderInvite(data) {
  showToast(`Added to "${data.folderName}"`, `by ${data.invitedBy}`, 'success');
  await loadSharedFolders();
  renderFolderRow();
}

async function loadMusicIndexBackground() {
  try {
    const idx = await DataSource.get(musicSource(), 'music/music-index.json');
    state.musicIndex = Array.isArray(idx) ? idx : [];
  } catch {}
}

boot();
