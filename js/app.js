import * as db from './db.js';
import { Spring, haptic } from './spring.js';
import { Sheet } from './sheet.js';
import { processImage, blobUrl, blobToDataURL, dataURLToBlob } from './images.js';
import {
  extractUrl, isValidUrl, normalizeUrl, storeNameFromUrl, parsePrice,
  fetchProductMeta, fetchImageBlob,
} from './meta.js';

/* ───────────── 유틸 ───────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const won = (n) => (n ? `${Number(n).toLocaleString('ko-KR')}원` : '');
const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const uid = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (ts) => {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : `${d.getFullYear()}년 `}${d.getMonth() + 1}월 ${d.getDate()}일`;
};
const daysAgo = (ts) => {
  const days = Math.floor((Date.now() - ts) / 86400000);
  return days <= 0 ? '오늘' : `${days}일 전`;
};
const formatDigits = (value) => {
  const n = parsePrice(value);
  return n ? n.toLocaleString('ko-KR') : '';
};

/* ───────────── 설정 (기기 내 localStorage) ───────────── */
const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url={url}';
const SETTINGS_KEY = 'wishbox.settings';
const DEFAULT_SETTINGS = { autoFetch: false, proxy: DEFAULT_PROXY, checkOnOpen: true, sort: 'recent' };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 저장 불가 환경 */ }
}

/* ───────────── 상태 ───────────── */
const STATUS_LABEL = { wish: '위시', bought: '구매함', dropped: '포기함' };
const SORTS = {
  recent: '최근 저장순',
  oldest: '오래된순',
  priceAsc: '가격 낮은순',
  priceDesc: '가격 높은순',
  priority: '우선순위순',
  target: '목표가 근접순',
};
const PRIORITY_LABEL = { 1: '언젠가', 2: '갖고 싶음', 3: '꼭 사고 싶음' };
const DEFAULT_CATEGORIES = ['의류', '신발', '가방', '뷰티', '전자기기', '생활', '취미'];

const state = { items: [], status: 'wish', filter: 'all', query: '' };
let openDetailSheet = null; // 현재 열린 상세 시트 { id, refresh }

const isReached = (it) =>
  it.status === 'wish' && it.targetPrice > 0 && it.price > 0 && it.price <= it.targetPrice;

function normalizeItem(raw) {
  return {
    id: raw.id || uid(),
    title: raw.title || '',
    url: raw.url || '',
    store: raw.store || (raw.url ? storeNameFromUrl(raw.url) : ''),
    price: parsePrice(raw.price),
    targetPrice: parsePrice(raw.targetPrice),
    category: raw.category || '',
    priority: [1, 2, 3].includes(raw.priority) ? raw.priority : 2,
    memo: raw.memo || '',
    images: Array.isArray(raw.images) ? raw.images : [],
    imageUrl: raw.imageUrl || '',
    status: STATUS_LABEL[raw.status] ? raw.status : 'wish',
    priceHistory: Array.isArray(raw.priceHistory) ? raw.priceHistory : [],
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
    statusAt: raw.statusAt || null,
    lastCheckedAt: raw.lastCheckedAt || null,
    reachedAt: raw.reachedAt || null,
  };
}

const findItem = (id) => state.items.find((i) => i.id === id);

async function persist(item) {
  item.updatedAt = Date.now();
  await db.putItem(item);
  const idx = state.items.findIndex((i) => i.id === item.id);
  if (idx >= 0) state.items[idx] = item;
  else state.items.push(item);
}

/* ───────────── 메인 목록 렌더링 ───────────── */
const grid = $('#grid');
const emptyState = $('#emptyState');

function thumbSrc(it) {
  const img = it.images?.[0];
  return img ? blobUrl(img.thumb) : it.imageUrl || '';
}

function placeholderHtml(it) {
  const letter = esc((it.title || it.store || '?').trim().charAt(0).toUpperCase());
  return `<div class="placeholder" aria-hidden="true">${letter}</div>`;
}

function cardMeta(it) {
  if (it.status === 'bought') return `구매 · ${fmtDate(it.statusAt || it.updatedAt)}`;
  if (it.status === 'dropped') return `포기 · ${fmtDate(it.statusAt || it.updatedAt)}`;
  if (isReached(it)) return '<span class="tone-green">목표가 도달</span>';
  if (it.targetPrice && it.price) return `목표가까지 ${won(it.price - it.targetPrice)}`;
  return esc(it.store || daysAgo(it.createdAt));
}

