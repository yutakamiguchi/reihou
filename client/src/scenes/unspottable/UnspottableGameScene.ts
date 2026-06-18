import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";
import { sfxHitPlayer, sfxHitNpc, sfxScore, sfxFootstep, sfxRoundStart, sfxRoundEnd } from "../../sfx";
import {
  preloadCharTextures, ensureCharAnims, applyCharPose,
  dirFromVector, dirFromAngle, CHAR_INITIAL_TEX, type Dir,
} from "../../character";
import { addMoveKeys } from "../../ui/inputKeys";

// サーバー(GameRoom)と一致させる移動パラメータ。クライアント予測で使用。
const PLAYER_SPEED = 140;
const ENTITY_RADIUS = 14;
const CHAR_DISPLAY_H = 64;                 // キャラの表示高さ(px)

interface ObstacleRect { x: number; y: number; w: number; h: number; }

interface EntityView {
  container: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Ellipse;
  sprite: Phaser.GameObjects.Sprite;
  nameLabel?: Phaser.GameObjects.Text;
  attackFx?: Phaser.GameObjects.Arc;
  hitFlash?: Phaser.Tweens.Tween;
  lastStep: number;   // 足音を鳴らした歩数（アニメフレーム切替ごと）
  punching: boolean;  // パンチ画像に差し替え中か
  dir: Dir;           // 現在の向き
  flip: boolean;      // side のとき左向きか
}

export class UnspottableGameScene extends Phaser.Scene {
  private room!: Room;
  private myId!: string;
  private views = new Map<string, EntityView>();
  private hud!: Phaser.GameObjects.Text;
  private scoreBox!: Phaser.GameObjects.Container;
  private scoreLines: Phaser.GameObjects.Text[] = [];
  private timerText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private readyButton!: Phaser.GameObjects.Text;
  private worldLayer!: Phaser.GameObjects.Layer;
  private keys!: {
    W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    UP: Phaser.Input.Keyboard.Key; DOWN: Phaser.Input.Keyboard.Key;
    LEFT: Phaser.Input.Keyboard.Key; RIGHT: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };
  private lastInputSent = { up: false, down: false, left: false, right: false };
  private lastMyScore = 0;
  private obstacleRects: ObstacleRect[] = [];
  private predictReady = false;
  private graveViews = new Map<any, Phaser.GameObjects.Container>();

  constructor() { super("UnspottableGame"); }

  init(data: { room: Room }) {
    this.room = data.room;
    this.myId = this.room.sessionId;
    // Phaser はシーンインスタンスを使い回す。前回ゲームの破棄済みオブジェクトへの
    // 参照が Map/配列に残ると、再入場時にそれを触って例外→描画ループが停止し固まる。
    // 再入場ごとに初期化する。
    this.views.clear();
    this.graveViews.clear();
    this.scoreLines = [];
    this.obstacleRects = [];
    this.lastInputSent = { up: false, down: false, left: false, right: false };
    this.lastMyScore = 0;
    this.predictReady = false;
  }

  preload() {
    preloadCharTextures(this);
  }

