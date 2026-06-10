// クエスト定義（受注制・モンハン的）。表示用のマスタ。
// server の MmoRoom 内 QUESTS と id/goal/reward を一致させること。
// goal.kind は server の MOB_KINDS のキーに一致させる（grunt/slime/tank/boss など）。
// reward.relic（霊宝＝有限供給/在庫から）を持つクエストは repeatable:false 必須。
export interface QuestDef {
  id: string;
  name: string;
  desc: string;
  goal: {
    type: "killAny" | "killKind"; // killAny=種別問わず討伐 / killKind=特定種別を討伐
    kind?: string;                // killKind のとき対象の MOB_KINDS キー
    count: number;                // 目標討伐数
  };
  reward: {
    gold?: number;
    item?: { id: string; n: number }; // ITEMS のキー（回復薬・バフ薬・巻物すべて可）
    relic?: boolean;                  // 在庫から霊宝を1枚（一回限りクエスト専用）
    rareBias?: number;                // relic 時のレア寄せ(0-1)
  };
  repeatable: boolean; // 報酬受取後に再受注できるか（relic 報酬は false）
}

export const QUESTS: QuestDef[] = [
  // --- 繰り返し受注（ゴールド・アイテム報酬。保存則に無関係） ---
  { id: "q_any30", name: "魔物退治の依頼", desc: "魔物を30体討伐する",
    goal: { type: "killAny", count: 30 },
    reward: { gold: 150, item: { id: "potion_s", n: 2 } }, repeatable: true },
  { id: "q_grunt10", name: "迷い霊の鎮め", desc: "迷い霊を10体討伐する",
    goal: { type: "killKind", kind: "grunt", count: 10 },
    reward: { gold: 60 }, repeatable: true },
  { id: "q_slime15", name: "スライム掃討", desc: "泥スライムを15体討伐する",
    goal: { type: "killKind", kind: "slime", count: 15 },
    reward: { gold: 120 }, repeatable: true },
  { id: "q_spider12", name: "毒蜘蛛の駆除", desc: "毒蜘蛛を12体討伐する",
    goal: { type: "killKind", kind: "spider", count: 12 },
    reward: { gold: 80, item: { id: "potion_l", n: 1 } }, repeatable: true },
  // --- 一回限り（巻物・霊宝報酬） ---
  { id: "q_boss1", name: "災厄の主を討て", desc: "災厄の主（ボス）を1体討伐する",
    goal: { type: "killKind", kind: "boss", count: 1 },
    reward: { item: { id: "scroll_atk", n: 1 } }, repeatable: false },
  { id: "q_tank20", name: "巨人狩りの誓い", desc: "岩石巨人を20体討伐する",
    goal: { type: "killKind", kind: "tank", count: 20 },
    reward: { relic: true, rareBias: 0.4 }, repeatable: false },
];

export const QUEST_BY_ID: Record<string, QuestDef> = Object.fromEntries(
  QUESTS.map((q) => [q.id, q]),
);

export const MAX_ACTIVE_QUESTS = 3;
