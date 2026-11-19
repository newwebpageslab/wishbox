// Supabase 클라우드 동기화 (외부 라이브러리 없이 REST API 직접 호출)
// - 휴대폰 저장소(IndexedDB)가 기본이고, 로그인하면 Supabase와 자동으로 맞춰짐
// - 같은 위시가 양쪽에서 바뀌면 더 나중에 수정된 쪽을 남김 (updatedAt 비교)
// - 비밀번호는 저장하지 않고, 로그인 후 받은 토큰만 이 기기에 저장
import * as db from './db.js';

const CONFIG_KEY = 'wishbox.cloud.config';
const SESSION_KEY = 'wishbox.cloud.session';
const TOMBSTONE_KEY = 'wishbox.cloud.tombstones';
const LAST_SYNC_KEY = 'wishbox.cloud.lastSync';
const TABLE = 'wishes';
const BUCKET = 'wish-images';

const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const store = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 저장 불가 환경 */ }
};
const randomId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export class CloudError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // config | auth | network | server
  }
}

/* ───────── 설정·세션 ───────── */
export const getConfig = () => load(CONFIG_KEY, { url: '', key: '' });
export function setConfig({ url, key }) {
  store(CONFIG_KEY, { url: String(url || '').trim().replace(/\/+$/, ''), key: String(key || '').trim() });
}
const getSession = () => load(SESSION_KEY, null);
export const isSignedIn = () => Boolean(getSession()?.refresh_token);
export const userEmail = () => getSession()?.user?.email || '';
export const lastSyncAt = () => load(LAST_SYNC_KEY, 0);

function saveSession(data) {
  const prev = getSession();
  store(SESSION_KEY, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3600) * 1000,
    user: { id: data.user?.id || prev?.user?.id, email: data.user?.email || prev?.user?.email },
  });
}

/* ───────── 상태 알림 (설정 화면·아이콘 갱신용) ───────── */
const listeners = new Set();
let status = { state: 'idle', error: null };
export const getStatus = () => status;
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setStatus(next) {
  status = next;
  listeners.forEach((fn) => { try { fn(status); } catch { /* 무시 */ } });
}

/* ───────── 인증 ───────── */
async function authRequest(grantType, body) {
  const { url, key } = getConfig();
  if (!url || !key) throw new CloudError('config', '프로젝트 URL과 Publishable key를 입력해 주세요');
  let res;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
  } catch {
    throw new CloudError('network', 'Supabase에 연결할 수 없어요. 주소와 인터넷 연결을 확인해 주세요');
  }
  if (res.status === 400 || res.status === 401) {
    if (grantType === 'refresh_token') {
      store(SESSION_KEY, null);
      throw new CloudError('auth', '로그인이 만료됐어요. 다시 로그인해 주세요');
    }
    throw new CloudError('auth', '이메일 또는 비밀번호가 맞지 않아요');
  }
  if (!res.ok) throw new CloudError('server', `Supabase 오류가 났어요 (${res.status})`);
  return res.json();
}

export async function signIn(email, password) {
  const data = await authRequest('password', { email: email.trim(), password });
  saveSession(data);
}

export async function signOut() {
  const session = getSession();
  const { url, key } = getConfig();
  if (session && url && key) {
    fetch(`${url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${session.access_token}` },
    }).catch(() => {});
  }
  store(SESSION_KEY, null);
  store(TOMBSTONE_KEY, null);
  store(LAST_SYNC_KEY, null);
  setStatus({ state: 'idle', error: null });
}

