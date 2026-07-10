#!/usr/bin/env node
// Generates src/accents.css: the selectable accent themes.
//
// Each accent is derived from the Nani sky ramp by keeping its OKLCH
// lightness/chroma CURVE per step and swapping in the accent's hue (chroma is
// scaled by the anchor's chroma relative to sky's step-9). That preserves the
// contrast architecture — badge text on accent-12, heatmap monotonicity, the
// pale 1..3 backgrounds — across every accent, light and dark.
//
// Rerun with `node scripts/gen-accents.mjs` after editing anchors.

// ── sRGB ↔ OKLCH ────────────────────────────────────────────────────────────
const srgbToLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (c) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
function rgbToHex([r, g, b]) {
  const to = (c) =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToOklab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const [l_, m_, s_] = [l, m, s].map(Math.cbrt);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}
function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, m, s] = [l_, m_, s_].map((c) => c ** 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(linearToSrgb);
}

const hexToLch = (hex) => {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  return { L, C: Math.hypot(a, b), H: (Math.atan2(b, a) * 180) / Math.PI };
};
const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
// Gamut-map by walking chroma down; L and H stay exact.
function lchToHex({ L, C, H }) {
  const rad = (H * Math.PI) / 180;
  let lo = 0;
  let hi = C;
  let rgb = oklabToRgb([L, hi * Math.cos(rad), hi * Math.sin(rad)]);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const t = oklabToRgb([L, mid * Math.cos(rad), mid * Math.sin(rad)]);
      if (inGamut(t)) lo = mid;
      else hi = mid;
    }
    rgb = oklabToRgb([L, lo * Math.cos(rad), lo * Math.sin(rad)]);
  }
  return rgbToHex(rgb);
}

// WCAG relative luminance / contrast, for the text-accent search.
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg, bg) => {
  const [a, b] = [luminance(fg) + 0.05, luminance(bg) + 0.05];
  return a > b ? a / b : b / a;
};
// Darkest/lightest L that still meets `min` contrast against bg.
function textColor({ C, H }, bg, min, dir) {
  let L = dir > 0 ? 0.55 : 0.72;
  for (let i = 0; i < 60; i++) {
    const hex = lchToHex({ L, C, H });
    if (contrast(hex, bg) >= min) return hex;
    L += dir * 0.005;
    if (L < 0.2 || L > 0.95) break;
  }
  return lchToHex({ L, C, H });
}

// ── Source curves: the sky ramps from styles.css ────────────────────────────
const SKY_LIGHT = [
  "#f3f9fe", "#ebf6ff", "#e5f3ff", "#d3ecff", "#bde2ff", "#9dd6ff",
  "#7ccbff", "#52bdff", "#24afff", "#09a5ff", "#008cf0", "#0077d4",
].map(hexToLch);
const SKY_DARK = [
  "#0d2133", "#102a41", "#143450", "#1a4160", "#205077", "#29679b",
  "#3181c4", "#2f9dec", "#3bb7ff", "#5ec4ff", "#7ed0ff", "#a6dfff",
].map(hexToLch);
const SKY_C9 = SKY_LIGHT[8].C;

// ── Accents: anchor = the step-9 hue/chroma each theme is built around ──────
// `l9` (optional) pulls the LIGHT ramp's step-9 lightness toward the anchor:
// sky's curve suits hues that peak bright (cyan, orange), but graphite/cafe/
// violet/indigo read washed-out at sky-9's L≈0.67. The shift fades in over
// steps 5→9 (pale 1..4 backgrounds stay put) and carries through 10..12, so
// the ramp stays monotonic and step-12 stays dark enough for white badge text.
const ACCENTS = [
  { id: "graphite", label: "グラファイト", anchor: "#42525f", l9: 0.48 },
  { id: "violet", label: "バイオレット", anchor: "#7c6cf5", l9: 0.6 },
  { id: "teal", label: "ミントティール", anchor: "#1cc2ad" },
  { id: "rose", label: "ローズ", anchor: "#f9558b" },
  { id: "coral", label: "コーラル", anchor: "#ff7a4d" },
  { id: "indigo", label: "インディゴ", anchor: "#5a6cf3", l9: 0.58 },
  { id: "amber", label: "アンバーゴールド", anchor: "#f5b301" },
  { id: "emerald", label: "エメラルド", anchor: "#2bb673" },
  { id: "cafe", label: "カフェブラウン", anchor: "#9c6b3f", l9: 0.57 },
];

