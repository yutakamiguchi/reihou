import { Room, Client } from "colyseus";
import { MmoState, MmoPlayer, Mob, Relic, Treasure, Gate } from "../../schema/MmoState";
import { supabaseAdmin, isSupabaseConfigured, loadGameStats, saveGameStats } from "../../supabase";

const SPIRIT_GAME_KEY = "spirit"; // game_stats のキー（霊宝の世界の進行）

// レベルから派生ステータスを算出（level-up 式と一致させること）
function nextExpFor(level: number) { return 20 + (level - 1) * 15; }
function maxHpFor(level: number) { return 100 + (level - 1) * 20; }
function atkFor(level: number) { return 10 + (level - 1) * 3; }

// 達成課題（満たすと在庫から霊宝授与。legend=true は秘宝を授かる頂点課題＝faucet）
interface Achv {
  id: string; type: "kills" | "collected" | "playSec" | "level"; need: number;
  desc: string; rareBias?: number; legend?: boolean;
}
const ACHIEVEMENTS: Achv[] = [
  { id: "kill10",   type: "kills",     need: 10,   desc: "魔物を10体討伐",   rareBias: 0 },
  { id: "kill50",   type: "kills",     need: 50,   desc: "魔物を50体討伐",   rareBias: 0.2 },
  { id: "kill200",  type: "kills",     need: 200,  desc: "魔物を200体討伐",  rareBias: 0.4 },
  { id: "kill1000", type: "kills",     need: 1000, desc: "魔物を1000体討伐", rareBias: 0.7 },
  { id: "collect10", type: "collected", need: 10,  desc: "霊宝を10種集める",  rareBias: 0.2 },
  { id: "collect25", type: "collected", need: 25,  desc: "霊宝を25種集める",  rareBias: 0.4 },
  { id: "collect35", type: "collected", need: 35,  desc: "霊宝を35種集める",  rareBias: 0.6 },
  { id: "play1h",   type: "playSec",   need: 3600, desc: "1時間プレイ",       rareBias: 0.2 },
  { id: "level10",  type: "level",     need: 10,   desc: "レベル10到達",      rareBias: 0.3 },
  { id: "level20",  type: "level",     need: 20,   desc: "レベル20到達",      rareBias: 0.6 },
  { id: "apex",     type: "collected", need: 42,   desc: "非秘宝42種を集めし者（秘宝を授かる）", legend: true },
  // 頂点課題（legend faucet）。やり込み系の到達で在庫から秘宝を授与。
  { id: "kill3000", type: "kills",     need: 3000,  desc: "魔物を3000体討伐せし者（秘宝を授かる）", legend: true },
  { id: "level30",  type: "level",     need: 30,    desc: "レベル30到達（秘宝を授かる）",          legend: true },
  { id: "play10h",  type: "playSec",   need: 36000, desc: "10時間プレイせし者（秘宝を授かる）",      legend: true },
];

// クエスト（受注制）。client の quests-meta.ts と id/goal/reward を一致させること。
// goal.kind は MOB_KINDS のキー。reward.relic（在庫から霊宝）は repeatable:false 専用。
interface QuestDef {
  id: string; name: string; desc: string;
  goal: { type: "killAny" | "killKind"; kind?: string; count: number };
  reward: { gold?: number; item?: { id: string; n: number }; relic?: boolean; rareBias?: number };
  repeatable: boolean;
}
const QUESTS: QuestDef[] = [
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
  { id: "q_boss1", name: "災厄の主を討て", desc: "災厄の主（ボス）を1体討伐する",
    goal: { type: "killKind", kind: "boss", count: 1 },
    reward: { item: { id: "scroll_atk", n: 1 } }, repeatable: false },
  { id: "q_tank20", name: "巨人狩りの誓い", desc: "岩石巨人を20体討伐する",
    goal: { type: "killKind", kind: "tank", count: 20 },
    reward: { relic: true, rareBias: 0.4 }, repeatable: false },
];
const QUEST_BY_ID: Record<string, QuestDef> = Object.fromEntries(QUESTS.map((q) => [q.id, q]));
const MAX_ACTIVE_QUESTS = 3;
// クエスト進捗のランタイム表現。active=受注中（残り討伐数）/ done=達成・報酬未受取 / claimed=受取済み
interface QuestRt {
  active: Array<{ id: string; remaining: number }>;
  done: Set<string>;
  claimed: Set<string>;
}

const TICK_RATE = 30;
const PLAYER_SPEED = 140;
const ENTITY_RADIUS = 14;
const NUM_COLORS = 8;

const ATTACK_RANGE = 72;        // 前方への射程
const ATTACK_HALF_WIDTH = 24;   // 進行方向に直交する半幅
const ATTACK_DURATION_MS = 220;
const ATTACK_COOLDOWN_MS = 400;

const MOB_TARGET_COUNT = 24; // 通常mob（ボス除く）の維持数
const MOB_AGGRO_RANGE = 260;
const BOSS_RESPAWN_MS = 45000; // ボス撃破後の再出現待ち

// 敵の種別ごとのパラメータ。speed=px/s、expMul=EXP倍率、drop=霊宝ドロップ率、rareBias=希少寄せ(0-1)
interface MobKindDef {
  name: string; maxHp: number; atk: number; speed: number;
  expMul: number; drop: number; rareBias: number;
}
const MOB_KINDS: Record<string, MobKindDef> = {
  grunt:    { name: "迷い霊",   maxHp: 50,  atk: 7,  speed: 62,  expMul: 1.0, drop: 0.08, rareBias: 0 },
  swift:    { name: "妖蝙蝠",   maxHp: 30,  atk: 6,  speed: 104, expMul: 1.2, drop: 0.08, rareBias: 0 },
  tank:     { name: "岩石巨人", maxHp: 150, atk: 12, speed: 38,  expMul: 2.2, drop: 0.22, rareBias: 0.5 },
  brute:    { name: "紅蓮鬼",   maxHp: 95,  atk: 16, speed: 58,  expMul: 1.8, drop: 0.14, rareBias: 0.3 },
  // 追加5種
  slime:    { name: "泥スライム", maxHp: 36, atk: 6,  speed: 50,  expMul: 0.9, drop: 0.07, rareBias: 0 },
  spider:   { name: "毒蜘蛛",   maxHp: 55,  atk: 10, speed: 90,  expMul: 1.4, drop: 0.10, rareBias: 0.1 },
  skeleton: { name: "骸骨剣士", maxHp: 82,  atk: 13, speed: 60,  expMul: 1.6, drop: 0.12, rareBias: 0.2 },
  scorpion: { name: "砂蠍",     maxHp: 120, atk: 14, speed: 46,  expMul: 2.0, drop: 0.18, rareBias: 0.4 },
  serpent:  { name: "大蛇",     maxHp: 100, atk: 17, speed: 84,  expMul: 2.0, drop: 0.16, rareBias: 0.35 },
  boss:     { name: "災厄の主", maxHp: 480, atk: 24, speed: 48,  expMul: 6.0, drop: 0.50, rareBias: 1.0 },
};
// 出現率（弱いほど多い）。ボスは別枠。
const MOB_SPAWN_WEIGHTS: Array<[string, number]> = [
  ["grunt", 26], ["slime", 22], ["swift", 14], ["spider", 12], ["skeleton", 9],
  ["brute", 6], ["tank", 5], ["scorpion", 3], ["serpent", 1],
];
function pickMobKind(): string {
  const total = MOB_SPAWN_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of MOB_SPAWN_WEIGHTS) { r -= w; if (r <= 0) return k; }
  return "grunt";
}

