const pkg = require('@cliqz/adblocker-electron');
console.log('Keys:', Object.keys(pkg));
if (pkg.ElectronBlocker) {
    console.log('ElectronBlocker keys:', Object.keys(pkg.ElectronBlocker));
}
console.log('fullLists:', pkg.fullLists ? pkg.fullLists.length : 'undefined');
console.log('adsAndTrackingLists:', pkg.adsAndTrackingLists ? pkg.adsAndTrackingLists.length : 'undefined');
process.exit(0);
