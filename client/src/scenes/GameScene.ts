import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";
import { COLORS, SKIN_TONES } from "../colors";
import { sfxHitPlayer, sfxHitNpc, sfxScore, sfxFootstep, sfxRoundStart, sfxRoundEnd } from "../sfx";

interface EntityView {
  container: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Ellipse;
  body: Phaser.GameObjects.Ellipse;
  head: Phaser.GameObjects.Arc;
  legL: Phaser.GameObjects.Rectangle;
  legR: Phaser.GameObjects.Rectangle;
  armL: Phaser.GameObjects.Rectangle;
  armR: Phaser.GameObjects.Rectangle;
  fist: Phaser.GameObjects.Arc;
  fistTween?: Phaser.Tweens.Tween;
  punching: boolean;
  nameLabel?: Phaser.GameObjects.Text;
  attackFx?: Phaser.GameObjects.Arc;
  selfHint?: Phaser.GameObjects.Arc;
  hitFlash?: Phaser.Tweens.Tween;
  walkPhase: number;
  lastFootstepPhase: number;
  skinTone: number;
}

export class GameScene extends Phaser.Scene {
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

  constructor() { super("Game"); }

  init(data: { room: Room }) {
    this.room = data.room;
    this.myId = this.room.sessionId;
  }

  create() {
    const { width, height } = this.scale;

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
    state.obstacles?.forEach((o: any) => this.drawObstacle(o));

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

    this.room.onLeave(() => this.scene.start("Lobby"));

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
      const t = 0.25;
      const cx = Phaser.Math.Linear(v.container.x, entity.x, t);
      const cy = Phaser.Math.Linear(v.container.y, entity.y, t);
      v.container.setPosition(cx, cy);
      v.container.setDepth(cy); // y-sort

      // 歩行アニメ
      const moving = Math.hypot(entity.vx, entity.vy) > 5 && !entity.stunned;
      if (moving) v.walkPhase += dtMs * 0.015;
      const sin = Math.sin(v.walkPhase);
      const bob = moving ? sin * 1.8 : 0;
      v.body.setY(0 + bob * 0.3);
      v.head.setPosition(Math.cos(entity.dir) * 5, -16 + bob * 0.6);
      // 足・腕の交互スイング
      if (moving) {
        v.legL.setY(10 + sin * 2);
        v.legR.setY(10 - sin * 2);
        v.armL.setY(-2 - sin * 2);
        v.armR.setY(-2 + sin * 2);
      } else {
        v.legL.setY(10); v.legR.setY(10);
        v.armL.setY(-2); v.armR.setY(-2);
      }

      // 足音（自キャラのみ、踏み込み位相で再生）
      if (moving && id === this.myId) {
        const phaseMod = ((v.walkPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const crossed =
          (v.lastFootstepPhase < Math.PI && phaseMod >= Math.PI) ||
          (v.lastFootstepPhase > phaseMod);
        if (crossed) sfxFootstep();
        v.lastFootstepPhase = phaseMod;
      }

      v.container.setAlpha(entity.stunned ? 0.45 : 1);

      if (v.nameLabel) v.nameLabel.setPosition(cx, cy - 38);
      if (v.selfHint) v.selfHint.setPosition(cx, cy);
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
    // 全キャラを同じ見た目に統一（本家のように群衆へ完全に溶け込ませる）
    const color = COLORS[0];
    const skin = SKIN_TONES[0];

    const container = this.add.container(entity.x, entity.y);
    // 影
    const shadow = this.add.ellipse(0, 10, 26, 9, 0x000000, 0.4);
    // 足（描画順は body より下、head より下になるよう先に追加）
    const legL = this.add.rectangle(-5, 10, 6, 8, 0x2a2a2a);
    const legR = this.add.rectangle(5, 10, 6, 8, 0x2a2a2a);
    // 腕
    const armL = this.add.rectangle(-11, -2, 5, 12, color).setStrokeStyle(1, 0x1a1a1a);
    const armR = this.add.rectangle(11, -2, 5, 12, color).setStrokeStyle(1, 0x1a1a1a);
    // 胴体（縦長楕円）
    const body = this.add.ellipse(0, 0, 22, 26, color).setStrokeStyle(2, 0x1a1a1a);
    // 頭
    const head = this.add.arc(0, -16, 8, 0, 360, false, skin).setStrokeStyle(2, 0x1a1a1a);
    // 拳（通常は胴体に隠れる位置、攻撃時に前へ伸びる）
    const fist = this.add.arc(0, 0, 6, 0, 360, false, skin)
      .setStrokeStyle(2, 0x1a1a1a)
      .setVisible(false);

    container.add([shadow, legL, legR, armL, armR, body, fist, head]);
    this.worldLayer.add(container);

    const view: EntityView = {
      container, shadow, body, head, legL, legR, armL, armR, fist,
      punching: false,
      walkPhase: Math.random() * Math.PI * 2,
      lastFootstepPhase: 0,
      skinTone: skin,
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

  private flashSelfHint() {
    const v = this.views.get(this.myId);
    if (!v) return;
    v.selfHint?.destroy();
    const ring = this.add.arc(v.container.x, v.container.y, 24, 0, 360, false, 0xffe066, 0)
      .setStrokeStyle(3, 0xffe066).setDepth(5000);
    v.selfHint = ring;
    this.tweens.add({
      targets: ring, alpha: { from: 1, to: 0 }, scale: { from: 1, to: 2.2 },
      duration: 2200,
      onComplete: () => { ring.destroy(); if (v.selfHint === ring) v.selfHint = undefined; },
    });
  }

  private flashHit(id: string) {
    const v = this.views.get(id);
    if (!v) return;
    v.hitFlash?.stop();
    const originalColor = v.body.fillColor;
    v.body.setFillStyle(0xffffff);
    v.hitFlash = this.tweens.add({
      targets: {}, duration: 120,
      onComplete: () => v.body.setFillStyle(originalColor),
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
    v.selfHint?.destroy();
    this.views.delete(id);
  }

  private showAttackFx(id: string, entity: any) {
    const v = this.views.get(id);
    if (!v) return;
    this.punchAnim(v, entity.dir);
    this.spawnConeFlash(v.container.x, v.container.y, entity.dir);
  }

  private punchAnim(v: EntityView, dir: number) {
    const REACH = 28;
    const cx = Math.cos(dir);
    const sy = Math.sin(dir);

    v.fistTween?.stop();
    v.fist.setVisible(true).setAlpha(1);
    v.fist.setPosition(cx * 8, sy * 8 - 2);
    v.punching = true;

    // 引きの腕（胴体側に少し戻る）
    const backArm = cx > 0 ? v.armL : v.armR;
    const punchArm = cx > 0 ? v.armR : v.armL;
    const backDefaultX = backArm.x;
    const punchDefaultX = punchArm.x;
    backArm.setX(backDefaultX - cx * 4);
    punchArm.setX(punchDefaultX + cx * 6);

    v.fistTween = this.tweens.add({
      targets: v.fist,
      x: cx * REACH,
      y: sy * REACH - 2,
      duration: 70,
      ease: "Quad.easeOut",
      yoyo: true,
      hold: 30,
      onComplete: () => {
        v.fist.setVisible(false);
        v.punching = false;
        backArm.setX(backDefaultX);
        punchArm.setX(punchDefaultX);
      },
    });
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
      this.phaseText.setText("自分の位置を確認！");
      this.time.delayedCall(2000, () => {
        if ((this.room.state as any).phase === "playing") this.phaseText.setText("");
      });
      this.readyButton.setVisible(false);
      this.flashSelfHint();
      sfxRoundStart();
      this.lastMyScore = 0;
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