// 狩場（ハント地）の定義。theme は client のタイルマップ/装飾テーマ。
// roster は弱→強の順。各階は roster の窓(3種)をずらして使う（深い階ほど強い種に）。
interface GroundDef { id: string; name: string; theme: string; floors: number; roster: string[]; }
const GROUNDS: Record<string, GroundDef> = {
  grass: { id: "grass", name: "草原", theme: "grass", floors: 5,
    roster: ["slime", "grunt", "swift", "spider", "skeleton", "brute", "serpent"] },
  cave:  { id: "cave",  name: "洞窟", theme: "cave",  floors: 5,
    roster: ["spider", "grunt", "scorpion", "skeleton", "serpent", "tank", "brute"] },
};
// 指定階の出現敵（[種別, 重み]）。窓は roster[f-1 .. f+1] の3種、弱い順に重み大。
function floorMobWeights(g: GroundDef, floor: number): Array<[string, number]> {
  const start = Math.max(0, Math.min(floor - 1, g.roster.length - 3));
  const window = g.roster.slice(start, start + 3);
  const weights = [5, 3, 2];
  return window.map((k, i) => [k, weights[i] ?? 1] as [string, number]);
}
const MOB_TOUCH_RANGE = 28;
const MOB_TOUCH_DMG_COOLDOWN_MS = 800;
const PLAYER_RESPAWN_DELAY_MS = 4000;
const RELIC_TARGET = 6;            // フィールドに常時湧かせる霊宝ノード数
const RELIC_PICKUP_RANGE = 30;     // 拾得判定の距離
const RELIC_SPAWN_COOLDOWN_MS = 4000;
const TREASURE_TARGET = 2;         // 狩場に常時湧かせる宝箱の数
const TREASURE_OPEN_RANGE = 48;    // 開封判定の距離（[E]）
const TREASURE_SPAWN_COOLDOWN_MS = 12000;

// --- アイテム ---
// kind: heal=HP回復 / buffAtk=攻撃倍率 / buffSpeed=移動速度倍率（バフは durationMs 間）
//       perm=恒久ステータスアップ（巻物。stat へ value を加算）
interface ItemDef {
  id: string; name: string; kind: "heal" | "buffAtk" | "buffSpeed" | "perm";
  value: number;        // heal=回復量 / buff=倍率 / perm=上昇量
  durationMs?: number;  // バフの持続
  price?: number;       // ショップ価格（回復系）
  sell?: number;        // 売却額（所持アイテムをゴールド化）
  dropWeight?: number;  // mobドロップの重み（バフ・巻物系）
  stat?: "atk" | "def" | "maxHp"; // perm の対象ステータス
}
const ITEMS: Record<string, ItemDef> = {
  potion_s:   { id: "potion_s",   name: "回復薬",     kind: "heal",      value: 60,  price: 30, sell: 12 },
  potion_l:   { id: "potion_l",   name: "上級回復薬", kind: "heal",      value: 180, price: 80, sell: 32 },
  elixir_atk: { id: "elixir_atk", name: "力の薬",     kind: "buffAtk",   value: 1.5, durationMs: 30000, sell: 16 }, // 入手は宝箱
  elixir_spd: { id: "elixir_spd", name: "俊足の薬",   kind: "buffSpeed", value: 1.4, durationMs: 30000, sell: 16 }, // 入手は宝箱
  scroll_atk: { id: "scroll_atk", name: "力の巻物",   kind: "perm", stat: "atk",   value: 3,  dropWeight: 1, sell: 80 },
  scroll_def: { id: "scroll_def", name: "堅の巻物",   kind: "perm", stat: "def",   value: 1,  dropWeight: 1, sell: 80 },
  scroll_hp:  { id: "scroll_hp",  name: "生命の巻物", kind: "perm", stat: "maxHp", value: 20, dropWeight: 1, sell: 80 },
};
// 討伐ドロップは巻物のみ（バフ薬は宝箱から）。各巻物 ≈ 0.67% × 1/3 ≈ 0.22%
const SCROLL_DROP_CHANCE = 0.0067;
const BUFF_TREASURE_ITEMS = ["elixir_atk", "elixir_spd"]; // 宝箱から出るバフ薬
const ATK_BUFF_MUL = ITEMS.elixir_atk.value;
const SPEED_BUFF_MUL = ITEMS.elixir_spd.value;
// ドロップ対象（バフ系）を重み付き抽選
const DROP_ITEMS: Array<[string, number]> = Object.values(ITEMS)
  .filter((it) => it.dropWeight && it.dropWeight > 0)
  .map((it) => [it.id, it.dropWeight as number]);
function pickDropItem(): string {
  const total = DROP_ITEMS.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [id, w] of DROP_ITEMS) { r -= w; if (r <= 0) return id; }
  return DROP_ITEMS[0]?.[0] ?? "elixir_atk";
}

// --- 装備 ---
// アイテムに準じる無限供給（霊宝の保存則 INV-1〜6 とは無関係）。
// 装備すると slot を占有し、atk/def/maxHp を加算する。
type EquipSlot = "weapon" | "shield" | "head" | "armor" | "amulet" | "ring";
interface EquipDef {
  id: string; name: string; slot: EquipSlot;
  atk?: number; def?: number; maxHp?: number;
  price?: number;       // ショップ価格
  sell?: number;        // 売却額
  dropWeight?: number;  // mobドロップの重み
}
const EQUIP: Record<string, EquipDef> = {
  sword_wood:   { id: "sword_wood",   name: "木の剣",     slot: "weapon", atk: 3,          price: 60,  sell: 24 },
  sword_iron:   { id: "sword_iron",   name: "鉄の剣",     slot: "weapon", atk: 8,          price: 200, sell: 80, dropWeight: 1 },
  shield_wood:  { id: "shield_wood",  name: "木の盾",     slot: "shield", def: 2,          price: 60,  sell: 24 },
  armor_leather:{ id: "armor_leather",name: "革の鎧",     slot: "armor",  def: 2, maxHp: 20, price: 120, sell: 48 },
  amulet_vigor: { id: "amulet_vigor", name: "活力の護符", slot: "amulet", maxHp: 40,       price: 150, sell: 60, dropWeight: 1 },
  ring_power:   { id: "ring_power",   name: "力の指輪",   slot: "ring",   atk: 5,          price: 180, sell: 72, dropWeight: 1 },
};
// 討伐による装備の低確率ドロップ（dropWeight>0 を重み付き抽選）
const EQUIP_DROP_CHANCE = 0.005;
const EQUIP_DROP_ITEMS: Array<[string, number]> = Object.values(EQUIP)
  .filter((e) => e.dropWeight && e.dropWeight > 0)
  .map((e) => [e.id, e.dropWeight as number]);
function pickDropEquip(): string {
  const total = EQUIP_DROP_ITEMS.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [id, w] of EQUIP_DROP_ITEMS) { r -= w; if (r <= 0) return id; }
  return EQUIP_DROP_ITEMS[0]?.[0] ?? "sword_iron";
}

