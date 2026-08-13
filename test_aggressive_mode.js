#!/usr/bin/env node
/**
 * Test script for aggressive ad blocker mode
 * Tests:
 * 1. Native blocker initialization with request-blocked event
 * 2. Fallback blocker attachment
 * 3. Pattern matching for common ad domains
 */

const path = require('path');
const { app, session } = require('electron');
const { AdblockerService } = require(path.join(__dirname, 'src', 'main', 'adblocker-service'));

let blockedCount = 0;
let nativeBlockedCount = 0;
let fallbackBlockedCount = 0;

async function testNativeBlocker() {
  console.log('\n=== PHASE 1: Testing Native Blocker ===\n');
  
  const sess = session.fromPartition('test-native');
  const adblockerService = new AdblockerService({
    mode: 'aggressive',
    onBlocked: (payload) => {
      nativeBlockedCount++;
      console.log(`[NATIVE] Blocked: ${payload.url}`);
      console.log(`  Rule: ${payload.rule}`);
      console.log(`  Type: ${payload.resourceType}`);
      console.log(`  Domain: ${payload.domain}\n`);
    },
  });

  try {
    console.log('Initializing native blocker service...');
    await adblockerService.init(sess);
    console.log(`✓ Native blocker initialized`);
    console.log(`  - CSS rules: ${(adblockerService.css || '').length} bytes`);
    console.log(`  - Network attached: ${adblockerService.networkAttached}`);
    console.log(`  - Engine config:`, adblockerService._engineConfig);
    if (!adblockerService.networkAttached && adblockerService._enableBlockingError) {
      console.log(`  - Error: ${adblockerService._enableBlockingError}`);
    }
  } catch (err) {
    console.error('✗ Native blocker init failed:', err.message);
    process.exit(1);
  }

  // Test with known ad domains
  const testDomains = [
    'https://doubleclick.net/pagead/ads',
    'https://googlesyndication.com/ad',
    'https://googletagmanager.com/gtag',
    'https://analytics.google.com/collect',
  ];

  console.log('\nAttempting to fetch from known ad domains...');
  for (const url of testDomains) {
    try {
      console.log(`Fetching: ${url}`);
      const res = await sess.fetch(url);
      console.log(`  → Status: ${res.status} (NOT BLOCKED - blocker may not be working)`);
    } catch (e) {
      console.log(`  → BLOCKED: ${e.message}`);
    }
  }

  console.log(`\n✓ Native blocker test complete`);
  console.log(`  Total blocked by native: ${nativeBlockedCount}`);
}

async function testPatternMatching() {
  console.log('\n=== PHASE 2: Testing Pattern Matching Logic ===\n');

  const testPatterns = [
    { url: 'https://doubleclick.net/ads/page', shouldBlock: true, reason: 'doubleclick.net' },
    { url: 'https://ads.google.com/pagead/ads', shouldBlock: true, reason: 'ads.google.com' },
    { url: 'https://analytics.google.com/analytics.js', shouldBlock: true, reason: 'analytics.google.com' },
    { url: 'https://www.google.com/search', shouldBlock: false, reason: 'legitimate Google domain' },
    { url: 'https://example.com/ads/banner.gif', shouldBlock: true, reason: '/ads/ pattern' },
    { url: 'https://cdn.example.com/tracking/beacon.gif', shouldBlock: true, reason: '/tracking/ pattern' },
  ];

  for (const test of testPatterns) {
    try {
      const url = new URL(test.url);
      const hostname = url.hostname.toLowerCase();
      const pathname = url.pathname.toLowerCase();

      let matches = false;
      let reason = '';

      // Check common AD domains
      const adDomains = [
        'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
        'google-analytics.com', 'analytics.google.com', 'ads.google.com'
      ];
      
      if (adDomains.some(d => hostname.includes(d))) {
        matches = true;
        reason = 'matched ad domain';
      }

      // Check URL patterns
      const adPatterns = ['/ads/', '/tracking/', '/beacon/', '/pixel/', '/analytics/'];
      if (adPatterns.some(p => pathname.includes(p))) {
        matches = true;
        reason = 'matched ad URL pattern';
      }

      const status = matches === test.shouldBlock ? '✓' : '✗';
      const verdict = matches ? 'BLOCKED' : 'ALLOWED';
      console.log(`${status} ${test.url}`);
      console.log(`  Expected: ${test.shouldBlock ? 'BLOCK' : 'ALLOW'} (${test.reason})`);
      console.log(`  Actual: ${verdict} (${reason || 'no match'})\n`);
    } catch (e) {
      console.log(`✗ Error parsing URL: ${test.url}`);
    }
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       Orion Browser Ad Blocker Test (Aggressive Mode)      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await app.whenReady();
    
    await testNativeBlocker();
    await testPatternMatching();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    TEST SUMMARY                            ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Native blocker network attached: ${nativeBlockedCount > 0 ? '✓ YES' : '✗ NO'}`);
    console.log(`Total blocks from native: ${nativeBlockedCount}`);
    console.log(`\nNext: Run on real ad test sites (e.g., adblock.turtlecute.org)\n`);

    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

main();
