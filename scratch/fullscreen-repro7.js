// Exact app wiring: resize -> updateBounds, where updateBounds applies NORMAL
// (chrome-offset) bounds when no tab is in content fullscreen, and FULL bounds
// when it is. Checks whether the resize-during-auto-fullscreen jump aborts the
// page's fullscreen, and whether the final state converges correctly.
const { app, BrowserWindow, BrowserView } = require('electron');

const PAGE = `data:text/html;charset=UTF-8,${encodeURIComponent(`
<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:#222;}
  #fs{position:absolute;left:0;top:0;width:100%;height:100%;background:#e33;}
</style></head><body><div id="fs">FS</div></body></html>`)}`;

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, frame: false, backgroundColor: '#080810', show: true });
  win.maximize();
  const view = new BrowserView({ webPreferences: { sandbox: true } });
  win.setBrowserView(view);
  view.setBounds({ x: 256, y: 80, width: 944, height: 720 });
  await view.webContents.loadURL(PAGE);
  const wc = view.webContents;

  // App-exact updateBounds: full branch when content-fs active, else chrome-offset
  let htmlFullscreenTab = false;
  function updateBounds() {
    if (htmlFullscreenTab) {
      const [w, h] = win.getContentSize();
      view.setBounds({ x: 0, y: 0, width: Math.max(100, w), height: Math.max(100, h) });
    } else {
      view.setBounds({ x: 256, y: 80, width: 944, height: 720 });
    }
  }
  wc.on('enter-html-full-screen', () => {
    log('WC-ENTER-HTML', 'isFS=', win.isFullScreen(), 'contentSize=', win.getContentSize(), 'view=', view.getBounds());
    htmlFullscreenTab = true;
    if (!win.isFullScreen()) win.setFullScreen(true);
    updateBounds();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullscreenTab = false;
    if (win.isFullScreen()) win.setFullScreen(false);
    updateBounds();
  });
  win.on('enter-full-screen', () => { log('WIN-ENTER-FS', 'view=', view.getBounds()); if (htmlFullscreenTab) updateBounds(); });
  win.on('resize', () => { log('WIN-RESIZE', 'contentSize=', win.getContentSize(), 'view=', view.getBounds()); updateBounds(); });

  async function probe(tag) {
    try {
      const r = await wc.executeJavaScript(`(() => {
        const b = document.getElementById('fs').getBoundingClientRect();
        return { innerW: window.innerWidth, innerH: window.innerHeight,
                 fsRect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
                 fsElement: !!document.fullscreenElement };
      })()`);
      log(tag, 'fsRect=', r.fsRect, 'fsElement=', r.fsElement,
          'contentSize=', win.getContentSize(), 'view=', view.getBounds(), 'isFS=', win.isFullScreen());
    } catch (e) { log(tag, 'probe error', e.message); }
  }

  await new Promise((r) => setTimeout(r, 400));
  wc.executeJavaScript('document.getElementById("fs").requestFullscreen()', true).catch((e) => log('req err', e.message));
  await new Promise((r) => setTimeout(r, 400));
  await probe('MID-TRANSITION');
  await new Promise((r) => setTimeout(r, 900));
  await probe('SETTLED');

  wc.executeJavaScript('document.exitFullscreen()').catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  await probe('AFTER-ESC');
  app.quit();
});
