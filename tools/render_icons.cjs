// 아이콘·공유 미리보기 PNG 만들기 (Playwright 필요)
// usage: node tools/render_icons.cjs   (저장소 최상위에서)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'icons');
const iconSvg = fs.readFileSync(path.join(out, 'icon.svg'), 'utf8');
const bare = iconSvg.replace(/<rect width="512" height="512" rx="112" fill="#FAF6EE"\/>/, '');

// full: 배경을 꽉 채움 (아이폰·안드로이드 마스크용), scale: 그림 크기
const iconPage = (size, { full = false, scale = 1 } = {}) => `<body style="margin:0;background:transparent">
  <div style="width:${size}px;height:${size}px;position:relative;overflow:hidden;
    ${full ? 'background:#FAF6EE' : ''}">
    <div style="position:absolute;inset:0;transform:scale(${scale})">
      ${(full ? bare : iconSvg).replace('<svg ', `<svg width="${size}" height="${size}" `)}
    </div>
  </div></body>`;

(async () => {
  const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const shot = async (html, size, file) => {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(html);
    await p.screenshot({ path: path.join(out, file), omitBackground: true });
    await p.close();
  };
  await shot(iconPage(192), 192, 'icon-192.png');
  await shot(iconPage(512), 512, 'icon-512.png');
  await shot(iconPage(512, { full: true, scale: 0.82 }), 512, 'icon-maskable-512.png');
  await shot(iconPage(180, { full: true, scale: 0.92 }), 180, 'apple-touch-icon.png');

  for (const name of ['og-image', 'og-race']) {
    const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
    await p.goto('file://' + path.join(root, 'tools/og', name + '.html'));
    await p.waitForLoadState('networkidle');
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(out, name + '.png') });
    await p.close();
  }
  await b.close();
  console.log('icons written to', out);
})();
