// 캡처/사진을 기기 안에서 축소·압축 (외부 전송 없음)
const FULL_MAX = 1600;
const THUMB_MAX = 480;

async function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch { /* 아래 폴백 */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function resize(source, max, quality) {
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  let out = await canvasToBlob(canvas, 'image/webp', quality);
  if (!out || out.type !== 'image/webp') out = await canvasToBlob(canvas, 'image/jpeg', quality);
  if (!out) throw new Error('이미지를 변환하지 못했어요');
  return out;
}

export async function processImage(blob) {
  const bitmap = await loadBitmap(blob);
  try {
    const [full, thumb] = await Promise.all([
      resize(bitmap, FULL_MAX, 0.85),
      resize(bitmap, THUMB_MAX, 0.8),
    ]);
    return { full, thumb };
  } finally {
    bitmap.close?.();
  }
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// Blob → object URL 캐시 (같은 Blob은 한 번만 생성)
const urlCache = new WeakMap();
export function blobUrl(blob) {
  if (!blob) return '';
  let url = urlCache.get(blob);
  if (!url) {
    url = URL.createObjectURL(blob);
    urlCache.set(blob, url);
  }
  return url;
}
