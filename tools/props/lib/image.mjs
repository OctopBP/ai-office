import sharp from 'sharp';
import { style } from './common.mjs';

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Хромакей: пиксели, близкие к key → прозрачные; на границе — мягкая альфа + un-premultiply от цвета фона.
 * Возвращает sharp-объект RGBA.
 */
export async function chromaKey(input, keyHex, { hard = style.key_hard, soft = style.key_soft } = {}) {
  const [kr, kg, kb] = hexToRgb(keyHex);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const d = Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2);
    let a;
    if (d <= hard) a = 0;
    else if (d >= soft) a = 1;
    else a = (d - hard) / (soft - hard);
    if (a < 1) {
      if (a === 0) { px[i] = px[i + 1] = px[i + 2] = 0; px[i + 3] = 0; continue; }
      // un-premultiply относительно фона: fg = (c - key*(1-a)) / a
      px[i]     = clamp((r - kr * (1 - a)) / a);
      px[i + 1] = clamp((g - kg * (1 - a)) / a);
      px[i + 2] = clamp((b - kb * (1 - a)) / a);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } });
}

const clamp = v => Math.max(0, Math.min(255, Math.round(v)));

/** Bounding box непрозрачных пикселей (alpha > thr) */
export async function alphaBBox(img, thr = 8) {
  const { data, info } = await img.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > thr) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Проп: обрезать по альфе, вписать в box (в px), прижать к низу по центру, квантовать.
 */
export async function finalizeProp(img, { boxW, boxH, anchor = 'bottom' }) {
  const bbox = await alphaBBox(img);
  if (!bbox) throw new Error('после хромакея не осталось непрозрачных пикселей — проверьте key_color/пороги');
  let cut = sharp(await img.clone().extract(bbox).png().toBuffer());
  const meta = await cut.metadata();
  const scale = Math.min(boxW / meta.width, boxH / meta.height);
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));
  const resized = await cut.resize(w, h, { kernel: sharp.kernel.nearest, fit: 'fill' }).png().toBuffer();
  const left = Math.round((boxW - w) / 2);
  const top = anchor === 'bottom' ? boxH - h : anchor === 'center' ? Math.round((boxH - h) / 2) : 0;
  const canvas = sharp({ create: { width: boxW, height: boxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, left, top }]);
  return quantize(canvas);
}

/** Тайл: без хромакея, точный ресайз с заливкой, квантование */
export async function finalizeTile(input, { w, h }) {
  const img = sharp(input).resize(w, h, { kernel: sharp.kernel.nearest, fit: 'fill' });
  return quantize(img);
}

export function quantize(img, colours = style.palette_colors) {
  return img.png({ palette: true, colours, dither: 0, compressionLevel: 9 });
}

/** Шахматный фон для контакт-листов */
export async function checker(w, h, cell = 16, a = '#2a2b3a', b = '#33344a') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><pattern id="p" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
      <rect width="${cell * 2}" height="${cell * 2}" fill="${a}"/>
      <rect width="${cell}" height="${cell}" fill="${b}"/><rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="${b}"/>
    </pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function labelSvg(text, w, h = 22, size = 13, color = '#e8e8f0') {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <text x="4" y="${Math.round(h * 0.72)}" font-family="Menlo, monospace" font-size="${size}" fill="${color}">${esc}</text></svg>`);
}
