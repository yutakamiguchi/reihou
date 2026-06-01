import { Room, Client } from "colyseus";
import {
  BombermanState, BPlayer, Bomb, Flame, Item, SoftBlock,
} from "../../schema/BombermanState";
import { canStartRound } from "../phase";

const TICK_RATE = 30;
const NUM_COLORS = 8;
const BOMB_FUSE_MS = 2500;
const FLAME_MS = 500;
const BASE_SPEED = 144;       // px/sec（=3セル/秒, tileSize48）
const SPEED_PER_LEVEL = 0.22; // speed スタック1段あたりの加速率
const SOFT_BLOCK_RATIO = 0.72; // 空きセルに soft を置く確率
const ITEM_DROP_CHANCE = 0.32;
const SNAP_EPS = 2;           // セル中心への到達判定（px）

interface BInput { up: boolean; down: boolean; left: boolean; right: boolean; }
interface BMove { targetCol: number; targetRow: number; } // 移動中の目標セル（サーバー内部のみ）

export class BombermanRoom extends Room<BombermanState> {
  maxClients = 4;
  private inputs = new Map<string, BInput>();
  private moves = new Map<string, BMove | null>();
  private lastTick = 0;
  private roundEndsAt = 0;
  private bombSeq = 0;
  private flameSeq = 0;
  private itemSeq = 0;

  onCreate(options: { code?: string }) {
    this.setState(new BombermanState());
    this.state.code = (options?.code || "").slice(0, 8);
    if (this.state.code !== "") this.setPrivate(true);
    this.generateMap();

    this.onMessage("input", (client, message: Partial<BInput>) => {
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      inp.up = !!message.up;
      inp.down = !!message.down;
      inp.left = !!message.left;
      inp.right = !!message.right;
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

    this.setSimulationInterval((dt) => this.update(dt), 1000 / TICK_RATE);
    this.lastTick = Date.now();
  }

  onJoin(client: Client, options: { name?: string }) {
    const p = new BPlayer();
    p.name = (options?.name || "Player").slice(0, 16);
    p.entityId = client.sessionId;
    p.colorIndex = Math.floor(Math.random() * NUM_COLORS);
    const spawn = this.spawnCellFor(this.state.players.size);
    this.placePlayerAtCell(p, spawn.col, spawn.row);
    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false });
    this.moves.set(client.sessionId, null);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.moves.delete(client.sessionId);
  }

  // --- マップ生成 ---

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
        if (this.isHardWall(col, row)) continue;
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
    const col = p.col, row = p.row;
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
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    if (this.state.phase !== "playing") return;

    this.state.timeLeft = Math.max(0, (this.roundEndsAt - now) / 1000);

    // プレイヤー移動
    this.state.players.forEach((p, sid) => this.movePlayer(p, sid, dt));

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

  private movePlayer(p: BPlayer, sid: string, dt: number) {
    if (!p.alive) return;
    const ts = this.state.tileSize;
    const inp = this.inputs.get(sid);
    const hasInput = !!(inp && (inp.up || inp.down || inp.left || inp.right));
    let mv = this.moves.get(sid) ?? null;

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
}

function cellKey(col: number, row: number): string {
  return `${col}_${row}`;
}
