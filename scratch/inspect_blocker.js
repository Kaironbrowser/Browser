const pkg = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
(async () => {
    try {
        const blocker = await pkg.ElectronBlocker.fromLists(fetch, ['https://easylist.to/easylist/easylist.txt']);
        console.log('Blocker instance keys:', Object.keys(blocker));
        console.log('Blocker instance proto keys:', Object.keys(Object.getPrototypeOf(blocker)));
        console.log('Is EventEmitter:', typeof blocker.on === 'function');
        
        // Check if filter-matched exists
        blocker.on('filter-matched', () => {});
        console.log('Registered filter-matched listener');
    } catch (e) {
        console.error('Error:', e);
    }
    process.exit(0);
})();
