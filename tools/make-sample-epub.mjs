/* make-sample-epub.mjs — 生成测试用 EPUB（无第三方依赖） */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample.epub');

/* ---------- 最小 ZIP 打包 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  // files: [{name, data:Buffer, store?}]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const zname = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const cdata = f.store ? data : deflateRawSync(data, { level: 9 });
    const method = f.store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);  // version needed
    lh.writeUInt16LE(0x0800, 6); // flags: UTF-8 name
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt16LE(0, 14);
    lh.writeUInt32LE(crc, 16);
    lh.writeUInt32LE(cdata.length, 20);
    lh.writeUInt32LE(data.length, 24);
    lh.writeUInt16LE(zname.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, zname, cdata);
    central.push({ zname, crc, csize: cdata.length, usize: data.length, localOffset: offset, method });
    offset += 30 + zname.length + cdata.length;
  }
  const cdStart = offset;
  const cdChunks = [];
  for (const e of central) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(0x0314, 4);     // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0x0800, 8);     // flags
    cd.writeUInt16LE(e.method, 10);  // compression method
    cd.writeUInt16LE(0, 12);         // mod time
    cd.writeUInt16LE(0, 14);         // mod date
    cd.writeUInt32LE(e.crc, 16);     // crc32
    cd.writeUInt32LE(e.csize, 20);   // compressed size
    cd.writeUInt32LE(e.usize, 24);   // uncompressed size
    cd.writeUInt16LE(e.zname.length, 28); // name length
    cd.writeUInt16LE(0, 30);         // extra length
    cd.writeUInt16LE(0, 32);         // comment length
    cd.writeUInt16LE(0, 34);         // disk number start
    cd.writeUInt16LE(0, 36);         // internal attrs
    cd.writeUInt32LE(0, 38);         // external attrs
    cd.writeUInt32LE(e.localOffset, 42); // local header offset
    cdChunks.push(cd, e.zname);
  }
  const cdBuf = Buffer.concat(cdChunks);
  offset += cdBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/* ---------- 内容 ---------- */
const chapters = [
  { title: '第一章：启程', n: 18 },
  { title: '第二章：引路人', n: 22 },
  { title: '第三章：歧途', n: 25 },
  { title: '第四章：归途', n: 20 },
];

function chXhtml(i) {
  const c = chapters[i];
  const paras = Array.from({ length: c.n }, (_, k) =>
    `<p>这是第${chapters[i].title.split(' ')[1]}第 ${k + 1} 段文字。晨光熹微，城市在薄雾中苏醒，远处的钟楼敲响六点，街角面包房飘出麦香。${i % 2 === 0 ? '风从窗口灌进来，吹灭了那盏油灯。' : ''}路人渐渐多了起来，电车叮当作响，生活一如往常地展开。</p>`);
  return `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c.title}</title></head><body><h1>${c.title}</h1>${paras.join('\n')}</body></html>`;
}

const containerXml = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:yuedu:sample"/></head><docTitle><text>示例电子书</text></docTitle><navMap>${chapters.map((c,i)=>`<navPoint id="np${i}" playOrder="${i+1}"><navLabel><text>${c.title}</text></navLabel><content src="chapters/ch${i+1}.xhtml"/></navPoint>`).join('')}</navMap></ncx>`;
const navHtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol>${chapters.map((c,i)=>`<li><a href="chapters/ch${i+1}.xhtml">${c.title}</a></li>`).join('')}</ol></nav></body></html>`;
const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#2b5876"/><text x="300" y="440" font-size="64" fill="#fff" text-anchor="middle" font-family="serif">示例电子书</text><text x="300" y="520" font-size="32" fill="#cfe3f2" text-anchor="middle">作者：测试</text></svg>`;
const manifestItems = chapters.map((_, i) => `<item id="c${i}" href="chapters/ch${i+1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
const spineItems = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('');
const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:yuedu:sample</dc:identifier><dc:title>示例电子书</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifestItems}</manifest><spine toc="ncx">${spineItems}</spine></package>`;

const files = [
  { name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii'), store: true },
  { name: 'META-INF/container.xml', data: Buffer.from(containerXml) },
  { name: 'OEBPS/toc.ncx', data: Buffer.from(ncx) },
  { name: 'OEBPS/nav.xhtml', data: Buffer.from(navHtml) },
  { name: 'OEBPS/cover.svg', data: Buffer.from(coverSvg) },
  ...chapters.map((_, i) => ({ name: `OEBPS/chapters/ch${i+1}.xhtml`, data: Buffer.from(chXhtml(i)) })),
  { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
];

const zipBuf = buildZip(files);
writeFileSync(OUT, zipBuf);
console.log('sample.epub 生成完毕，大小', zipBuf.length);