/** テーマカラーのパレット。明るい背景用と暗い背景用の2値を持つ */
export const PALETTE: Record<string, { label: string; light: string; dark: string }> = {
  red: { label: "あか", light: "#d64545", dark: "#ff7b7b" },
  orange: { label: "だいだい", light: "#e07b1f", dark: "#ffa94d" },
  amber: { label: "こがね", light: "#b8860b", dark: "#f5c84c" },
  lime: { label: "わかば", light: "#5c9a1b", dark: "#a3d95b" },
  green: { label: "みどり", light: "#1f9d55", dark: "#5fd38d" },
  teal: { label: "あおみどり", light: "#0f8c8c", dark: "#4fd1c5" },
  sky: { label: "そら", light: "#1c7ed6", dark: "#74c0fc" },
  indigo: { label: "あい", light: "#4c51bf", dark: "#a3a8f0" },
  violet: { label: "すみれ", light: "#7e3fbf", dark: "#c9a0ff" },
  pink: { label: "もも", light: "#d63f8c", dark: "#f78fc4" },
  brown: { label: "くり", light: "#8a5a3b", dark: "#d2a27c" },
  slate: { label: "はい", light: "#56637a", dark: "#a9b4c8" },
};

export const PALETTE_KEYS = Object.keys(PALETTE);

export function isDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function colorOf(key: string | undefined): string {
  const c = PALETTE[key ?? ""] ?? PALETTE.slate;
  return isDark() ? c.dark : c.light;
}

/** まだ誰も使っていない色を選ぶ */
export function firstFreeColor(taken: Set<string>): string {
  return PALETTE_KEYS.find((k) => !taken.has(k)) ?? PALETTE_KEYS[0];
}
