import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";
import {
  preloadCharTextures, ensureCharAnims, applyCharPose,
  dirFromVector, dirFromAngle, CHAR_INITIAL_TEX, type Dir,
} from "../../character";
import { sfxHitPlayer, sfxHitNpc, sfxScore, sfxFootstep, sfxRoundStart } from "../../sfx";
import { addMoveKeys } from "../../ui/inputKeys";

const PLAYER_SPEED = 140;
const ENTITY_RADIUS = 14;
const CHAR_DISPLAY_H = 56;
const MOB_DISPLAY_H = 52;

interface PlayerView {
  container: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Ellipse;
  sprite: Phaser.GameObjects.Sprite;
  nameLabel: Phaser.GameObjects.Text;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFg: Phaser.GameObjects.Rectangle;
  dir: Dir;
  flip: boolean;
  punching: boolean;
  lastStep: number;
}

interface MobView {
  container: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Ellipse;
  sprite: Phaser.GameObjects.Sprite;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFg: Phaser.GameObjects.Rectangle;
  dir: Dir;
  flip: boolean;
}

export class MmoGameScene extends Phaser.Scene {
  private room!: Room;
  private myId!: string;
  private players = new Map<string, PlayerView>();
  private mobs = new Map<string, MobView>();
  private worldLayer!: Phaser.GameObjects.Layer;
  private predictReady = false;

  // HUD
  private hpBarBg!: Phaser.GameObjects.Rectangle;
  private hpBarFg!: Phaser.GameObjects.Rectangle;
  private expBarBg!: Phaser.GameObjects.Rectangle;
  private expBarFg!: Phaser.GameObjects.Rectangle;
  private hudText!: Phaser.GameObjects.Text;
  private deadText!: Phaser.GameObjects.Text;

  private keys!: {
    W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    UP: Phaser.Input.Keyboard.Key; DOWN: Phaser.Input.Keyboard.Key;
    LEFT: Phaser.Input.Keyboard.Key; RIGHT: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };
  private lastInputSent = { up: false, down: false, left: false, right: false };

  constructor() { super("MmoGame"); }

  init(data: { room: Room }) {
    this.room = data.room;
    this.myId = this.room.sessionId;
  }

  preload() {
    preloadCharTextures(this);
    // モンスター画像があれば使う（無ければキャラ緑染めで代用）
    this.load.image("mob", "/char/mob_idle.png");
  }

