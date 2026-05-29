import { Room, Client } from "colyseus";
import { GameState, Player, Entity, Obstacle, Grave } from "../schema/GameState";
import { canStartRound } from "./phase";

const NPC_COUNT = 40;
const PLAYER_SPEED = 140;
const NPC_SPEED_MIN = 80;
const NPC_SPEED_MAX = 150;
const ENTITY_RADIUS = 14;
const ATTACK_RANGE = 64;       // 前方への射程
const ATTACK_HALF_WIDTH = 18;  // 進行方向に直交する半幅（合計36px）
const ATTACK_DURATION_MS = 220;
const STUN_DURATION_MS = 1500;
const ATTACK_COOLDOWN_MS = 500;
const KNOCKBACK_SPEED = 320;
const KNOCKBACK_MS = 220;
const NUM_COLORS = 8;
const TICK_RATE = 30;
const NPC_IDLE_CHANCE = 0.4;
const NPC_IDLE_MIN_MS = 400;
const NPC_IDLE_MAX_MS = 2200;
const NPC_TURN_WHILE_IDLE_CHANCE = 0.55;
const PAIR_RATIO = 0.35;
const PAIR_OFFSET_DIST = 26;

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  attackQueued: boolean;
  lastAttackAt: number;
}

interface NpcAI {
  targetX: number;
  targetY: number;
  retargetAt: number;
  speed: number;
  idleUntil: number;
  partnerId?: string;
  isLeader: boolean;
  offsetAngle: number;
}

interface KnockbackState {
  vx: number;
  vy: number;
  until: number;
}

export class GameRoom extends Room<GameState> {
  maxClients = 4;
  private inputs = new Map<string, InputState>();
  private npcAI = new Map<string, NpcAI>();
  private knockback = new Map<string, KnockbackState>();
  private lastTick = 0;
  private roundEndsAt = 0;

  onCreate(options: { code?: string }) {
    this.setState(new GameState());
    this.state.code = (options?.code || "").slice(0, 8);
    // プライベートルームはマッチメイキング一覧から除外
    if (this.state.code !== "") this.setPrivate(true);
    this.spawnObstacles();
    this.spawnNpcs();

    this.onMessage("input", (client, message: Partial<InputState>) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      input.up = !!message.up;
      input.down = !!message.down;
      input.left = !!message.left;
      input.right = !!message.right;
    });

    this.onMessage("attack", (client) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      const now = Date.now();
      if (now - input.lastAttackAt < ATTACK_COOLDOWN_MS) return;
      input.attackQueued = true;
      input.lastAttackAt = now;
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
    const player = new Player();
    player.name = (options?.name || "Player").slice(0, 16);
    player.entityId = client.sessionId;
    this.state.players.set(client.sessionId, player);

    const entity = new Entity();
    entity.id = client.sessionId;
    entity.isPlayer = true;
    entity.colorIndex = Math.floor(Math.random() * NUM_COLORS);
    this.placeEntityRandomly(entity);
    this.state.entities.set(client.sessionId, entity);

    this.inputs.set(client.sessionId, {
      up: false, down: false, left: false, right: false,
      attackQueued: false, lastAttackAt: 0,
    });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.state.entities.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.knockback.delete(client.sessionId);
  }

  // --- マップ生成 ---

  private spawnObstacles() {
    const W = this.state.mapWidth;
    const H = this.state.mapHeight;
    const obs: Array<{ x: number; y: number; w: number; h: number; kind: string }> = [
      // 四隅近くの柱
      { x: 220, y: 180, w: 40, h: 40, kind: "pillar" },
      { x: W - 220, y: 180, w: 40, h: 40, kind: "pillar" },
      { x: 220, y: H - 180, w: 40, h: 40, kind: "pillar" },
      { x: W - 220, y: H - 180, w: 40, h: 40, kind: "pillar" },
      // 中央のベンチ
      { x: W / 2 - 80, y: H / 2 - 40, w: 70, h: 24, kind: "bench" },
      { x: W / 2 + 10, y: H / 2 + 30, w: 70, h: 24, kind: "bench" },
      // 装飾の木箱
      { x: 480, y: 540, w: 36, h: 36, kind: "crate" },
      { x: W - 480 - 36, y: 160, w: 36, h: 36, kind: "crate" },
    ];
    for (const o of obs) {
      const ob = new Obstacle();
      ob.x = o.x; ob.y = o.y; ob.w = o.w; ob.h = o.h; ob.kind = o.kind;
      this.state.obstacles.push(ob);
    }
  }

