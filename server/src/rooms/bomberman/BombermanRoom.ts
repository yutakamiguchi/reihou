import { Room, Client } from "colyseus";
import {
  BombermanState, BPlayer, Bomb, Flame, Item, SoftBlock,
} from "../../schema/BombermanState";
import { canStartRound } from "../phase";
import { getMapById, pickRandomMap, type BombermanMap } from "./maps";

const TICK_RATE = 30;
const NUM_COLORS = 8;
const BOMB_FUSE_MS = 2500;
const FLAME_MS = 500;
const BASE_SPEED = 144;       // px/sec（=3セル/秒, tileSize48）
const SPEED_PER_LEVEL = 0.22; // speed スタック1段あたりの加速率
const SOFT_BLOCK_RATIO = 0.72; // 空きセルに soft を置く確率
const ITEM_DROP_CHANCE = 0.32;
const SNAP_EPS = 2;           // セル中心への到達判定（px）
const FIXED_DT = 1 / TICK_RATE; // 移動は固定タイムステップで進める（予測と一致させる）
const MAX_STEPS = 5;          // 1updateで消化する最大固定ステップ数（暴走防止）

const MAX_SLOTS = 4;          // プレイヤー＋CPU の合計上限
const BOT_THINK_MS = 220;     // CPU が方針を再考する間隔
const BOT_NAMES = ["CPU-A", "CPU-B", "CPU-C", "CPU-D"];

interface BInput { up: boolean; down: boolean; left: boolean; right: boolean; seq: number; }
interface BMove { targetCol: number; targetRow: number; } // 移動中の目標セル（サーバー内部のみ）

// CPU の思考状態（サーバー内部のみ）
interface BotState {
  nextThinkAt: number;
  plan: Array<{ col: number; row: number }>; // 目標セルまでの経路
  wantBomb: boolean;
}

export class BombermanRoom extends Room<BombermanState> {
  maxClients = 4;
  private inputs = new Map<string, BInput>();
  private moves = new Map<string, BMove | null>();
  private bots = new Map<string, BotState>();
  // ワープ対のキャッシュ（key=`col_row` → 相手セル）。startRound/onCreate で tiles から構築。
  private warpPairs = new Map<string, { col: number; row: number }>();
  private botSeq = 0;
  private lastTick = 0;
  private roundEndsAt = 0;
  private bombSeq = 0;
  private flameSeq = 0;
  private itemSeq = 0;
  private accumulator = 0; // 固定タイムステップ用の時間アキュムレータ

  onCreate(options: { code?: string }) {
    this.setState(new BombermanState());
    this.state.code = (options?.code || "").slice(0, 8);
    if (this.state.code !== "") this.setPrivate(true);
    this.applyMap(getMapById("classic")!); // 既定マップを反映（tiles/cols/rows/warpPairs 構築）
    this.generateMap();

    this.onMessage("input", (client, message: Partial<BInput>) => {
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      inp.up = !!message.up;
      inp.down = !!message.down;
      inp.left = !!message.left;
      inp.right = !!message.right;
      // 受信した最新の入力シーケンス番号（reconcile の基準。人間プレイヤーのみ送ってくる）
      if (typeof message.seq === "number" && message.seq > inp.seq) inp.seq = message.seq;
    });

    this.onMessage("placeBomb", (client) => {
      this.tryPlaceBomb(client.sessionId);
    });

    this.onMessage("ready", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.ready = true;
      this.maybeStartRound();
    });

    // マップ選択（ロビー中のみ／既存の＋CPU等に倣い誰でも変更可）。
    this.onMessage("selectMap", (_client, message: { mapId?: string }) => {
      if (this.state.phase !== "lobby") return;
      const id = message?.mapId || "";
      if (id !== "random" && !getMapById(id)) return; // 不正IDは無視
      this.state.mapId = id;
      // random はプレビュー不可なので tiles は据え置き。具象マップならプレビュー反映。
      if (id !== "random") this.applyMap(getMapById(id)!);
    });

