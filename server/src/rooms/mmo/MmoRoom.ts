import { Room, Client } from "colyseus";
import { MmoState, MmoPlayer, Mob, Relic, Gate } from "../../schema/MmoState";
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
];

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
  grunt:    { name: "迷い霊",   maxHp: 50,  atk: 7,  speed: 62,  expMul: 1.0, drop: 0.45, rareBias: 0 },
  swift:    { name: "妖蝙蝠",   maxHp: 30,  atk: 6,  speed: 104, expMul: 1.2, drop: 0.45, rareBias: 0 },
  tank:     { name: "岩石巨人", maxHp: 150, atk: 12, speed: 38,  expMul: 2.2, drop: 0.75, rareBias: 0.5 },
  brute:    { name: "紅蓮鬼",   maxHp: 95,  atk: 16, speed: 58,  expMul: 1.8, drop: 0.6,  rareBias: 0.3 },
  // 追加5種
  slime:    { name: "泥スライム", maxHp: 36, atk: 6,  speed: 50,  expMul: 0.9, drop: 0.40, rareBias: 0 },
  spider:   { name: "毒蜘蛛",   maxHp: 55,  atk: 10, speed: 90,  expMul: 1.4, drop: 0.5,  rareBias: 0.1 },
  skeleton: { name: "骸骨剣士", maxHp: 82,  atk: 13, speed: 60,  expMul: 1.6, drop: 0.55, rareBias: 0.2 },
  scorpion: { name: "砂蠍",     maxHp: 120, atk: 14, speed: 46,  expMul: 2.0, drop: 0.7,  rareBias: 0.4 },
  serpent:  { name: "大蛇",     maxHp: 100, atk: 17, speed: 84,  expMul: 2.0, drop: 0.65, rareBias: 0.35 },
  boss:     { name: "災厄の主", maxHp: 480, atk: 24, speed: 48,  expMul: 6.0, drop: 1.0,  rareBias: 1.0 },
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
  private nextBossAt = 0;
  private lastTick = 0;
  // 霊宝の所有を保存する先＝Supabaseのアカウント。sessionId -> profile_id（ゲストは null）
  private profileIds = new Map<string, string | null>();
  // プレイ時間/達成の算出用ランタイム
  private statsRt = new Map<string, {
    basePlaySec: number; sessionStartMs: number;
    claimed: Set<string>; collected: number;
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
    if (profileId && isSupabaseConfigured) {
      const s = await loadGameStats(profileId, SPIRIT_GAME_KEY);
      if (s) {
        if (typeof s.level === "number" && s.level >= 1) {
          p.level = s.level;
          p.exp = typeof s.exp === "number" ? s.exp : 0;
          p.nextExp = nextExpFor(p.level);
          p.maxHp = maxHpFor(p.level);
          p.atk = atkFor(p.level);
          p.hp = p.maxHp;
        }
        p.kills = typeof s.kills === "number" ? s.kills : 0;
        basePlaySec = typeof s.playSec === "number" ? s.playSec : 0;
        claimed = Array.isArray(s.claimed) ? s.claimed : [];
      }
    }
    p.playSec = Math.floor(basePlaySec);
    this.statsRt.set(client.sessionId, {
      basePlaySec, sessionStartMs: Date.now(), claimed: new Set(claimed), collected: 0,
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
      p.vx = dx * PLAYER_SPEED;
      p.vy = dy * PLAYER_SPEED;
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
            t.hp = Math.max(0, t.hp - m.atk);
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
    mob.hp -= attacker.atk;
    mob.hitUntil = now + 150;
    if (mob.hp <= 0) this.onMobKilled(attacker, bestId, mob);
  }

  private onMobKilled(attacker: MmoPlayer, mobId: string, mob: Mob) {
    attacker.kills += 1; // 討伐数（表示用・ログイン者は永続）
    const def = MOB_KINDS[mob.kind] ?? MOB_KINDS.grunt;
    // EXP 付与（種別倍率）
    const gain = Math.round((5 + mob.level * 3) * def.expMul);
    const oldLevel = attacker.level;
    attacker.exp += gain;
    while (attacker.exp >= attacker.nextExp) {
      attacker.exp -= attacker.nextExp;
      attacker.level += 1;
      attacker.maxHp += 20;
      attacker.atk += 3;
      attacker.hp = attacker.maxHp; // レベルアップで全回復
      attacker.nextExp = 20 + (attacker.level - 1) * 15;
    }
    if (attacker.level > oldLevel) this.persistStats(attacker); // レベルアップ時に保存
    // mob 消滅（次tickで補充）
    this.state.mobs.delete(mobId);
    this.mobAI.delete(mobId);
    if (mob.kind === "boss") this.nextBossAt = Date.now() + BOSS_RESPAWN_MS;

    // 霊宝ドロップ（種別のドロップ率・レア寄せで在庫から払い出し）
    this.tryRelicDrop(attacker, def);
    this.evalAchievements(attacker); // 討伐数・レベル系の達成判定
  }

  // mob討伐：種別のドロップ率で霊宝ドロップ（強敵ほど高確率＆レア寄り）。
  private tryRelicDrop(attacker: MmoPlayer, def: MobKindDef) {
    if (Math.random() >= def.drop) return;
    this.grantRelic(attacker, Math.min(1, def.rareBias + this.floorRareBias)); // 深い階ほどレア寄り
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
