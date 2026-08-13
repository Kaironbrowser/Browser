const pkg = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
(async () => {
    try {
        const blocker = await pkg.ElectronBlocker.fromLists(fetch, [
            'https://easylist.to/easylist/easylist.txt'
        ]);
        console.log('Blocker loaded. Filters count:', blocker.filters.size);
        
        const testUrl = 'https://doubleclick.net/ads.js';
        const result = blocker.match({
            url: testUrl,
            type: 'script',
            sourceUrl: 'https://example.com'
        });
        console.log('Match result for doubleclick:', result.match);
        if (result.match) {
            console.log('Filter:', result.filter.toString());
        }

        blocker.on('filter-matched', (filter, request) => {
            console.log('EVENT: filter-matched', filter.toString());
        });

        // Simulate how Electron details would look
        // Actually ElectronBlocker has onBeforeRequest that we can call
        console.log('Calling blocker.onBeforeRequest...');
        const response = blocker.onBeforeRequest({
            url: testUrl,
            resourceType: 'script',
            webContentsId: 1
        }, (res) => {
            console.log('onBeforeRequest callback:', res);
        });

    } catch (e) {
        console.error('Error:', e);
    }
    process.exit(0);
})();