  private spawnNpcs() {
    // 既存NPCを一掃してから再生成（ラウンド間で倒されたNPCを補充）
    const existing: string[] = [];
    this.state.entities.forEach((e, id) => { if (!e.isPlayer) existing.push(id); });
    for (const id of existing) this.state.entities.delete(id);
    this.npcAI.clear();

    const ids: string[] = [];
    for (let i = 0; i < NPC_COUNT; i++) {
      const id = `npc_${i}`;
      const e = new Entity();
      e.id = id;
      e.isPlayer = false;
      e.colorIndex = Math.floor(Math.random() * NUM_COLORS);
      this.placeEntityRandomly(e);
      this.state.entities.set(id, e);
      this.npcAI.set(id, {
        targetX: e.x, targetY: e.y, retargetAt: 0,
        speed: NPC_SPEED_MIN + Math.random() * (NPC_SPEED_MAX - NPC_SPEED_MIN),
        idleUntil: 0,
        isLeader: false,
        offsetAngle: Math.random() * Math.PI * 2,
      });
      ids.push(id);
    }

    // ペア形成
    const pairCount = Math.floor((NPC_COUNT * PAIR_RATIO) / 2);
    for (let p = 0; p < pairCount; p++) {
      const a = ids[p * 2];
      const b = ids[p * 2 + 1];
      const ai = this.npcAI.get(a)!;
      const bi = this.npcAI.get(b)!;
      ai.isLeader = true; ai.partnerId = b;
      bi.isLeader = false; bi.partnerId = a;
      bi.offsetAngle = Math.random() * Math.PI * 2;
    }
  }

  private placeEntityRandomly(e: Entity) {
    for (let i = 0; i < 20; i++) {
      const x = 40 + Math.random() * (this.state.mapWidth - 80);
      const y = 40 + Math.random() * (this.state.mapHeight - 80);
      if (!this.collidesWithObstacle(x, y, ENTITY_RADIUS + 4)) {
        e.x = x; e.y = y; return;
      }
    }
    e.x = 60 + Math.random() * 60;
    e.y = 60 + Math.random() * 60;
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
    this.state.players.forEach(p => { p.score = 0; });
    // 前ラウンドの墓を消去し、NPCを満タンまで再生成
    this.state.graves.clear();
    this.spawnNpcs();
    // プレイヤーは色再ランダム＆再配置（NPCは spawnNpcs 内で配置済み）
    this.state.entities.forEach(e => {
      if (!e.isPlayer) return;
      e.colorIndex = Math.floor(Math.random() * NUM_COLORS);
      e.stunned = false;
      this.placeEntityRandomly(e);
    });
  }

  private endRound() {
    this.state.phase = "ended";
    this.clock.setTimeout(() => {
      this.state.phase = "lobby";
      this.state.players.forEach(p => { p.ready = false; });
    }, 5000);
  }

  // --- 1tick ---

  private update(_dt: number) {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    if (this.state.phase === "playing") {
      this.state.timeLeft = Math.max(0, (this.roundEndsAt - now) / 1000);
      if (this.state.timeLeft <= 0) this.endRound();
    }

    this.state.players.forEach((player, sid) => {
      const e = this.state.entities.get(sid);
      const input = this.inputs.get(sid);
      if (!e || !input) return;

      if (e.stunned && now >= e.stunUntil) e.stunned = false;

      const kb = this.knockback.get(sid);
      if (kb && now >= kb.until) this.knockback.delete(sid);

      if (kb) {
        e.vx = kb.vx; e.vy = kb.vy;
      } else if (!e.stunned && this.state.phase === "playing") {
        let dx = 0, dy = 0;
        if (input.up) dy -= 1;
        if (input.down) dy += 1;
        if (input.left) dx -= 1;
        if (input.right) dx += 1;
        const len = Math.hypot(dx, dy);
        if (len > 0) { dx /= len; dy /= len; e.dir = Math.atan2(dy, dx); }
        e.vx = dx * PLAYER_SPEED;
        e.vy = dy * PLAYER_SPEED;
      } else {
        e.vx = 0; e.vy = 0;
      }
      this.moveEntity(e, dt);

      if (input.attackQueued) {
        input.attackQueued = false;
        if (!e.stunned && !kb && this.state.phase === "playing") {
          e.attackUntil = now + ATTACK_DURATION_MS;
          this.resolveAttack(sid, e, player);
        }
      }
    });

    if (this.state.phase === "playing") {
      this.state.entities.forEach((e) => {
        if (e.isPlayer) return;
        const ai = this.npcAI.get(e.id);
        if (!ai) return;

        const kb = this.knockback.get(e.id);
        if (kb && now >= kb.until) this.knockback.delete(e.id);
        if (e.stunned && now >= e.stunUntil) e.stunned = false;

        if (kb) {
          e.vx = kb.vx; e.vy = kb.vy;
          this.moveEntity(e, dt);
          return;
        }
        if (e.stunned) { e.vx = 0; e.vy = 0; this.moveEntity(e, dt); return; }

        // フォロワーはリーダーを追う
        if (!ai.isLeader && ai.partnerId) {
          const leader = this.state.entities.get(ai.partnerId);
          if (leader) {
            const tx = leader.x + Math.cos(ai.offsetAngle) * PAIR_OFFSET_DIST;
            const ty = leader.y + Math.sin(ai.offsetAngle) * PAIR_OFFSET_DIST;
            const dx = tx - e.x, dy = ty - e.y;
            const len = Math.hypot(dx, dy);
            if (len > 4) {
              const sp = Math.min(ai.speed, len * 4); // 近づいたら減速
              e.vx = (dx / len) * sp;
              e.vy = (dy / len) * sp;
              e.dir = Math.atan2(dy, dx);
            } else {
              e.vx = 0; e.vy = 0;
              if (Math.random() < 0.005) e.dir = leader.dir;
            }
            this.moveEntity(e, dt);
            return;
          }
        }

        const reachedTarget = Math.hypot(ai.targetX - e.x, ai.targetY - e.y) < 8;
        const retargetDue = now >= ai.retargetAt;

        if (reachedTarget || retargetDue) {
          if (now >= ai.idleUntil) {
            if (Math.random() < NPC_IDLE_CHANCE) {
              ai.idleUntil = now + NPC_IDLE_MIN_MS + Math.random() * (NPC_IDLE_MAX_MS - NPC_IDLE_MIN_MS);
              if (Math.random() < NPC_TURN_WHILE_IDLE_CHANCE) {
                e.dir = Math.random() * Math.PI * 2;
              }
            } else {
              for (let i = 0; i < 6; i++) {
                const tx = 40 + Math.random() * (this.state.mapWidth - 80);
                const ty = 40 + Math.random() * (this.state.mapHeight - 80);
                if (!this.collidesWithObstacle(tx, ty, ENTITY_RADIUS + 4)) {
                  ai.targetX = tx; ai.targetY = ty; break;
                }
              }
              ai.retargetAt = now + 1500 + Math.random() * 3000;
              ai.speed = NPC_SPEED_MIN + Math.random() * (NPC_SPEED_MAX - NPC_SPEED_MIN);
            }
          }
        }

        if (now < ai.idleUntil) {
          e.vx = 0; e.vy = 0;
        } else {
          const dx = ai.targetX - e.x;
          const dy = ai.targetY - e.y;
          const len = Math.hypot(dx, dy);
          if (len > 0) {
            e.vx = (dx / len) * ai.speed;
            e.vy = (dy / len) * ai.speed;
            e.dir = Math.atan2(dy, dx);
          }
        }
        this.moveEntity(e, dt);
      });
    }
  }

