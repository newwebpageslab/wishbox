// 링크 도우미 (네트워크 사용 없음): URL 추출·정규화, 도메인으로 사이트 이름 추측, 가격 파싱

const KNOWN_SITES = [
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

// 링크 도메인으로 사이트 이름 추측 (입력 편의용)
export function siteNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www\.|m\.)/, '');
    const known = KNOWN_SITES.find(([d]) => host === d || host.endsWith('.' + d) || host.includes(d));
    return known ? known[1] : host;
  } catch {
    return '';
  }
}

const normalizeText = (s) => String(s || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

// 네이버 검색어: 상품명에 브랜드가 이미 들어 있으면 중복으로 붙이지 않음
export function buildQuery(brand, title) {
  const b = (brand || '').trim();
  const t = (title || '').trim();
  if (!b) return t;
  if (!t) return b;
  return normalizeText(t).includes(normalizeText(b)) ? t : `${b} ${t}`;
}

// 네이버 통합검색 페이지 (로그인 없이 열림, 가격비교 정보 포함. 서버·API 사용 없음)
// 네이버쇼핑 검색 주소는 로그인을 요구하는 경우가 있어 통합검색을 사용
export function naverSearchPageUrl(query) {
  return `https://m.search.naver.com/search.naver?query=${encodeURIComponent(query)}`;
}

export function parsePrice(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[^\d.]/g, '');
  if (!digits) return null;
  const n = Math.round(parseFloat(digits));
  return Number.isFinite(n) && n > 0 ? n : null;
}
