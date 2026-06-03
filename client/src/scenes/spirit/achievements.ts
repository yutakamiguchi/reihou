// 達成課題（表示用）。server の ACHIEVEMENTS と id/type/need を一致させること。
export interface ClientAchv {
  id: string; type: "kills" | "collected" | "playSec" | "level"; need: number; desc: string;
}
export const ACHIEVEMENTS: ClientAchv[] = [
  { id: "kill10",   type: "kills",     need: 10,   desc: "魔物を10体討伐" },
  { id: "kill50",   type: "kills",     need: 50,   desc: "魔物を50体討伐" },
  { id: "kill200",  type: "kills",     need: 200,  desc: "魔物を200体討伐" },
  { id: "kill1000", type: "kills",     need: 1000, desc: "魔物を1000体討伐" },
  { id: "collect10", type: "collected", need: 10,  desc: "霊宝を10種集める" },
  { id: "collect25", type: "collected", need: 25,  desc: "霊宝を25種集める" },
  { id: "collect35", type: "collected", need: 35,  desc: "霊宝を35種集める" },
  { id: "play1h",   type: "playSec",   need: 3600, desc: "1時間プレイ" },
  { id: "level10",  type: "level",     need: 10,   desc: "レベル10到達" },
  { id: "level20",  type: "level",     need: 20,   desc: "レベル20到達" },
  { id: "apex",     type: "collected", need: 42,   desc: "非秘宝42種（秘宝授与）" },
];
