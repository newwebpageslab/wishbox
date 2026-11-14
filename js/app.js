import * as db from './db.js';
import { Spring, haptic } from './spring.js';
import { Sheet } from './sheet.js';
import { processImage, blobUrl, blobToDataURL, dataURLToBlob } from './images.js';
import {
  extractUrl, isValidUrl, normalizeUrl, siteNameFromUrl, parsePrice, buildQuery, naverSearchPageUrl,
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
const SETTINGS_KEY = 'wishbox.settings';

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { sort: saved.sort && saved.sort !== 'target' ? saved.sort : 'recent' };
  } catch {
    return { sort: 'recent' };
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
  priority: '꼭 사고 싶음 먼저',
};
const DEFAULT_CATEGORIES = ['의류', '신발', '악세사리', '가방', '뷰티', '전자기기', '생활용품', '음식'];

// status: 'wish' | 'bought' | 'dropped' | 'lowest'(최저가 검색 탭)
const state = { items: [], status: 'wish', filter: 'all', query: '' };
let openDetailSheet = null; // 현재 열린 상세 시트 { id, sheet, refresh }

const queryOf = (it) => buildQuery(it.brand, it.title);
const displayName = (it) => [it.brand, it.title].filter(Boolean).join(' ');
const matchesQuery = (i, q) =>
  [i.brand, i.title, i.memo, i.site, i.category, i.url].some((v) => (v || '').toLowerCase().includes(q));

function normalizeItem(raw) {
  return {
    id: raw.id || uid(),
    brand: raw.brand || '',
    title: raw.title || '',
    site: raw.site ?? raw.store ?? '', // 이전 버전의 store 값 이어받기
    url: raw.url || '',
    price: parsePrice(raw.price),
    category: raw.category || '',
    favorite: raw.favorite ?? raw.priority === 3, // 이전 버전 '꼭 사고 싶음' 이어받기
    memo: raw.memo || '',
    images: Array.isArray(raw.images) ? raw.images : [],
    imageUrl: raw.imageUrl || '',
    status: STATUS_LABEL[raw.status] ? raw.status : 'wish',
    priceHistory: Array.isArray(raw.priceHistory) ? raw.priceHistory : [],
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
    statusAt: raw.statusAt || null,
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

// 가격 변경 기록
function applyPrice(item, newPrice) {
  if (!newPrice || newPrice === item.price) return false;
  item.priceHistory = [...(item.priceHistory || []), { price: newPrice, at: Date.now() }];
  item.price = newPrice;
  return true;
}

const naverLink = (it, label = '최저가 찾기', cls = 'low-go') =>
  `<a class="${cls}" href="${esc(naverSearchPageUrl(queryOf(it)))}" target="_blank" rel="noopener noreferrer">${label}${icon('arrow-up-right')}</a>`;

/* ───────────── 메인 목록 렌더링 ───────────── */
const grid = $('#grid');
const emptyState = $('#emptyState');

function thumbSrc(it) {
  const img = it.images?.[0];
  return img ? blobUrl(img.thumb) : it.imageUrl || '';
}

function placeholderHtml(it) {
  const letter = esc((it.brand || it.title || it.site || '?').trim().charAt(0).toUpperCase());
  return `<div class="placeholder" aria-hidden="true">${letter}</div>`;
}

function thumbHtml(it) {
  const src = thumbSrc(it);
  return `${placeholderHtml(it)}${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}`;
}

function cardMeta(it) {
  if (it.status === 'bought') return `구매 · ${fmtDate(it.statusAt || it.updatedAt)}`;
  if (it.status === 'dropped') return `포기 · ${fmtDate(it.statusAt || it.updatedAt)}`;
  return esc(it.site || daysAgo(it.createdAt));
}

function cardHtml(it) {
  return `
    <button class="card" data-id="${esc(it.id)}" type="button">
      <div class="thumb">
        ${thumbHtml(it)}
        ${it.favorite && it.status === 'wish' ? `<span class="badge badge-heart" aria-label="꼭 사고 싶음">${icon('heart')}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-store">${esc(it.brand || it.site || '브랜드 미입력')}</div>
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
    case 'priority': sorted.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.createdAt - a.createdAt); break;
    default: sorted.sort((a, b) => b.createdAt - a.createdAt);
  }
  return sorted;
}

