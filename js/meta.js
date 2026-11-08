// 링크 처리: URL 추출·정규화, 쇼핑몰 이름, 상품 정보(제목·이미지·가격) 파싱

const KNOWN_STORES = [
  ['coupang.com', '쿠팡'],
  ['musinsa.com', '무신사'],
  ['smartstore.naver.com', '네이버 스마트스토어'],
  ['brand.naver.com', '네이버 브랜드스토어'],
  ['shopping.naver.com', '네이버쇼핑'],
  ['29cm.co.kr', '29CM'],
  ['wconcept.co.kr', 'W컨셉'],
  ['11st.co.kr', '11번가'],
  ['gmarket.co.kr', 'G마켓'],
  ['auction.co.kr', '옥션'],
  ['ssg.com', 'SSG'],
  ['lotteon.com', '롯데ON'],
  ['oliveyoung.co.kr', '올리브영'],
  ['kurly.com', '컬리'],
  ['zigzag.kr', '지그재그'],
  ['a-bly.com', '에이블리'],
  ['ohou.se', '오늘의집'],
  ['kream.co.kr', 'KREAM'],
  ['hmall.com', '현대Hmall'],
  ['ikea.com', 'IKEA'],
  ['aliexpress.com', '알리익스프레스'],
  ['temu.com', '테무'],
  ['amazon.', 'Amazon'],
];

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|n_media|n_query|n_rank|n_ad|n_campaign|n_keyword|NaPm|ref$|referrer)/i;

// 붙여넣은 텍스트("상품명 https://...")에서 첫 URL만 뽑기
export function extractUrl(text) {
  if (!text) return '';
  const m = String(text).match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[),.]+$/, '');
  const bare = String(text).trim();
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(bare)) return 'https://' + bare;
  return '';
}

export function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// 중복 비교용: 추적 파라미터·해시 제거
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    [...u.searchParams.keys()].forEach((k) => {
      if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    });
    u.hostname = u.hostname.replace(/^(www\.|m\.)/, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return url || '';
  }
}

export function storeNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www\.|m\.)/, '');
    const known = KNOWN_STORES.find(([d]) => host === d || host.endsWith('.' + d) || host.includes(d));
    return known ? known[1] : host;
  } catch {
    return '';
  }
}

export function parsePrice(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[^\d.]/g, '');
  if (!digits) return null;
  const n = Math.round(parseFloat(digits));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function absolute(src, base) {
  if (!src) return '';
  try { return new URL(src, base).toString(); } catch { return ''; }
}

function readJsonLdProducts(doc) {
  const products = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = node['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) products.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { visit(JSON.parse(s.textContent)); } catch { /* 깨진 JSON 무시 */ }
  });
  return products;
}

function jsonLdPrice(product) {
  let offers = product.offers;
  if (Array.isArray(offers)) offers = offers[0];
  if (!offers) return null;
  return parsePrice(offers.price ?? offers.lowPrice ?? offers.priceSpecification?.price);
}

function jsonLdImage(product) {
  const img = product.image;
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return typeof img[0] === 'string' ? img[0] : img[0]?.url || '';
  return img.url || '';
}

// HTML 문자열에서 상품 정보 추출 (프록시로 받아온 페이지에 사용)
export function parseProductHtml(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (...keys) => {
    for (const k of keys) {
      const el = doc.querySelector(`meta[property="${k}"], meta[name="${k}"], meta[itemprop="${k}"]`);
      const v = el?.getAttribute('content')?.trim();
      if (v) return v;
    }
    return '';
  };
  const product = readJsonLdProducts(doc)[0];

  const title =
    meta('og:title', 'twitter:title') || product?.name || doc.querySelector('title')?.textContent?.trim() || '';

  const image = absolute(meta('og:image', 'og:image:url', 'twitter:image') || (product && jsonLdImage(product)), pageUrl);

  const price =
    parsePrice(meta('product:sale_price:amount')) ??
    parsePrice(meta('product:price:amount', 'og:price:amount')) ??
    (product ? jsonLdPrice(product) : null) ??
    parsePrice(doc.querySelector('[itemprop="price"]')?.getAttribute('content'));

  const siteName = meta('og:site_name');
  return { title: cleanTitle(title, siteName), image, price, siteName };
}

function cleanTitle(title, siteName) {
  let t = title.replace(/\s+/g, ' ').trim();
  if (siteName) {
    const re = new RegExp(`\\s*[-|:·]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    t = t.replace(re, '');
  }
  return t;
}

function buildProxyUrl(template, target) {
  return template.includes('{url}')
    ? template.replace('{url}', encodeURIComponent(target))
    : template + encodeURIComponent(target);
}

async function fetchWithTimeout(url, ms, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// 프록시를 거쳐 상품 페이지 정보 가져오기. 실패하면 예외.
export async function fetchProductMeta(url, proxyTemplate, signal) {
  const res = await fetchWithTimeout(buildProxyUrl(proxyTemplate, url), 12000, signal);
  const html = await res.text();
  return parseProductHtml(html, url);
}

// 상품 대표 이미지를 Blob으로 받아 기기에 저장 (쇼핑몰 이미지 링크가 깨져도 남도록)
export async function fetchImageBlob(imageUrl, proxyTemplate, signal) {
  const res = await fetchWithTimeout(buildProxyUrl(proxyTemplate, imageUrl), 12000, signal);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/') && blob.size < 1000) throw new Error('이미지가 아님');
  return blob;
}
