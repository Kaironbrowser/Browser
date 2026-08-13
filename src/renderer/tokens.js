/**
 * ============================================================
 *  ORION DESIGN SYSTEM — tokens.js
 *  Single source of truth for the design system engine.
 *
 *  Import this anywhere you need design values in JS.
 *  CSS variables in style.css mirror these exactly.
 * ============================================================
 */

// ── SPACING SCALE (4px base) ──────────────────────────────────
export const SPACE = Object.freeze({
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  10: '40px',
  12: '48px',
  16: '64px',
});

// ── RADIUS SYSTEM ─────────────────────────────────────────────
export const RADIUS = Object.freeze({
  sm:   '6px',
  md:   '8px',
  lg:   '10px',
  xl:   '12px',
  '2xl': '24px',
  full: '9999px',
});

// ── MOTION SYSTEM ─────────────────────────────────────────────
export const DURATION = Object.freeze({
  fast:  180,
  base:  240,
  slow:  300,
  modal: 320,
});

export const EASING = Object.freeze({
  out:    'cubic-bezier(0.3, 0.7, 0.15, 1)',
  in:     'cubic-bezier(0.7, 0.3, 0.15, 1)',
  snappy: 'cubic-bezier(0.2, 0, 0, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
});

// Utility: build a CSS transition string
export function transition(...props) {
  return props
    .map(([prop, dur = DURATION.base, ease = EASING.out]) =>
      `${prop} ${dur}ms ${ease}`
    )
    .join(', ');
}

// ── COLORS (dark theme) ───────────────────────────────────────
export const COLOR = Object.freeze({
  // Backgrounds
  bgBase:     '#000000',
  bgRaised:   '#000000',
  bgOverlay:  '#111111',
  bgElevated: '#161616',
  surfaceCard: '#1A1A1A',

  // Surfaces
  surface0: 'rgba(255,255,255,0.015)',
  surface1: 'rgba(255,255,255,0.025)',
  surface2: 'rgba(255,255,255,0.04)',
  surface3: 'rgba(255,255,255,0.06)',

  // Borders
  border0:      'rgba(255,255,255,0.06)',
  border1:      'rgba(255,255,255,0.08)',
  border2:      'rgba(255,255,255,0.10)',
  borderAccent: 'rgba(255,255,255,0.22)',

  // Text
  textPrimary:   '#FFFFFF',
  textSecondary: '#D6D6D6',
  textTertiary:  '#999999',
  textMuted:     '#707070',

  // Accent
  accent1: '#000000',
  accentGlow: 'rgba(0,0,0,0.22)',

  // Semantic
  success: '#34d39b',
  warning: '#f5a623',
  danger:  '#f26b6b',
  info:    '#000000',
});

// ── ELEVATION (shadow) SYSTEM ─────────────────────────────────
export const SHADOW = Object.freeze({
  sm:    '0 2px 8px rgba(0,0,0,0.6)',
  md:    '0 4px 20px rgba(0,0,0,0.7)',
  lg:    '0 8px 40px rgba(0,0,0,0.8)',
  focus: '0 0 0 2px rgba(255,255,255,0.18)',
  accent: '0 2px 12px rgba(0,0,0,0.22)',
  innerHighlight: 'inset 0 1px 0 rgba(255,255,255,0.08)',
});

// ── TYPOGRAPHY ────────────────────────────────────────────────
export const TYPE = Object.freeze({
  fontUi:   "'Geist', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif",
  fontMono: "'Geist Mono', 'SF Mono', 'Segoe UI Mono', monospace",

  // Type scale (px)
  xs:   11,
  sm:   12,
  base: 13,
  md:   14,
  lg:   15,
  xl:   16,
  '2xl': 20,
  '3xl': 28,

  // Weight scale
  light:    300,
  regular:  400,
  medium:   500,
  semibold: 600,
  bold:     700,

  // Leading (line-height)
  tight:  1.3,
  normal: 1.55,
  loose:  1.75,
});

// ── LAYOUT ────────────────────────────────────────────────────
export const LAYOUT = Object.freeze({
  railW:          236,
  railWCollapsed: 60,
  chromeH:        52,
  statusH:        28,
  aiW:            360,
});

// ── Z-INDEX LAYERS ────────────────────────────────────────────
export const Z = Object.freeze({
  base:    1,
  raised:  10,
  overlay: 100,
  modal:   200,
  toast:   9999,
});

// ── BREAKPOINTS ───────────────────────────────────────────────
export const BP = Object.freeze({
  sm:  960,
  md:  1200,
  lg:  1440,
});

// ── COMPONENT TOKENS (derived) ────────────────────────────────
// Use these when building components to stay coherent.
export const COMPONENT = Object.freeze({
  // Buttons
  btn: {
    height:       32,
    heightSm:     26,
    heightLg:     40,
    radius:       RADIUS.md,
    radiusPill:   RADIUS.full,
    paddingX:     SPACE[3],
  },

  // Inputs
  input: {
    height:   36,
    radius:   RADIUS.md,
    radiusPill: RADIUS.full,
    paddingX: SPACE[3],
  },

  // Cards
  card: {
    radius:  RADIUS.xl,
    padding: SPACE[4],
  },

  // Tabs
  tab: {
    height:       38,
    radius:       RADIUS.lg,
    paddingX:     SPACE[3],
    closeBtnSize: 20,
  },

  // Rail
  rail: {
    itemHeight:  38,
    itemRadius:  RADIUS.lg,
    paddingX:    SPACE[3],
  },

  // Settings
  settings: {
    sidebarW:   200,
    cardRadius: RADIUS.xl,
  },
});

// ── EXPORT COMBINED ───────────────────────────────────────────
export default {
  SPACE,
  RADIUS,
  DURATION,
  EASING,
  COLOR,
  SHADOW,
  TYPE,
  LAYOUT,
  Z,
  BP,
  COMPONENT,
  transition,
};