interface InputState {
  up: boolean; down: boolean; left: boolean; right: boolean;
  attackQueued: boolean; lastAttackAt: number;
}

interface MobAI {
  targetX: number;
  targetY: number;
  retargetAt: number;
  lastTouchAt: Map<string, number>;
}

export class MmoRoom extends Room<MmoState> {
  maxClients = 16;
  private inputs = new Map<string, InputState>();
  // 静的な当たり判定（AABB: 左上x,y＋幅高さ）。町のみ設定。clientの装飾と座標を一致させる
  private obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
  private mobAI = new Map<string, MobAI>();
  // エリア種別（解析済み）。ground="town"以外が狩場。
  private ground = "town";
  private floor = 0;
  private floorHpMul = 1;      // 階層による敵HP倍率（深層ほど急カーブ）
  private floorAtkMul = 1;     // 階層による敵ATK倍率（緩やかに上昇）
  private floorRareBias = 0;   // 階層によるレア寄せ加算（深層ほど厚く＝報酬）
  private floorMobs: Array<[string, number]> = [];
  private hasBoss = false;
  private mobSeq = 0;
  private relicSeq = 0;
  private lastRelicSpawnAt = 0;
  private treasureSeq = 0;
  private lastTreasureSpawnAt = 0;
  private nextBossAt = 0;
  private lastTick = 0;
  // 霊宝の所有を保存する先＝Supabaseのアカウント。sessionId -> profile_id（ゲストは null）
  private profileIds = new Map<string, string | null>();
  // プレイ時間/達成の算出用ランタイム
  private statsRt = new Map<string, {
    basePlaySec: number; sessionStartMs: number;
    claimed: Set<string>; collected: number; quests: QuestRt;
  }>();
  private lastPersistAt = 0;

  onCreate(options: { code?: string; area?: string }) {
    this.setState(new MmoState());
    this.applyArea(typeof options?.area === "string" ? options.area : "town");

    if (this.isHunt()) {
      for (let i = 0; i < MOB_TARGET_COUNT; i++) this.spawnMob();
      if (this.hasBoss) this.nextBossAt = Date.now() + 20000; // 最下層：最初のボスは20秒後から
    }

    this.onMessage("input", (client, message: Partial<InputState>) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      input.up = !!message.up;
      input.down = !!message.down;
      input.left = !!message.left;
      input.right = !!message.right;
    });

    this.onMessage("chat", (client, message: { text?: string }) => {
      const p = this.state.players.get(client.sessionId);
      const text = (message?.text ?? "").toString().replace(/\s+/g, " ").trim().slice(0, 120);
      if (!p || !text) return;
      this.broadcast("chat", { name: p.name, text });
    });