// Sky reference points for the non-ramp tokens (measured from styles.css).
const DARK_BG = "#171d23";

// Nani's neutrals are blue-cast (hue ≈ sky's), which clashes under a warm
// accent — the canvas keeps whispering "blue". So each accent also re-hues
// the neutral tokens: same OKLCH lightness/chroma, accent hue, chroma kept
// subtle (clamped multiplier) so the tint stays a cast, never a wash.
const LIGHT_NEUTRALS = {
  "--color-gray-2": "#fbfdff",
  "--color-gray-3": "#f6f9fb",
  "--color-gray-4": "#f1f6f9",
  "--color-gray-5": "#e9eef1",
  "--color-gray-6": "#e2eaee",
  "--color-gray-7": "#cad3d8",
  "--color-gray-8": "#b1bec6",
  "--color-gray-9": "#99a2a7",
  "--color-gray-10": "#7f8b91",
  "--color-gray-11": "#5f6a6f",
  "--color-gray-12": "#080d12",
  "--bg-secondary": "#f6f9fb",
  "--bg-tertiary": "#f1f6f9",
  "--bg-quaternary": "#e9eef1",
  "--border-light": "#e9eef1",
  "--border-medium": "#e2eaee",
  "--border-strong": "#cad3d8",
  "--border-inverted": "#b1bec6",
};
const DARK_NEUTRALS = {
  "--color-gray-4": "#232b33",
  "--color-gray-5": "#2b343d",
  "--color-gray-6": "#35414b",
  "--color-gray-7": "#435160",
  "--color-gray-9": "#6e7d88",
  "--color-gray-11": "#a7b4bd",
  "--bg-primary": "#171d23",
  "--bg-secondary": "#1e262d",
  "--bg-tertiary": "#27313a",
  "--bg-quaternary": "#303c46",
  "--border-light": "#2b343d",
  "--border-medium": "#35404a",
  "--border-strong": "#46535f",
  "--border-inverted": "#5c6b77",
  "--text-primary": "#e9eff4",
  "--text-secondary": "#a7b4bd",
  "--text-tertiary": "#77848d",
  "--text-light": "#5b676f",
};