    this.onMessage("addBot", () => {
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size >= MAX_SLOTS) return;
      this.addBot();
    });

    this.onMessage("removeBot", () => {
      if (this.state.phase !== "lobby") return;
      // 末尾の bot を1体削除
      let target: string | null = null;
      this.state.players.forEach((p, id) => { if (p.isBot) target = id; });
      if (target) this.removePlayerId(target);
    });

    this.setSimulationInterval((dt) => this.update(dt), 1000 / TICK_RATE);
    this.lastTick = Date.now();
  }

  onJoin(client: Client, options: { name?: string }) {
    const p = new BPlayer();
    p.name = (options?.name || "Player").slice(0, 16);
    p.entityId = client.sessionId;
    p.colorIndex = Math.floor(Math.random() * NUM_COLORS);
    p.playerNo = this.nextPlayerNo();
    const spawn = this.spawnCellFor(p.playerNo - 1);
    this.placePlayerAtCell(p, spawn.col, spawn.row);
    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false, seq: 0 });
    this.moves.set(client.sessionId, null);
  }

  onLeave(client: Client) {
    this.removePlayerId(client.sessionId);
  }

  // 空いている最小のプレイヤー番号(1〜4)を返す。退出で空けば再利用される。
  private nextPlayerNo(): number {
    const used = new Set<number>();
    this.state.players.forEach((p) => used.add(p.playerNo));
    for (let n = 1; n <= MAX_SLOTS; n++) if (!used.has(n)) return n;
    return 1;
  }

  // 人間・CPU 共通の退出処理。
  private removePlayerId(id: string) {
    this.state.players.delete(id);
    this.inputs.delete(id);
    this.moves.delete(id);
    this.bots.delete(id);
  }

  // CPU を1体追加する。
  private addBot() {
    const id = `bot_${this.botSeq++}`;
    const p = new BPlayer();
    const botCount = Array.from(this.state.players.values()).filter(b => b.isBot).length;
    p.name = BOT_NAMES[botCount % BOT_NAMES.length];
    p.entityId = id;
    p.isBot = true;
    p.ready = true; // CPU は常に準備OK
    p.colorIndex = Math.floor(Math.random() * NUM_COLORS);
    p.playerNo = this.nextPlayerNo();
    const spawn = this.spawnCellFor(p.playerNo - 1);
    this.placePlayerAtCell(p, spawn.col, spawn.row);
    this.state.players.set(id, p);
    this.inputs.set(id, { up: false, down: false, left: false, right: false, seq: 0 });
    this.moves.set(id, null);
    this.bots.set(id, { nextThinkAt: 0, plan: [], wantBomb: false });
  }

  // --- マップ生成 ---

  // プリセットマップの tiles/cols/rows を state に反映＋ワープ対を構築する。
  // mapId（選択状態。"random"含む）はここでは触らない（呼び出し側が管理）。
  private applyMap(map: BombermanMap) {
    this.state.cols = map.cols;
    this.state.rows = map.rows;
    this.state.tiles = map.tiles;
    this.buildWarpPairs(map);
  }

  // 指定セルの tiles 文字（'#'壁 / '.'床 / '^v<>'ベルト / '0-9'ワープ）。範囲外は壁扱い。
  private tileAt(col: number, row: number): string {
    const { cols, rows, tiles } = this.state;
    if (col < 0 || row < 0 || col >= cols || row >= rows) return "#";
    if (tiles.length !== cols * rows) return ".";
    return tiles.charAt(row * cols + col);
  }

  // ベルト文字 → 移動量と向き（dir: 0下/1左/2右/3上）。ベルトでなければ null。
  private beltDir(ch: string): { dc: number; dr: number; dir: number } | null {
    switch (ch) {
      case "^": return { dc: 0, dr: -1, dir: 3 };
      case "v": return { dc: 0, dr: 1, dir: 0 };
      case "<": return { dc: -1, dr: 0, dir: 1 };
      case ">": return { dc: 1, dr: 0, dir: 2 };
      default: return null;
    }
  }

  // セル到達時のワープ処理。ワープ上かつ未ワープなら対へテレポート（justWarpedで跳ね返り防止）。
  private handleWarp(p: BPlayer) {
    const here = this.tileAt(p.col, p.row);
    if (here >= "0" && here <= "9") {
      if (!p.justWarped) {
        const pair = this.warpPairs.get(cellKey(p.col, p.row));
        if (pair) {
          p.col = pair.col; p.row = pair.row;
          p.x = pair.col * this.state.tileSize + this.state.tileSize / 2;
          p.y = pair.row * this.state.tileSize + this.state.tileSize / 2;
          p.justWarped = true;
        }
      }
    } else {
      p.justWarped = false; // ワープ外に出たら再ワープ可能に戻す
    }
  }

  // tiles 中の数字（同じ数字が2個で1対）からワープ対応表を作る。
  private buildWarpPairs(map: BombermanMap) {
    this.warpPairs.clear();
    const byChar = new Map<string, Array<{ col: number; row: number }>>();
    for (let row = 0; row < map.rows; row++) {
      for (let col = 0; col < map.cols; col++) {
        const ch = map.tiles.charAt(row * map.cols + col);
        if (ch >= "0" && ch <= "9") {
          if (!byChar.has(ch)) byChar.set(ch, []);
          byChar.get(ch)!.push({ col, row });
        }
      }
    }
    for (const cells of byChar.values()) {
      if (cells.length === 2) {
        const [a, b] = cells;
        this.warpPairs.set(cellKey(a.col, a.row), b);
        this.warpPairs.set(cellKey(b.col, b.row), a);
      }
    }
  }

  private isHardWall(col: number, row: number): boolean {
    const { cols, rows } = this.state;
    if (col <= 0 || row <= 0 || col >= cols - 1 || row >= rows - 1) return true;
    return col % 2 === 0 && row % 2 === 0;
  }

  // 四隅スポーン地点とその L 字（隣接2セル）は soft を置かない
  private isSpawnSafe(col: number, row: number): boolean {
    const { cols, rows } = this.state;
    const corners = [
      [1, 1], [2, 1], [1, 2],
      [cols - 2, 1], [cols - 3, 1], [cols - 2, 2],
      [1, rows - 2], [2, rows - 2], [1, rows - 3],
      [cols - 2, rows - 2], [cols - 3, rows - 2], [cols - 2, rows - 3],
    ];
    return corners.some(([c, r]) => c === col && r === row);
  }

  private generateMap() {
    this.state.softBlocks.clear();
    const { cols, rows } = this.state;
    for (let row = 1; row < rows - 1; row++) {
      for (let col = 1; col < cols - 1; col++) {
        if (this.tileAt(col, row) !== ".") continue; // 壁・ベルト・ワープには置かない
        if (this.isSpawnSafe(col, row)) continue;
        if (Math.random() < SOFT_BLOCK_RATIO) {
          const sb = new SoftBlock();
          sb.col = col; sb.row = row;
          this.state.softBlocks.set(cellKey(col, row), sb);
        }
      }
    }
  }

  private spawnCellFor(index: number): { col: number; row: number } {
    const { cols, rows } = this.state;
    const corners = [
      { col: 1, row: 1 },
      { col: cols - 2, row: rows - 2 },
      { col: cols - 2, row: 1 },
      { col: 1, row: rows - 2 },
    ];
    return corners[index % corners.length];
  }

  private placePlayerAtCell(p: BPlayer, col: number, row: number) {
    p.col = col; p.row = row;
    p.x = col * this.state.tileSize + this.state.tileSize / 2;
    p.y = row * this.state.tileSize + this.state.tileSize / 2;
  }

  // --- ラウンド進行 ---

  private maybeStartRound() {
    if (this.state.phase !== "lobby") return;
    if (!canStartRound(this.state.players)) return;
    this.startRound();
  }

  private startRound() {
    this.state.phase = "playing";
    this.state.timeLeft = this.state.roundDuration;
    this.roundEndsAt = Date.now() + this.state.roundDuration * 1000;
    this.state.bombs.clear();
    this.state.flames.clear();
    this.state.items.clear();

    // マップ確定（"random" はここで具象マップへ。mapId=選択状態は保持）
    const actual = this.state.mapId === "random"
      ? pickRandomMap()
      : (getMapById(this.state.mapId) ?? getMapById("classic")!);
    this.applyMap(actual);
    this.generateMap();

    let i = 0;
    this.state.players.forEach((p) => {
      const spawn = this.spawnCellFor(i++);
      this.placePlayerAtCell(p, spawn.col, spawn.row);
      p.alive = true;
      p.maxBombs = 1;
      p.activeBombs = 0;
      p.range = 1;
      p.speed = 1;
      p.justWarped = false;
      this.moves.set(p.entityId, null);
    });
  }

  private endRound() {
    this.state.phase = "ended";
    this.clock.setTimeout(() => {
      this.state.phase = "lobby";
      this.state.players.forEach(p => { p.ready = false; });
    }, 5000);
  }

  // --- 爆弾 ---

  private tryPlaceBomb(sid: string) {
    if (this.state.phase !== "playing") return;
    const p = this.state.players.get(sid);
    if (!p || !p.alive) return;
    if (p.activeBombs >= p.maxBombs) return;
    // 「今キャラが乗っているマス」に置く（移動中も見た目の立ち位置に一致）。
    // p.col/p.row は移動元のままになるため、現在のピクセル位置からセルを算出する。
    const ts = this.state.tileSize;
    const col = Math.max(0, Math.min(this.state.cols - 1, Math.floor(p.x / ts)));
    const row = Math.max(0, Math.min(this.state.rows - 1, Math.floor(p.y / ts)));
    if (this.bombAt(col, row)) return;
    const bomb = new Bomb();
    bomb.id = `b${this.bombSeq++}`;
    bomb.owner = sid;
    bomb.col = col; bomb.row = row;
    bomb.range = p.range;
    bomb.explodesAt = Date.now() + BOMB_FUSE_MS;
    this.state.bombs.set(bomb.id, bomb);
    p.activeBombs++;
  }

  private bombAt(col: number, row: number): Bomb | undefined {
    let found: Bomb | undefined;
    this.state.bombs.forEach((b) => { if (b.col === col && b.row === row) found = b; });
    return found;
  }

  // --- 1tick ---

  private update(_dt: number) {
    const now = Date.now();
    const frameDt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    if (this.state.phase !== "playing") {
      this.accumulator = 0; // ロビー等で溜めない（開始時の一気消化＝ワープ防止）
      return;
    }

    this.state.timeLeft = Math.max(0, (this.roundEndsAt - now) / 1000);

    // --- 移動・入力消費は固定タイムステップで（予測と完全一致させる） ---
    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      this.accumulator -= FIXED_DT;
      steps++;
      this.fixedStep(now);
    }
    // スパイク時（タブ停止/GC）に溜まりすぎた分は捨てる（巻き取りワープ防止）
    if (this.accumulator > FIXED_DT * MAX_STEPS) this.accumulator = 0;

    // 爆弾タイマー
    const toExplode: Bomb[] = [];
    this.state.bombs.forEach((b) => { if (now >= b.explodesAt) toExplode.push(b); });
    for (const b of toExplode) this.explode(b, now);

    // 炎の消滅
    const expiredFlames: string[] = [];
    this.state.flames.forEach((f, id) => { if (now >= f.until) expiredFlames.push(id); });
    for (const id of expiredFlames) this.state.flames.delete(id);

    // 被弾判定 & アイテム取得
    this.state.players.forEach((p) => {
      if (!p.alive) return;
      if (this.flameAt(p.col, p.row)) {
        p.alive = false;
        return;
      }
      this.pickupItem(p);
    });

    // 勝敗
    if (this.state.timeLeft <= 0) { this.endRound(); return; }
    const alive = Array.from(this.state.players.values()).filter(p => p.alive);
    if (this.state.players.size >= 2 && alive.length <= 1) {
      if (alive.length === 1) alive[0].score++;
      this.endRound();
    }
  }

  // 固定タイムステップ1回分: CPU思考 → 入力反映 → 全プレイヤー移動。
  private fixedStep(now: number) {
    this.state.players.forEach((p, sid) => {
      if (p.isBot && p.alive) this.thinkBot(p, sid, now);
    });
    this.state.players.forEach((p, sid) => this.movePlayer(p, sid, FIXED_DT));
  }

  private movePlayer(p: BPlayer, sid: string, dt: number) {
    if (!p.alive) return;
    const ts = this.state.tileSize;
    const inp = this.inputs.get(sid);
    const hasInput = !!(inp && (inp.up || inp.down || inp.left || inp.right));
    let mv = this.moves.get(sid) ?? null;

    // この固定ステップ時点で反映済みの入力seqを記録（reconcile基準。bot は seq=0）
    if (inp) p.lastSeq = inp.seq;

    // 移動中でなく、入力があれば次の目標セルを決める
    if (!mv && hasInput && inp) {
      let dc = 0, dr = 0, dir = p.dir;
      if (inp.up) { dr = -1; dir = 3; }
      else if (inp.down) { dr = 1; dir = 0; }
      else if (inp.left) { dc = -1; dir = 1; }
      else if (inp.right) { dc = 1; dir = 2; }
      if (dc !== 0 || dr !== 0) {
        const ncol = p.col + dc, nrow = p.row + dr;
        p.dir = dir;
        if (this.isPassable(ncol, nrow)) {
          mv = { targetCol: ncol, targetRow: nrow };
          this.moves.set(sid, mv);
        }
      }
    }

    // ベルト：入力が無く、ベルト上にいるなら矢印方向へ1マス（連続コンベア）。入力時はプレイヤー優先。
    if (!mv && !hasInput) {
      const b = this.beltDir(this.tileAt(p.col, p.row));
      if (b) {
        p.dir = b.dir;
        const ncol = p.col + b.dc, nrow = p.row + b.dr;
        if (this.isPassable(ncol, nrow)) {
          mv = { targetCol: ncol, targetRow: nrow };
          this.moves.set(sid, mv);
        }
      }
    }

    // 移動中状態を state にミラー（クライアントが reconcile で再現するため）
    p.moveTargetCol = mv ? mv.targetCol : -1;
    p.moveTargetRow = mv ? mv.targetRow : -1;

    // 移動中なら、入力が切れても目標セルまで進みきってから止まる（戻らない）
    if (!mv) return;

    // 目標セル中心へ移動
    const tx = mv.targetCol * ts + ts / 2;
    const ty = mv.targetRow * ts + ts / 2;
    const speed = BASE_SPEED * (1 + (p.speed - 1) * SPEED_PER_LEVEL);
    const step = speed * dt;
    const ddx = tx - p.x, ddy = ty - p.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist <= step + SNAP_EPS) {
      p.x = tx; p.y = ty;
      p.col = mv.targetCol; p.row = mv.targetRow;
      this.moves.set(sid, null); // 到達。次tickで次方向を受付
      p.moveTargetCol = -1; p.moveTargetRow = -1;
      this.handleWarp(p); // ワープ上ならテレポート
    } else {
      p.x += (ddx / dist) * step;
      p.y += (ddy / dist) * step;
    }
  }

  private isPassable(col: number, row: number): boolean {
    const { cols, rows } = this.state;
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    if (this.isHardWall(col, row)) return false;
    if (this.state.softBlocks.has(cellKey(col, row))) return false;
    if (this.bombAt(col, row)) return false;
    return true;
  }

  // --- 爆発 ---

  private explode(bomb: Bomb, now: number) {
    // 既に処理済み（誘爆で消えた）なら無視
    if (!this.state.bombs.has(bomb.id)) return;
    this.state.bombs.delete(bomb.id);
    const owner = this.state.players.get(bomb.owner);
    if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);

    this.addFlame(bomb.col, bomb.row, now);

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dc, dr] of dirs) {
      for (let i = 1; i <= bomb.range; i++) {
        const col = bomb.col + dc * i;
        const row = bomb.row + dr * i;
        if (this.isHardWall(col, row)) break;

        const key = cellKey(col, row);
        const sb = this.state.softBlocks.get(key);
        if (sb) {
          this.state.softBlocks.delete(key);
          this.addFlame(col, row, now);
          this.maybeDropItem(col, row);
          break; // soft ブロックで延焼停止
        }

        this.addFlame(col, row, now);

        // 誘爆: そのセルの別爆弾を即時起爆（次tickではなくこの場で連鎖）
        const other = this.bombAt(col, row);
        if (other) this.explode(other, now);
      }
    }
  }

  private addFlame(col: number, row: number, now: number) {
    const f = new Flame();
    f.id = `f${this.flameSeq++}`;
    f.col = col; f.row = row;
    f.until = now + FLAME_MS;
    this.state.flames.set(f.id, f);
  }

  private flameAt(col: number, row: number): boolean {
    let hit = false;
    this.state.flames.forEach((f) => { if (f.col === col && f.row === row) hit = true; });
    return hit;
  }

  private maybeDropItem(col: number, row: number) {
    if (Math.random() >= ITEM_DROP_CHANCE) return;
    const kinds = ["bomb", "fire", "speed"];
    const item = new Item();
    item.id = `i${this.itemSeq++}`;
    item.col = col; item.row = row;
    item.kind = kinds[Math.floor(Math.random() * kinds.length)];
    this.state.items.set(item.id, item);
  }

  private pickupItem(p: BPlayer) {
    let pickedId: string | null = null;
    let kind = "";
    this.state.items.forEach((it, id) => {
      if (pickedId) return;
      if (it.col === p.col && it.row === p.row) { pickedId = id; kind = it.kind; }
    });
    if (!pickedId) return;
    this.state.items.delete(pickedId);
    if (kind === "bomb") p.maxBombs++;
    else if (kind === "fire") p.range++;
    else if (kind === "speed") p.speed++;
  }

  // ===== CPU 思考 =====

  private thinkBot(p: BPlayer, sid: string, now: number) {
    const bot = this.bots.get(sid);
    if (!bot) return;
    const inp = this.inputs.get(sid)!;
    const moving = this.moves.get(sid) != null;

    // セル境界に乗っている時だけ方針転換（移動中は現在の1マスを進みきる）
    if (!moving && now >= bot.nextThinkAt) {
      bot.nextThinkAt = now + BOT_THINK_MS;
      this.decideBot(p, bot);
    }

    // 爆弾を置きたい & まだ移動を始めていない（=セル中心にいる）なら設置
    if (bot.wantBomb && !moving) {
      this.tryPlaceBomb(sid);
      bot.wantBomb = false;
      // 設置直後は逃げ経路を即再計算
      bot.plan = this.fleePath(p.col, p.row, true) ?? [];
    }

    // 経路の先頭セルへ1マス分の入力を出す
    this.driveAlongPlan(p, inp, bot);
  }

  // 危険マップ: 現在の炎＋起爆予定の爆弾の爆風が及ぶセルを true に。
  private buildDanger(extraBomb?: { col: number; row: number; range: number }): Set<string> {
    const danger = new Set<string>();
    this.state.flames.forEach((f) => danger.add(cellKey(f.col, f.row)));
    const addBlast = (bcol: number, brow: number, range: number) => {
      danger.add(cellKey(bcol, brow));
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dc, dr] of dirs) {
        for (let i = 1; i <= range; i++) {
          const col = bcol + dc * i, row = brow + dr * i;
          if (this.isHardWall(col, row)) break;
          danger.add(cellKey(col, row));
          if (this.state.softBlocks.has(cellKey(col, row))) break;
        }
      }
    };
    this.state.bombs.forEach((b) => addBlast(b.col, b.row, b.range));
    if (extraBomb) addBlast(extraBomb.col, extraBomb.row, extraBomb.range);
    return danger;
  }

  // 通行可能かつ（任意で）危険でないセルか
  private botWalkable(col: number, row: number): boolean {
    const { cols, rows } = this.state;
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    if (this.isHardWall(col, row)) return false;
    if (this.state.softBlocks.has(cellKey(col, row))) return false;
    if (this.bombAt(col, row)) return false;
    return true;
  }

  // BFS で start から、cond を満たすセルまでの最短経路（セル配列、start除く）を返す。
  private bfsTo(
    startCol: number, startRow: number,
    cond: (col: number, row: number) => boolean,
    avoid: Set<string>,
    maxDepth = 30,
  ): Array<{ col: number; row: number }> | null {
    const startKey = cellKey(startCol, startRow);
    const visited = new Set<string>([startKey]);
    const queue: Array<{ col: number; row: number; path: Array<{ col: number; row: number }> }> = [
      { col: startCol, row: startRow, path: [] },
    ];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur.path.length > maxDepth) continue;
      if (cur.path.length > 0 && cond(cur.col, cur.row)) return cur.path;
      for (const [dc, dr] of dirs) {
        const nc = cur.col + dc, nr = cur.row + dr;
        const k = cellKey(nc, nr);
        if (visited.has(k)) continue;
        if (!this.botWalkable(nc, nr)) continue;
        if (avoid.has(k)) continue;
        visited.add(k);
        queue.push({ col: nc, row: nr, path: [...cur.path, { col: nc, row: nr }] });
      }
    }
    return null;
  }

  // 安全なセルへの逃げ経路。afterBomb=true なら「自分が今いるセルに爆弾を置いた後」の危険で判定。
  private fleePath(col: number, row: number, afterBomb: boolean, range = 1): Array<{ col: number; row: number }> | null {
    const danger = afterBomb
      ? this.buildDanger({ col, row, range })
      : this.buildDanger();
    if (!danger.has(cellKey(col, row)) && !afterBomb) return [];
    return this.bfsTo(col, row, (c, r) => !danger.has(cellKey(c, r)), new Set());
  }

  // CPU の方針決定: 危険回避 > アイテム > 攻撃(プレイヤー隣接で爆弾) > ブロック破壊 > 徘徊
  private decideBot(p: BPlayer, bot: BotState) {
    bot.wantBomb = false;
    const danger = this.buildDanger();
    const here = cellKey(p.col, p.row);

    // 1) 今いるセルが危険 → 逃げる
    if (danger.has(here)) {
      const flee = this.bfsTo(p.col, p.row, (c, r) => !danger.has(cellKey(c, r)), new Set());
      bot.plan = flee ?? [];
      return;
    }

    // 2) アイテムが近ければ取りに行く（危険セルは通らない）
    const toItem = this.bfsTo(p.col, p.row, (c, r) => {
      let found = false;
      this.state.items.forEach((it) => { if (it.col === c && it.row === r) found = true; });
      return found;
    }, danger, 8);
    if (toItem && toItem.length > 0) { bot.plan = toItem; return; }

    // 3) 攻撃: 射程内にプレイヤーがいて、置いても安全に逃げられるなら爆弾
    if (p.activeBombs < p.maxBombs && this.enemyInBlast(p) && this.fleePath(p.col, p.row, true, p.range)) {
      bot.wantBomb = true;
      bot.plan = [];
      return;
    }

    // 4) ブロック破壊: 隣に soft があり、置いて逃げられるなら爆弾。無ければ soft の隣へ移動
    if (p.activeBombs < p.maxBombs && this.softAdjacent(p.col, p.row) && this.fleePath(p.col, p.row, true, p.range)) {
      bot.wantBomb = true;
      bot.plan = [];
      return;
    }
    const toSoft = this.bfsTo(p.col, p.row, (c, r) => this.softAdjacent(c, r), danger, 12);
    if (toSoft && toSoft.length > 0) { bot.plan = toSoft; return; }

    // 5) 敵を追う: 最寄りの生存プレイヤーに隣接するセルへ近づく（射程に捉えに行く）
    const toEnemy = this.bfsTo(p.col, p.row, (c, r) => this.enemyAdjacent(p, c, r), danger, 20);
    if (toEnemy && toEnemy.length > 0) { bot.plan = toEnemy; return; }

    // 6) 徘徊: 安全な隣接セルへランダム
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5);
    for (const [dc, dr] of dirs) {
      const nc = p.col + dc, nr = p.row + dr;
      if (this.botWalkable(nc, nr) && !danger.has(cellKey(nc, nr))) {
        bot.plan = [{ col: nc, row: nr }];
        return;
      }
    }
    bot.plan = [];
  }

  // 自分の爆弾射程内に生存プレイヤー（自分以外）がいるか
  private enemyInBlast(p: BPlayer): boolean {
    const dirs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dc, dr] of dirs) {
      for (let i = (dc === 0 && dr === 0) ? 0 : 1; i <= p.range; i++) {
        const col = p.col + dc * i, row = p.row + dr * i;
        if (i > 0 && this.isHardWall(col, row)) break;
        if (i > 0 && this.state.softBlocks.has(cellKey(col, row))) break;
        let hit = false;
        this.state.players.forEach((o) => {
          if (o.entityId === p.entityId || !o.alive) return;
          if (o.col === col && o.row === row) hit = true;
        });
        if (hit) return true;
      }
    }
    return false;
  }

  private softAdjacent(col: number, row: number): boolean {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    return dirs.some(([dc, dr]) => this.state.softBlocks.has(cellKey(col + dc, row + dr)));
  }

  // セル(col,row)が、自分以外の生存プレイヤーと同じか隣接しているか（攻撃を仕掛けに行く目標）
  private enemyAdjacent(self: BPlayer, col: number, row: number): boolean {
    let hit = false;
    this.state.players.forEach((o) => {
      if (o.entityId === self.entityId || !o.alive) return;
      const d = Math.abs(o.col - col) + Math.abs(o.row - row);
      if (d <= 1) hit = true;
    });
    return hit;
  }

  // 経路の先頭セルへ向かう1マス分の方向入力を inp に設定。
  private driveAlongPlan(p: BPlayer, inp: BInput, bot: BotState) {
    inp.up = inp.down = inp.left = inp.right = false;
    // 到達済みの先頭を捨てる
    while (bot.plan.length > 0 && bot.plan[0].col === p.col && bot.plan[0].row === p.row) {
      bot.plan.shift();
    }
    if (bot.plan.length === 0) return;
    const next = bot.plan[0];
    const dc = next.col - p.col, dr = next.row - p.row;
    if (Math.abs(dc) + Math.abs(dr) !== 1) { bot.plan = []; return; } // 隣接でなければ破棄
    // 進路が塞がれたら破棄して再考
    if (!this.botWalkable(next.col, next.row)) { bot.plan = []; return; }
    if (dc === 1) inp.right = true;
    else if (dc === -1) inp.left = true;
    else if (dr === 1) inp.down = true;
    else if (dr === -1) inp.up = true;
  }
}

function cellKey(col: number, row: number): string {
  return `${col}_${row}`;
}
