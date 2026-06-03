// カードの見た目メタ（アイコン・レアリティ表示）。DBには持たせず client 側で対応。
import type { Rarity } from "../../spirit";

export const CARD_ICON: Record<number, string> = {
  1: "🔥", 2: "🌊", 3: "🪨", 4: "🌬️", 5: "🐦", 6: "🗝️", 7: "👢", 8: "🪬",
  9: "🪞", 10: "✨", 11: "🌫️", 12: "⚡", 13: "🪡",
  14: "🕊️", 15: "📖", 16: "🔮",
  // 普通(+18)
  17: "💧", 18: "🐀", 19: "🪵", 20: "⏳", 21: "🗡️", 22: "🕯️", 23: "🌰", 24: "🎣",
  25: "🏮", 26: "📜", 27: "🥄", 28: "🐇", 29: "🧱", 30: "🌾", 31: "🪙", 32: "🪶",
  33: "🪈", 34: "🧪",
  // 希少(+11)
  35: "🧿", 36: "🦅", 37: "🧊", 38: "🔪", 39: "🦋", 40: "🐺", 41: "🐉", 42: "🐚",
  43: "🦊", 44: "🦚", 45: "💍",
  // 秘宝(+5)
  46: "👑", 47: "🌱", 48: "👁️", 49: "🕰️", 50: "🏆",
};

export const RARITY_META: Record<Rarity, { label: string; colorStr: string; colorNum: number }> = {
  common: { label: "普通", colorStr: "#8a93a8", colorNum: 0x8a93a8 },
  rare:   { label: "希少", colorStr: "#5fb6c4", colorNum: 0x5fb6c4 },
  legend: { label: "秘宝", colorStr: "#e8b04b", colorNum: 0xe8b04b },
};