function buildAccent({ id, label, anchor, l9 }) {
  const { C: aC, H } = hexToLch(anchor);
  const k = aC / SKY_C9;
  const dL9 = l9 === undefined ? 0 : l9 - SKY_LIGHT[8].L;
  const light = SKY_LIGHT.map(({ L, C }, i) => {
    const t = Math.min(Math.max((i + 1 - 4) / 5, 0), 1);
    return lchToHex({ L: L + t * dL9, C: C * k, H });
  });
  const dark = SKY_DARK.map(({ L, C }) => lchToHex({ L, C: C * k, H }));

  // Text accents: sky's are ~#0089f2 (4.0:1 on white) / #4dbeff (7.9:1 on the
  // dark bg). Meet-or-beat those, searching downward/upward in L.
  const textLight = textColor({ C: Math.min(aC, 0.19), H }, "#ffffff", 4.0, -1);
  const textDark = textColor({ C: Math.min(aC * 0.8, 0.13), H }, DARK_BG, 6.0, +1);

  // Garnish tokens, same shape as sky's: selection = accent-8 @ 30%,
  // ice gradient tints, translucent second layer.
  const selection = `${light[7]}4d`;
  const gradLight = [
    lchToHex({ L: 0.992, C: Math.min(0.007 * k, 0.012), H }),
    lchToHex({ L: 0.985, C: Math.min(0.012 * k, 0.02), H }),
  ];
  const gradDark = [
    lchToHex({ L: 0.245, C: Math.min(0.012 * k, 0.025), H }),
    lchToHex({ L: 0.258, C: Math.min(0.018 * k, 0.035), H }),
  ];
  const layerLight = `${lchToHex({ L: 0.5, C: Math.min(0.08 * k, 0.12), H })}0f`;
  const layerDark = `${lchToHex({ L: 0.78, C: Math.min(0.1 * k, 0.14), H })}14`;
  // Modal/palette scrim: sky's navy #001428 re-hued, same 30% alpha.
  const scrim = () => `${tint("#001428")}4d`;

  // Primary buttons carry white text, so they use the light ramp's dark end
  // in BOTH modes (mirrors the sky skin's #0089f2/#007ee0/#0072cb trio, which
  // sits at accent-11 → just past accent-12). Same L-curve ⇒ same contrast.
  const l11 = hexToLch(light[10]);
  const l12 = hexToLch(light[11]);
  const btn = [
    light[10],
    lchToHex({ L: (l11.L + l12.L) / 2, C: (l11.C + l12.C) / 2, H }),
    lchToHex({ L: l12.L - 0.015, C: l12.C, H }),
  ];
  const buttons = (indent) =>
    [
      `${indent}--button-primary-bg: ${btn[0]};`,
      `${indent}--button-primary-bg-hover: ${btn[1]};`,
      `${indent}--button-primary-bg-active: ${btn[2]};`,
    ].join("\n");

  // Re-hued neutrals (see LIGHT_NEUTRALS above).
  const nk = Math.min(Math.max(k, 0.25), 1.25);
  const tint = (hex) => {
    const { L, C } = hexToLch(hex);
    return lchToHex({ L, C: C * nk, H });
  };
  const neutrals = (table, indent) =>
    Object.entries(table)
      .map(([name, hex]) => `${indent}${name}: ${tint(hex)};`)
      .join("\n");

  const ramp = (hexes, indent) =>
    hexes.map((h, i) => `${indent}--color-accent-${i + 1}: ${h};`).join("\n");

  return `/* ── ${label} ── */
[data-accent="${id}"]:not([data-theme="dark"]) {
${ramp(light, "  ")}
${neutrals(LIGHT_NEUTRALS, "  ")}
${buttons("  ")}
  --text-accent: ${textLight};
  --color-scrim: ${scrim()};
  --color-selection: ${selection};
  --bg-gradient-subtle: linear-gradient(0deg, #fff, ${gradLight[0]} 45%, ${gradLight[1]});
  --bg-radi-dots: radial-gradient(${tint("#e2eaef")} 1.2px, transparent 1.2px);
  --color-second-layer-bg: ${layerLight};
}
[data-theme="dark"][data-accent="${id}"] {
${ramp(dark, "  ")}
${neutrals(DARK_NEUTRALS, "  ")}
${buttons("  ")}
  --text-accent: ${textDark};
  --color-scrim: ${scrim()};
  --color-selection: ${selection};
  --bg-gradient-subtle: linear-gradient(0deg, ${tint(DARK_BG)}, ${gradDark[0]} 45%, ${gradDark[1]});
  --bg-radi-dots: radial-gradient(${tint("#2b343d")} 1.2px, transparent 1.2px);
  --color-second-layer-bg: ${layerDark};
}
`;
}

const header = `/* @generated by scripts/gen-accents.mjs — do not edit by hand.
   Selectable accent themes. Each swaps the sky accent ramp (styles.css) for
   another hue while keeping the exact per-step OKLCH lightness curve, so
   contrast relationships (badges, heatmap, pale fills) hold for every theme.
   The attribute lives on <html>; "sky" is the default (no attribute). */
`;

const css = header + "\n" + ACCENTS.map(buildAccent).join("\n");
const { writeFileSync } = await import("node:fs");
const out = new URL("../src/accents.css", import.meta.url);
writeFileSync(out, css);
console.log(`wrote src/accents.css (${ACCENTS.length} accents)`);
for (const a of ACCENTS) {
  const { C, H } = hexToLch(a.anchor);
  console.log(`  ${a.id.padEnd(9)} hue ${H.toFixed(0).padStart(4)}  C ${C.toFixed(3)}`);
}
