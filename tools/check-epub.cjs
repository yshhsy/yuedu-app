/* check-epub.cjs — 用 app 实际的 jszip 库校验 sample.epub 可读性 */
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('../lib/jszip.min.js');

(async () => {
  const p = path.join(__dirname, '..', 'sample.epub');
  const data = fs.readFileSync(p);
  try {
    const zip = await JSZip.loadAsync(data);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    console.log('JSZip 读取成功, 共', names.length, '个文件');
    const opf = await zip.file('OEBPS/content.opf').async('string');
    console.log('OPF 读取成功, 长度', opf.length, '包含文件数条目:', (opf.match(/item id=/g) || []).length);
    const ch1 = await zip.file('OEBPS/chapters/ch1.xhtml').async('string');
    console.log('ch1 读取成功, 前80字符:', JSON.stringify(ch1.slice(0, 80)));
    const cov = await zip.file('OEBPS/cover.svg').async('string');
    console.log('cover.svg 读取成功, 长度', cov.length);
    console.log('验证通过 ✓');
  } catch (e) {
    console.error('JSZip 读取失败 ✗:', e.message);
    process.exit(1);
  }
})();