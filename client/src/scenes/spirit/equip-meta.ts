// 装備の表示メタ（サーバー EQUIP と id を一致させる）。効果値・価格はサーバー権威。
export interface EquipMeta { id: string; name: string; icon: string; slot: string; desc: string; }

export const EQUIP_META: Record<string, EquipMeta> = {
  sword_wood:    { id: "sword_wood",    name: "木の剣",     icon: "🗡️", slot: "weapon", desc: "攻撃 +3" },
  sword_iron:    { id: "sword_iron",    name: "鉄の剣",     icon: "⚔️", slot: "weapon", desc: "攻撃 +8" },
  shield_wood:   { id: "shield_wood",   name: "木の盾",     icon: "🛡️", slot: "shield", desc: "防御 +2" },
  armor_leather: { id: "armor_leather", name: "革の鎧",     icon: "🥋", slot: "armor",  desc: "防御 +2 / 最大HP +20" },
  amulet_vigor:  { id: "amulet_vigor",  name: "活力の護符", icon: "🔮", slot: "amulet", desc: "最大HP +40" },
  ring_power:    { id: "ring_power",    name: "力の指輪",   icon: "💍", slot: "ring",   desc: "攻撃 +5" },
};

// 装備スロット（UI表示順とラベル。key はサーバーの EquipSlot と一致）
export const SLOTS: Array<{ key: string; label: string }> = [
  { key: "weapon", label: "武器" },
  { key: "shield", label: "盾" },
  { key: "head",   label: "頭" },
  { key: "armor",  label: "鎧" },
  { key: "amulet", label: "護符" },
  { key: "ring",   label: "指輪" },
];

// ショップで購入できる装備（価格表示用。実際の課金判定はサーバー権威）
export const EQUIP_SHOP: Array<{ id: string; price: number }> = [
  { id: "sword_wood",    price: 60 },
  { id: "shield_wood",   price: 60 },
  { id: "armor_leather", price: 120 },
  { id: "amulet_vigor",  price: 150 },
  { id: "ring_power",    price: 180 },
  { id: "sword_iron",    price: 200 },
];

// 装備の売値（表示用。サーバー EQUIP.sell と一致）
export const EQUIP_SELL: Record<string, number> = {
  sword_wood: 24, sword_iron: 80, shield_wood: 24,
  armor_leather: 48, amulet_vigor: 60, ring_power: 72,
};
