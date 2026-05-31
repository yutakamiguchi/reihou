import { Room, Client } from "colyseus";
import { MmoState, MmoPlayer, Mob } from "../../schema/MmoState";

const TICK_RATE = 30;
const PLAYER_SPEED = 140;
const ENTITY_RADIUS = 14;
const NUM_COLORS = 8;

const ATTACK_RANGE = 72;        // 前方への射程
const ATTACK_HALF_WIDTH = 24;   // 進行方向に直交する半幅
const ATTACK_DURATION_MS = 220;
const ATTACK_COOLDOWN_MS = 400;

const MOB_TARGET_COUNT = 24;
const MOB_SPEED = 62;
const MOB_AGGRO_RANGE = 260;
const MOB_TOUCH_RANGE = 28;
const MOB_TOUCH_DMG_COOLDOWN_MS = 800;
const PLAYER_RESPAWN_DELAY_MS = 4000;

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
  private mobAI = new Map<string, MobAI>();
  private mobSeq = 0;
  private lastTick = 0;

  onCreate() {
    this.setState(new MmoState());

    for (let i = 0; i < MOB_TARGET_COUNT; i++) this.spawnMob();

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

    this.setSimulationInterval((dt) => this.update(dt), 1000 / TICK_RATE);
    this.lastTick = Date.now();
  }

  onJoin(client: Client, options: { name?: string }) {
    const p = new MmoPlayer();
    p.id = client.sessionId;
    p.name = (options?.name || "Player").slice(0, 16);
    p.colorIndex = Math.floor(Math.random() * NUM_COLORS);
    p.level = 1; p.exp = 0; p.nextExp = 20;
    p.maxHp = 100; p.hp = 100; p.atk = 10;
    this.placeRandomly(p);
    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, {
      up: false, down: false, left: false, right: false,
      attackQueued: false, lastAttackAt: 0,
    });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
  }

  // --- スポーン ---

  private placeRandomly(e: { x: number; y: number }) {
    e.x = 80 + Math.random() * (this.state.mapWidth - 160);
    e.y = 80 + Math.random() * (this.state.mapHeight - 160);
  }

  private spawnMob() {
    const id = `mob_${this.mobSeq++}`;
    const m = new Mob();
    m.id = id;
    m.level = 1;
    m.maxHp = 30; m.hp = 30; m.atk = 5;
    this.placeRandomly(m);
    this.state.mobs.set(id, m);
    this.mobAI.set(id, {
      targetX: m.x, targetY: m.y, retargetAt: 0,
      lastTouchAt: new Map(),
    });
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

    // モンスター
    this.state.mobs.forEach((m) => {
      if (!m.alive) return;
      const ai = this.mobAI.get(m.id);
      if (!ai) return;

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
        m.x += (dx / d) * MOB_SPEED * dt;
        m.y += (dy / d) * MOB_SPEED * dt;

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
        m.x += (dx / d) * MOB_SPEED * 0.6 * dt;
        m.y += (dy / d) * MOB_SPEED * 0.6 * dt;
      }
      this.clampToMap(m);
    });

    // mob 補充
    if (this.countAliveMobs() < MOB_TARGET_COUNT) this.spawnMob();
  }

  private countAliveMobs(): number {
    let n = 0;
    this.state.mobs.forEach((m) => { if (m.alive) n++; });
    return n;
  }

  private moveEntity(e: { x: number; y: number; vx: number; vy: number }, dt: number) {
    e.x = e.x + e.vx * dt;
    e.y = e.y + e.vy * dt;
    this.clampToMap(e);
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
    // EXP 付与
    const gain = 5 + mob.level * 3;
    attacker.exp += gain;
    while (attacker.exp >= attacker.nextExp) {
      attacker.exp -= attacker.nextExp;
      attacker.level += 1;
      attacker.maxHp += 20;
      attacker.atk += 3;
      attacker.hp = attacker.maxHp; // レベルアップで全回復
      attacker.nextExp = 20 + (attacker.level - 1) * 15;
    }
    // mob 消滅（次tickで補充）
    this.state.mobs.delete(mobId);
    this.mobAI.delete(mobId);
  }

  private killPlayer(p: MmoPlayer, now: number) {
    p.dead = true;
    p.hp = 0;
    p.vx = 0; p.vy = 0;
    p.respawnAt = now + PLAYER_RESPAWN_DELAY_MS;
  }
}
