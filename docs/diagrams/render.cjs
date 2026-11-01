// Export the diagrams in this folder: SVG + PNG per diagram, and one PDF
// with a page each. Usage (see README.md for the one-time setup):
//   node docs/diagrams/render.cjs /path/to/mermaid-bundle.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = __dirname;
const OUT = path.join(SRC, 'export');
const MERMAID = process.argv[2];
if (!MERMAID) {
  console.error('Usage: node render.cjs <mermaid bundle.js>');
  process.exit(1);
}

const titles = {
  '00-key': 'Key & glossary: how to read these diagrams',
  '01-system-map': '1 · System map: apps and connections',
  '02-order-lifecycle': '2 · Life of an order',
  '03-payment-fiskalizimi': '3 · Payment & fiskalizimi',
  '04-data-model': '4 · Data model: what the till stores',
  '05-signin-security': '5 · Sign-in & security',
  '06-shifts': '6 · Shifts & clock-in',
  '07-reports': '7 · Reports: which screen reads what',
  '08-live-offline': '8 · Live updates & offline',
};

// "OneTap POS v0.2.103 · drawn from the code of 2026-11-01"
const repo = path.resolve(SRC, '..', '..');
const version = JSON.parse(
  fs.readFileSync(path.join(repo, 'package.json'), 'utf8'),
).version;
let codeDate = '';
try {
  codeDate = execSync('git log -1 --format=%cs -- src', { cwd: repo })
    .toString()
    .trim();
} catch {
  codeDate = new Date().toISOString().slice(0, 10);
}
const stamp = (file) =>
  `OneTap POS v${version} · drawn from the code of ${codeDate} · docs/diagrams/${file}`;

const FONT = 'Helvetica, Arial, sans-serif';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs
    .readdirSync(SRC)
    .filter((f) => /^\d\d-.*\.(mmd|html)$/.test(f))
    .sort();
  const b = await chromium.launch();
  const page = await b.newPage({
    deviceScaleFactor: 2.5,
    viewport: { width: 2400, height: 1600 },
  });
  await page.setContent('<html><body style="margin:0;background:#fff"></body></html>');
  await page.addScriptTag({ path: MERMAID });
  await page.evaluate(() =>
    mermaid.initialize({
      startOnLoad: false,
      layout: 'elk',
      elk: { nodePlacementStrategy: 'NETWORK_SIMPLEX', mergeEdges: false },
      theme: 'base',
      securityLevel: 'loose',
      themeCSS:
        '.cluster-label foreignObject{overflow:visible} .cluster-label div, .cluster-label span, .cluster-label p{white-space:nowrap !important; font-weight:700; font-size:20px}',
      themeVariables: {
        fontFamily: 'Helvetica, Arial, sans-serif',
        fontSize: '18px',
        primaryColor: '#e8f0fe',
        lineColor: '#495057',
        clusterBkg: '#fafbfc',
        clusterBorder: '#ced4da',
        edgeLabelBackground: '#ffffff',
        titleColor: '#212529',
      },
      flowchart: {
        htmlLabels: true,
        wrappingWidth: 400,
        curve: 'basis',
        nodeSpacing: 45,
        rankSpacing: 55,
        padding: 14,
      },
    }),
  );

  const pages = [];
  for (const f of files) {
    const name = f.replace(/\.(mmd|html)$/, '');
    const raw = fs.readFileSync(path.join(SRC, f), 'utf8');
    let body;
    let isHtml = false;
    if (f.endsWith('.html')) {
      body = raw;
      isHtml = true;
    } else {
      body = await page.evaluate(
        async ([id, code]) => (await mermaid.render(id, code)).svg,
        ['d' + name.slice(0, 2), raw],
      );
      fs.writeFileSync(path.join(OUT, name + '.svg'), body);
    }
    pages.push({ name, file: f, body, isHtml, title: titles[name] || name });
  }

  // PNG per page, title on top and the version stamp underneath.
  for (const p of pages) {
    await page.setContent(`<html><body style="margin:0;background:#fff">
      <div id="w" style="display:inline-block;padding:40px;background:#fff">
        <div style="font:700 34px ${FONT};color:#0b1f44;margin:0 0 24px">${p.title}</div>
        ${p.body}
        <div style="font:14px ${FONT};color:#868e96;margin-top:24px">${stamp(p.file)}</div>
      </div></body></html>`);
    if (!p.isHtml) {
      await page.evaluate(() => {
        const s = document.querySelector('#w > svg');
        s.style.maxWidth = 'none';
        s.setAttribute('width', s.viewBox.baseVal.width);
      });
    }
    await page.locator('#w').screenshot({ path: path.join(OUT, p.name + '.png') });
  }

  // PDF: one A3 page each, landscape or portrait to suit the drawing.
  for (const p of pages) {
    const m = p.isHtml
      ? null
      : p.body.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
    p.portrait = m ? Number(m[2]) > Number(m[1]) * 1.05 : false;
  }
  const html = pages
    .map(
      (p) => `<section class="${p.portrait ? 'pt' : 'ls'}">
      <div class="t">${p.title}</div>
      <div class="fit${p.isHtml ? ' html' : ''}">${p.body}</div>
      <div class="s">${stamp(p.file)}</div></section>`,
    )
    .join('');
  await page.setContent(`<html><head><style>
    @page ls { size: 420mm 297mm; margin: 0 } @page pt { size: 297mm 420mm; margin: 0 }
    body { margin: 0 }
    section { box-sizing: border-box; padding: 10mm; display: flex; flex-direction: column; break-after: page }
    section.ls { page: ls; width: 420mm; height: 296mm } section.pt { page: pt; width: 297mm; height: 419mm }
    .t { font: 700 22pt ${FONT}; color: #0b1f44; margin-bottom: 6mm }
    .s { font: 9pt ${FONT}; color: #868e96; margin-top: 4mm }
    .fit { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center }
    .fit svg { max-width: 100% !important; max-height: 100% !important; width: 100%; height: 100% }
    .fit.html { align-items: flex-start; justify-content: flex-start; zoom: 1.12 }
  </style></head><body>${html}</body></html>`);
  await page.pdf({
    path: path.join(OUT, 'onetap-pos-diagrams.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
  });
  await b.close();
  console.log('done', pages.map((p) => p.name).join(', '));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
