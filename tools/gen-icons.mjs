/* gen-icons.mjs — 生成应用图标（纯 Node，无依赖）
 * 输出 icons/icon-512.png（master），再用 sips 缩放出其他尺寸 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 形状（SDF） ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) - r;
}
function sdRotatedRR(px, py, cx, cy, hw, hh, r, ang) {
  const s = Math.sin(-ang), c = Math.cos(-ang);
  const x = (px - cx) * c - (py - cy) * s;
  const y = (px - cx) * s + (py - cy) * c;
  return sdRoundRect(x, y, 0, 0, hw, hh, r);
}
function aa(d, px) { return clamp(0.5 - d / px, 0, 1); }
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- 绘制 ---------- */
function drawIcon(N) {
  const img = Buffer.alloc(N * N * 4);
  const R = N * 0.22;                 // 圆角
  const c1 = [0x3f, 0x6d, 0xf6], c2 = [0x26, 0x43, 0xb0];
  const ribbon = [0xff, 0xb4, 0x54];
  const spine = [0x1d, 0x37, 0x99];
  const white = [0xff, 0xff, 0xff];
  const pageHw = N * 0.125, pageHh = N * 0.175, pageCy = N * 0.51, pageR = N * 0.045, pageAng = 0.21;
  const pageCxL = N * 0.5 - N * 0.135, pageCxR = N * 0.5 + N * 0.135;
  const ribbonCx = N * 0.5, ribbonCy = N * 0.26, ribbonHw = N * 0.052, ribbonHh = N * 0.095, ribbonR = N * 0.02;
  const spineCx = N * 0.5, spineCy = N * 0.505, spineHw = N * 0.014, spineHh = N * 0.16;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5, py = y + 0.5;
      // 背景圆角
      const dbg = sdRoundRect(px, py, N / 2, N / 2, N / 2, N / 2, R);
      let aBg = aa(dbg, 1.6);
      if (aBg <= 0) continue;
      const t = clamp(py / N, 0, 1) * 0.92 + 0.08;
      let r = lerp(c1[0], c2[0], t), g = lerp(c1[1], c2[1], t), b = lerp(c1[2], c2[2], t);

      // 书页（白色，左右两页，最小距离）
      const dL = sdRotatedRR(px, py, pageCxL, pageCy, pageHw, pageHh, pageR, pageAng);
      const dR = sdRotatedRR(px, py, pageCxR, pageCy, pageHw, pageHh, pageR, -pageAng);
      const dPage = Math.min(dL, dR);
      const aPage = aa(dPage, 1.8);
      if (aPage > 0) {
        r = lerp(r, white[0], aPage); g = lerp(g, white[1], aPage); b = lerp(b, white[2], aPage);
      }
      // 书脊（深色分隔线，置于书页之上）
      const dSp = sdRoundRect(px, py, spineCx, spineCy, spineHw, spineHh, spineHw);
      const aSp = aa(dSp, 1.8) * (0.85);
      if (aSp > 0) {
        r = lerp(r, spine[0], aSp); g = lerp(g, spine[1], aSp); b = lerp(b, spine[2], aSp);
      }
      // 书签（橙色小条，位于书顶）
      const dRb = sdRoundRect(px, py, ribbonCx, ribbonCy, ribbonHw, ribbonHh, ribbonR);
      const aRb = aa(dRb, 1.8);
      if (aRb > 0) {
        r = lerp(r, ribbon[0], aRb); g = lerp(g, ribbon[1], aRb); b = lerp(b, ribbon[2], aRb);
      }

      const i = (y * N + x) * 4;
      img[i] = Math.round(r); img[i + 1] = Math.round(g); img[i + 2] = Math.round(b); img[i + 3] = Math.round(aBg * 255);
    }
  }
  return img;
}

const N = 512;
const img = drawIcon(N);
writeFileSync(join(OUT, 'icon-512.png'), encodePNG(N, N, img));
console.log('icons/icon-512.png 生成完毕');
