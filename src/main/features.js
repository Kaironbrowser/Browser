const FEATURE_REGISTRY = [
  {
    id: 'adBlocker',
    name: 'Ad Blocker',
    category: 'privacy',
    // Disabled by default: enable explicitly in settings or via shields
    defaultEnabled: false,
    // mode: 'off' | 'cosmetic' | 'full' | 'standard' | 'aggressive'
    settings: {
      mode: 'off',
      blockTrackers: true,
      blockAds: true,
    },
  },
  {
    id: 'httpsOnlyMode',
    name: 'HTTPS-Only Mode',
    category: 'privacy',
    description: 'Automatically upgrades sites to HTTPS and warns before loading insecure pages.',
    defaultEnabled: true,
    settings: {},
  },
  {
    id: 'webRtcProtection',
    name: 'WebRTC Protection',
    category: 'privacy',
    description: 'Restricts WebRTC to proxied/relay connections (disables non-proxied UDP) to reduce IP exposure.',
    defaultEnabled: true,
    settings: {},
  },
  {
    id: 'dnsOverHttps',
    name: 'Secure DNS',
    category: 'privacy',
    description: 'Encrypt DNS lookups with DNS-over-HTTPS. Changes take effect after restarting Kairon.',
    defaultEnabled: true,
    settings: {
      provider: 'cloudflare',
      customUrl: '',
    },
  },
  {
    id: 'siteBlocker',
    name: 'Site Blocker',
    category: 'security',
    defaultEnabled: false,
    settings: {
      blockedSites: [],
      allowOverrides: true,
      schedules: [],
    },
  },
  {
    id: 'themeSystem',
    name: 'Theme System',
    category: 'appearance',
    defaultEnabled: true,
    settings: {
      mode: 'dark',
      tabPosition: 'sidebar', // "sidebar" or "top"
    },
  },
  {
    id: 'performanceOptimizer',
    name: 'Performance Optimizer',
    category: 'performance',
    // Not wired up in code yet: hidden from the settings UI so users don't
    // mistake an inert control for a working feature.
    hidden: true,
    defaultEnabled: true,
    settings: {
      discardInactiveTabs: false,
      maxBackgroundTabs: 10,
    },
  },
  {
    id: 'downloadManager',
    name: 'Download Manager',
    category: 'advanced',
    defaultEnabled: true,
    settings: {
      askEveryDownload: true,
      defaultPath: '',
    },
  },
  {
    id: 'tabBehavior',
    name: 'Tab Behavior',
    category: 'performance',
    // Not wired up in code yet: hidden from the settings UI.
    hidden: true,
    defaultEnabled: true,
    settings: {
      confirmOnCloseMultiple: false,
      restoreOnStartup: true,
    },
  },
  {
    id: 'securityProtections',
    name: 'Security Protections',
    category: 'security',
    // Not wired up in code yet: hidden from the settings UI.
    hidden: true,
    defaultEnabled: true,
    settings: {
      blockInsecureContent: true,
    },
  },
  {
    id: 'developerTools',
    name: 'Developer Tools',
    category: 'advanced',
    // Not wired up in code yet: hidden from the settings UI.
    hidden: true,
    defaultEnabled: false,
    settings: {
      allowDevtools: false,
    },
  },
];

const AD_BLOCK_PATTERNS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.google-analytics.com/*',
  '*://*.googletagservices.com/*',
  '*://*.adnxs.com/*',
  '*://*.advertising.com/*',
  '*://*.moatads.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.quantserve.com/*',
  '*://*.adsrvr.org/*',
  '*://*.pubmatic.com/*',
  '*://*.rubiconproject.com/*',
  '*://*.openx.net/*',
  '*://*.criteo.com/*',
  '*://*.outbrain.com/*',
  '*://*.taboola.com/*',
  '*://*.amazon-adsystem.com/*',
  '*://*.facebook.com/tr*',
  '*://*.hotjar.com/*',
  '*://*.mixpanel.com/*',
  '*://*.segment.com/*',
  '*://*.amplitude.com/*',
  '*://*.chartbeat.com/*',
  '*://*.addthis.com/*',
  '*://*.sharethis.com/*',
];

function cloneRegistry() {
  return FEATURE_REGISTRY.map((feature) => ({
    ...feature,
    settings: JSON.parse(JSON.stringify(feature.settings)),
  }));
}

function getDefaultFeatureState() {
  const result = {};
  for (const feature of FEATURE_REGISTRY) {
    result[feature.id] = {
      enabled: feature.defaultEnabled,
      settings: JSON.parse(JSON.stringify(feature.settings)),
    };
  }
  return result;
}

module.exports = {
  FEATURE_REGISTRY,
  AD_BLOCK_PATTERNS,
  cloneRegistry,
  getDefaultFeatureState,
};