function renderChips(inStatus) {
  const chips = $('#chips');
  const counts = new Map();
  inStatus.forEach((it) => it.category && counts.set(it.category, (counts.get(it.category) || 0) + 1));

  if (state.filter.startsWith('cat:') && !counts.has(state.filter.slice(4))) state.filter = 'all';

  const chip = (key, label, count) =>
    `<button type="button" class="chip ${state.filter === key ? 'selected' : ''}" data-filter="${esc(key)}" aria-pressed="${state.filter === key}">${label}<span class="chip-count">${count}</span></button>`;

  let html = chip('all', '전체', inStatus.length);
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

  // 카테고리 칩: 최저가 검색 탭은 검색 가능한 위시 기준, 나머지 탭은 해당 상태 기준
  const onLowestTab = state.status === 'lowest';
  const inStatus = onLowestTab
    ? state.items.filter((i) => i.status === 'wish' && queryOf(i))
    : state.items.filter((i) => i.status === state.status);
  renderChips(inStatus);

  // 최저가 검색 탭이면 목록 영역을 숨기고 최저가 찾기 목록만 표시
  $('#listArea').hidden = onLowestTab;
  renderLowest();
  openDetailSheet?.refresh();
  if (onLowestTab) return;

  let list = inStatus;
  if (state.filter.startsWith('cat:')) list = list.filter((i) => i.category === state.filter.slice(4));
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter((i) => matchesQuery(i, q));
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
        <p class="empty-desc">브랜드명, 상품명, 메모, 사이트로 찾을 수 있어요.</p>`;
    } else if (state.status === 'wish') {
      emptyState.innerHTML = `<div class="empty-icon">${icon('heart')}</div>
        <p class="empty-title">아직 담은 위시가 없어요</p>
        <p class="empty-desc">아래 ‘위시 추가’를 눌러<br>첫 위시를 담아보세요.</p>`;
    } else {
      emptyState.innerHTML = `<div class="empty-icon">${icon(state.status === 'bought' ? 'bag' : 'xmark')}</div>
        <p class="empty-title">${state.status === 'bought' ? '구매한 위시가 없어요' : '포기한 위시가 없어요'}</p>
        <p class="empty-desc">위시 상세 화면에서 ${state.status === 'bought' ? '‘구매 완료’' : '‘포기’'}를 누르면 여기로 옮겨져요.</p>`;
    }
  }
}

// 이미지가 깨지면 플레이스홀더가 보이도록 제거
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.thumb, .gallery, .photo-tile, .low-thumb')) e.target.remove();
}, true);

/* ───────────── 최저가 검색 탭: 위시별 '네이버 최저가 찾기' 버튼 목록 ───────────── */
const lowestSection = $('#lowest');

function lowestRowHtml(it) {
  return `
    <div class="low-row">
      <button type="button" class="low-thumb" data-open="${esc(it.id)}" aria-label="${esc(displayName(it))} 상세 보기">${thumbHtml(it)}</button>
      <div class="low-info">
        <button type="button" class="low-name" data-open="${esc(it.id)}">${esc(displayName(it))}</button>
        <div class="low-price">${it.price ? `<b>${won(it.price)}</b>` : '<span class="muted">가격 미입력</span>'}${it.site ? `<span class="low-mall">${esc(it.site)}</span>` : ''}</div>
      </div>
      ${naverLink(it)}
    </div>`;
}

function renderLowest() {
  lowestSection.hidden = state.status !== 'lowest';
  if (lowestSection.hidden) return;
  const q = state.query.trim().toLowerCase();
  let list = state.items.filter((i) => i.status === 'wish' && queryOf(i));
  if (state.filter.startsWith('cat:')) list = list.filter((i) => i.category === state.filter.slice(4));
  if (q) list = list.filter((i) => matchesQuery(i, q));
  const wish = sortItems(list);

  const empty = $('#lowestEmpty');
  empty.hidden = wish.length > 0;
  $('#lowestBody').hidden = !wish.length;
  if (!wish.length) {
    empty.innerHTML = q
      ? `<div class="empty-icon">${icon('search')}</div><p class="empty-title">‘${esc(state.query.trim())}’에 맞는 위시가 없어요</p>`
      : `<div class="empty-icon">${icon('search')}</div><p class="empty-title">최저가를 찾을 위시가 없어요</p>
         <p class="empty-desc">브랜드명이나 상품명을 적은 위시를 담으면<br>여기서 네이버 최저가를 바로 찾아볼 수 있어요.</p>`;
    return;
  }
  $('#lowestList').innerHTML = wish.map(lowestRowHtml).join('');
}

lowestSection.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) openDetail(open.dataset.open);
});

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
function toast(message, { actionLabel, onAction, duration = 3200 } = {}) {
  currentToast?.dismiss();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="toast-msg">${message}</span>${actionLabel ? `<button type="button" class="toast-action">${esc(actionLabel)}</button>` : ''}`;
  $('#toastRoot').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const timer = setTimeout(() => handle.dismiss(), duration);
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

function choiceChips(values, selected, attr) {
  return values
    .map((v) => `<button type="button" class="chip chip-sm ${v === selected ? 'selected' : ''}" data-${attr}="${esc(v)}">${esc(v)}</button>`)
    .join('');
}

/* 자동완성 매칭: 대소문자·띄어쓰기 무시, 한글 초성 검색 지원 (예: "ㄴㅇㅋ" → 나이키) */
const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const squash = (s) => String(s).toLowerCase().replace(/\s+/g, '');
const toChosung = (s) =>
  [...squash(s)].map((ch) => {
    const code = ch.charCodeAt(0) - 0xac00;
    return code >= 0 && code <= 11171 ? CHOSUNG[Math.floor(code / 588)] : ch;
  }).join('');
const isChosungOnly = (s) => /^[ㄱ-ㅎ]+$/.test(squash(s));

function matchesTyped(candidate, typed) {
  const t = squash(typed);
  if (!t) return false;
  if (squash(candidate).includes(t)) return true;
  return isChosungOnly(t) && toChosung(candidate).includes(t);
}

// 입력한 글자와 일치하는 부분을 굵게 (일반 문자 일치일 때만)
function highlightMatch(candidate, typed) {
  const t = typed.trim();
  const i = candidate.toLowerCase().indexOf(t.toLowerCase());
  if (!t || i < 0) return esc(candidate);
  return `${esc(candidate.slice(0, i))}<b>${esc(candidate.slice(i, i + t.length))}</b>${esc(candidate.slice(i + t.length))}`;
}

function topValues(key, limit) {
  const counts = new Map();
  state.items.forEach((i) => i[key] && counts.set(i[key], (counts.get(i[key]) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([v]) => v);
}

function openForm(existing = null, { sharedText = '' } = {}) {
  const draft = existing
    ? { ...existing, images: existing.images.slice(), priceHistory: existing.priceHistory.slice() }
    : normalizeItem({});
  const isEdit = Boolean(existing);

  const sheet = new Sheet({ title: isEdit ? '위시 편집' : '위시 추가', className: 'sheet-form' });
  sheet.left.innerHTML = `<button type="button" class="nav-btn" data-act="cancel">취소</button>`;
  sheet.right.innerHTML = `<button type="button" class="nav-btn nav-btn-strong" data-act="save">${isEdit ? '완료' : '저장'}</button>`;

  // 기본 카테고리 + 직접 만든 카테고리
  const categoryOptions = [...new Set([...DEFAULT_CATEGORIES, ...topValues('category', 6)])];
  // 자동완성 후보: 지금까지 입력한 브랜드·사이트 (많이 쓴 순)
  const brandPool = topValues('brand', 300);
  const sitePool = topValues('site', 300);

  sheet.body.innerHTML = `
    <form class="form" novalidate>
      <section class="photos-section">
        <div class="section-label">${icon('photo')}사진 <span class="muted">최대 ${MAX_PHOTOS}장</span></div>
        <div class="photos"></div>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">브랜드명</span>
          <input name="brand" autocomplete="off" placeholder="브랜드명을 입력해주세요" maxlength="40" value="${esc(draft.brand)}">
        </label>
        <div class="choice-chips suggest" data-role="brand-suggest" aria-label="브랜드 추천" hidden></div>
        <label class="field">
          <span class="field-label">상품명</span>
          <textarea name="title" rows="1" placeholder="상품명을 입력해주세요" maxlength="200">${esc(draft.title)}</textarea>
        </label>
        <p class="field-hint">${icon('search')}브랜드명 + 상품명으로 네이버 최저가를 찾아요.</p>
        <label class="field">
          <span class="field-label">${icon('store')}사이트</span>
          <input name="site" autocomplete="off" placeholder="사이트를 입력해주세요" maxlength="40" value="${esc(draft.site)}">
        </label>
        <div class="choice-chips suggest" data-role="site-suggest" aria-label="사이트 추천" hidden></div>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">가격</span>
          <div class="money"><input name="price" inputmode="numeric" autocomplete="off" placeholder="가격을 입력해주세요" value="${formatDigits(draft.price)}"><span>원</span></div>
        </label>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">${icon('link')}상품 링크 <span class="muted">(선택)</span></span>
          <div class="field-row">
            <input name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
              placeholder="링크를 입력해주세요" value="${esc(draft.url)}">
            <button type="button" class="pill-btn" data-act="paste">붙여넣기</button>
          </div>
        </label>
        <div class="link-status" hidden></div>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">카테고리</span>
          <input name="category" autocomplete="off" placeholder="카테고리를 입력하거나 선택해주세요" value="${esc(draft.category)}" maxlength="20">
        </label>
        <div class="choice-chips" data-role="categories">${choiceChips(categoryOptions, draft.category, 'cat')}</div>
      </section>

      <section class="group">
        <label class="field">
          <span class="field-label">메모</span>
          <textarea name="memo" rows="3" placeholder="선택할 옵션, 구매하고 싶은 사유 등을 적어요" maxlength="1000">${esc(draft.memo)}</textarea>
        </label>
      </section>

      <section class="group">
        <button type="button" class="row row-btn fav-row" data-act="toggle-fav" aria-pressed="${draft.favorite}">
          <span class="heart-check" aria-hidden="true">${icon('heart')}</span><span>꼭 사고 싶음</span>
        </button>
      </section>
      <p class="form-error" role="alert" hidden></p>
    </form>`;

  const form = $('form', sheet.body);
  const { url: urlInput, brand: brandInput, title: titleInput, site: siteInput,
    price: priceInput, category: categoryInput, memo: memoInput } = form.elements;
  const linkStatus = $('.link-status', form);
  const photosEl = $('.photos', form);
  const errorEl = $('.form-error', form);

  // 자동 높이 텍스트 영역
  const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  [titleInput, memoInput].forEach((ta) => {
    ta.addEventListener('input', () => autosize(ta));
    requestAnimationFrame(() => autosize(ta));
  });

  // 금액 입력: 숫자만, 천 단위 콤마
  priceInput.addEventListener('input', () => { priceInput.value = formatDigits(priceInput.value); });

  // 선택 칩: 같은 칩을 다시 누르면 해제
  const bindChips = (role, attr, input) => {
    const box = $(`[data-role="${role}"]`, form);
    if (!box) return;
    const sync = () => $$(`[data-${attr}]`, box).forEach((b) => b.classList.toggle('selected', b.dataset[attr] === input.value.trim()));
    box.addEventListener('click', (e) => {
      const btn = e.target.closest(`[data-${attr}]`);
      if (!btn) return;
      input.value = input.value.trim() === btn.dataset[attr] ? '' : btn.dataset[attr];
      sync();
    });
    input.addEventListener('input', sync);
  };
  bindChips('categories', 'cat', categoryInput);

  // 자동완성: 입력하는 동안 비슷한 브랜드·사이트를 아래에 추천 (빈 칸이면 숨김)
  const bindSuggest = (input, pool, role) => {
    const box = $(`[data-role="${role}"]`, form);
    const update = () => {
      const typed = input.value.trim();
      const matches = typed ? pool.filter((v) => v !== typed && matchesTyped(v, typed)).slice(0, 6) : [];
      box.hidden = !matches.length;
      box.innerHTML = matches
        .map((v) => `<button type="button" class="chip chip-sm" data-pick="${esc(v)}"><span>${highlightMatch(v, typed)}</span></button>`)
        .join('');
    };
    input.addEventListener('input', update);
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pick]');
      if (!btn) return;
      input.value = btn.dataset.pick;
      input.dispatchEvent(new Event('input'));
      haptic(6);
    });
  };
  bindSuggest(brandInput, brandPool, 'brand-suggest');
  bindSuggest(siteInput, sitePool, 'site-suggest');

  $('[data-act="toggle-fav"]', form).addEventListener('click', (e) => {
    draft.favorite = !draft.favorite;
    e.currentTarget.setAttribute('aria-pressed', String(draft.favorite));
    if (draft.favorite) haptic(8);
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
        <span class="photo-main">대표</span>
        <button type="button" class="photo-remove" data-remove="remote" aria-label="사진 삭제">${icon('xmark')}</button>
      </div>`);
    }
    for (let i = 0; i < processing; i++) tiles.push('<div class="photo-tile loading"><span class="spinner"></span></div>');
    if (draft.images.length + processing < MAX_PHOTOS) {
      tiles.push(`<button type="button" class="photo-add" data-act="add-photo">${icon('camera')}<span>사진 추가</span></button>`);
    }
    photosEl.innerHTML = tiles.join('');
  }
  renderPhotos();

  async function addImageBlobs(blobs) {
    const room = MAX_PHOTOS - draft.images.length - processing;
    const list = blobs.filter((b) => b && b.type.startsWith('image/')).slice(0, Math.max(0, room));
    if (!list.length) return;
    processing += list.length;
    renderPhotos();
    for (const blob of list) {
      try {
        draft.images.push(await processImage(blob));
      } catch {
        toast('이 사진은 불러올 수 없어요 (지원하지 않는 형식)');
      } finally {
        processing--;
        renderPhotos();
      }
    }
  }

  photosEl.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="add-photo"]')) {
      addImageBlobs(await pickImages());
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

  /* 링크 (선택 입력 — 네트워크 사용 없음) */
  function duplicateOf(url) {
    const key = normalizeUrl(url);
    return state.items.find((i) => i.id !== draft.id && i.url && normalizeUrl(i.url) === key);
  }

  function handleUrl() {
    const raw = urlInput.value.trim();
    const url = extractUrl(raw);
    if (!raw) { linkStatus.hidden = true; return; }
    if (!url || !isValidUrl(url)) {
      linkStatus.hidden = false;
      linkStatus.className = 'link-status tone-warn';
      linkStatus.textContent = '올바른 링크 형식이 아니에요';
      return;
    }
    if (urlInput.value !== url) urlInput.value = url;
    if (!siteInput.value.trim()) {
      siteInput.value = siteNameFromUrl(url);
      siteInput.dispatchEvent(new Event('input'));
    }
    const dup = duplicateOf(url);
    linkStatus.hidden = !dup;
    linkStatus.className = 'link-status';
    linkStatus.innerHTML = dup
      ? `<div class="dup">${icon('info')}이미 저장한 위시예요 · <b>${esc(displayName(dup))}</b> <button type="button" class="link-btn" data-open="${esc(dup.id)}">보기</button></div>`
      : '';
  }

  urlInput.addEventListener('paste', (e) => {
    const url = extractUrl(e.clipboardData?.getData('text') || '');
    if (url) {
      e.preventDefault();
      urlInput.value = url;
      handleUrl();
    }
  });
  urlInput.addEventListener('blur', handleUrl);
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
        const url = extractUrl(await navigator.clipboard.readText());
        if (!url) { toast('클립보드에 링크가 없어요'); return; }
        urlInput.value = url;
        handleUrl();
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
    const brand = brandInput.value.replace(/\s+/g, ' ').trim();
    const title = titleInput.value.replace(/\s+/g, ' ').trim();
    if (!title && !brand && !draft.images.length && !draft.imageUrl) {
      errorEl.hidden = false;
      errorEl.textContent = '브랜드명, 상품명, 사진 중 하나는 입력해 주세요.';
      haptic([6, 40, 6]);
      return;
    }
    if (processing) {
      errorEl.hidden = false;
      errorEl.textContent = '사진을 처리하는 중이에요. 잠시만 기다려 주세요.';
      return;
    }
    saving = true;

    const item = {
      ...draft,
      url: validUrl,
      brand,
      title: title || (brand ? '' : '이름 없는 위시'),
      site: siteInput.value.trim(),
      category: categoryInput.value.trim(),
      memo: memoInput.value.trim(),
    };
    if (!isEdit) item.price = null;
    const newPrice = parsePrice(priceInput.value);
    if (newPrice) applyPrice(item, newPrice);
    else item.price = null;

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
    haptic(10);
    toast(isEdit ? '수정했어요' : `${icon('check')}위시에 담았어요`);
  }

  sheet.open();

  if (sharedText) {
    const url = extractUrl(sharedText);
    if (url) { urlInput.value = url; handleUrl(); }
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

  function historyHtml(it) {
    const list = [...(it.priceHistory || [])].reverse().slice(0, 8);
    if (list.length < 2) return '';
    return `<section class="group">
      <div class="group-title">가격 기록</div>
      ${list.map((h, i) => {
        const prev = list[i + 1]?.price;
        const delta = prev ? h.price - prev : 0;
        return `<div class="row"><span>${fmtDate(h.at)}</span>
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
    const meta = [it.site, it.category].filter(Boolean).map(esc).join(' · ');
    sheet.body.innerHTML = `
      <div class="detail">
        ${galleryHtml(it)}
        <div class="detail-head">
          ${it.status === 'wish' ? `<button type="button" class="detail-fav" data-act="toggle-fav" aria-pressed="${it.favorite}" aria-label="꼭 사고 싶음">${icon('heart')}</button>` : ''}
          ${it.brand ? `<div class="detail-brand">${esc(it.brand)}</div>` : ''}
          <h2 class="detail-title">${esc(it.title || it.brand)}</h2>
          ${meta ? `<div class="detail-store">${meta}</div>` : ''}
          <div class="detail-price">${it.price ? won(it.price) : '<span class="muted">가격 미입력</span>'}</div>
          ${it.status !== 'wish' ? `<div class="status-pill">${STATUS_LABEL[it.status]} · ${fmtDate(it.statusAt || it.updatedAt)}</div>` : ''}
        </div>

        ${queryOf(it) ? naverLink(it, `${icon('search')}네이버에서 최저가 찾기`, 'btn btn-primary btn-block') : ''}
        ${it.url ? `<a class="btn btn-gray btn-block" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.site || '쇼핑몰')}에서 보기${icon('arrow-up-right')}</a>` : ''}

        ${it.status === 'wish' ? `
        <section class="group price-update">
          ${editingPrice ? `
            <form class="price-form" data-role="price-form">
              <div class="money"><input name="newPrice" inputmode="numeric" autocomplete="off" placeholder="바뀐 가격" value="${formatDigits(it.price)}"><span>원</span></div>
              <button type="submit" class="pill-btn pill-strong">저장</button>
              <button type="button" class="pill-btn" data-act="price-cancel">취소</button>
            </form>` : `
            <button type="button" class="row row-btn" data-act="price-edit">${icon('tag')}<span>가격이 바뀌었나요?</span><span class="row-value muted">직접 수정</span></button>`}
        </section>` : ''}

        <section class="group memo-group">
          <div class="group-title">메모</div>
          <p class="memo ${it.memo ? '' : 'muted'}">${it.memo ? esc(it.memo) : '메모가 없어요. 편집에서 추가할 수 있어요.'}</p>
        </section>

        <section class="group">
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
        const changed = applyPrice(target, price);
        editingPrice = false;
        if (changed) await persist(target);
        render();
        if (changed) { haptic(10); toast('가격을 업데이트했어요'); }
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

  sheet.layer.addEventListener('click', (e) => {
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
      case 'toggle-fav': {
        const it = findItem(id);
        it.favorite = !it.favorite;
        if (it.favorite) haptic(8);
        persist(it).then(render);
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
    const storage = await db.storageInfo();

    sheet.body.innerHTML = `
      <div class="settings">
        <section class="stats">
          <div class="stat"><span class="stat-label">위시</span><b>${wish.length}개</b><span class="stat-sub">${won(sum(wish)) || '0원'}</span></div>
          <div class="stat"><span class="stat-label">구매함</span><b>${bought.length}개</b><span class="stat-sub">${won(sum(bought)) || '0원'}</span></div>
          <div class="stat stat-green"><span class="stat-label">포기로 아낀 돈</span><b>${won(sum(dropped)) || '0원'}</b><span class="stat-sub">${dropped.length}개</span></div>
        </section>

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

  sheet.layer.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') sheet.close();
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
    const data = JSON.stringify({ app: 'wishbox', version: 3, exportedAt: new Date().toISOString(), items });
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
// 안드로이드에서 :active 피드백이 터치 즉시 나타나도록
document.addEventListener('touchstart', () => {}, { passive: true });

function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  const shared = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join(' ');
  if (params.has('share')) history.replaceState(null, '', location.pathname);
  if (shared) openForm(null, { sharedText: shared });
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

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
