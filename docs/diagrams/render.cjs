const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const SRC = __dirname;
const OUT = path.join(SRC, 'export');
const MERMAID = process.argv[2];
const titles = {
  '01-system-map': '1 · System map: apps and connections',
  '02-order-lifecycle': '2 · Life of an order',
  '03-payment-fiskalizimi': '3 · Payment & fiskalizimi',
};
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.mmd')).sort();
  const b = await chromium.launch();
  const page = await b.newPage({ deviceScaleFactor: 2.5, viewport: { width: 2400, height: 1600 } });
  await page.setContent('<html><body style="margin:0;background:#fff"></body></html>');
  await page.addScriptTag({ path: MERMAID });
  await page.evaluate(() => mermaid.initialize({
    startOnLoad: false, layout: 'elk', elk: { nodePlacementStrategy: 'NETWORK_SIMPLEX', mergeEdges: false }, theme: 'base', securityLevel: 'loose', themeCSS: '.cluster-label foreignObject{overflow:visible} .cluster-label div, .cluster-label span, .cluster-label p{white-space:nowrap !important; font-weight:700; font-size:20px}',
    themeVariables: { fontFamily: 'Helvetica, Arial, sans-serif', fontSize: '18px',
      primaryColor: '#e8f0fe', lineColor: '#495057', clusterBkg: '#fafbfc', clusterBorder: '#ced4da', edgeLabelBackground: '#ffffff', titleColor: '#212529' },
    flowchart: { htmlLabels: true, wrappingWidth: 400, curve: 'basis', nodeSpacing: 45, rankSpacing: 55, padding: 14 },
  }));
  const pages = [];
  for (const f of files) {
    const name = f.replace(/\.mmd$/, '');
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    const svg = await page.evaluate(async ([id, code]) => (await mermaid.render(id, code)).svg, ['d' + name.slice(0, 2), code]);
    fs.writeFileSync(path.join(OUT, name + '.svg'), svg);
    pages.push({ name, svg, title: titles[name] || name });
  }
  // PNG per diagram
  for (const p of pages) {
    await page.setContent(`<html><body style="margin:0;background:#fff"><div id="w" style="display:inline-block;padding:40px;background:#fff">
      <div style="font:700 34px Helvetica,Arial,sans-serif;color:#0b1f44;margin:0 0 24px">${p.title}</div>${p.svg}</div></body></html>`);
    await page.evaluate(() => { const s = document.querySelector('svg'); const w = s.viewBox.baseVal.width; s.style.maxWidth = 'none'; s.setAttribute('width', w); });
    await page.locator('#w').screenshot({ path: path.join(OUT, p.name + '.png') });
  }
  // PDF: one page per diagram, landscape or portrait A3 to suit its shape.
  for (const p of pages) {
    const m = p.svg.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
    p.portrait = m ? Number(m[2]) > Number(m[1]) * 1.05 : false;
  }
  const html = pages.map(p => `<section class="${p.portrait ? 'pt' : 'ls'}">
      <div class="t">${p.title}</div><div class="fit">${p.svg}</div></section>`).join('');
  await page.setContent(`<html><head><style>
    @page ls { size: 420mm 297mm; margin: 0 } @page pt { size: 297mm 420mm; margin: 0 }
    body { margin: 0 }
    section { box-sizing: border-box; padding: 10mm; display: flex; flex-direction: column; break-after: page }
    section.ls { page: ls; width: 420mm; height: 296mm } section.pt { page: pt; width: 297mm; height: 419mm }
    .t { font: 700 22pt Helvetica, Arial, sans-serif; color: #0b1f44; margin-bottom: 6mm }
    .fit { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center }
    .fit svg { max-width: 100% !important; max-height: 100% !important; width: 100%; height: 100% }
  </style></head><body>${html}</body></html>`);
  await page.pdf({ path: path.join(OUT, 'onetap-pos-diagrams.pdf'), preferCSSPageSize: true, printBackground: true });
  await b.close();
  console.log('done', pages.map(p => p.name).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
