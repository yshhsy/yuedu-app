/* verify-icon.mjs — 校验 PNG 尺寸与关键像素 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const buf = readFileSync(process.argv[2]);
const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
let idat = null;
for (let i = 8; i < buf.length;) {
  const len = buf.readUInt32BE(i);
  const type = buf.toString('ascii', i + 4, i + 8);
  if (type === 'IDAT') idat = buf.subarray(i + 8, i + 8 + len);
  i += 12 + len;
}
const raw = inflateSync(idat);
const px = (x, y) => {
  const row = y * (w * 4 + 1);
  const o = row + 1 + x * 4;
  return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
};
console.log(`尺寸: ${w}x${h}`);
console.log('中心(256,256):', px(256, 256).join(','), '(期望近似白色书页)');
console.log('书脊(256,270):', px(256, 270).join(','), '(期望深蓝)');
console.log('书签(256,133):', px(256, 133).join(','), '(期望橙)');
console.log('左上角(2,2):', px(2, 2).join(','), '(期望透明 a=0)');
console.log('左上角(20,20):', px(20, 20).join(','), '(期望蓝色渐变)');
