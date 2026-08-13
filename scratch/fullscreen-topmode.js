// Replicates the real top-tab-mode flow: normal view at {0,128,1279,671} (chrome
// 128px tall, no rail), window auto-fullscreens, renderer sends fullscreen
// metrics {0,128,1265,665} MID-TRANSITION (before enter-html-full-screen), and
// the app's new guard must prevent the view from jumping mid-transition.
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
  const win = new BrowserWindow({ width: 1400, height: 900, frame: false, backgroundColor: '#080810', show: true });
  win.maximize();
  const view = new BrowserView({ webPreferences: { sandbox: true } });
  win.setBrowserView(view);
  await view.webContents.loadURL(PAGE);
  const wc = view.webContents;

  // Top-tab chrome geometry
  const NORMAL_BOUNDS = { x: 0, y: 128, width: 1279, height: 671 };
  view.setBounds(NORMAL_BOUNDS);

  let htmlFullscreenTabId = null;
  let fullscreenTransitionActive = false;
  let layoutMetrics = { x: 0, y: 128, width: 1279, height: 671 }; // normal-state metrics

  function updateBounds() {
    if (htmlFullscreenTabId === 7) {
      const [w, h] = win.getContentSize();
      view.setBounds({ x: 0, y: 0, width: Math.max(100, w), height: Math.max(100, h) });
      log('UPDATE-BOUNDS', 'FULL ->', view.getBounds());
    } else if (win.isFullScreen() && fullscreenTransitionActive) {
      log('UPDATE-BOUNDS', 'GUARD: skip (transition in flight), view stays', view.getBounds());
      return;
    } else if (layoutMetrics) {
      view.setBounds(layoutMetrics);
      log('UPDATE-BOUNDS', 'METRICS ->', view.getBounds());
    } else {
      view.setBounds(NORMAL_BOUNDS);
    }
  }

  // Real handlers
  wc.on('enter-html-full-screen', () => {
    log('WC-ENTER-HTML', 'isFS=', win.isFullScreen(), 'view=', view.getBounds());
    htmlFullscreenTabId = 7;
    if (!win.isFullScreen()) win.setFullScreen(true);
    updateBounds();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullscreenTabId = null;
    if (win.isFullScreen()) win.setFullScreen(false);
    updateBounds();
  });
  win.on('enter-full-screen', () => {
    log('WIN-ENTER-FS', 'contentSize=', win.getContentSize());
    fullscreenTransitionActive = true;
    setTimeout(() => {
      fullscreenTransitionActive = false;
      updateBounds();
    }, 400);
    if (htmlFullscreenTabId != null) updateBounds();
  });
  win.on('resize', () => {
    log('WIN-RESIZE', 'contentSize=', win.getContentSize(), 'view=', view.getBounds());
    updateBounds();
  });

  async function probe(tag) {
    try {
      const r = await wc.executeJavaScript(`(() => {
        const b = document.getElementById('fs').getBoundingClientRect();
        return { y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), fsElement: !!document.fullscreenElement, innerW: window.innerWidth, innerH: window.innerHeight };
      })()`);
      log(tag, 'fsRect=', { x: 0, y: r.y, w: r.w, h: r.h }, 'fsElement=', r.fsElement,
          'viewport=', { w: r.innerW, h: r.innerH }, 'contentSize=', win.getContentSize(),
          'view=', view.getBounds());
    } catch (e) { log(tag, 'probe error', e.message); }
  }

  await new Promise((r) => setTimeout(r, 400));
  await probe('BEFORE');

  // Request fullscreen; on the next tick simulate the renderer sending its
  // FULLSCREEN-time metrics while htmlFullscreenTabId is still null.
  wc.executeJavaScript('document.getElementById("fs").requestFullscreen()', true).catch((e) => log('req err', e.message));
  setTimeout(() => {
    layoutMetrics = { x: 0, y: 128, width: 1265, height: 665 }; // fullscreen chrome metrics arrive mid-transition
    log('SIMULATED-IPC-METRICS', JSON.stringify(layoutMetrics), 'htmlFullscreenTabId=', htmlFullscreenTabId);
    updateBounds();
  }, 120);

  await new Promise((r) => setTimeout(r, 900));
  await probe('AFTER-ENTER');
  await new Promise((r) => setTimeout(r, 900));
  await probe('AFTER-SETTLE');

  wc.executeJavaScript('document.exitFullscreen()').catch(() => {});
  await new Promise((r) => setTimeout(r, 900));
  await probe('AFTER-ESC');
  app.quit();
});
