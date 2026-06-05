// アイテムの表示メタ（サーバー ITEMS と id を一致させる）。効果値はサーバー権威。
export interface ItemMeta { id: string; name: string; icon: string; desc: string; }

export const ITEM_META: Record<string, ItemMeta> = {
  potion_s:   { id: "potion_s",   name: "回復薬",     icon: "🧪", desc: "HPを60回復" },
  potion_l:   { id: "potion_l",   name: "上級回復薬", icon: "🍶", desc: "HPを180回復" },
  elixir_atk: { id: "elixir_atk", name: "力の薬",     icon: "💪", desc: "30秒 攻撃1.5倍" },
  elixir_spd: { id: "elixir_spd", name: "俊足の薬",   icon: "👟", desc: "30秒 速度1.4倍" },
};
// ホットキー1〜4／一覧の並び順
export const ITEM_ORDER = ["potion_s", "potion_l", "elixir_atk", "elixir_spd"];
export const SPEED_BUFF_MUL = 1.4; // サーバーの SPEED_BUFF_MUL と一致（移動予測用）