function cardHtml(it) {
  const src = thumbSrc(it);
  return `
    <button class="card" data-id="${esc(it.id)}" type="button">
      <div class="thumb">
        ${placeholderHtml(it)}
        ${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
        ${isReached(it) ? `<span class="badge badge-green">${icon('target')}도달</span>` : ''}
        ${it.priority === 3 && it.status === 'wish' ? `<span class="badge badge-heart" aria-label="꼭 사고 싶음">${icon('heart')}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-store">${esc(it.store || '직접 추가')}</div>
        <div class="card-title">${esc(it.title)}</div>
        <div class="card-price">${it.price ? won(it.price) : '<span class="muted">가격 미입력</span>'}</div>
        <div class="card-meta">${cardMeta(it)}</div>
      </div>
    </button>`;
}

function sortItems(list) {
  const byNullLast = (a, b, fn) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return fn(a, b);
  };
  const sorted = [...list];
  switch (settings.sort) {
    case 'oldest': sorted.sort((a, b) => a.createdAt - b.createdAt); break;
    case 'priceAsc': sorted.sort((a, b) => byNullLast(a.price, b.price, (x, y) => x - y)); break;
    case 'priceDesc': sorted.sort((a, b) => byNullLast(a.price, b.price, (x, y) => y - x)); break;
    case 'priority': sorted.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt); break;
    case 'target': {
      const ratio = (it) => (it.price && it.targetPrice ? (it.price - it.targetPrice) / it.targetPrice : null);
      sorted.sort((a, b) => byNullLast(ratio(a), ratio(b), (x, y) => x - y));
      break;
    }
    default: sorted.sort((a, b) => b.createdAt - a.createdAt);
  }
  return sorted;
}

function renderChips(inStatus) {
  const chips = $('#chips');
  const counts = new Map();
  inStatus.forEach((it) => it.category && counts.set(it.category, (counts.get(it.category) || 0) + 1));
  const reachedCount = inStatus.filter(isReached).length;

  // 사라진 필터는 초기화
  if (state.filter === 'reached' && !reachedCount) state.filter = 'all';
  if (state.filter.startsWith('cat:') && !counts.has(state.filter.slice(4))) state.filter = 'all';

  const chip = (key, label, count, extra = '') =>
    `<button type="button" class="chip ${extra} ${state.filter === key ? 'selected' : ''}" data-filter="${esc(key)}" aria-pressed="${state.filter === key}">${label}<span class="chip-count">${count}</span></button>`;

  let html = chip('all', '전체', inStatus.length);
  if (reachedCount) html += chip('reached', `${icon('target')}목표가 도달`, reachedCount, 'chip-green');
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count]) => (html += chip(`cat:${name}`, esc(name), count)));
  chips.innerHTML = html;
  chips.hidden = inStatus.length === 0;
}

function render() {
  const counts = { wish: 0, bought: 0, dropped: 0 };
  state.items.forEach((it) => counts[it.status]++);
  $$('#statusSeg [data-status]').forEach((b) => {
    $('.seg-count', b).textContent = counts[b.dataset.status] || '';
  });

  const inStatus = state.items.filter((i) => i.status === state.status);
  renderChips(inStatus);

  let list = inStatus;
  if (state.filter === 'reached') list = list.filter(isReached);
  else if (state.filter.startsWith('cat:')) list = list.filter((i) => i.category === state.filter.slice(4));

  const q = state.query.trim().toLowerCase();
  if (q) {
    list = list.filter((i) =>
      [i.title, i.memo, i.store, i.category, i.url].some((v) => (v || '').toLowerCase().includes(q)));
  }
  list = sortItems(list);

  grid.innerHTML = list.map(cardHtml).join('');
  $('#sortBtn .sort-label').textContent = SORTS[settings.sort] || SORTS.recent;

  const total = list.reduce((sum, i) => sum + (i.price || 0), 0);
  $('#summaryLine').textContent = list.length
    ? `${list.length}개${total ? ` · 합계 ${won(total)}` : ''}`
    : '';

  emptyState.hidden = list.length > 0;
  if (!list.length) {
    if (q) {
      emptyState.innerHTML = `<div class="empty-icon">${icon('search')}</div>
        <p class="empty-title">‘${esc(state.query.trim())}’에 맞는 위시가 없어요</p>
        <p class="empty-desc">상품명, 메모, 쇼핑몰 이름으로 찾을 수 있어요.</p>`;
    } else if (state.status === 'wish') {
      emptyState.innerHTML = `<div class="empty-icon">${icon('heart')}</div>
        <p class="empty-title">아직 담은 위시가 없어요</p>
        <p class="empty-desc">아래 ‘위시 추가’를 눌러 상품 링크를 붙여넣거나<br>캡처한 사진을 넣어 첫 위시를 담아보세요.</p>`;
    } else {
      emptyState.innerHTML = `<div class="empty-icon">${icon(state.status === 'bought' ? 'bag' : 'xmark')}</div>
        <p class="empty-title">${state.status === 'bought' ? '구매한 위시가 없어요' : '포기한 위시가 없어요'}</p>
        <p class="empty-desc">위시 상세 화면에서 ${state.status === 'bought' ? '‘구매 완료’' : '‘포기’'}를 누르면 여기로 옮겨져요.</p>`;
    }
  }
  openDetailSheet?.refresh();
}

// 이미지가 깨지면 플레이스홀더가 보이도록 제거
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.thumb, .gallery, .photo-tile')) e.target.remove();
}, true);

/* ───────────── 세그먼트 컨트롤 (스프링 인디케이터) ───────────── */
const seg = $('#statusSeg');
const segIndicator = $('.seg-indicator', seg);
const segX = new Spring({ damping: 1, response: 0.32, onUpdate: (x) => (segIndicator.style.transform = `translateX(${x}px)`) });
const segW = new Spring({ damping: 1, response: 0.32, onUpdate: (w) => (segIndicator.style.width = `${w}px`) });

function moveSegIndicator(animate = true) {
  const btn = $(`[data-status="${state.status}"]`, seg);
  if (!btn) return;
  const x = btn.offsetLeft;
  const w = btn.offsetWidth;
  if (animate) { segX.to(x); segW.to(w); } else { segX.set(x); segW.set(w); }
  $$('[data-status]', seg).forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
}

seg.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-status]');
  if (!btn || btn.dataset.status === state.status) return;
  state.status = btn.dataset.status;
  state.filter = 'all';
  moveSegIndicator(true);
  render();
  window.scrollTo({ top: 0 });
});
window.addEventListener('resize', () => moveSegIndicator(false));

/* ───────────── 상단바: 큰 제목이 사라지면 작은 제목 + 반투명 재질 ───────────── */
const navbar = $('#navbar');
new IntersectionObserver(([entry]) => {
  navbar.classList.toggle('scrolled', !entry.isIntersecting);
}, { rootMargin: '-56px 0px 0px 0px' }).observe($('#largeTitle'));

/* ───────────── 검색 ───────────── */
const searchInput = $('#searchInput');
searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  $('#searchClear').hidden = !searchInput.value;
  render();
});
$('#searchClear').addEventListener('click', () => {
  searchInput.value = '';
  state.query = '';
  $('#searchClear').hidden = true;
  render();
  searchInput.focus();
});

$('#chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  state.filter = state.filter === chip.dataset.filter ? 'all' : chip.dataset.filter;
  render();
});

/* ───────────── 정렬 팝오버 (버튼에서 펼쳐짐) ───────────── */
function openSortMenu(anchor) {
  const existing = $('.popover');
  if (existing) { existing.remove(); return; }
  const rect = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = Object.entries(SORTS)
    .map(([key, label]) => `<button type="button" role="menuitemradio" aria-checked="${settings.sort === key}" data-sort="${key}">
      <span>${label}</span>${settings.sort === key ? icon('check') : ''}</button>`)
    .join('');
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  document.body.appendChild(pop);
  requestAnimationFrame(() => pop.classList.add('show'));

  const close = () => {
    pop.classList.remove('show');
    pop.addEventListener('transitionend', () => pop.remove(), { once: true });
    setTimeout(() => pop.remove(), 300);
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  document.addEventListener('pointerdown', outside, true);
  pop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    settings.sort = btn.dataset.sort;
    saveSettings();
    render();
    close();
  });
}
$('#sortBtn').addEventListener('click', (e) => openSortMenu(e.currentTarget));

/* ───────────── 토스트 (아래에서 나타나 아래로 사라짐) ───────────── */
let currentToast = null;
function toast(message, { actionLabel, onAction, duration = 3200, tone = '' } = {}) {
  currentToast?.dismiss();
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="toast-msg">${message}</span>${actionLabel ? `<button type="button" class="toast-action">${esc(actionLabel)}</button>` : ''}`;
  $('#toastRoot').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let timer = setTimeout(() => handle.dismiss(), duration);
  const handle = {
    dismiss() {
      clearTimeout(timer);
      el.classList.remove('in');
      setTimeout(() => el.remove(), 320);
      if (currentToast === handle) currentToast = null;
    },
  };
  el.querySelector('.toast-action')?.addEventListener('click', () => {
    handle.dismiss();
    onAction?.();
  });
  currentToast = handle;
  return handle;
}

