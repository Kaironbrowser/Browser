const fetch = require('cross-fetch');
(async () => {
    try {
        const url = 'https://easylist.to/easylist/easylist.txt';
        const resp = await fetch(url);
        console.log('Status:', resp.status);
        const text = await resp.text();
        console.log('Length:', text.length);
        console.log('First 100 chars:', text.slice(0, 100));
    } catch (e) {
        console.error('Fetch error:', e);
    }
    process.exit(0);
})();