    this.onMessage("attack", (client) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      const now = Date.now();
      if (now - input.lastAttackAt < ATTACK_COOLDOWN_MS) return;
      input.attackQueued = true;
      input.lastAttackAt = now;
    });

    // アイテム使用（サーバー権威）
    this.onMessage("useItem", (client, message: { id?: string }) => {
      this.useItem(client.sessionId, message?.id ?? "");
    });

    // アイテム購入（ショップ。ゴールドを消費）
    this.onMessage("buyItem", (client, message: { id?: string }) => {
      this.buyItem(client.sessionId, message?.id ?? "");
    });

    // アイテム売却（ショップ。ゴールドを得る）
    this.onMessage("sellItem", (client, message: { id?: string }) => {
      this.sellItem(client.sessionId, message?.id ?? "");
    });

    // 宝箱を開ける（[E]。近接の宝箱からバフ薬＋ゴールド）
    this.onMessage("openTreasure", (client, message: { id?: string }) => {
      this.openTreasure(client.sessionId, message?.id ?? "");
    });

    // 装備を装着（所持ギアをスロットへ）
    this.onMessage("equipItem", (client, message: { id?: string }) => {
      this.equipItem(client.sessionId, message?.id ?? "");
    });

    // 装備を外す（スロット指定で所持ギアへ戻す）
    this.onMessage("unequipItem", (client, message: { slot?: string }) => {
      this.unequipItem(client.sessionId, message?.slot ?? "");
    });

    // クエスト：受注
    this.onMessage("acceptQuest", (client, message: { id?: string }) => {
      this.acceptQuest(client.sessionId, message?.id ?? "");
    });
    // クエスト：報告（達成済みクエストの報酬受取）
    this.onMessage("claimQuest", (client, message: { id?: string }) => {
      this.claimQuest(client.sessionId, message?.id ?? "");
    });
    // クエスト：現在の受注状態を要求（受注所パネルを開いたとき）
    this.onMessage("questState", (client) => {
      const rt = this.statsRt.get(client.sessionId);
      if (rt) client.send("questState", this.questStatePayload(rt.quests));
    });

    this.setSimulationInterval((dt) => this.update(dt), 1000 / TICK_RATE);
    this.lastTick = Date.now();
  }

  async onJoin(client: Client, options: { name?: string; token?: string }) {
    // Supabaseアクセストークンを検証し、霊宝の所有を紐づける profile_id を得る。
    // （クライアント送信の id は信用せず、トークンからサーバーで解決する）
    let profileId: string | null = null;
    let displayName = (options?.name || "Player").slice(0, 16);
    if (options?.token && isSupabaseConfigured) {
      try {
        const { data, error } = await supabaseAdmin.auth.getUser(options.token);
        if (!error && data.user && !data.user.is_anonymous) {
          profileId = data.user.id;
          const prof = await supabaseAdmin
            .from("profiles").select("display_name").eq("id", profileId).single();
          if (prof.data?.display_name) displayName = prof.data.display_name;
        }
      } catch (e: any) {
        console.warn("[mmo] token検証失敗:", e?.message ?? e);
      }
    }
    this.profileIds.set(client.sessionId, profileId);
    console.log(`[mmo] join sid=${client.sessionId} profile=${profileId ?? "(guest)"} name=${displayName}`);

    const p = new MmoPlayer();
    p.id = client.sessionId;
    p.name = displayName;
    p.colorIndex = Math.floor(Math.random() * NUM_COLORS);
    p.level = 1; p.exp = 0; p.nextExp = 20;
    p.maxHp = 100; p.hp = 100; p.atk = 10;

    // 保存済みの進行を復元（ログイン者のみ）
    let basePlaySec = 0;
    let claimed: string[] = [];
    const questRt: QuestRt = { active: [], done: new Set(), claimed: new Set() };
    if (profileId && isSupabaseConfigured) {
      const s = await loadGameStats(profileId, SPIRIT_GAME_KEY);
      if (s) {
        p.bonusAtk = typeof s.bonusAtk === "number" ? s.bonusAtk : 0;
        p.bonusDef = typeof s.bonusDef === "number" ? s.bonusDef : 0;
        p.bonusMaxHp = typeof s.bonusMaxHp === "number" ? s.bonusMaxHp : 0;
        if (typeof s.level === "number" && s.level >= 1) {
          p.level = s.level;
          p.exp = typeof s.exp === "number" ? s.exp : 0;
          p.nextExp = nextExpFor(p.level);
        }
        // 装備（未装備の所持＋装備中スロット）を recalcStats の前に復元
        if (s.gear && typeof s.gear === "object") {
          for (const [k, v] of Object.entries(s.gear)) {
            if (EQUIP[k] && typeof v === "number" && v > 0) p.gear.set(k, v);
          }
        }
        if (s.equip && typeof s.equip === "object") {
          for (const [slot, id] of Object.entries(s.equip)) {
            if (typeof id === "string" && EQUIP[id] && EQUIP[id].slot === slot) p.equip.set(slot, id);
          }
        }
        this.recalcStats(p, true); // レベル＋巻物＋装備ボーナスから atk/maxHp/def を再計算
        p.kills = typeof s.kills === "number" ? s.kills : 0;
        basePlaySec = typeof s.playSec === "number" ? s.playSec : 0;
        claimed = Array.isArray(s.claimed) ? s.claimed : [];
        // クエスト進捗の復元（不正なidは無視）
        if (s.quests && typeof s.quests === "object") {
          const q = s.quests as any;
          if (Array.isArray(q.active)) {
            for (const a of q.active) {
              if (a && QUEST_BY_ID[a.id] && typeof a.remaining === "number"
                && questRt.active.length < MAX_ACTIVE_QUESTS) {
                questRt.active.push({ id: a.id, remaining: Math.max(0, Math.floor(a.remaining)) });
              }
            }
          }
          if (Array.isArray(q.done)) for (const id of q.done) if (QUEST_BY_ID[id]) questRt.done.add(id);
          if (Array.isArray(q.claimed)) for (const id of q.claimed) if (QUEST_BY_ID[id]) questRt.claimed.add(id);
        }
        p.gold = typeof s.gold === "number" ? s.gold : 0;
        if (s.items && typeof s.items === "object") {
          for (const [k, v] of Object.entries(s.items)) {
            if (ITEMS[k] && typeof v === "number" && v > 0) p.items.set(k, v);
          }
        }
      }
    }
    p.playSec = Math.floor(basePlaySec);
    this.statsRt.set(client.sessionId, {
      basePlaySec, sessionStartMs: Date.now(), claimed: new Set(claimed), collected: 0,
      quests: questRt,
    });

    this.placeRandomly(p);
    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, {
      up: false, down: false, left: false, right: false,
      attackQueued: false, lastAttackAt: 0,
    });
    // 蒐集数を取得して達成判定（入場時のバックフィル）
    if (profileId) void this.refreshCollectedAndEval(p);
  }

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (p) this.persistStats(p); // 退出時に進行を保存
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.profileIds.delete(client.sessionId);
    this.statsRt.delete(client.sessionId);
  }

  // ログイン者なら進行（レベル/EXP/討伐数/プレイ時間/達成）を game_stats に保存（fire-and-forget）。
  private persistStats(p: MmoPlayer) {
    const pid = this.profileIds.get(p.id);
    if (!pid || !isSupabaseConfigured) return;
    const rt = this.statsRt.get(p.id);
    void saveGameStats(pid, SPIRIT_GAME_KEY, {
      level: p.level, exp: p.exp, kills: p.kills, playSec: p.playSec,
      claimed: rt ? [...rt.claimed] : [],
      quests: rt ? {
        active: rt.quests.active.map((a) => ({ id: a.id, remaining: a.remaining })),
        done: [...rt.quests.done], claimed: [...rt.quests.claimed],
      } : { active: [], done: [], claimed: [] },
      gold: p.gold, items: Object.fromEntries(p.items.entries()),
      gear: Object.fromEntries(p.gear.entries()), equip: Object.fromEntries(p.equip.entries()),
      bonusAtk: p.bonusAtk, bonusDef: p.bonusDef, bonusMaxHp: p.bonusMaxHp,
    });
  }

  // 蒐集数(所持種数)を再取得して達成判定（霊宝入手後・入場時に呼ぶ）。
  private async refreshCollectedAndEval(p: MmoPlayer) {
    const pid = this.profileIds.get(p.id);
    const rt = this.statsRt.get(p.id);
    if (!pid || !rt || !isSupabaseConfigured) return;
    const { count } = await supabaseAdmin
      .from("user_cards").select("*", { count: "exact", head: true })
      .eq("profile_id", pid).gt("count", 0);
    rt.collected = count ?? 0;
    this.evalAchievements(p);
  }

  // 未達成の課題で条件を満たすものを授与する。
  private evalAchievements(p: MmoPlayer) {
    const rt = this.statsRt.get(p.id);
    const pid = this.profileIds.get(p.id);
    if (!rt || !pid || !isSupabaseConfigured) return;
    for (const a of ACHIEVEMENTS) {
      if (rt.claimed.has(a.id)) continue;
      const cur = a.type === "kills" ? p.kills
        : a.type === "level" ? p.level
        : a.type === "playSec" ? p.playSec
        : rt.collected;
      if (cur >= a.need) {
        rt.claimed.add(a.id);          // 先にマーク（多重付与防止）
        this.persistStats(p);
        void this.grantAchievementReward(p, a);
      }
    }
  }

  private async grantAchievementReward(p: MmoPlayer, a: Achv) {
    const pid = this.profileIds.get(p.id);
    if (!pid) return;
    const client = this.clients.find((c) => c.sessionId === p.id);
    try {
      let cardId: number | null = null;
      if (a.legend) {
        cardId = await this.grantAvailableLegend(pid);
      } else {
        const { data, error } = await supabaseAdmin.rpc("explore_pull_for", {
          p_profile: pid, p_season: 1, p_rare_bias: a.rareBias ?? 0,
        });
        if (error) { console.warn("[mmo] 達成報酬失敗:", error.message); return; }
        cardId = (data as number | null) ?? null;
      }
      client?.send("achievement", { id: a.id, desc: a.desc, cardId });
    } catch (e: any) {
      console.warn("[mmo] 達成報酬例外:", e?.message ?? e);
    }
  }

  // 在庫が残る秘宝を1つ授与（頂点課題の faucet）。
  private async grantAvailableLegend(profileId: string): Promise<number | null> {
    const { data } = await supabaseAdmin
      .from("cards").select("id").eq("rarity", "legend").gt("world_reserve", 0).limit(1);
    if (!data || data.length === 0) return null;
    const cid = data[0].id as number;
    await supabaseAdmin.rpc("grant_card", { p_card: cid, p_profile: profileId });
    return cid;
  }

  // --- スポーン ---

  private placeRandomly(e: { x: number; y: number }) {
    for (let i = 0; i < 30; i++) {
      const x = 80 + Math.random() * (this.state.mapWidth - 160);
      const y = 80 + Math.random() * (this.state.mapHeight - 160);
      if (!this.isBlocked(x, y)) { e.x = x; e.y = y; return; }
    }
    e.x = 80 + Math.random() * (this.state.mapWidth - 160);
    e.y = 80 + Math.random() * (this.state.mapHeight - 160);
  }

  private spawnMob(kind: string = this.pickFloorMob()) {
    const id = `mob_${this.mobSeq++}`;
    const def = MOB_KINDS[kind] ?? MOB_KINDS.grunt;
    const m = new Mob();
    m.id = id;
    m.kind = kind;
    m.level = Math.max(1, this.floor); // 階層＝レベル（EXP・表示用）
    m.maxHp = Math.round(def.maxHp * this.floorHpMul); m.hp = m.maxHp; // 深層ほど硬い
    m.atk = Math.round(def.atk * this.floorAtkMul);                    // 攻撃は緩やかに
    this.placeRandomly(m);
    this.state.mobs.set(id, m);
    this.mobAI.set(id, {
      targetX: m.x, targetY: m.y, retargetAt: 0,
      lastTouchAt: new Map(),
    });
  }

  private bossAlive(): boolean {
    let b = false;
    this.state.mobs.forEach((m) => { if (m.alive && m.kind === "boss") b = true; });
    return b;
  }

  private isHunt(): boolean { return this.ground !== "town"; }

  // エリア文字列を解析して部屋の種別・難易度・マップサイズを設定する。
  // "town" / "hunt:<ground>:<floor>"（旧 "field" は草原B1にマップ）。
  private applyArea(areaIn: string) {
    let area = areaIn === "field" ? "hunt:grass:1" : areaIn;
    if (area === "town") {
      this.ground = "town"; this.floor = 0;
      this.state.area = "town"; this.state.ground = "town";
      this.state.groundName = "ホームタウン"; this.state.floor = 0;
      this.state.mapWidth = 1280; this.state.mapHeight = 768; // Tiledマップ(40x24*32)に一致
      this.buildTownObstacles();
      this.setupGates();
      return;
    }
    const parts = area.split(":"); // hunt:ground:floor
    const g = GROUNDS[parts[1]] ?? GROUNDS.grass;
    const floor = Math.max(1, Math.min(parseInt(parts[2] ?? "1", 10) || 1, g.floors));
    this.ground = g.id; this.floor = floor;
    const f = floor - 1;
    this.floorHpMul = Math.pow(2.3, f);  // 1階層ごとにHP×2.3（B2=2.3 … B5≈28倍）
    this.floorAtkMul = Math.pow(1.5, f); // 攻撃は1階層ごと×1.5（B5≈5倍）一撃死を回避
    this.floorRareBias = 0.15 * f;       // 深層ほどレア寄り（B5=0.6）
    this.floorMobs = floorMobWeights(g, floor);
    this.hasBoss = floor === g.floors;
    this.state.area = `hunt:${g.id}:${floor}`;
    this.state.ground = g.id;
    this.state.groundName = g.name;
    this.state.floor = floor;
    // 狩場マップは既定サイズ(2560x1440)を使用
    this.setupGates();
  }

  // 階層の出現敵テーブルから1種選ぶ。
  private pickFloorMob(): string {
    const table = this.floorMobs.length ? this.floorMobs : MOB_SPAWN_WEIGHTS;
    const total = table.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [k, w] of table) { r -= w; if (r <= 0) return k; }
    return table[0]?.[0] ?? "grunt";
  }

  // 町の当たり判定を構築。clientの buildTownDecor() と (cx, 足元y) を一致させること
  private buildTownObstacles() {
    const box = (x: number, y: number, w: number, h: number) => this.obstacles.push({ x, y, w, h });
    // 建物（足元y基準。壁の下側のみブロック＝屋根の裏には回り込める）
    const house = (cx: number, fy: number) => box(cx - 46, fy - 70, 92, 70);
    house(250, 250); house(640, 250); house(1040, 250);
    // 井戸・看板
    box(640 - 16, 440 - 28, 32, 28);
    box(1090 - 10, 440 - 18, 20, 18);
    // 木の幹
    const trunk = (cx: number, fy: number) => box(cx - 10, fy - 16, 20, 16);
    trunk(130, 470); trunk(1210, 560); trunk(430, 560); trunk(900, 580);
    trunk(180, 720); trunk(1150, 720); trunk(760, 210);
    // 岩
    box(560 - 14, 600 - 12, 28, 12);
    box(470 - 14, 300 - 12, 28, 12);
    box(880 - 48, 250 - 14, 96, 40); // ショップ（clientの buildTownDecor と一致）
  }

  private setupGates() {
    const W = this.state.mapWidth, H = this.state.mapHeight;
    const add = (key: string, x: number, y: number, toArea: string, label: string) => {
      const g = new Gate(); g.x = x; g.y = y; g.toArea = toArea; g.label = label;
      this.state.gates.set(key, g);
    };
    if (this.ground === "town") {
      // 町：各狩場のB1へ（右辺に縦に2つ）
      add("toGrass", W - 120, H * 0.38, "hunt:grass:1", "草原へ");
      add("toCave", W - 120, H * 0.66, "hunt:cave:1", "洞窟へ");
      return;
    }
    // 狩場：上り階段（左）＝前の階 or 町、下り階段（右）＝次の階（最下層は無し）
    const gid = this.ground;
    const def = GROUNDS[gid];
    if (this.floor > 1) add("up", 120, H / 2, `hunt:${gid}:${this.floor - 1}`, "上り階段");
    else add("up", 120, H / 2, "town", "町へ");
    if (def && this.floor < def.floors) add("down", W - 120, H / 2, `hunt:${gid}:${this.floor + 1}`, "下り階段");
  }

  // --- 1tick ---

  private update(_dt: number) {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    // プレイヤー
    this.state.players.forEach((p, sid) => {
      const input = this.inputs.get(sid);
      if (!input) return;

      if (p.dead) {
        p.vx = 0; p.vy = 0;
        if (now >= p.respawnAt) {
          p.dead = false;
          p.hp = p.maxHp;
          this.placeRandomly(p);
        }
        return;
      }

      let dx = 0, dy = 0;
      if (input.up) dy -= 1;
      if (input.down) dy += 1;
      if (input.left) dx -= 1;
      if (input.right) dx += 1;
      const len = Math.hypot(dx, dy);
      if (len > 0) { dx /= len; dy /= len; p.dir = Math.atan2(dy, dx); }
      const spd = PLAYER_SPEED * (now < p.buffSpeedUntil ? SPEED_BUFF_MUL : 1); // 俊足の薬バフ
      p.vx = dx * spd;
      p.vy = dy * spd;
      this.moveEntity(p, dt);

      if (input.attackQueued) {
        input.attackQueued = false;
        p.attackUntil = now + ATTACK_DURATION_MS;
        this.resolvePlayerAttack(p);
      }
    });

    // 狩場のみ：モンスター・霊宝（町は安全＝出ない）
    if (this.isHunt()) {
    // モンスター
    this.state.mobs.forEach((m) => {
      if (!m.alive) return;
      const ai = this.mobAI.get(m.id);
      if (!ai) return;
      const spd = (MOB_KINDS[m.kind] ?? MOB_KINDS.grunt).speed;

      // 最近傍の生存プレイヤー
      let nearest: MmoPlayer | null = null;
      let nearestD = Infinity;
      this.state.players.forEach((p) => {
        if (p.dead) return;
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < nearestD) { nearestD = d; nearest = p; }
      });

      if (nearest && nearestD < MOB_AGGRO_RANGE) {
        const t = nearest as MmoPlayer;
        const dx = t.x - m.x, dy = t.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        m.dir = Math.atan2(dy, dx);
        m.x += (dx / d) * spd * dt;
        m.y += (dy / d) * spd * dt;

        // 接触ダメージ
        if (nearestD < MOB_TOUCH_RANGE) {
          const last = ai.lastTouchAt.get(t.id) ?? 0;
          if (now - last >= MOB_TOUCH_DMG_COOLDOWN_MS) {
            ai.lastTouchAt.set(t.id, now);
            // 割合軽減（上限付）: 被ダメ = 敵atk × 100/(100+def)、最小1
            const dmg = Math.max(1, Math.round(m.atk * (100 / (100 + Math.max(0, t.def)))));
            t.hp = Math.max(0, t.hp - dmg);
            if (t.hp <= 0) this.killPlayer(t, now);
          }
        }
      } else {
        // ランダムウォーク
        if (now >= ai.retargetAt || Math.hypot(ai.targetX - m.x, ai.targetY - m.y) < 8) {
          ai.targetX = 80 + Math.random() * (this.state.mapWidth - 160);
          ai.targetY = 80 + Math.random() * (this.state.mapHeight - 160);
          ai.retargetAt = now + 2000 + Math.random() * 3000;
        }
        const dx = ai.targetX - m.x, dy = ai.targetY - m.y;
        const d = Math.hypot(dx, dy) || 1;
        m.dir = Math.atan2(dy, dx);
        m.x += (dx / d) * spd * 0.6 * dt;
        m.y += (dy / d) * spd * 0.6 * dt;
      }
      this.clampToMap(m);
    });

    // 通常mobの補充＋ボスの出現（ボスは最下層のみ）
    if (this.countAliveMobs() < MOB_TARGET_COUNT) this.spawnMob();
    if (this.hasBoss && !this.bossAlive() && now >= this.nextBossAt) this.spawnMob("boss");

    // 霊宝ノード：拾得判定（サーバー権威）＋補充
    this.state.relics.forEach((r, rid) => {
      let picker: MmoPlayer | null = null;
      this.state.players.forEach((p) => {
        if (picker || p.dead) return;
        if (!this.profileIds.get(p.id)) return; // ログイン者のみ拾得
        if (Math.hypot(p.x - r.x, p.y - r.y) <= RELIC_PICKUP_RANGE) picker = p;
      });
      if (picker) {
        this.state.relics.delete(rid);   // 即削除＝二重取得防止
        this.grantRelic(picker);          // 在庫から払い出し（async）
      }
    });
    if (this.state.relics.size < RELIC_TARGET && now >= this.lastRelicSpawnAt) {
      this.spawnRelic();
      this.lastRelicSpawnAt = now + RELIC_SPAWN_COOLDOWN_MS;
    }
    // 宝箱：補充（開封は openTreasure メッセージで）
    if (this.state.treasures.size < TREASURE_TARGET && now >= this.lastTreasureSpawnAt) {
      this.spawnTreasure();
      this.lastTreasureSpawnAt = now + TREASURE_SPAWN_COOLDOWN_MS;
    }
    } // isField（狩場のみ）

    // プレイ時間を更新（整数秒なので変化は毎秒1回＝差分送信は軽い）
    this.state.players.forEach((p) => {
      const rt = this.statsRt.get(p.id);
      if (rt) p.playSec = Math.floor(rt.basePlaySec + (now - rt.sessionStartMs) / 1000);
    });
    // 60秒ごとに全員ぶんを保存＋プレイ時間系の達成判定
    if (now - this.lastPersistAt > 60000) {
      this.lastPersistAt = now;
      this.state.players.forEach((p) => { this.persistStats(p); this.evalAchievements(p); });
    }
  }

  private spawnRelic() {
    const r = new Relic();
    r.id = `relic_${this.relicSeq++}`;
    this.placeRandomly(r);
    this.state.relics.set(r.id, r);
  }

  private spawnTreasure() {
    const t = new Treasure();
    t.id = `treasure_${this.treasureSeq++}`;
    this.placeRandomly(t);
    this.state.treasures.set(t.id, t);
  }

  // 宝箱を開ける（サーバー権威で近接判定）。バフ薬1個＋ゴールドを付与。
  private openTreasure(sid: string, id: string) {
    const p = this.state.players.get(sid);
    const t = this.state.treasures.get(id);
    if (!p || p.dead || !t) return;
    if (Math.hypot(p.x - t.x, p.y - t.y) > TREASURE_OPEN_RANGE) return; // 範囲外
    this.state.treasures.delete(id); // 即削除＝二重開封防止
    const itemId = BUFF_TREASURE_ITEMS[Math.floor(Math.random() * BUFF_TREASURE_ITEMS.length)];
    this.addItem(p, itemId);
    const gold = 30 + this.floor * 20 + Math.floor(Math.random() * 20);
    p.gold += gold;
    this.clients.find((c) => c.sessionId === sid)?.send("treasureOpened", { itemId, gold });
    this.persistStats(p);
  }

  private countAliveMobs(): number {
    let n = 0;
    this.state.mobs.forEach((m) => { if (m.alive && m.kind !== "boss") n++; });
    return n;
  }

  private moveEntity(e: { x: number; y: number; vx: number; vy: number }, dt: number) {
    // 軸分離で動かす（壁ずりできる）。障害物が無いエリア(狩場)では素通り
    if (e.vx !== 0) e.x = this.collideAxis(e.x + e.vx * dt, e.y, e.vx > 0, true);
    if (e.vy !== 0) e.y = this.collideAxis(e.x, e.y + e.vy * dt, e.vy > 0, false);
    this.clampToMap(e);
  }

  // 移動先(x,y)を障害物(半径ENTITY_RADIUS膨張)から押し戻し、移動軸の座標を返す
  private collideAxis(x: number, y: number, positive: boolean, isX: boolean): number {
    const R = ENTITY_RADIUS;
    for (const o of this.obstacles) {
      const x0 = o.x - R, y0 = o.y - R, x1 = o.x + o.w + R, y1 = o.y + o.h + R;
      if (x > x0 && x < x1 && y > y0 && y < y1) {
        if (isX) x = positive ? x0 : x1;
        else y = positive ? y0 : y1;
      }
    }
    return isX ? x : y;
  }

  // 障害物に重ならない座標を返す（初期配置・リスポーン用）
  private isBlocked(x: number, y: number): boolean {
    for (const o of this.obstacles) {
      if (x > o.x - ENTITY_RADIUS && x < o.x + o.w + ENTITY_RADIUS &&
          y > o.y - ENTITY_RADIUS && y < o.y + o.h + ENTITY_RADIUS) return true;
    }
    return false;
  }

  private clampToMap(e: { x: number; y: number }) {
    e.x = Math.max(ENTITY_RADIUS, Math.min(this.state.mapWidth - ENTITY_RADIUS, e.x));
    e.y = Math.max(ENTITY_RADIUS, Math.min(this.state.mapHeight - ENTITY_RADIUS, e.y));
  }

  // --- 戦闘 ---

  private resolvePlayerAttack(attacker: MmoPlayer) {
    const fx = Math.cos(attacker.dir);
    const fy = Math.sin(attacker.dir);

    let bestId: string | null = null;
    let bestScore = Infinity;
    this.state.mobs.forEach((m, id) => {
      if (!m.alive) return;
      const dx = m.x - attacker.x;
      const dy = m.y - attacker.y;
      const forward = dx * fx + dy * fy;
      const side = Math.abs(-dx * fy + dy * fx);
      if (forward <= 0 || forward > ATTACK_RANGE) return;
      if (side > ATTACK_HALF_WIDTH) return;
      const score = forward + side * 0.5;
      if (score < bestScore) { bestScore = score; bestId = id; }
    });

    if (!bestId) return;
    const mob = this.state.mobs.get(bestId)!;
    const now = Date.now();
    const atk = attacker.atk * (now < attacker.buffAtkUntil ? ATK_BUFF_MUL : 1); // 力の薬バフ
    mob.hp -= atk;
    mob.hitUntil = now + 150;
    if (mob.hp <= 0) this.onMobKilled(attacker, bestId, mob);
  }

  private onMobKilled(attacker: MmoPlayer, mobId: string, mob: Mob) {
    attacker.kills += 1; // 討伐数（表示用・ログイン者は永続）
    const def = MOB_KINDS[mob.kind] ?? MOB_KINDS.grunt;
    // ゴールド獲得（強敵・深層ほど多い）
    attacker.gold += Math.max(1, Math.round((2 + this.floor * 2) * def.expMul));
    // 巻物ドロップ（霊宝とは別枠。バフ薬は宝箱から）
    if (Math.random() < SCROLL_DROP_CHANCE) {
      const itemId = pickDropItem();
      this.addItem(attacker, itemId);
      this.clients.find((c) => c.sessionId === attacker.id)?.send("itemFound", { id: itemId });
    }
    // EXP 付与（種別倍率）
    const gain = Math.round((5 + mob.level * 3) * def.expMul);
    const oldLevel = attacker.level;
    attacker.exp += gain;
    while (attacker.exp >= attacker.nextExp) {
      attacker.exp -= attacker.nextExp;
      attacker.level += 1;
      attacker.nextExp = nextExpFor(attacker.level);
    }
    if (attacker.level > oldLevel) this.recalcStats(attacker, true); // 巻物ボーナス込みで再計算＋全回復
    if (attacker.level > oldLevel) this.persistStats(attacker); // レベルアップ時に保存
    // mob 消滅（次tickで補充）
    this.state.mobs.delete(mobId);
    this.mobAI.delete(mobId);
    if (mob.kind === "boss") this.nextBossAt = Date.now() + BOSS_RESPAWN_MS;

    // 霊宝ドロップ（種別のドロップ率・レア寄せで在庫から払い出し）
    this.tryRelicDrop(attacker, def);
    this.tryEquipDrop(attacker);     // 装備の低確率ドロップ（無限供給）
    this.progressQuests(attacker, mob.kind); // 受注中クエストの進捗（討伐系）
    this.evalAchievements(attacker); // 討伐数・レベル系の達成判定
  }

  // 受注中クエストの進捗を進める。対象種別の討伐で remaining を1減らし、0で達成(done)へ。
  private progressQuests(p: MmoPlayer, mobKind: string) {
    const rt = this.statsRt.get(p.id);
    if (!rt) return;
    const client = this.clients.find((c) => c.sessionId === p.id);
    let changed = false;
    let completed = false;
    for (const a of rt.quests.active) {
      const def = QUEST_BY_ID[a.id];
      if (!def || a.remaining <= 0) continue;
      const match = def.goal.type === "killAny"
        || (def.goal.type === "killKind" && def.goal.kind === mobKind);
      if (!match) continue;
      a.remaining -= 1;
      changed = true;
      if (a.remaining <= 0) {
        rt.quests.done.add(a.id);
        completed = true;
        client?.send("questDone", { id: a.id, name: def.name });
      }
    }
    if (!changed) return;
    // 達成したものは active から除去
    if (completed) rt.quests.active = rt.quests.active.filter((a) => a.remaining > 0);
    this.persistStats(p);
    client?.send("questState", this.questStatePayload(rt.quests));
  }

  // クライアントへ返すクエスト状態（active の残り＋達成/受取済み）。
  private questStatePayload(q: QuestRt) {
    return {
      active: q.active.map((a) => ({ id: a.id, remaining: a.remaining })),
      done: [...q.done],
      claimed: [...q.claimed],
    };
  }

  // クエストを受注（上限3・重複/達成中/受取済み(一回限り)は不可）。
  private acceptQuest(sessionId: string, id: string) {
    const p = this.state.players.get(sessionId);
    const rt = this.statsRt.get(sessionId);
    const def = QUEST_BY_ID[id];
    if (!p || !rt || !def) return;
    if (rt.quests.active.some((a) => a.id === id)) return;     // 受注中
    if (rt.quests.done.has(id)) return;                        // 達成・報告待ち
    if (!def.repeatable && rt.quests.claimed.has(id)) return;  // 一回限りで受取済み
    if (rt.quests.active.length >= MAX_ACTIVE_QUESTS) return;   // 上限
    rt.quests.active.push({ id, remaining: def.goal.count });
    this.persistStats(p);
    this.clients.find((c) => c.sessionId === sessionId)?.send("questState", this.questStatePayload(rt.quests));
  }

  // 達成済みクエストを報告して報酬を受け取る。
  private claimQuest(sessionId: string, id: string) {
    const p = this.state.players.get(sessionId);
    const rt = this.statsRt.get(sessionId);
    const def = QUEST_BY_ID[id];
    if (!p || !rt || !def) return;
    if (!rt.quests.done.has(id)) return;                       // 達成していない
    rt.quests.done.delete(id);                                 // 先に除去（多重受取防止）
    if (def.repeatable) rt.quests.claimed.delete(id);          // 繰り返し：再受注可能に
    else rt.quests.claimed.add(id);                            // 一回限り：受取済みとして固定
    this.grantQuestReward(p, def);
    this.persistStats(p);
    this.clients.find((c) => c.sessionId === sessionId)?.send("questState", this.questStatePayload(rt.quests));
  }

  // クエスト報酬を付与（ゴールド/アイテム/霊宝。すべて既存の付与処理を流用）。
  private grantQuestReward(p: MmoPlayer, def: QuestDef) {
    const client = this.clients.find((c) => c.sessionId === p.id);
    const r = def.reward;
    if (r.gold) p.gold += r.gold;
    if (r.item && ITEMS[r.item.id]) this.addItem(p, r.item.id, r.item.n);
    if (r.relic) this.grantRelic(p, r.rareBias ?? 0); // 在庫から霊宝（relicFound 通知＋蒐集更新は grantRelic 内）
    client?.send("questReward", {
      id: def.id, name: def.name,
      gold: r.gold ?? 0,
      item: r.item ? { id: r.item.id, n: r.item.n } : null,
      relic: !!r.relic,
    });
  }

  // mob討伐：種別のドロップ率で霊宝ドロップ（強敵ほど高確率＆レア寄り）。
  private tryRelicDrop(attacker: MmoPlayer, def: MobKindDef) {
    if (Math.random() >= def.drop) return;
    this.grantRelic(attacker, Math.min(1, def.rareBias + this.floorRareBias)); // 深い階ほどレア寄り
  }

  // mob討伐：低確率で装備をドロップ（gear へ。無限供給・保存則とは無関係）。
  private tryEquipDrop(attacker: MmoPlayer) {
    if (EQUIP_DROP_ITEMS.length === 0) return;
    if (Math.random() >= EQUIP_DROP_CHANCE) return;
    const id = pickDropEquip();
    this.addGear(attacker, id);
    const client = this.clients.find((c) => c.sessionId === attacker.id);
    client?.send("equipFound", { id, name: EQUIP[id]?.name ?? id });
    this.persistStats(attacker);
  }

  private addItem(p: MmoPlayer, id: string, n = 1) {
    p.items.set(id, (p.items.get(id) ?? 0) + n);
  }

  private addGear(p: MmoPlayer, id: string, n = 1) {
    p.gear.set(id, (p.gear.get(id) ?? 0) + n);
  }

  // レベル由来 + 巻物ボーナスから atk/maxHp/def を再計算。
  // healFull=true で全回復、それ以外は現HPを上限内に収める。
  private recalcStats(p: MmoPlayer, healFull = false) {
    // 装備中ギアの補正を合算（無限供給。霊宝の保存則とは無関係）
    let eqAtk = 0, eqDef = 0, eqHp = 0;
    p.equip.forEach((id) => {
      const d = EQUIP[id];
      if (d) { eqAtk += d.atk ?? 0; eqDef += d.def ?? 0; eqHp += d.maxHp ?? 0; }
    });
    p.maxHp = maxHpFor(p.level) + p.bonusMaxHp + eqHp;
    p.atk = atkFor(p.level) + p.bonusAtk + eqAtk;
    p.def = 1 + p.bonusDef + eqDef;
    p.hp = healFull ? p.maxHp : Math.min(p.hp, p.maxHp);
  }

  // アイテム使用（サーバー権威）。回復はHP回復、バフは一定時間有効化、巻物は恒久ステアップ。
  private useItem(sid: string, id: string) {
    const p = this.state.players.get(sid);
    const def = ITEMS[id];
    if (!p || p.dead || !def) return;
    if ((p.items.get(id) ?? 0) <= 0) return;
    const now = Date.now();
    if (def.kind === "heal") {
      if (p.hp >= p.maxHp) return; // 満タンなら消費しない
      p.hp = Math.min(p.maxHp, p.hp + def.value);
    } else if (def.kind === "buffAtk") {
      p.buffAtkUntil = now + (def.durationMs ?? 0);
    } else if (def.kind === "buffSpeed") {
      p.buffSpeedUntil = now + (def.durationMs ?? 0);
    } else if (def.kind === "perm") {
      if (def.stat === "atk") p.bonusAtk += def.value;
      else if (def.stat === "def") p.bonusDef += def.value;
      else if (def.stat === "maxHp") p.bonusMaxHp += def.value;
      const wasFull = p.hp >= p.maxHp;
      this.recalcStats(p, false);
      if (def.stat === "maxHp" && wasFull) p.hp = p.maxHp; // HP上限が増えた分も埋める
    }
    const left = (p.items.get(id) ?? 0) - 1;
    if (left <= 0) p.items.delete(id); else p.items.set(id, left);
    this.persistStats(p);
  }

  // アイテム/装備の売却（所持を1つ減らし sell 分のゴールドを得る）。装備は未装備分(gear)から。
  private sellItem(sid: string, id: string) {
    const p = this.state.players.get(sid);
    if (!p) return;
    const eq = EQUIP[id];
    if (eq) {
      if (!eq.sell || (p.gear.get(id) ?? 0) <= 0) return;
      const left = (p.gear.get(id) ?? 0) - 1;
      if (left <= 0) p.gear.delete(id); else p.gear.set(id, left);
      p.gold += eq.sell;
      this.persistStats(p);
      return;
    }
    const def = ITEMS[id];
    if (!def || !def.sell) return;
    if ((p.items.get(id) ?? 0) <= 0) return;
    const left = (p.items.get(id) ?? 0) - 1;
    if (left <= 0) p.items.delete(id); else p.items.set(id, left);
    p.gold += def.sell;
    this.persistStats(p);
  }

  // アイテム/装備の購入。ゴールド消費。装備は gear へ加算。
  private buyItem(sid: string, id: string) {
    const p = this.state.players.get(sid);
    if (!p) return;
    const eq = EQUIP[id];
    if (eq) {
      if (!eq.price || p.gold < eq.price) return;
      p.gold -= eq.price;
      this.addGear(p, id);
      this.persistStats(p);
      return;
    }
    const def = ITEMS[id];
    if (!def || !def.price) return;
    if (p.gold < def.price) return;
    p.gold -= def.price;
    this.addItem(p, id);
    this.persistStats(p);
  }

  // 装備を装着（所持ギアをスロットへ。同スロットに既装備があれば gear へ戻す）。
  private equipItem(sid: string, id: string) {
    const p = this.state.players.get(sid);
    const def = EQUIP[id];
    if (!p || !def) return;
    if ((p.gear.get(id) ?? 0) <= 0) return;
    const prev = p.equip.get(def.slot);
    if (prev) this.addGear(p, prev);            // 既装備を所持へ戻す
    const left = (p.gear.get(id) ?? 0) - 1;
    if (left <= 0) p.gear.delete(id); else p.gear.set(id, left);
    p.equip.set(def.slot, id);
    const wasFull = p.hp >= p.maxHp;
    this.recalcStats(p, false);
    if (wasFull) p.hp = p.maxHp;                // maxHp上昇分を埋める
    this.persistStats(p);
  }

  // 装備を外す（スロットの装備を所持ギアへ戻す）。
  private unequipItem(sid: string, slot: string) {
    const p = this.state.players.get(sid);
    if (!p) return;
    const cur = p.equip.get(slot);
    if (!cur) return;
    this.addGear(p, cur);
    p.equip.delete(slot);
    this.recalcStats(p, false);                 // maxHp低下時は現HPを上限内に丸める
    this.persistStats(p);
  }

  // 在庫から霊宝を1枚そのプレイヤーの所有へ払い出し、本人に通知する。
  // 在庫・保存則の更新は explore_pull_for（service_role）に閉じ込める。rareBias=希少寄せ(0-1)。
  private grantRelic(player: MmoPlayer, rareBias = 0) {
    const profileId = this.profileIds.get(player.id);
    if (!profileId || !isSupabaseConfigured) return;     // ゲストは払い出し無し
    const client = this.clients.find((c) => c.sessionId === player.id);
    void (async () => {
      try {
        const { data, error } = await supabaseAdmin.rpc("explore_pull_for", {
          p_profile: profileId, p_season: 1, p_rare_bias: rareBias,
        });
        if (error) { console.warn("[mmo] 払い出し失敗:", error.message); return; }
        if (data == null) return;                          // 在庫切れ
        client?.send("relicFound", { cardId: data as number });
        void this.refreshCollectedAndEval(player); // 蒐集が増えたかも→達成判定
      } catch (e: any) {
        console.warn("[mmo] 払い出し例外:", e?.message ?? e);
      }
    })();
  }

  private killPlayer(p: MmoPlayer, now: number) {
    p.dead = true;
    p.hp = 0;
    p.vx = 0; p.vy = 0;
    p.respawnAt = now + PLAYER_RESPAWN_DELAY_MS;
  }
}
