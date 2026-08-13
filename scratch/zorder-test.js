// Z-order test: window webContents (CYAN background) vs BrowserView (RED content)
// fully covering the window. Capture tells us which renders on top.
const { app, BrowserWindow, BrowserView } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, frame: false, backgroundColor: '#080810', show: true });
  win.loadURL(`data:text/html,<body style="margin:0;background:#0ff"><div style="height:100%;color:#000;font-size:40px">WINDOW CONTENT (cyan)</div></body>`);

  const view = new BrowserView({ webPreferences: { sandbox: true } });
  win.setBrowserView(view);
  await view.webContents.loadURL(`data:text/html,<body style="margin:0;background:#f00"><div style="height:100%;color:#fff;font-size:40px">VIEW (red)</div></body>`);

  // Cover the ENTIRE window with the view
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  await new Promise((r) => setTimeout(r, 600));

  const img = await win.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(path.join(__dirname, 'zorder.png'), png);
  // Analyze the center pixel color
  const sharp = require('sharp');
  const { data, info } = await sharp(path.join(__dirname, 'zorder.png')).raw().toBuffer({ resolveWithObject: true });
  const idx = ((Math.floor(info.height / 2) * info.width) + Math.floor(info.width / 2)) * info.channels;
  const c = { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
  console.log('capture size', info.width, 'x', info.height, 'center pixel', JSON.stringify(c));
  // red = view on top; cyan (0,255,255) = window content on top
  const viewTop = c.r > 150 && c.g < 120 && c.b < 120;
  console.log(viewTop ? 'RESULT: BrowserView renders ABOVE window webContents' : 'RESULT: window webContents renders ABOVE BrowserView');
  app.quit();
});