  create() {
    const { width, height } = this.scale;
    ensureCharAnims(this);

    // --- マップ床 ---
    this.add.rectangle(width / 2, height / 2, width, height, 0x4a5566);
    // 市松模様
    const tile = 64;
    const tilesX = Math.ceil(width / tile);
    const tilesY = Math.ceil(height / tile);
    for (let i = 0; i < tilesX; i++) {
      for (let j = 0; j < tilesY; j++) {
        if (((i + j) & 1) === 0) {
          this.add.rectangle(i * tile + tile / 2, j * tile + tile / 2, tile, tile, 0x424d5d).setAlpha(0.55);
        }
      }
    }
    // 縁取り
    this.add.rectangle(width / 2, height / 2, width - 4, height - 4, 0, 0).setStrokeStyle(4, 0x2a313c);

    // 障害物
    const state: any = this.room.state;
    state.obstacles?.forEach((o: any) => {
      this.drawObstacle(o);
      this.obstacleRects.push({ x: o.x, y: o.y, w: o.w, h: o.h });
    });

    // ワールドレイヤー（depth sort用）
    this.worldLayer = this.add.layer();

    // --- HUD ---
    this.timerText = this.add.text(width / 2, 16, "", {
      fontSize: "34px", color: "#ffffff", fontStyle: "bold",
      stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5, 0).setDepth(1000);

    this.hud = this.add.text(12, 12, "", {
      fontSize: "14px", color: "#cccccc",
    }).setDepth(1000);

    if (state.code) {
      const codeBox = this.add.text(12, 36, `ROOM CODE: ${state.code}`, {
        fontSize: "18px", color: "#ffe066", fontStyle: "bold",
        backgroundColor: "#1a1d24", padding: { x: 8, y: 4 } as any,
      }).setDepth(1000).setInteractive({ useHandCursor: true });
      codeBox.on("pointerdown", () => {
        navigator.clipboard?.writeText(state.code).catch(() => {});
        codeBox.setText(`COPIED!  ${state.code}`);
        this.time.delayedCall(1200, () => codeBox.setText(`ROOM CODE: ${state.code}`));
      });
    }

    this.phaseText = this.add.text(width / 2, 70, "", {
      fontSize: "22px", color: "#ffe066", stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5).setDepth(1000);

    // スコア欄
    const scorePanel = this.add.rectangle(width - 12, 12, 220, 130, 0x000000, 0.5)
      .setOrigin(1, 0).setStrokeStyle(2, 0x666666).setDepth(999);
    this.scoreBox = this.add.container(width - 220 - 12 + 12, 12 + 8).setDepth(1000);
    this.scoreBox.add(this.add.text(0, 0, "SCORE", {
      fontSize: "14px", color: "#aaaaaa", fontStyle: "bold",
    }));

    this.readyButton = this.add.text(width / 2, height / 2, "[ 準備 OK ]", {
      fontSize: "32px", color: "#7ee787", backgroundColor: "#222",
      padding: { x: 16, y: 8 } as any, fontStyle: "bold",
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(1000);

    this.readyButton.on("pointerdown", () => {
      this.room.send("ready");
      this.readyButton.setText("準備済み...").disableInteractive();
    });

    this.keys = this.input.keyboard!.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
      UP: Phaser.Input.Keyboard.KeyCodes.UP,
      DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
      LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
      RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
    }) as any;

    this.keys.SPACE.on("down", () => this.room.send("attack"));

    // ESC でルーム退室 → onLeave 経由でロビーへ戻る
    this.input.keyboard!.on("keydown-ESC", () => this.room.leave());

    const $ = getStateCallbacks(this.room);

    $(state).entities.onAdd((entity: any, id: string) => {
      this.addEntityView(id, entity);
      $(entity).listen("attackUntil", (val: number) => {
        // 攻撃エフェクトは自分の駒だけ表示（他人の攻撃が見えると正体がバレるため）
        if (id === this.myId && val > Date.now()) this.showAttackFx(id, entity);
      });
      $(entity).listen("stunned", (val: boolean) => {
        // ヒット演出（白フラッシュ/星/スロー/シェイク）は自分だけ。
        // 他人はサーバー由来のノックバック移動だけ見えるので正体が割れない。
        if (val && id === this.myId) this.flashHit(id);
      });
    });
    $(state).entities.onRemove((_e: any, id: string) => this.removeEntityView(id));

    $(state).graves.onAdd((g: any) => this.addGrave(g));
    $(state).graves.onRemove((g: any) => this.removeGrave(g));

    $(state).players.onAdd((p: any, id: string) => {
      this.refreshScoreboard();
      $(p).listen("score", (newVal: number, oldVal: number | undefined) => {
        if (oldVal === undefined) return;
        const diff = newVal - oldVal;
        if (diff !== 0) this.popScore(id, diff);
        this.refreshScoreboard();
      });
    });
    $(state).players.onRemove(() => this.refreshScoreboard());

    $(state).listen("phase", () => this.onPhaseChanged());

    scorePanel.setVisible(true);
    void scorePanel;

    this.room.onLeave(() => this.scene.start("UnspottableLobby"));

    this.onPhaseChanged();
  }

  update(_t: number, dtMs: number) {
    const up = this.keys.W.isDown || this.keys.UP.isDown;
    const down = this.keys.S.isDown || this.keys.DOWN.isDown;
    const left = this.keys.A.isDown || this.keys.LEFT.isDown;
    const right = this.keys.D.isDown || this.keys.RIGHT.isDown;
    const last = this.lastInputSent;
    if (up !== last.up || down !== last.down || left !== last.left || right !== last.right) {
      this.lastInputSent = { up, down, left, right };
      this.room.send("input", this.lastInputSent);
    }

    const state: any = this.room.state;
    state.entities.forEach((entity: any, id: string) => {
      const v = this.views.get(id);
      if (!v) return;

      let cx: number, cy: number;
      if (id === this.myId && state.phase === "playing" && !entity.stunned) {
        // 自分のキャラはローカル予測で即時移動（入力遅延を消す）
        ({ x: cx, y: cy } = this.predictSelf(v, entity, dtMs, up, down, left, right));
      } else {
        // 他キャラ＆スタン中はサーバー位置へ補間
        const t = (id === this.myId) ? 0.4 : 0.25;
        cx = Phaser.Math.Linear(v.container.x, entity.x, t);
        cy = Phaser.Math.Linear(v.container.y, entity.y, t);
      }
      v.container.setPosition(cx, cy);
      v.container.setDepth(cy); // y-sort

      // 移動方向の算出（自分は予測入力ベース、他者はサーバー速度ベース）
      let dx: number, dy: number;
      let moving: boolean;
      if (id === this.myId && state.phase === "playing" && !entity.stunned) {
        dx = (right ? 1 : 0) - (left ? 1 : 0);
        dy = (down ? 1 : 0) - (up ? 1 : 0);
        moving = (up || down || left || right);
      } else {
        dx = entity.vx; dy = entity.vy;
        moving = Math.hypot(entity.vx, entity.vy) > 5 && !entity.stunned;
      }

      // 向き・歩行/待機ポーズの適用（パンチ中は触らない）
      if (!v.punching) {
        if (moving) {
          const d = dirFromVector(dx, dy);
          if (d) { v.dir = d.dir; v.flip = d.flip; }
          applyCharPose(v.sprite, v.dir, "walk", v.flip, CHAR_DISPLAY_H);
        } else {
          applyCharPose(v.sprite, v.dir, "idle", v.flip, CHAR_DISPLAY_H);
        }
      }

      // 足音（自キャラのみ、歩行アニメのコマ切替に同期）
      if (moving && !v.punching && id === this.myId) {
        const step = v.sprite.anims.currentFrame?.index ?? 0;
        if (step !== v.lastStep) {
          sfxFootstep();
          v.lastStep = step;
        }
      }

      v.container.setAlpha(entity.stunned ? 0.45 : 1);

      if (v.nameLabel) v.nameLabel.setPosition(cx, cy - 38);
    });

    const phase = state.phase;
    if (phase === "playing") {
      this.timerText.setText(state.timeLeft.toFixed(1));
      this.hud.setText(`プレイヤー: ${state.players.size}/4`);
    } else if (phase === "lobby") {
      this.timerText.setText("");
      this.hud.setText(`ロビー — 人数: ${state.players.size}/4`);
    } else if (phase === "ended") {
      this.timerText.setText("END");
      this.hud.setText("");
    }

    this.refreshScoreboard();
  }

  // --- クライアント予測 ---

  private predictSelf(
    v: EntityView, entity: any, dtMs: number,
    up: boolean, down: boolean, left: boolean, right: boolean,
  ): { x: number; y: number } {
    const dt = Math.min(dtMs, 50) / 1000; // 大きなフレーム飛びを抑制
    let px = v.container.x;
    let py = v.container.y;

    // サーバー初回位置への同期（予測開始時に一度合わせる）
    if (!this.predictReady) {
      this.predictReady = true;
      px = entity.x; py = entity.y;
    }

    let dx = 0, dy = 0;
    if (up) dy -= 1;
    if (down) dy += 1;
    if (left) dx -= 1;
    if (right) dx += 1;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }

    const mapW = this.room.state ? (this.room.state as any).mapWidth : 1280;
    const mapH = this.room.state ? (this.room.state as any).mapHeight : 720;

    let nx = px + dx * PLAYER_SPEED * dt;
    let ny = py + dy * PLAYER_SPEED * dt;
    // サーバーと同じ軸別衝突解決
    if (this.collidesObstacle(nx, py, ENTITY_RADIUS)) nx = px;
    if (this.collidesObstacle(nx, ny, ENTITY_RADIUS)) ny = py;
    nx = Phaser.Math.Clamp(nx, ENTITY_RADIUS, mapW - ENTITY_RADIUS);
    ny = Phaser.Math.Clamp(ny, ENTITY_RADIUS, mapH - ENTITY_RADIUS);

    // サーバー確定位置へのゆるい補正（ズレが大きければ強めに寄せる）
    const drift = Math.hypot(entity.x - nx, entity.y - ny);
    const corr = drift > 50 ? 0.3 : 0.04;
    nx = Phaser.Math.Linear(nx, entity.x, corr);
    ny = Phaser.Math.Linear(ny, entity.y, corr);

    return { x: nx, y: ny };
  }

  private collidesObstacle(x: number, y: number, r: number): boolean {
    for (const o of this.obstacleRects) {
      const cx = Math.max(o.x, Math.min(x, o.x + o.w));
      const cy = Math.max(o.y, Math.min(y, o.y + o.h));
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
    }
    return false;
  }

  // --- 墓 ---

  private addGrave(g: any) {
    const c = this.add.container(g.x, g.y).setDepth(g.y - 1);
    // 土まんじゅう
    const mound = this.add.ellipse(0, 8, 30, 12, 0x3c3328, 0.9);
    // 墓石（角丸風に矩形＋頭の半円）
    const stone = this.add.rectangle(0, -4, 16, 20, 0x9a9a9a).setStrokeStyle(2, 0x5a5a5a);
    const stoneTop = this.add.arc(0, -14, 8, 0, 180, false, 0x9a9a9a)
      .setStrokeStyle(2, 0x5a5a5a).setRotation(Math.PI);
    // 十字
    const crossV = this.add.rectangle(0, -8, 3, 10, 0x6a6a6a);
    const crossH = this.add.rectangle(0, -11, 8, 3, 0x6a6a6a);
    c.add([mound, stone, stoneTop, crossV, crossH]);
    this.worldLayer.add(c);
    this.graveViews.set(g, c);

    // 出現演出: ポンと跳ねる
    c.setScale(0.2);
    this.tweens.add({ targets: c, scale: 1, duration: 260, ease: "Back.easeOut" });
  }

  private removeGrave(g: any) {
    const c = this.graveViews.get(g);
    if (c) { c.destroy(); this.graveViews.delete(g); }
  }

  // --- 描画 ---

  private drawObstacle(o: any) {
    const color = o.kind === "pillar" ? 0x6e6e6e : o.kind === "bench" ? 0x6a4a2c : 0x8a6a3a;
    const top = o.kind === "pillar" ? 0x9c9c9c : o.kind === "bench" ? 0x8d6534 : 0xb38a52;
    // 影
    this.add.rectangle(o.x + o.w / 2 + 3, o.y + o.h / 2 + 6, o.w + 4, o.h + 4, 0x000000, 0.35)
      .setDepth(o.y + o.h / 2 - 0.5);
    const rect = this.add.rectangle(o.x + o.w / 2, o.y + o.h / 2, o.w, o.h, color)
      .setStrokeStyle(2, 0x222222);
    rect.setDepth(o.y + o.h / 2);
    // ハイライト
    this.add.rectangle(o.x + o.w / 2, o.y + 3, o.w - 4, 4, top, 0.7)
      .setDepth(o.y + o.h / 2 + 0.1);
  }

  private addEntityView(id: string, entity: any) {
    const container = this.add.container(entity.x, entity.y);
    // イラストスプライト（足元がコンテナ原点に来るよう origin を最下端付近へ）
    const sprite = this.add.sprite(0, 0, CHAR_INITIAL_TEX)
      .setOrigin(0.5, 0.96);
    applyCharPose(sprite, "front", "idle", false, CHAR_DISPLAY_H);
    // 影（足元＝原点の真下にぴったり敷く）
    const shadow = this.add.ellipse(0, 0, 26, 9, 0x000000, 0.4);

    container.add([shadow, sprite]);
    this.worldLayer.add(container);

    const view: EntityView = {
      container, shadow, sprite,
      lastStep: 0,
      punching: false,
      dir: "front",
      flip: false,
    };
    this.views.set(id, view);
    this.updateLabelForPhase(id, entity);
  }

  private updateLabelForPhase(id: string, entity: any) {
    const v = this.views.get(id);
    if (!v) return;
    const phase = (this.room.state as any).phase;
    const showLabel = entity.isPlayer && (phase === "lobby" || phase === "ended");
    if (showLabel && !v.nameLabel) {
      const player = (this.room.state as any).players.get(id);
      const labelColor = id === this.myId ? "#ffe066" : "#ffffff";
      const text = (player?.name || "?") + (id === this.myId ? " (YOU)" : "");
      v.nameLabel = this.add.text(v.container.x, v.container.y - 38, text, {
        fontSize: "12px", color: labelColor, stroke: "#000", strokeThickness: 3,
      }).setOrigin(0.5).setDepth(5000);
    } else if (!showLabel && v.nameLabel) {
      v.nameLabel.destroy();
      v.nameLabel = undefined;
    }
  }

  private flashHit(id: string) {
    const v = this.views.get(id);
    if (!v) return;
    v.hitFlash?.stop();
    v.sprite.setTintFill(0xffffff);
    v.hitFlash = this.tweens.add({
      targets: {}, duration: 120,
      onComplete: () => v.sprite.clearTint(),
    });

    const entity: any = (this.room.state as any).entities.get(id);
    const isPlayer = entity?.isPlayer;

    // 星パーティクル
    this.spawnStarBurst(v.container.x, v.container.y);

    if (isPlayer) {
      sfxHitPlayer();
      this.cameras.main.shake(160, 0.006);
      this.applySlowMo();
    } else {
      sfxHitNpc();
      this.cameras.main.shake(80, 0.002);
    }
  }

  private spawnStarBurst(x: number, y: number) {
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 18 + Math.random() * 12;
      const star = this.add.star(x, y, 4, 3, 7, 0xffe066).setDepth(6000);
      this.tweens.add({
        targets: star,
        x: x + Math.cos(angle) * (28 + dist),
        y: y + Math.sin(angle) * (28 + dist),
        alpha: { from: 1, to: 0 },
        scale: { from: 1, to: 0.4 },
        angle: 180 + Math.random() * 180,
        duration: 380 + Math.random() * 200,
        ease: "Quad.easeOut",
        onComplete: () => star.destroy(),
      });
    }
  }

