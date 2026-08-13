const { app, session } = require('electron');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
app.whenReady().then(async () => {
  const sess = session.fromPartition('test');
  const fetchImpl = require('cross-fetch');
  const blocker = await ElectronBlocker.fromLists(fetchImpl, ['https://easylist.to/easylist/easylist.txt'], { loadNetworkFilters: true });
  blocker.on('request-blocked', () => console.log('EMITTED request-blocked'));
  blocker.on('filter-matched', () => console.log('EMITTED filter-matched'));
  blocker.enableBlockingInSession(sess);
  try {
    const res = await sess.fetch('https://googleads.g.doubleclick.net/pagead/ads');
    console.log('fetch succeeded?', res.ok);
  } catch (e) {
    console.log('fetch failed (blocked):', e.message);
  }
  app.quit();
});
