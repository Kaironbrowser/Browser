const path = require('path');
const { AdblockerService } = require(path.join(__dirname, '..', 'src', 'main', 'adblocker-service'));

async function run() {
  const svc = new AdblockerService({ updateIntervalMs: 0 });
  try {
    console.log('[test-targets] initializing adblocker service...');
    await svc.init();
    console.log('[test-targets] adblocker initialized, css length=', (svc.css || '').length);
  } catch (err) {
    console.error('[test-targets] adblocker init failed', err);
    process.exit(1);
  }

  const tests = [
    'https://www.google-analytics.com/collect?v=1',
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://www.facebook.com/tr/?id=123',
    'https://luckyorange.com/track.js',
    'https://cdn.mouseflow.com/projects/000000.js',
  ];

  // With native integration we don't call shouldBlock manually; show css/stats
  try {
    console.log('[test-targets] css length =', (svc.css || '').length);
    console.log('[test-targets] blocked count (so far) =', svc.getStats().blocked);
  } catch (e) {}

  svc.destroy();
}

run().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
