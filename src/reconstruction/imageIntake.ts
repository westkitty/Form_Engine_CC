import { LIMITS } from '../io/validate';

export interface LoadedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  mime: string;
  hasAlpha: boolean;
  fileBytes: number;
}

export class ImageIntakeError extends Error {}

/** Decode a PNG/JPEG/WebP file honouring EXIF orientation, with size and pixel-count guards. */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  const mime = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : 'image/jpeg');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ImageIntakeError(`${file.name}: unsupported image type ${mime}. Use PNG, JPEG or WebP.`);
  if (file.size > LIMITS.maxImageBytes) throw new ImageIntakeError(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB; the limit is ${LIMITS.maxImageBytes / 1e6} MB.`);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new ImageIntakeError(`${file.name} could not be decoded as an image.`); }
  if (bitmap.width * bitmap.height > LIMITS.maxImagePixels) { bitmap.close(); throw new ImageIntakeError(`${file.name} is ${bitmap.width}×${bitmap.height}; the limit is ${(LIMITS.maxImagePixels / 1e6).toFixed(0)} megapixels.`); }
  const hasAlpha = mime !== 'image/jpeg' && detectAlpha(bitmap);
  return { bitmap, width: bitmap.width, height: bitmap.height, mime, hasAlpha, fileBytes: file.size };
}

function detectAlpha(b: ImageBitmap) {
  const s = Math.min(1, 128 / Math.max(b.width, b.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(b.width * s)); c.height = Math.max(1, Math.round(b.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(b, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

export interface Crop { x: number; y: number; w: number; h: number } // normalised 0..1

/** Non-destructive edit → prepared canvas (crop, 90° rotation, downscale to maxSide). */
export function prepareCanvas(img: LoadedImage, crop: Crop, rotation: 0 | 90 | 180 | 270, maxSide = 2048): HTMLCanvasElement {
  const sx = crop.x * img.width, sy = crop.y * img.height, sw = Math.max(1, crop.w * img.width), sh = Math.max(1, crop.h * img.height);
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
  const rot = rotation % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = rot ? dh : dw; c.height = rot ? dw : dh;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(img.bitmap, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, keepAlpha: boolean): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), keepAlpha ? 'image/png' : 'image/jpeg', 0.92));
}

/** Foreground bounding box from alpha (if any) or from difference to the border colour. */
export function foregroundBox(c: HTMLCanvasElement): Crop {
  const s = Math.min(1, 256 / Math.max(c.width, c.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(c.width * s)); t.height = Math.max(1, Math.round(c.height * s));
  const ctx = t.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(c, 0, 0, t.width, t.height);
  const d = ctx.getImageData(0, 0, t.width, t.height).data;
  const bg = [d[0], d[1], d[2]];
  let minX = t.width, minY = t.height, maxX = -1, maxY = -1;
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const k = (y * t.width + x) * 4;
    const fg = d[k + 3] > 16 && (d[k + 3] < 250 || Math.abs(d[k] - bg[0]) + Math.abs(d[k + 1] - bg[1]) + Math.abs(d[k + 2] - bg[2]) > 40);
    if (fg) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX / t.width, y: minY / t.height, w: (maxX - minX + 1) / t.width, h: (maxY - minY + 1) / t.height };
}