let refreshing = null;
async function accessToken() {
  const session = getSession();
  if (!session) throw new CloudError('auth', '로그인이 필요해요');
  if (Date.now() < session.expires_at - 60_000) return session.access_token;
  refreshing ??= authRequest('refresh_token', { refresh_token: session.refresh_token })
    .then((data) => { saveSession(data); return data.access_token; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/* ───────── API 요청 ───────── */
async function api(path, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const { url, key } = getConfig();
  if (!url || !key) throw new CloudError('config', '클라우드 설정이 없어요');
  const token = await accessToken();
  let res;
  try {
    res = await fetch(url + path, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${token}`, ...headers },
      body,
      credentials: 'omit',
    });
  } catch {
    throw new CloudError('network', 'Supabase에 연결할 수 없어요. 프로젝트가 일시정지됐다면 대시보드에서 다시 켜 주세요');
  }
  if (res.status === 401) throw new CloudError('auth', '로그인이 만료됐어요. 다시 로그인해 주세요');
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.message || j.error || ''; } catch { /* 본문 없음 */ }
    throw new CloudError('server', `Supabase 오류가 났어요 (${res.status}${detail ? `: ${detail}` : ''})`);
  }
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const upload = (path, blob) =>
  api(`/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'image/webp', 'x-upsert': 'true' },
    body: blob,
  });

async function download(path) {
  const res = await api(`/storage/v1/object/authenticated/${BUCKET}/${encodePath(path)}`, { raw: true });
  return res.blob();
}

const upsertRows = (rows) =>
  api(`/rest/v1/${TABLE}?on_conflict=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

/* ───────── 삭제 기록 (오프라인에서 지운 위시도 나중에 클라우드에서 지우기 위함) ───────── */
export function markDeleted(id) {
  const tombs = load(TOMBSTONE_KEY, {});
  tombs[id] = Date.now();
  store(TOMBSTONE_KEY, tombs);
}

/* ───────── 변환 ───────── */
// 로컬 위시 → 클라우드 줄 (사진은 업로드 후 경로만 기록)
async function pushItem(item, uid) {
  let imagesChanged = false;
  for (const img of item.images || []) {
    if (!img.id) { img.id = randomId(); imagesChanged = true; }
    if (!img.path) {
      const base = `${uid}/${item.id}/${img.id}`;
      await upload(`${base}-full`, img.full);
      await upload(`${base}-thumb`, img.thumb);
      img.path = base;
      imagesChanged = true;
    }
  }
  if (imagesChanged) await db.putItem(item); // 업로드 경로 기억 (updatedAt은 그대로)
  const { images, ...data } = item;
  return {
    id: item.id,
    data,
    images: (images || []).map((img) => ({ id: img.id, path: img.path })),
    updated_at: item.updatedAt,
    deleted: false,
  };
}

// 클라우드 줄 → 로컬 위시 (이미 받은 사진은 다시 받지 않음)
async function pullItem(row, localItem) {
  const images = [];
  for (const ref of row.images || []) {
    const existing = localItem?.images?.find((img) => img.path && img.path === ref.path);
    if (existing) { images.push(existing); continue; }
    const [full, thumb] = await Promise.all([download(`${ref.path}-full`), download(`${ref.path}-thumb`)]);
    images.push({ id: ref.id, path: ref.path, full, thumb });
  }
  return { ...row.data, id: row.id, images, updatedAt: row.updated_at };
}

/* ───────── 동기화 ───────── */
let syncing = null;
let timer = 0;
// 앱이 메모리에 들고 있는 위시 목록을 그대로 쓰도록 연결 (업로드한 사진 경로가 앱 쪽에도 바로 반영됨)
let localSource = () => db.getAllItems();
export function setLocalSource(fn) { localSource = fn; }

export function scheduleSync(delay = 1500) {
  if (!isSignedIn()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

export function syncNow() {
  if (!isSignedIn()) return Promise.reject(new CloudError('auth', '로그인이 필요해요'));
  if (!syncing) syncing = runSync().finally(() => { syncing = null; });
  return syncing;
}

async function runSync() {
  setStatus({ state: 'syncing', error: null });
  try {
    const uid = getSession().user.id;
    const local = [...(await localSource())];
    const localMap = new Map(local.map((i) => [i.id, i]));
    const rows = await api(`/rest/v1/${TABLE}?select=id,data,images,updated_at,deleted`);
    const remoteMap = new Map(rows.map((r) => [r.id, r]));
    const tombs = load(TOMBSTONE_KEY, {});

    const deletesToPush = [];
    const itemsToPush = [];
    const rowsToPull = [];
    const idsToDeleteLocally = [];

    // 1) 이 기기에서 지운 위시
    for (const [id, deletedAt] of Object.entries(tombs)) {
      const remote = remoteMap.get(id);
      if (localMap.has(id) || !remote || remote.deleted) { delete tombs[id]; continue; } // 되살렸거나 이미 처리됨
      if (remote.updated_at <= deletedAt) deletesToPush.push({ id, deletedAt, images: remote.images || [] });
      else delete tombs[id]; // 다른 기기에서 더 나중에 수정 → 클라우드 쪽을 살림
    }
    const pendingDelete = new Set(deletesToPush.map((d) => d.id));

    // 2) 클라우드와 비교
    for (const row of rows) {
      if (pendingDelete.has(row.id)) continue;
      const localItem = localMap.get(row.id);
      if (row.deleted) {
        if (localItem && localItem.updatedAt <= row.updated_at) idsToDeleteLocally.push(row.id);
        else if (localItem) itemsToPush.push(localItem);
        continue;
      }
      if (!localItem || row.updated_at > localItem.updatedAt) rowsToPull.push(row);
      else if (localItem.updatedAt > row.updated_at) itemsToPush.push(localItem);
    }
    for (const item of local) if (!remoteMap.has(item.id)) itemsToPush.push(item);

    // 3) 받아오기
    for (const row of rowsToPull) await db.putItem(await pullItem(row, localMap.get(row.id)));
    for (const id of idsToDeleteLocally) await db.deleteItem(id);

    // 4) 올리기
    const upRows = [];
    for (const item of itemsToPush) upRows.push(await pushItem(item, uid));
    for (const d of deletesToPush) upRows.push({ id: d.id, data: {}, images: [], updated_at: d.deletedAt, deleted: true });
    if (upRows.length) await upsertRows(upRows);

    // 5) 지운 위시의 사진 파일 정리 (실패해도 동기화는 성공으로 처리)
    const orphanFiles = deletesToPush.flatMap((d) => d.images.flatMap((img) => [`${img.path}-full`, `${img.path}-thumb`]));
    if (orphanFiles.length) {
      api(`/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: orphanFiles }),
      }).catch(() => {});
    }
    deletesToPush.forEach((d) => delete tombs[d.id]);
    store(TOMBSTONE_KEY, tombs);
    store(LAST_SYNC_KEY, Date.now());

    const result = {
      pulled: rowsToPull.length + idsToDeleteLocally.length,
      pushed: itemsToPush.length + deletesToPush.length,
    };
    setStatus({ state: 'idle', error: null, result });
    return result;
  } catch (e) {
    const error = e instanceof CloudError ? e : new CloudError('server', e?.message || '동기화하지 못했어요');
    setStatus({ state: 'error', error });
    throw error;
  }
}