/* ───────────── 목표가 도달 알림 ───────────── */
async function systemNotify(item) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.ready;
    if (!reg) return;
    const src = item.images?.[0] ? undefined : item.imageUrl || undefined;
    await reg.showNotification('🎯 목표가에 도달했어요', {
      body: `${item.title}\n지금 ${won(item.price)} (목표 ${won(item.targetPrice)})`,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      image: src,
      tag: `reached-${item.id}`,
      data: { id: item.id },
    });
  } catch { /* 알림 실패는 조용히 무시 */ }
}

function celebrateReached(item, { system = false } = {}) {
  haptic([12, 60, 12]);
  toast(`${icon('target')}<b>${esc(item.title)}</b> 목표가 도달! ${won(item.price)}`, {
    tone: 'toast-green',
    actionLabel: '보기',
    onAction: () => openDetail(item.id),
    duration: 6000,
  });
  if (system || document.hidden) systemNotify(item);
}

// 가격 변경 기록 + 목표가 도달 여부 판정
function applyPrice(item, newPrice, source) {
  const wasReached = isReached(item);
  let changed = false;
  if (newPrice && newPrice !== item.price) {
    item.priceHistory = [...(item.priceHistory || []), { price: newPrice, at: Date.now(), source }];
    item.price = newPrice;
    changed = true;
  }
  const newlyReached = !wasReached && isReached(item);
  if (newlyReached) item.reachedAt = Date.now();
  if (!isReached(item)) item.reachedAt = null;
  return { changed, newlyReached };
}

/* ───────────── 앱 열 때 가격 확인 (링크+목표가 있는 위시) ───────────── */
const CHECK_INTERVAL = 6 * 3600 * 1000;
const CHECK_LIMIT = 15;
let checking = false;

async function checkPrices({ manual = false } = {}) {
  if (checking || !settings.autoFetch || !navigator.onLine) {
    if (manual && !settings.autoFetch) toast('설정에서 ‘링크 정보 자동 가져오기’를 먼저 켜주세요');
    return;
  }
  const now = Date.now();
  const targets = state.items
    .filter((i) => i.status === 'wish' && i.url && i.targetPrice > 0)
    .filter((i) => manual || !i.lastCheckedAt || now - i.lastCheckedAt > CHECK_INTERVAL)
    .slice(0, CHECK_LIMIT);
  if (!targets.length) {
    if (manual) toast('확인할 위시가 없어요 (링크와 목표가가 있는 위시만 확인해요)');
    return;
  }

  checking = true;
  const status = $('#checkStatus');
  status.hidden = false;
  let updated = 0;
  let reached = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    status.textContent = `가격 확인 중 ${i + 1}/${targets.length}`;
    try {
      const meta = await fetchProductMeta(item.url, settings.proxy);
      item.lastCheckedAt = Date.now();
      if (meta.price) {
        const r = applyPrice(item, meta.price, 'auto');
        if (r.changed) updated++;
        if (r.newlyReached) { reached++; celebrateReached(item, { system: true }); }
      } else failed++;
      await persist(item);
    } catch {
      failed++;
    }
    if (i < targets.length - 1) await sleep(1200);
  }
  checking = false;
  status.hidden = true;
  render();
  if (manual || updated) {
    if (!reached) {
      const parts = [`${targets.length}개 확인`];
      if (updated) parts.push(`${updated}개 가격 변동`);
      if (failed) parts.push(`${failed}개 확인 불가`);
      toast(parts.join(' · '));
    }
  }
}

/* ───────────── 추가 / 편집 시트 ───────────── */
const fileInput = $('#fileInput');

function pickImages() {
  return new Promise((resolve) => {
    fileInput.value = '';
    const onChange = () => { fileInput.removeEventListener('change', onChange); resolve([...fileInput.files]); };
    fileInput.addEventListener('change', onChange);
    fileInput.click();
  });
}

const MAX_PHOTOS = 6;