  create() {
    const { width, height } = this.scale;
    ensureCharAnims(this);
    const state: any = this.room.state;
    const mapW = state.mapWidth, mapH = state.mapHeight;

    // --- 背景（広いマップ。個別タイルは重いので大きい矩形＋疎なグリッド線） ---
    this.add.rectangle(mapW / 2, mapH / 2, mapW, mapH, 0x3a6b3f);
    const grid = this.add.graphics();
    grid.lineStyle(2, 0x000000, 0.08);
    for (let x = 0; x <= mapW; x += 128) grid.lineBetween(x, 0, x, mapH);
    for (let y = 0; y <= mapH; y += 128) grid.lineBetween(0, y, mapW, y);
    // 外周フェンス
    this.add.rectangle(mapW / 2, mapH / 2, mapW, mapH, 0, 0).setStrokeStyle(8, 0x2a3a2c);

    this.worldLayer = this.add.layer();

    // --- カメラ ---
    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.cameras.main.setBackgroundColor(0x223024);

    // --- HUD（画面固定） ---
    this.add.rectangle(12, 12, 240, 78, 0x000000, 0.5)
      .setOrigin(0, 0).setStrokeStyle(2, 0x666666).setScrollFactor(0).setDepth(1000);
    this.hudText = this.add.text(20, 18, "", {
      fontSize: "15px", color: "#ffffff", fontStyle: "bold",
    }).setScrollFactor(0).setDepth(1001);
    // HP バー
    this.hpBarBg = this.add.rectangle(20, 44, 220, 14, 0x401515)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1001);
    this.hpBarFg = this.add.rectangle(20, 44, 220, 14, 0xe04545)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1002);
    // EXP バー
    this.expBarBg = this.add.rectangle(20, 64, 220, 10, 0x2a2a40)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1001);
    this.expBarFg = this.add.rectangle(20, 64, 0, 10, 0x66aaff)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1002);

    this.deadText = this.add.text(width / 2, height / 2, "", {
      fontSize: "40px", color: "#ff6666", fontStyle: "bold", stroke: "#000", strokeThickness: 5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2000).setVisible(false);

    this.add.text(width - 12, height - 10, "ESC: ハブに戻る", {
      fontSize: "13px", color: "#aaaaaa",
    }).setOrigin(1, 1).setScrollFactor(0).setDepth(1000);

    // --- 入力 ---
    this.keys = addMoveKeys(this);
    this.keys.SPACE.on("down", () => this.room.send("attack"));
    this.input.keyboard!.on("keydown-ESC", () => this.room.leave());

    // --- state 購読 ---
    const $ = getStateCallbacks(this.room);

    $(state).players.onAdd((p: any, id: string) => {
      this.addPlayerView(id, p);
      if (id === this.myId) {
        const v = this.players.get(id);
        if (v) this.cameras.main.startFollow(v.container, true, 0.15, 0.15);
      }
      $(p).listen("attackUntil", (val: number) => {
        if (val > Date.now()) this.showAttackFx(id, p);
      });
      $(p).listen("hp", (nv: number, ov: number | undefined) => {
        this.updatePlayerHpBar(id, p);
        if (ov !== undefined && nv < ov) { this.flashHit(id, true); this.popDamage(id, ov - nv); }
      });
      $(p).listen("level", (nv: number, ov: number | undefined) => {
        if (ov !== undefined && nv > ov) this.popLevelUp(id);
      });
    });
    $(state).players.onRemove((_p: any, id: string) => this.removePlayerView(id));

    $(state).mobs.onAdd((m: any, id: string) => {
      this.addMobView(id, m);
      $(m).listen("hp", (nv: number, ov: number | undefined) => {
        this.updateMobHpBar(id, m);
        if (ov !== undefined && nv < ov) this.flashHit(id, false);
      });
    });
    $(state).mobs.onRemove((m: any, id: string) => this.removeMobView(id, m));

    this.room.onLeave(() => this.scene.start("MmoLobby"));
  }

  update(_t: number, dtMs: number) {
    const state: any = this.room.state;
    const me: any = state.players.get(this.myId);

    // 入力送信
    const up = this.keys.W.isDown || this.keys.UP.isDown;
    const down = this.keys.S.isDown || this.keys.DOWN.isDown;
    const left = this.keys.A.isDown || this.keys.LEFT.isDown;
    const right = this.keys.D.isDown || this.keys.RIGHT.isDown;
    const last = this.lastInputSent;
    if (up !== last.up || down !== last.down || left !== last.left || right !== last.right) {
      this.lastInputSent = { up, down, left, right };
      this.room.send("input", this.lastInputSent);
    }

    // プレイヤー描画
    state.players.forEach((p: any, id: string) => {
      const v = this.players.get(id);
      if (!v) return;
      let cx: number, cy: number;
      if (id === this.myId && !p.dead) {
        ({ x: cx, y: cy } = this.predictSelf(v, p, dtMs, up, down, left, right));
      } else {
        const t = id === this.myId ? 0.4 : 0.25;
        cx = Phaser.Math.Linear(v.container.x, p.x, t);
        cy = Phaser.Math.Linear(v.container.y, p.y, t);
      }
      v.container.setPosition(cx, cy);
      v.container.setDepth(cy);

      // 向き・歩行
      let dx: number, dy: number, moving: boolean;
      if (id === this.myId && !p.dead) {
        dx = (right ? 1 : 0) - (left ? 1 : 0);
        dy = (down ? 1 : 0) - (up ? 1 : 0);
        moving = up || down || left || right;
      } else {
        dx = p.vx; dy = p.vy;
        moving = Math.hypot(p.vx, p.vy) > 5 && !p.dead;
      }
      if (!v.punching) {
        if (moving) {
          const d = dirFromVector(dx, dy);
          if (d) { v.dir = d.dir; v.flip = d.flip; }
          applyCharPose(v.sprite, v.dir, "walk", v.flip, CHAR_DISPLAY_H);
        } else {
          applyCharPose(v.sprite, v.dir, "idle", v.flip, CHAR_DISPLAY_H);
        }
      }
      if (moving && !v.punching && id === this.myId) {
        const step = v.sprite.anims.currentFrame?.index ?? 0;
        if (step !== v.lastStep) { sfxFootstep(); v.lastStep = step; }
      }
      v.container.setAlpha(p.dead ? 0.3 : 1);
    });

    // モンスター描画
    state.mobs.forEach((m: any, id: string) => {
      const v = this.mobs.get(id);
      if (!v) return;
      const cx = Phaser.Math.Linear(v.container.x, m.x, 0.3);
      const cy = Phaser.Math.Linear(v.container.y, m.y, 0.3);
      v.container.setPosition(cx, cy);
      v.container.setDepth(cy);
      const d = dirFromAngle(m.dir);
      v.dir = d.dir; v.flip = d.flip;
      applyCharPose(v.sprite, v.dir, "walk", v.flip, MOB_DISPLAY_H);
    });

    // HUD
    if (me) {
      this.hudText.setText(`Lv.${me.level}   ${me.name}`);
      this.hpBarFg.width = 220 * Math.max(0, me.hp / me.maxHp);
      this.expBarFg.width = 220 * Math.max(0, Math.min(1, me.exp / me.nextExp));
      this.deadText.setVisible(me.dead);
      if (me.dead) {
        const sec = Math.max(0, (me.respawnAt - Date.now()) / 1000);
        this.deadText.setText(`やられた！\n復活まで ${sec.toFixed(1)}秒`);
      }
    }
  }

  // --- クライアント予測（UnspottableGameScene 流用） ---

  private predictSelf(
    v: PlayerView, entity: any, dtMs: number,
    up: boolean, down: boolean, left: boolean, right: boolean,
  ): { x: number; y: number } {
    const dt = Math.min(dtMs, 50) / 1000;
    let px = v.container.x, py = v.container.y;
    if (!this.predictReady) { this.predictReady = true; px = entity.x; py = entity.y; }
    let dx = 0, dy = 0;
    if (up) dy -= 1; if (down) dy += 1; if (left) dx -= 1; if (right) dx += 1;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    const mapW = (this.room.state as any).mapWidth;
    const mapH = (this.room.state as any).mapHeight;
    let nx = px + dx * PLAYER_SPEED * dt;
    let ny = py + dy * PLAYER_SPEED * dt;
    nx = Phaser.Math.Clamp(nx, ENTITY_RADIUS, mapW - ENTITY_RADIUS);
    ny = Phaser.Math.Clamp(ny, ENTITY_RADIUS, mapH - ENTITY_RADIUS);
    const drift = Math.hypot(entity.x - nx, entity.y - ny);
    const corr = drift > 50 ? 0.3 : 0.04;
    nx = Phaser.Math.Linear(nx, entity.x, corr);
    ny = Phaser.Math.Linear(ny, entity.y, corr);
    return { x: nx, y: ny };
  }

  // --- プレイヤー ---

  private addPlayerView(id: string, p: any) {
    const container = this.add.container(p.x, p.y);
    const shadow = this.add.ellipse(0, 0, 24, 8, 0x000000, 0.4);
    const sprite = this.add.sprite(0, 0, CHAR_INITIAL_TEX).setOrigin(0.5, 0.96);
    applyCharPose(sprite, "front", "idle", false, CHAR_DISPLAY_H);
    const hpBg = this.add.rectangle(0, -CHAR_DISPLAY_H - 8, 36, 5, 0x000000, 0.6);
    const hpFg = this.add.rectangle(-18, -CHAR_DISPLAY_H - 8, 36, 5, 0x6be36b).setOrigin(0, 0.5);
    const nameLabel = this.add.text(0, -CHAR_DISPLAY_H - 18,
      p.name + (id === this.myId ? " (YOU)" : ""), {
      fontSize: "12px", color: id === this.myId ? "#ffe066" : "#ffffff",
      stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5);
    container.add([shadow, sprite, hpBg, hpFg, nameLabel]);
    this.worldLayer.add(container);
    this.players.set(id, {
      container, shadow, sprite, nameLabel, hpBg, hpFg,
      dir: "front", flip: false, punching: false, lastStep: 0,
    });
    this.updatePlayerHpBar(id, p);
  }

  private updatePlayerHpBar(id: string, p: any) {
    const v = this.players.get(id);
    if (!v) return;
    const ratio = Math.max(0, p.hp / p.maxHp);
    v.hpFg.width = 36 * ratio;
    v.hpFg.fillColor = ratio > 0.5 ? 0x6be36b : ratio > 0.25 ? 0xe3c84b : 0xe04545;
  }

  private removePlayerView(id: string) {
    const v = this.players.get(id);
    if (!v) return;
    v.container.destroy();
    this.players.delete(id);
  }

  // --- モンスター ---

  private addMobView(id: string, m: any) {
    const container = this.add.container(m.x, m.y);
    const shadow = this.add.ellipse(0, 0, 22, 7, 0x000000, 0.4);
    // モンスター画像が読めていればそれを、無ければキャラを緑染めで代用
    const hasMobTex = this.textures.exists("mob") && this.textures.get("mob").key !== "__MISSING";
    let sprite: Phaser.GameObjects.Sprite;
    if (hasMobTex) {
      sprite = this.add.sprite(0, 0, "mob").setOrigin(0.5, 0.96);
      const h = sprite.frame.realHeight || MOB_DISPLAY_H;
      sprite.setScale(MOB_DISPLAY_H / h);
    } else {
      sprite = this.add.sprite(0, 0, CHAR_INITIAL_TEX).setOrigin(0.5, 0.96);
      applyCharPose(sprite, "front", "idle", false, MOB_DISPLAY_H);
      sprite.setTint(0x66dd66); // 緑染めでモンスター代用
    }
    const hpBg = this.add.rectangle(0, -MOB_DISPLAY_H - 6, 30, 4, 0x000000, 0.6);
    const hpFg = this.add.rectangle(-15, -MOB_DISPLAY_H - 6, 30, 4, 0xff7777).setOrigin(0, 0.5);
    container.add([shadow, sprite, hpBg, hpFg]);
    this.worldLayer.add(container);
    this.mobs.set(id, { container, shadow, sprite, hpBg, hpFg, dir: "front", flip: false });
    this.updateMobHpBar(id, m);
  }

  private updateMobHpBar(id: string, m: any) {
    const v = this.mobs.get(id);
    if (!v) return;
    v.hpFg.width = 30 * Math.max(0, m.hp / m.maxHp);
  }

  private removeMobView(id: string, _m: any) {
    const v = this.mobs.get(id);
    if (!v) return;
    // 撃破演出
    this.spawnStarBurst(v.container.x, v.container.y);
    sfxScore();
    v.container.destroy();
    this.mobs.delete(id);
  }

  // --- FX ---

  private flashHit(id: string, isPlayer: boolean) {
    const v = isPlayer ? this.players.get(id) : this.mobs.get(id);
    if (!v) return;
    const sprite = v.sprite;
    const prevTint = sprite.tintTopLeft;
    const wasTinted = sprite.isTinted;
    sprite.setTintFill(0xffffff);
    this.time.delayedCall(110, () => {
      if (!sprite.active) return;
      if (wasTinted && !isPlayer) sprite.setTint(prevTint);
      else sprite.clearTint();
    });
    this.spawnStarBurst(v.container.x, v.container.y);
    if (isPlayer) { sfxHitPlayer(); this.cameras.main.shake(80, 0.004); }
    else sfxHitNpc();
  }

  private spawnStarBurst(x: number, y: number) {
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.4;
      const star = this.add.star(x, y, 4, 3, 6, 0xffe066).setDepth(6000);
      this.tweens.add({
        targets: star,
        x: x + Math.cos(angle) * 30,
        y: y + Math.sin(angle) * 30,
        alpha: { from: 1, to: 0 }, scale: { from: 1, to: 0.4 },
        duration: 360, ease: "Quad.easeOut",
        onComplete: () => star.destroy(),
      });
    }
  }

  private showAttackFx(id: string, entity: any) {
    const v = this.players.get(id);
    if (!v) return;
    const cos = Math.cos(entity.dir);
    const d = dirFromAngle(entity.dir);
    v.punching = true;
    v.dir = d.dir; v.flip = d.flip;
    applyCharPose(v.sprite, d.dir, "punch", d.flip, CHAR_DISPLAY_H);
    this.tweens.add({
      targets: v.sprite,
      x: cos * 8, y: -Math.abs(Math.sin(entity.dir)) * 2,
      duration: 70, ease: "Quad.easeOut", yoyo: true, hold: 30,
      onComplete: () => v.sprite.setPosition(0, 0),
    });
    this.time.delayedCall(220, () => {
      if (!v.sprite.active) return;
      v.punching = false;
      applyCharPose(v.sprite, v.dir, "idle", v.flip, CHAR_DISPLAY_H);
      v.sprite.setPosition(0, 0);
    });
    this.spawnConeFlash(v.container.x, v.container.y, entity.dir);
  }

  private spawnConeFlash(x: number, y: number, dir: number) {
    const length = 72, width = 40;
    const cx = x + Math.cos(dir) * (length / 2);
    const cy = y + Math.sin(dir) * (length / 2);
    const rect = this.add.rectangle(cx, cy, length, width, 0xffffff, 0.2)
      .setRotation(dir).setDepth(4900);
    this.tweens.add({ targets: rect, alpha: 0, duration: 160, onComplete: () => rect.destroy() });
  }

  private popDamage(id: string, dmg: number) {
    const v = this.players.get(id);
    if (!v) return;
    const t = this.add.text(v.container.x, v.container.y - CHAR_DISPLAY_H, `-${Math.round(dmg)}`, {
      fontSize: "20px", color: "#ff7878", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(6500);
    this.tweens.add({
      targets: t, y: t.y - 36, alpha: { from: 1, to: 0 },
      duration: 700, ease: "Quad.easeOut", onComplete: () => t.destroy(),
    });
  }

  private popLevelUp(id: string) {
    const v = this.players.get(id);
    if (!v) return;
    if (id === this.myId) sfxRoundStart();
    const t = this.add.text(v.container.x, v.container.y - CHAR_DISPLAY_H - 20, "LEVEL UP!", {
      fontSize: "22px", color: "#ffe066", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(6600);
    this.tweens.add({
      targets: t, y: t.y - 40, alpha: { from: 1, to: 0 }, scale: { from: 1.4, to: 1 },
      duration: 900, ease: "Quad.easeOut", onComplete: () => t.destroy(),
    });
  }
}