  private moveEntity(e: Entity, dt: number) {
    const newX = e.x + e.vx * dt;
    const newY = e.y + e.vy * dt;

    let resolvedX = newX, resolvedY = newY;
    if (this.collidesWithObstacle(newX, e.y, ENTITY_RADIUS)) resolvedX = e.x;
    if (this.collidesWithObstacle(resolvedX, newY, ENTITY_RADIUS)) resolvedY = e.y;

    e.x = Math.max(ENTITY_RADIUS, Math.min(this.state.mapWidth - ENTITY_RADIUS, resolvedX));
    e.y = Math.max(ENTITY_RADIUS, Math.min(this.state.mapHeight - ENTITY_RADIUS, resolvedY));
  }

  private collidesWithObstacle(x: number, y: number, r: number): boolean {
    for (let i = 0; i < this.state.obstacles.length; i++) {
      const o = this.state.obstacles[i];
      const cx = Math.max(o.x, Math.min(x, o.x + o.w));
      const cy = Math.max(o.y, Math.min(y, o.y + o.h));
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
    }
    return false;
  }

  private resolveAttack(attackerId: string, attacker: Entity, attackerPlayer: Player) {
    // 前方軸: (fx, fy) は単位ベクトル。直交軸は (-fy, fx)
    const fx = Math.cos(attacker.dir);
    const fy = Math.sin(attacker.dir);

    let bestId: string | null = null;
    let bestForward = Infinity;

    this.state.entities.forEach((target, tid) => {
      if (tid === attackerId) return;
      const dx = target.x - attacker.x;
      const dy = target.y - attacker.y;
      const forward = dx * fx + dy * fy;          // 前方への投影
      const side = Math.abs(-dx * fy + dy * fx);  // 横方向への距離

      if (forward <= 0 || forward > ATTACK_RANGE) return;
      if (side > ATTACK_HALF_WIDTH) return;

      // 最も前にいる相手が優先（同じ距離なら横ずれが小さい方）
      const score = forward + side * 0.5;
      if (score < bestForward) { bestForward = score; bestId = tid; }
    });

    if (!bestId) return;
    const target = this.state.entities.get(bestId)!;

    // ノックバック方向
    const kdx = Math.cos(attacker.dir);
    const kdy = Math.sin(attacker.dir);
    const now = Date.now();

    if (target.isPlayer) {
      attackerPlayer.score += 1;
      target.stunned = true;
      target.stunUntil = now + STUN_DURATION_MS;
      this.knockback.set(bestId!, {
        vx: kdx * KNOCKBACK_SPEED, vy: kdy * KNOCKBACK_SPEED,
        until: now + KNOCKBACK_MS,
      });
    } else {
      // NPCを倒した: 減点 + 自分が硬直 + その場に墓を設置してNPCは消滅
      attackerPlayer.score = Math.max(0, attackerPlayer.score - 1);
      attacker.stunned = true;
      attacker.stunUntil = now + 500;

      const grave = new Grave();
      grave.x = target.x;
      grave.y = target.y;
      this.state.graves.push(grave);

      this.state.entities.delete(bestId!);
      this.npcAI.delete(bestId!);
      this.knockback.delete(bestId!);
    }
  }
}