  private applySlowMo() {
    this.time.timeScale = 0.35;
    this.tweens.timeScale = 0.35;
    // time/tween のスケールが下がっているのでDOMのsetTimeoutで戻す
    setTimeout(() => {
      this.time.timeScale = 1;
      this.tweens.timeScale = 1;
    }, 220);
  }

  private popScore(playerId: string, diff: number) {
    const entity = (this.room.state as any).entities.get(playerId);
    if (!entity) return;
    const v = this.views.get(playerId);
    const x = v ? v.container.x : entity.x;
    const y = v ? v.container.y - 30 : entity.y - 30;
    const color = diff > 0 ? "#7ee787" : "#ff7878";
    const text = (diff > 0 ? "+" : "") + diff;
    const t = this.add.text(x, y, text, {
      fontSize: "26px", color, fontStyle: "bold",
      stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(6500);
    this.tweens.add({
      targets: t, y: y - 40, alpha: { from: 1, to: 0 }, scale: { from: 1.3, to: 1 },
      duration: 800, ease: "Quad.easeOut",
      onComplete: () => t.destroy(),
    });
    if (playerId === this.myId && diff > 0) sfxScore();
  }

  private removeEntityView(id: string) {
    const v = this.views.get(id);
    if (!v) return;
    v.container.destroy();
    v.nameLabel?.destroy();
    v.attackFx?.destroy();
    this.views.delete(id);
  }

  private showAttackFx(id: string, entity: any) {
    const v = this.views.get(id);
    if (!v) return;
    // 攻撃方向のパンチ画像に差し替え、その方向へ素早く突き出して戻す
    const cos = Math.cos(entity.dir);
    const d = dirFromAngle(entity.dir);
    v.punching = true;
    v.dir = d.dir; v.flip = d.flip;
    applyCharPose(v.sprite, d.dir, "punch", d.flip, CHAR_DISPLAY_H);
    const lunge = 8;
    this.tweens.add({
      targets: v.sprite,
      x: cos * lunge,
      y: -Math.abs(Math.sin(entity.dir)) * 2,
      duration: 70, ease: "Quad.easeOut", yoyo: true, hold: 30,
      onComplete: () => v.sprite.setPosition(0, 0),
    });
    // 攻撃モーション後、立ち絵へ戻す（次フレームで歩行/待機が再判定される）
    this.time.delayedCall(220, () => {
      if (!v.sprite.active) return;
      v.punching = false;
      applyCharPose(v.sprite, v.dir, "idle", v.flip, CHAR_DISPLAY_H);
      v.sprite.setPosition(0, 0);
    });
    this.spawnConeFlash(v.container.x, v.container.y, entity.dir);
  }

  private spawnConeFlash(x: number, y: number, dir: number) {
    // まっすぐな帯。矩形を回転させて方向に重ねる
    const length = 64;
    const width = 36;
    const cx = x + Math.cos(dir) * (length / 2);
    const cy = y + Math.sin(dir) * (length / 2);
    const rect = this.add.rectangle(cx, cy, length, width, 0xffffff, 0.22)
      .setRotation(dir).setDepth(4900);
    this.tweens.add({
      targets: rect, alpha: 0, duration: 180,
      onComplete: () => rect.destroy(),
    });
  }

  private onPhaseChanged() {
    const state: any = this.room.state;
    const phase = state.phase;
    state.entities?.forEach((entity: any, id: string) => this.updateLabelForPhase(id, entity));

    if (phase === "lobby") {
      this.phaseText.setText("LOBBY — 「準備 OK」で開始");
      this.readyButton.setVisible(true).setInteractive({ useHandCursor: true }).setText("[ 準備 OK ]");
    } else if (phase === "playing") {
      this.phaseText.setText("START!");
      this.time.delayedCall(1200, () => {
        if ((this.room.state as any).phase === "playing") this.phaseText.setText("");
      });
      this.readyButton.setVisible(false);
      sfxRoundStart();
      this.lastMyScore = 0;
      this.predictReady = false; // ラウンド開始位置に再同期
    } else if (phase === "ended") {
      sfxRoundEnd();
      const players = Array.from(state.players.values()) as any[];
      players.sort((a, b) => b.score - a.score);
      const winner = players[0];
      this.phaseText.setText(winner ? `WINNER: ${winner.name}  ${winner.score}pt` : "終了");
      this.readyButton.setVisible(false);
    }
  }

  private refreshScoreboard() {
    const state: any = this.room.state;
    const players = Array.from(state.players.values()) as any[];
    players.sort((a, b) => b.score - a.score);

    // 既存の行を更新 or 追加
    while (this.scoreLines.length < players.length) {
      const line = this.add.text(0, 20 + this.scoreLines.length * 22, "", {
        fontSize: "16px", color: "#ffffff",
      });
      this.scoreBox.add(line);
      this.scoreLines.push(line);
    }
    while (this.scoreLines.length > players.length) {
      this.scoreLines.pop()?.destroy();
    }
    players.forEach((p, i) => {
      const isMe = p.entityId === this.myId;
      this.scoreLines[i].setText(`${i + 1}. ${p.name}  ${p.score}`);
      this.scoreLines[i].setColor(isMe ? "#ffe066" : "#ffffff");
    });
  }
}