function openForm(existing = null, { sharedText = '' } = {}) {
  const draft = existing
    ? { ...existing, images: existing.images.slice(), priceHistory: existing.priceHistory.slice() }
    : normalizeItem({});
  const isEdit = Boolean(existing);

  const sheet = new Sheet({ title: isEdit ? '위시 편집' : '위시 추가', className: 'sheet-form' });
  sheet.left.innerHTML = `<button type="button" class="nav-btn" data-act="cancel">취소</button>`;
  sheet.right.innerHTML = `<button type="button" class="nav-btn nav-btn-strong" data-act="save">${isEdit ? '완료' : '저장'}</button>`;

  const usedCategories = [...new Set(state.items.map((i) => i.category).filter(Boolean))];
  const categoryOptions = [...new Set([...usedCategories, ...DEFAULT_CATEGORIES])].slice(0, 12);

  sheet.body.innerHTML = `
    <form class="form" novalidate>
      <section class="group">
        <label class="field">
          <span class="field-label">${icon('link')}상품 링크</span>
          <div class="field-row">
            <input name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
              placeholder="링크 붙여넣기" value="${esc(draft.url)}">
            <button type="button" class="pill-btn" data-act="paste">붙여넣기</button>
          </div>
        </label>
        <div class="link-status" hidden></div>
      </section>

      <section class="photos-section">
        <div class="section-label">${icon('photo')}사진 <span class="muted">캡처·사진 최대 ${MAX_PHOTOS}장</span></div>
        <div class="photos"></div>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">상품명</span>
          <textarea name="title" rows="1" placeholder="예) 나이키 에어포스 1 화이트" maxlength="200">${esc(draft.title)}</textarea>
        </label>
        <div class="field-pair">
          <label class="field">
            <span class="field-label">현재 가격</span>
            <div class="money"><input name="price" inputmode="numeric" autocomplete="off" placeholder="0" value="${formatDigits(draft.price)}"><span>원</span></div>
          </label>
          <label class="field">
            <span class="field-label">${icon('target')}목표가</span>
            <div class="money"><input name="targetPrice" inputmode="numeric" autocomplete="off" placeholder="이 가격이면 구매" value="${formatDigits(draft.targetPrice)}"><span>원</span></div>
          </label>
        </div>
        <p class="field-hint target-hint" hidden></p>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">카테고리</span>
          <input name="category" autocomplete="off" placeholder="직접 입력하거나 아래에서 선택" value="${esc(draft.category)}" maxlength="20">
        </label>
        <div class="choice-chips" data-role="categories">
          ${categoryOptions.map((c) => `<button type="button" class="chip chip-sm ${c === draft.category ? 'selected' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
        <div class="field">
          <span class="field-label">얼마나 갖고 싶나요?</span>
          <div class="mini-seg" role="radiogroup">
            ${[1, 2, 3].map((p) => `<button type="button" role="radio" data-priority="${p}" aria-checked="${draft.priority === p}">${PRIORITY_LABEL[p]}</button>`).join('')}
          </div>
        </div>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">메모</span>
          <textarea name="memo" rows="3" placeholder="왜 갖고 싶은지 적어두면 나중에 판단하기 쉬워요&#10;예) 출근용 운동화가 다 닳아서, 사이즈 270" maxlength="1000">${esc(draft.memo)}</textarea>
        </label>
      </section>
      <p class="form-error" role="alert" hidden></p>
    </form>`;

  const form = $('form', sheet.body);
  const urlInput = form.elements.url;
  const titleInput = form.elements.title;
  const priceInput = form.elements.price;
  const targetInput = form.elements.targetPrice;
  const categoryInput = form.elements.category;
  const memoInput = form.elements.memo;
  const linkStatus = $('.link-status', form);
  const photosEl = $('.photos', form);
  const errorEl = $('.form-error', form);
  const targetHint = $('.target-hint', form);

  // 자동 높이 텍스트 영역
  const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  [titleInput, memoInput].forEach((ta) => {
    ta.addEventListener('input', () => autosize(ta));
    requestAnimationFrame(() => autosize(ta));
  });

  // 금액 입력: 숫자만, 천 단위 콤마
  [priceInput, targetInput].forEach((input) => {
    input.addEventListener('input', () => {
      input.value = formatDigits(input.value);
      updateTargetHint();
    });
  });
  function updateTargetHint() {
    const p = parsePrice(priceInput.value);
    const t = parsePrice(targetInput.value);
    if (p && t) {
      targetHint.hidden = false;
      targetHint.className = `field-hint target-hint ${p <= t ? 'tone-green' : ''}`;
      targetHint.innerHTML = p <= t
        ? `${icon('target')}이미 목표가 이하예요`
        : `목표가까지 ${won(p - t)} (${Math.round(((p - t) / p) * 100)}%) 더 내려가야 해요`;
    } else targetHint.hidden = true;
  }
  updateTargetHint();

  // 카테고리 / 우선순위 선택
  $('[data-role="categories"]', form).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    const same = categoryInput.value === btn.dataset.cat;
    categoryInput.value = same ? '' : btn.dataset.cat;
    syncCategoryChips();
  });
  categoryInput.addEventListener('input', syncCategoryChips);
  function syncCategoryChips() {
    $$('[data-cat]', form).forEach((b) => b.classList.toggle('selected', b.dataset.cat === categoryInput.value.trim()));
  }
  $('.mini-seg', form).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-priority]');
    if (!btn) return;
    draft.priority = Number(btn.dataset.priority);
    $$('[data-priority]', form).forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  });

  /* 사진 */
  let processing = 0;
  function renderPhotos() {
    const tiles = draft.images.map((img, i) => `
      <div class="photo-tile">
        <img src="${esc(blobUrl(img.thumb))}" alt="">
        ${i === 0 ? '<span class="photo-main">대표</span>' : ''}
        <button type="button" class="photo-remove" data-remove="${i}" aria-label="사진 삭제">${icon('xmark')}</button>
      </div>`);
    if (!draft.images.length && draft.imageUrl) {
      tiles.push(`<div class="photo-tile">
        <img src="${esc(draft.imageUrl)}" alt="" referrerpolicy="no-referrer">
        <span class="photo-main">링크</span>
        <button type="button" class="photo-remove" data-remove="remote" aria-label="사진 삭제">${icon('xmark')}</button>
      </div>`);
    }
    for (let i = 0; i < processing; i++) tiles.push('<div class="photo-tile loading"><span class="spinner"></span></div>');
    if (draft.images.length + processing < MAX_PHOTOS) {
      tiles.push(`<button type="button" class="photo-add" data-act="add-photo">${icon('camera')}<span>캡처·사진 추가</span></button>`);
    }
    photosEl.innerHTML = tiles.join('');
  }
  renderPhotos();

  async function addImageBlobs(blobs, { front = false } = {}) {
    const room = MAX_PHOTOS - draft.images.length - processing;
    const list = blobs.filter((b) => b && b.type.startsWith('image/')).slice(0, Math.max(0, room));
    if (!list.length) return false;
    processing += list.length;
    renderPhotos();
    let ok = false;
    for (const blob of list) {
      try {
        const img = await processImage(blob);
        if (front) draft.images.unshift(img); else draft.images.push(img);
        ok = true;
      } catch {
        toast('이 사진은 불러올 수 없어요 (지원하지 않는 형식)');
      } finally {
        processing--;
        renderPhotos();
      }
    }
    return ok;
  }

  photosEl.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="add-photo"]')) {
      const files = await pickImages();
      addImageBlobs(files);
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      if (rm.dataset.remove === 'remote') draft.imageUrl = '';
      else draft.images.splice(Number(rm.dataset.remove), 1);
      renderPhotos();
    }
  });

  // PC에서 Ctrl+V로 캡처 이미지 붙여넣기
  sheet.body.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length && e.target !== urlInput) {
      e.preventDefault();
      addImageBlobs(files);
    }
  });

  /* 링크 */
  let fetchCtrl = null;
  let lastHandledUrl = isEdit ? draft.url : '';
  let typingTimer = 0;

  function setLinkStatus(html, tone = '') {
    linkStatus.hidden = !html;
    linkStatus.className = `link-status ${tone}`;
    linkStatus.innerHTML = html;
  }

  function duplicateOf(url) {
    const key = normalizeUrl(url);
    return state.items.find((i) => i.id !== draft.id && i.url && normalizeUrl(i.url) === key);
  }

  function applyPastedText(text) {
    const url = extractUrl(text);
    if (!url) return false;
    urlInput.value = url;
    // "상품명 https://..." 형태면 상품명도 채움
    const rest = text
      .replace(/https?:\/\/[^\s<>"']+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\[[^\]]{1,20}\]\s*/, ''); // 앞의 [쇼핑몰명] 제거
    if (rest && !titleInput.value.trim() && rest.length <= 200) {
      titleInput.value = rest;
      autosize(titleInput);
    }
    handleUrl();
    return true;
  }

  async function handleUrl() {
    const url = extractUrl(urlInput.value);
    if (!url || !isValidUrl(url)) {
      setLinkStatus(urlInput.value.trim() ? '올바른 링크 형식이 아니에요' : '', urlInput.value.trim() ? 'tone-warn' : '');
      return;
    }
    if (url === lastHandledUrl) return;
    lastHandledUrl = url;
    if (urlInput.value !== url) urlInput.value = url;
    draft.store = storeNameFromUrl(url);

    const dup = duplicateOf(url);
    const dupHtml = dup
      ? `<div class="dup">${icon('info')}이미 저장한 위시예요 · <b>${esc(dup.title)}</b> <button type="button" class="link-btn" data-open="${esc(dup.id)}">보기</button></div>`
      : '';

    if (!settings.autoFetch) {
      setLinkStatus(`${icon('store')}<span>${esc(draft.store)}</span><span class="muted"> · 자동 채우기는 설정에서 켤 수 있어요</span>${dupHtml}`);
      return;
    }

    fetchCtrl?.abort();
    fetchCtrl = new AbortController();
    const { signal } = fetchCtrl;
    setLinkStatus(`<span class="spinner"></span><span>${esc(draft.store)} 상품 정보를 가져오는 중…</span>${dupHtml}`);
    try {
      const meta = await fetchProductMeta(url, settings.proxy, signal);
      if (signal.aborted) return;
      const filled = [];
      if (meta.title && !titleInput.value.trim()) {
        titleInput.value = meta.title;
        autosize(titleInput);
        filled.push('상품명');
      }
      if (meta.price && !priceInput.value) {
        priceInput.value = formatDigits(meta.price);
        updateTargetHint();
        filled.push('가격');
      }
      if (meta.image && !draft.images.length && !draft.imageUrl) {
        try {
          const blob = await fetchImageBlob(meta.image, settings.proxy, signal);
          const ok = await addImageBlobs([blob], { front: true });
          if (!ok) throw new Error('변환 실패');
        } catch {
          if (signal.aborted) return;
          draft.imageUrl = meta.image;
          renderPhotos();
        }
        filled.push('사진');
      }
      if (signal.aborted) return;
      setLinkStatus(
        filled.length
          ? `${icon('check')}<span>${esc(draft.store)} · ${filled.join(', ')}을 채웠어요</span>${dupHtml}`
          : `${icon('info')}<span>${esc(draft.store)} · 가져올 정보가 없었어요. 직접 입력해 주세요</span>${dupHtml}`,
        filled.length ? 'tone-green' : '',
      );
    } catch {
      if (signal.aborted) return;
      setLinkStatus(`${icon('info')}<span>${esc(draft.store)} · 이 쇼핑몰은 정보를 가져올 수 없었어요. 캡처를 넣거나 직접 입력해 주세요</span>${dupHtml}`, 'tone-warn');
    }
  }

  urlInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (applyPastedText(text)) e.preventDefault();
  });
  urlInput.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(handleUrl, 600);
  });
  urlInput.addEventListener('blur', () => { clearTimeout(typingTimer); handleUrl(); });

  linkStatus.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open]');
    if (btn) openDetail(btn.dataset.open);
  });

  /* 헤더·버튼 */
  sheet.layer.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') sheet.close();
    if (act === 'save') save();
    if (act === 'paste') {
      try {
        const text = await navigator.clipboard.readText();
        if (!applyPastedText(text)) toast('클립보드에 링크가 없어요');
      } catch {
        urlInput.focus();
        toast('입력칸을 길게 눌러 붙여넣기 해주세요');
      }
    }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  let saving = false;
  async function save() {
    if (saving) return;
    const url = extractUrl(urlInput.value);
    const validUrl = url && isValidUrl(url) ? url : '';
    const title = titleInput.value.replace(/\s+/g, ' ').trim();
    if (!title && !validUrl && !draft.images.length && !draft.imageUrl) {
      errorEl.hidden = false;
      errorEl.textContent = '링크, 사진, 상품명 중 하나는 입력해 주세요.';
      haptic([6, 40, 6]);
      return;
    }
    if (processing) {
      errorEl.hidden = false;
      errorEl.textContent = '사진을 처리하는 중이에요. 잠시만 기다려 주세요.';
      return;
    }
    saving = true;
    fetchCtrl?.abort();

    const store = validUrl ? storeNameFromUrl(validUrl) : '';
    const item = {
      ...draft,
      url: validUrl,
      store,
      title: title || (store ? `${store} 상품` : '이름 없는 위시'),
      targetPrice: parsePrice(targetInput.value),
      category: categoryInput.value.trim(),
      memo: memoInput.value.trim(),
    };
    if (!isEdit) item.price = null;
    const before = isEdit ? { ...existing } : null;
    const { newlyReached } = applyPrice(item, parsePrice(priceInput.value), 'manual');
    if (!parsePrice(priceInput.value)) item.price = null;
    // 편집으로 목표가만 바꿔 도달한 경우도 알림
    const reachedNow = isEdit ? !isReached(before) && isReached(item) : isReached(item);
    if (reachedNow && !item.reachedAt) item.reachedAt = Date.now();

    try {
      await persist(item);
    } catch {
      saving = false;
      toast('저장하지 못했어요. 저장 공간을 확인해 주세요');
      return;
    }
    db.requestPersistence();
    if (!isEdit && state.status !== 'wish') {
      state.status = 'wish';
      moveSegIndicator(true);
    }
    render();
    await sheet.close();
    if (newlyReached || reachedNow) celebrateReached(item);
    else {
      haptic(10);
      toast(isEdit ? '수정했어요' : `${icon('check')}위시에 담았어요`);
    }
  }

  sheet.open();

  if (sharedText) applyPastedText(sharedText);
  else if (!isEdit) {
    // 클립보드에 링크가 있으면 바로 제안 (권한 허용된 경우에만 조용히)
    navigator.permissions?.query({ name: 'clipboard-read' }).then(async (p) => {
      if (p.state !== 'granted' || urlInput.value) return;
      const text = await navigator.clipboard.readText().catch(() => '');
      const url = extractUrl(text);
      if (url && isValidUrl(url) && !duplicateOf(url)) {
        setLinkStatus(`${icon('link')}<span>복사한 링크가 있어요</span><button type="button" class="link-btn" data-use-clip>붙여넣기</button>`);
        $('[data-use-clip]', linkStatus)?.addEventListener('click', () => applyPastedText(text));
      }
    }).catch(() => {});
  }
}

/* ───────────── 상세 시트 ───────────── */
function openDetail(id) {
  const item = findItem(id);
  if (!item) return;
  if (openDetailSheet?.id === id) return;

  const sheet = new Sheet({
    title: '',
    className: 'sheet-detail',
    onClose: () => { if (openDetailSheet?.sheet === sheet) openDetailSheet = null; },
  });
  sheet.left.innerHTML = `<button type="button" class="nav-btn" data-act="edit">편집</button>`;
  sheet.right.innerHTML = `<button type="button" class="nav-btn nav-btn-strong" data-act="close">닫기</button>`;

  let editingPrice = false;

  function targetBlock(it) {
    if (!it.targetPrice) return '';
    if (!it.price) return `<div class="target-card">${icon('target')}<div><b>목표가 ${won(it.targetPrice)}</b><span class="muted">현재 가격을 입력하면 도달 여부를 알려드려요</span></div></div>`;
    if (isReached(it) || (it.status !== 'wish' && it.price <= it.targetPrice)) {
      const diff = it.targetPrice - it.price;
      return `<div class="target-card reached">${icon('target')}<div><b>목표가 도달!</b><span>목표 ${won(it.targetPrice)}${diff > 0 ? ` · ${won(diff)} 더 저렴` : ''}</span></div></div>`;
    }
    const first = it.priceHistory?.[0]?.price || it.price;
    const span = first - it.targetPrice;
    const progress = span > 0 ? Math.min(1, Math.max(0, (first - it.price) / span)) : 0;
    return `<div class="target-card">
      ${icon('target')}
      <div class="target-info">
        <b>목표가 ${won(it.targetPrice)}</b>
        <span class="muted">${won(it.price - it.targetPrice)} 더 내려가야 해요</span>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress * 100)}"><i style="width:${Math.max(4, progress * 100)}%"></i></div>
      </div>
    </div>`;
  }

  function historyHtml(it) {
    const list = [...(it.priceHistory || [])].reverse().slice(0, 8);
    if (list.length < 2) return '';
    return `<section class="group">
      <div class="group-title">가격 기록</div>
      ${list.map((h, i) => {
        const prev = list[i + 1]?.price;
        const delta = prev ? h.price - prev : 0;
        return `<div class="row"><span>${fmtDate(h.at)}${h.source === 'auto' ? ' <span class="muted">자동</span>' : ''}</span>
          <span class="row-value">${won(h.price)}${delta ? ` <span class="${delta < 0 ? 'tone-green' : 'tone-red'}">${delta < 0 ? '▼' : '▲'}${won(Math.abs(delta))}</span>` : ''}</span></div>`;
      }).join('')}
    </section>`;
  }

  function galleryHtml(it) {
    const imgs = it.images.map((img) => `<div class="gallery-item"><img src="${esc(blobUrl(img.full))}" alt=""></div>`);
    if (!imgs.length && it.imageUrl) imgs.push(`<div class="gallery-item"><img src="${esc(it.imageUrl)}" alt="" referrerpolicy="no-referrer"></div>`);
    if (!imgs.length) return `<div class="gallery gallery-empty">${placeholderHtml(it)}</div>`;
    return `<div class="gallery-wrap"><div class="gallery">${imgs.join('')}</div>
      ${imgs.length > 1 ? `<div class="dots">${imgs.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>` : ''}</div>`;
  }

  function statusActions(it) {
    if (it.status === 'wish') {
      return `<div class="action-pair">
        <button type="button" class="btn btn-tinted" data-act="bought">${icon('bag')}구매 완료</button>
        <button type="button" class="btn btn-gray" data-act="dropped">${icon('xmark')}포기할래요</button>
      </div>`;
    }
    return `<button type="button" class="btn btn-gray btn-block" data-act="restore">${icon('heart')}다시 위시로 옮기기</button>`;
  }

  function draw() {
    const it = findItem(id);
    if (!it) { sheet.close(); return; }
    const scrollTop = sheet.body.scrollTop;
    sheet.body.innerHTML = `
      <div class="detail">
        ${galleryHtml(it)}
        <div class="detail-head">
          <div class="detail-store">${esc(it.store || '직접 추가')}${it.category ? ` · ${esc(it.category)}` : ''}</div>
          <h2 class="detail-title">${esc(it.title)}</h2>
          <div class="detail-price">${it.price ? won(it.price) : '<span class="muted">가격 미입력</span>'}</div>
          ${it.status !== 'wish' ? `<div class="status-pill">${STATUS_LABEL[it.status]} · ${fmtDate(it.statusAt || it.updatedAt)}</div>` : ''}
        </div>
        ${targetBlock(it)}
        ${it.url ? `<a class="btn btn-primary btn-block" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">쇼핑몰에서 보기${icon('arrow-up-right')}</a>` : ''}

        ${it.status === 'wish' ? `
        <section class="group price-update">
          ${editingPrice ? `
            <form class="price-form" data-role="price-form">
              <div class="money"><input name="newPrice" inputmode="numeric" autocomplete="off" placeholder="바뀐 가격" value="${formatDigits(it.price)}"><span>원</span></div>
              <button type="submit" class="pill-btn pill-strong">저장</button>
              <button type="button" class="pill-btn" data-act="price-cancel">취소</button>
            </form>` : `
            <button type="button" class="row row-btn" data-act="price-edit">${icon('tag')}<span>가격이 바뀌었나요?</span><span class="row-value muted">직접 수정</span></button>
            ${it.url && settings.autoFetch && it.targetPrice ? `<button type="button" class="row row-btn" data-act="price-check">${icon('refresh')}<span>지금 가격 확인</span><span class="row-value muted">${it.lastCheckedAt ? `${daysAgo(it.lastCheckedAt)} 확인` : ''}</span></button>` : ''}`}
        </section>` : ''}

        <section class="group memo-group">
          <div class="group-title">왜 갖고 싶었나요?</div>
          <p class="memo ${it.memo ? '' : 'muted'}">${it.memo ? esc(it.memo) : '메모가 없어요. 편집에서 추가할 수 있어요.'}</p>
        </section>

        <section class="group">
          <div class="row"><span>얼마나 갖고 싶나요?</span><span class="row-value">${PRIORITY_LABEL[it.priority]}</span></div>
          <div class="row"><span>저장한 날</span><span class="row-value">${fmtDate(it.createdAt)} · ${daysAgo(it.createdAt)}</span></div>
        </section>

        ${historyHtml(it)}
        ${statusActions(it)}
        <button type="button" class="btn btn-destructive btn-block" data-act="delete">${icon('trash')}삭제</button>
      </div>`;
    sheet.body.scrollTop = scrollTop;

    const gallery = $('.gallery', sheet.body);
    const dots = $$('.dots i', sheet.body);
    if (gallery && dots.length) {
      gallery.addEventListener('scroll', () => {
        const i = Math.round(gallery.scrollLeft / gallery.clientWidth);
        dots.forEach((d, j) => d.classList.toggle('on', i === j));
      }, { passive: true });
    }
    const priceForm = $('[data-role="price-form"]', sheet.body);
    if (priceForm) {
      const input = priceForm.elements.newPrice;
      input.addEventListener('input', () => (input.value = formatDigits(input.value)));
      input.focus();
      input.select();
      priceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const price = parsePrice(input.value);
        if (!price) { input.focus(); return; }
        const target = findItem(id);
        const { changed, newlyReached } = applyPrice(target, price, 'manual');
        editingPrice = false;
        if (changed) await persist(target);
        render();
        if (newlyReached) celebrateReached(target);
        else if (changed) { haptic(10); toast('가격을 업데이트했어요'); }
      });
    }
  }

  async function changeStatus(status) {
    const it = findItem(id);
    const prev = { status: it.status, statusAt: it.statusAt };
    it.status = status;
    it.statusAt = Date.now();
    await persist(it);
    render();
    await sheet.close();
    haptic(10);
    const saved = status === 'dropped' && it.price ? ` · ${won(it.price)} 아꼈어요` : '';
    toast(`${status === 'bought' ? '구매함' : status === 'dropped' ? '포기함' : '위시'}으로 옮겼어요${saved}`, {
      actionLabel: '실행 취소',
      onAction: async () => {
        Object.assign(it, prev);
        await persist(it);
        render();
      },
    });
  }

  async function remove() {
    const it = findItem(id);
    await db.deleteItem(id);
    state.items = state.items.filter((i) => i.id !== id);
    render();
    await sheet.close();
    haptic(10);
    toast('삭제했어요', {
      actionLabel: '실행 취소',
      duration: 5000,
      onAction: async () => {
        await persist(it);
        render();
      },
    });
  }

  sheet.layer.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    switch (act) {
      case 'close': sheet.close(); break;
      case 'edit': openForm(findItem(id)); break;
      case 'bought': changeStatus('bought'); break;
      case 'dropped': changeStatus('dropped'); break;
      case 'restore': changeStatus('wish'); break;
      case 'delete': remove(); break;
      case 'price-edit': editingPrice = true; draw(); break;
      case 'price-cancel': editingPrice = false; draw(); break;
      case 'price-check': {
        const it = findItem(id);
        const btn = e.target.closest('[data-act]');
        btn.disabled = true;
        $('.row-value', btn).innerHTML = '<span class="spinner"></span>';
        try {
          const meta = await fetchProductMeta(it.url, settings.proxy);
          it.lastCheckedAt = Date.now();
          if (!meta.price) throw new Error('가격 없음');
          const { changed, newlyReached } = applyPrice(it, meta.price, 'auto');
          await persist(it);
          render();
          if (newlyReached) celebrateReached(it);
          else toast(changed ? `가격이 ${won(meta.price)}으로 바뀌었어요` : '가격 변동이 없어요');
        } catch {
          toast('이 쇼핑몰은 가격을 확인할 수 없었어요');
          draw();
        }
        break;
      }
      default:
    }
  });

  openDetailSheet = { id, sheet, refresh: draw };
  draw();
  sheet.open();
}

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openDetail(card.dataset.id);
});

/* ───────────── 설정 시트 ───────────── */
function openSettings() {
  const sheet = new Sheet({ title: '설정', className: 'sheet-settings' });
  sheet.right.innerHTML = `<button type="button" class="nav-btn nav-btn-strong" data-act="close">완료</button>`;

  async function draw() {
    const wish = state.items.filter((i) => i.status === 'wish');
    const bought = state.items.filter((i) => i.status === 'bought');
    const dropped = state.items.filter((i) => i.status === 'dropped');
    const sum = (list) => list.reduce((s, i) => s + (i.price || 0), 0);
    const notif = 'Notification' in window ? Notification.permission : 'unsupported';
    const storage = await db.storageInfo();

    sheet.body.innerHTML = `
      <div class="settings">
        <section class="stats">
          <div class="stat"><span class="stat-label">위시</span><b>${wish.length}개</b><span class="stat-sub">${won(sum(wish)) || '0원'}</span></div>
          <div class="stat"><span class="stat-label">구매함</span><b>${bought.length}개</b><span class="stat-sub">${won(sum(bought)) || '0원'}</span></div>
          <div class="stat stat-green"><span class="stat-label">포기로 아낀 돈</span><b>${won(sum(dropped)) || '0원'}</b><span class="stat-sub">${dropped.length}개</span></div>
        </section>

        <div class="group-caption">링크</div>
        <section class="group">
          <label class="row row-toggle">
            <span>링크 정보 자동 채우기</span>
            <input type="checkbox" class="switch" data-setting="autoFetch" ${settings.autoFetch ? 'checked' : ''}>
          </label>
          <details class="advanced">
            <summary>프록시 주소 (고급)</summary>
            <div class="field"><input data-setting="proxy" value="${esc(settings.proxy)}" spellcheck="false" autocapitalize="off">
            <p class="field-hint">{url} 자리에 상품 링크가 들어가요.</p></div>
          </details>
        </section>
        <p class="group-foot">링크를 붙여넣으면 상품명·사진·가격을 자동으로 채워요. 쇼핑몰 페이지를 읽기 위해 <b>상품 링크 주소만</b> 외부 프록시 서버(${esc(hostOf(settings.proxy))})를 거쳐요. 사진·메모 등 다른 데이터는 보내지 않아요. 일부 쇼핑몰(쿠팡 등)은 막혀 있어 직접 입력해야 해요.</p>

        <div class="group-caption">목표가 알림</div>
        <section class="group">
          <label class="row row-toggle ${settings.autoFetch ? '' : 'disabled'}">
            <span>앱을 열 때 가격 확인</span>
            <input type="checkbox" class="switch" data-setting="checkOnOpen" ${settings.checkOnOpen ? 'checked' : ''} ${settings.autoFetch ? '' : 'disabled'}>
          </label>
          <button type="button" class="row row-btn" data-act="check-now" ${settings.autoFetch ? '' : 'disabled'}>${icon('refresh')}<span>지금 모두 확인</span></button>
          <button type="button" class="row row-btn" data-act="notif" ${notif === 'granted' || notif === 'unsupported' ? 'disabled' : ''}>${icon('bell')}<span>휴대폰 알림 받기</span>
            <span class="row-value muted">${{ granted: '허용됨', denied: '차단됨', default: '허용하기', unsupported: '미지원' }[notif]}</span></button>
        </section>
        <p class="group-foot">링크와 목표가가 있는 위시의 가격을 앱을 열 때(6시간마다) 확인하고, 목표가 이하로 내려가면 알려드려요. 웹앱 특성상 <b>앱이 꺼져 있을 때는 확인하지 않아요.</b> 가격을 직접 수정해도 도달 여부를 바로 알려드려요.${notif === 'denied' ? ' 알림이 차단돼 있다면 휴대폰의 사이트 설정에서 허용해 주세요.' : ''}</p>

        <div class="group-caption">데이터</div>
        <section class="group">
          <button type="button" class="row row-btn" data-act="export">${icon('download')}<span>백업 파일 내보내기</span></button>
          <button type="button" class="row row-btn" data-act="import">${icon('upload')}<span>백업 파일 가져오기</span></button>
          <div class="row"><span>저장 상태</span><span class="row-value">${storage.persisted ? '<span class="tone-green">영구 저장</span>' : '일반'}${storage.usage != null ? ` · ${(storage.usage / 1048576).toFixed(1)}MB` : ''}</span></div>
        </section>
        <p class="group-foot">모든 위시는 이 휴대폰 브라우저 안에만 저장돼요. 브라우저 데이터를 지우거나 폰을 바꾸면 사라지니, 가끔 백업 파일을 내보내 두세요.</p>
        <input type="file" accept="application/json,.json" data-role="import-file" hidden>
      </div>`;
  }

  sheet.body.addEventListener('change', (e) => {
    const key = e.target.dataset.setting;
    if (!key) return;
    settings[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim() || DEFAULT_PROXY;
    saveSettings();
    if (key === 'autoFetch' && settings.autoFetch) toast('이제 링크를 붙여넣으면 상품 정보를 채워요');
    draw();
    render();
  });

  sheet.layer.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') sheet.close();
    if (act === 'check-now') { sheet.close(); checkPrices({ manual: true }); }
    if (act === 'notif') {
      try { await Notification.requestPermission(); } catch { /* 무시 */ }
      draw();
    }
    if (act === 'export') exportBackup();
    if (act === 'import') {
      const input = $('[data-role="import-file"]', sheet.body);
      input.value = '';
      input.onchange = async () => {
        const file = input.files[0];
        if (file) { await importBackup(file); draw(); }
      };
      input.click();
    }
  });

  draw();
  sheet.open();
}
$('#settingsBtn').addEventListener('click', openSettings);

function hostOf(template) {
  try { return new URL(template.replace('{url}', '')).hostname; } catch { return '알 수 없음'; }
}

/* ───────────── 백업 ───────────── */
async function exportBackup() {
  try {
    const items = await Promise.all(state.items.map(async (it) => ({
      ...it,
      images: await Promise.all(it.images.map(async (img) => ({
        full: await blobToDataURL(img.full),
        thumb: await blobToDataURL(img.thumb),
      }))),
    })));
    const data = JSON.stringify({ app: 'wishbox', version: 1, exportedAt: new Date().toISOString(), items });
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `위시함-백업-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`${items.length}개 위시를 백업 파일로 내보냈어요`);
  } catch {
    toast('백업 파일을 만들지 못했어요');
  }
}

