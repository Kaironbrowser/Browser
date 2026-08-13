const pkg = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
(async () => {
    try {
        const blocker = await pkg.ElectronBlocker.fromLists(fetch, ['https://easylist.to/easylist/easylist.txt']);
        
        function getAllMethods(obj) {
            let methods = new Set();
            while (obj) {
                Object.getOwnPropertyNames(obj).forEach(prop => methods.add(prop));
                obj = Object.getPrototypeOf(obj);
            }
            return Array.from(methods);
        }

        console.log('All methods/props:', getAllMethods(blocker).filter(m => !m.startsWith('_')));
        console.log('ElectronBlocker static methods:', Object.getOwnPropertyNames(pkg.ElectronBlocker));
        
    } catch (e) {
        console.error('Error:', e);
    }
    process.exit(0);
})();
