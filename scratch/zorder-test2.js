const { app, BrowserWindow, BrowserView } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, frame: false, backgroundColor: '#080810', show: true });
  const winLoaded = win.loadURL(`data:text/html,<body style="margin:0;background:#00ffff"><div style="height:100%;color:#000;font-size:40px">WINDOW CONTENT (cyan)</div></body>`);
  await new Promise((r) => win.webContents.once('did-finish-load', r));

  const view = new BrowserView({ webPreferences: { sandbox: true } });
  win.setBrowserView(view);
  const viewLoaded = view.webContents.loadURL(`data:text/html,<body style="margin:0;background:#ff0000"><div style="height:100%;color:#fff;font-size:40px">VIEW (red)</div></body>`);
  await new Promise((r) => view.webContents.once('did-finish-load', r));

  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  await new Promise((r) => setTimeout(r, 1200));

  const img = await win.capturePage();
  const png = img.toPNG();
  const file = path.join(__dirname, 'zorder2.png');
  fs.writeFileSync(file, png);
  const sharp = require('sharp');
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75], [0.1, 0.9], [0.9, 0.1]];
  const colors = pts.map(([fx, fy]) => {
    const x = Math.floor(fx * info.width), y = Math.floor(fy * info.height);
    const i = (y * info.width + x) * ch;
    return { at: [fx, fy], c: [data[i], data[i + 1], data[i + 2]] };
  });
  console.log('size', info.width, 'x', info.height);
  colors.forEach(({ at, c }) => console.log('pixel', JSON.stringify(at), 'rgb', JSON.stringify(c)));
  const reds = colors.filter(({ c }) => c[0] > 150 && c[1] < 100 && c[2] < 100).length;
  const cyans = colors.filter(({ c }) => c[0] < 100 && c[1] > 150 && c[2] > 150).length;
  console.log('RED pixels:', reds, '| CYAN pixels:', cyans);
  console.log(reds >= 3 ? 'RESULT: BrowserView on TOP' : (cyans >= 3 ? 'RESULT: window webContents on TOP' : 'RESULT: ambiguous'));
  app.quit();
});
