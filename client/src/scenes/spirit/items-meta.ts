// アイテムの表示メタ（サーバー ITEMS と id を一致させる）。効果値はサーバー権威。
export interface ItemMeta { id: string; name: string; icon: string; desc: string; }

export const ITEM_META: Record<string, ItemMeta> = {
  potion_s:   { id: "potion_s",   name: "回復薬",     icon: "🧪", desc: "HPを60回復" },
  potion_l:   { id: "potion_l",   name: "上級回復薬", icon: "🍶", desc: "HPを180回復" },
  elixir_atk: { id: "elixir_atk", name: "力の薬",     icon: "💪", desc: "30秒 攻撃1.5倍" },
  elixir_spd: { id: "elixir_spd", name: "俊足の薬",   icon: "👟", desc: "30秒 速度1.4倍" },
  scroll_atk: { id: "scroll_atk", name: "力の巻物",   icon: "📜", desc: "攻撃力 +3（永続）" },
  scroll_def: { id: "scroll_def", name: "堅の巻物",   icon: "📜", desc: "防御力 +1（永続）" },
  scroll_hp:  { id: "scroll_hp",  name: "生命の巻物", icon: "📜", desc: "最大HP +20（永続）" },
};
// 一覧の並び順（先頭4つは数字キー1〜4のホットキー対象）
export const ITEM_ORDER = ["potion_s", "potion_l", "elixir_atk", "elixir_spd", "scroll_atk", "scroll_def", "scroll_hp"];
export const SPEED_BUFF_MUL = 1.4; // サーバーの SPEED_BUFF_MUL と一致（移動予測用）

// ショップで購入できるアイテム（価格表示用。実際の課金判定はサーバー権威）
export const SHOP_ITEMS: Array<{ id: string; price: number }> = [
  { id: "potion_s", price: 30 },
  { id: "potion_l", price: 80 },
];

// ショップで売却できるアイテムの売値（表示用。サーバー ITEMS.sell と一致）
export const SELL_PRICES: Record<string, number> = {
  potion_s: 12, potion_l: 32, elixir_atk: 16, elixir_spd: 16,
  scroll_atk: 80, scroll_def: 80, scroll_hp: 80,
};