async function importBackup(file) {
  try {
    const json = JSON.parse(await file.text());
    if (json?.app !== 'wishbox' || !Array.isArray(json.items)) throw new Error('형식 오류');
    const items = await Promise.all(json.items.map(async (raw) => normalizeItem({
      ...raw,
      images: await Promise.all((raw.images || []).map(async (img) => ({
        full: await dataURLToBlob(img.full),
        thumb: await dataURLToBlob(img.thumb),
      }))),
    })));
    await db.putItems(items);
    state.items = (await db.getAllItems()).map(normalizeItem);
    render();
    toast(`${items.length}개 위시를 가져왔어요`);
  } catch {
    toast('위시함 백업 파일이 아니거나 손상됐어요');
  }
}

/* ───────────── 시작 ───────────── */
$('#addBtn').addEventListener('click', () => openForm());
emptyState.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="add"]')) openForm();
});
// 안드로이드에서 :active 피드백이 터치 즉시 나타나도록
document.addEventListener('touchstart', () => {}, { passive: true });

function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  const shared = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join(' ');
  const itemId = params.get('item');
  if (params.has('share') || itemId) history.replaceState(null, '', location.pathname);
  if (shared) openForm(null, { sharedText: shared });
  else if (itemId) openDetail(itemId);
}

async function init() {
  try {
    state.items = (await db.getAllItems()).map(normalizeItem);
  } catch {
    toast('저장소를 열 수 없어요. 시크릿 모드라면 일반 모드로 열어주세요', { duration: 8000 });
  }
  render();
  moveSegIndicator(false);
  document.documentElement.classList.add('ready');
  handleLaunchParams();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-item') openDetail(e.data.id);
    });
  }

  if (settings.autoFetch && settings.checkOnOpen) setTimeout(() => checkPrices(), 1500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && settings.autoFetch && settings.checkOnOpen) checkPrices();
  });
}

init();
