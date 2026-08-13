const path = require('path');
const { AdblockerService } = require(path.join(__dirname, '..', 'src', 'main', 'adblocker-service'));

async function run() {
  const svc = new AdblockerService({ updateIntervalMs: 0 });
  try {
    console.log('[test] initializing adblocker service...');
    await svc.init();
    console.log('[test] adblocker initialized, css length=', (svc.css || '').length);
  } catch (err) {
    console.error('[test] adblocker init failed', err);
    process.exit(1);
  }

  // Native integration test: we've initialized the native blocker and can inspect css/stats
  try {
    console.log('[test] css length =', (svc.css || '').length);
    console.log('[test] blocked count (so far) =', svc.getStats().blocked);
  } catch (e) {}

  svc.destroy();
}

run().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
