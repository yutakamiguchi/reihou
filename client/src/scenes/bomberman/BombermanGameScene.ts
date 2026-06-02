import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";
import {
  preloadCharTextures, ensureCharAnims, applyCharPose,
  CHAR_INITIAL_TEX, type Dir,
} from "../../character";
import { COLORS } from "../../colors";
import { sfxHitPlayer, sfxScore, sfxRoundStart, sfxRoundEnd } from "../../sfx";
import { addMoveKeys } from "../../ui/inputKeys";

const CHAR_DISPLAY_H = 48;

// サーバー(BombermanRoom)と一致させる移動パラメータ。クライアント予測で使用。
const BASE_SPEED = 144;
const SPEED_PER_LEVEL = 0.22;
const SNAP_EPS = 2;
const FIXED_DT = 1 / 30; // サーバーと同じ固定タイムステップ

// 自キャラのローカル予測状態（サーバーのセル移動を再現）。
interface PredictState {
  col: number; row: number;
  x: number; y: number;
  dir: number; // 0=下 1=左 2=右 3=上（サーバーと同じ）
  move: { targetCol: number; targetRow: number } | null;
}

// 送信済みでサーバー未確定の入力（reconcile で再適用する）。
interface PendingInput { seq: number; up: boolean; down: boolean; left: boolean; right: boolean; }

interface PlayerView {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Ellipse;
  nameLabel?: Phaser.GameObjects.Text;
  lastX: number;
  lastY: number;
  wasAlive: boolean;
  dir: Dir;
  flip: boolean;
}

export class BombermanGameScene extends Phaser.Scene {
  private room!: Room;
  private myId!: string;
  private offsetX = 0;
  private offsetY = 0;
  private ts = 48;

  private players = new Map<string, PlayerView>();
  private bombs = new Map<string, Phaser.GameObjects.Container>();
  private flames = new Map<string, Phaser.GameObjects.Rectangle>();
  private items = new Map<string, Phaser.GameObjects.Container>();
  private softBlocks = new Map<string, Phaser.GameObjects.Rectangle>();

  private worldLayer!: Phaser.GameObjects.Layer;
  private timerText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private hud!: Phaser.GameObjects.Text;
  private scoreBox!: Phaser.GameObjects.Container;
  private scoreLines: Phaser.GameObjects.Text[] = [];
  private readyButton!: Phaser.GameObjects.Text;
  private addCpuButton!: Phaser.GameObjects.Text;
  private removeCpuButton!: Phaser.GameObjects.Text;

  private keys!: {
    W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    UP: Phaser.Input.Keyboard.Key; DOWN: Phaser.Input.Keyboard.Key;
    LEFT: Phaser.Input.Keyboard.Key; RIGHT: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };
  // 押されている方向キーを「押した順」で保持。先に押した方向を優先する。
  private dirOrder: Array<"up" | "down" | "left" | "right"> = [];

  // 自キャラのローカル予測。サーバー初回位置で初期化する。
  private predict: PredictState | null = null;
  private inputSeq = 0;                  // 送信した入力の通し番号
  private pending: PendingInput[] = [];  // サーバー未確定の入力キュー
  private predictAccum = 0;              // 固定ステップ用アキュムレータ

  constructor() { super("BombermanGame"); }

  init(data: { room: Room }) {
    this.room = data.room;
    this.myId = this.room.sessionId;
  }

  preload() {
    preloadCharTextures(this);
  }

  create() {
    const { width, height } = this.scale;
    ensureCharAnims(this);
    const state: any = this.room.state;
    this.ts = state.tileSize;
    const gridW = state.cols * this.ts;
    const gridH = state.rows * this.ts;
    this.offsetX = Math.floor((width - gridW) / 2);
    this.offsetY = Math.floor((height - gridH) / 2) + 20;

    this.add.rectangle(width / 2, height / 2, width, height, 0x2a2f3a);

    for (let row = 0; row < state.rows; row++) {
      for (let col = 0; col < state.cols; col++) {
        const c = this.cellCenter(col, row);
        if (this.isHardWall(col, row, state.cols, state.rows)) {
          this.add.rectangle(c.x, c.y, this.ts, this.ts, 0x5a6270).setStrokeStyle(2, 0x3a4150);
          this.add.rectangle(c.x, c.y - this.ts * 0.18, this.ts, this.ts * 0.3, 0x6e7686, 0.7);
        } else {
          const shade = ((col + row) & 1) === 0 ? 0x3c8a4a : 0x46974f;
          this.add.rectangle(c.x, c.y, this.ts, this.ts, shade);
        }
      }
    }
    this.add.rectangle(width / 2, this.offsetY + gridH / 2, gridW + 4, gridH + 4, 0, 0)
      .setStrokeStyle(4, 0x1a1d24);

    this.worldLayer = this.add.layer();

    this.timerText = this.add.text(width / 2, 14, "", {
      fontSize: "32px", color: "#ffffff", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5, 0).setDepth(1000);
    this.hud = this.add.text(12, 12, "", { fontSize: "14px", color: "#cccccc" }).setDepth(1000);
    this.phaseText = this.add.text(width / 2, 60, "", {
      fontSize: "22px", color: "#ffe066", stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5).setDepth(1000);

    if (state.code) {
      const codeBox = this.add.text(12, 36, `ROOM CODE: ${state.code}`, {
        fontSize: "16px", color: "#ffe066", fontStyle: "bold",
        backgroundColor: "#1a1d24", padding: { x: 8, y: 4 } as any,
      }).setDepth(1000).setInteractive({ useHandCursor: true });
      codeBox.on("pointerdown", () => {
        navigator.clipboard?.writeText(state.code).catch(() => {});
        codeBox.setText(`COPIED!  ${state.code}`);
        this.time.delayedCall(1200, () => codeBox.setText(`ROOM CODE: ${state.code}`));
      });
    }

    const scorePanel = this.add.rectangle(width - 12, 12, 200, 130, 0x000000, 0.5)
      .setOrigin(1, 0).setStrokeStyle(2, 0x666666).setDepth(999);
    void scorePanel;
    this.scoreBox = this.add.container(width - 200 - 12 + 12, 12 + 8).setDepth(1000);
    this.scoreBox.add(this.add.text(0, 0, "WINS", { fontSize: "14px", color: "#aaaaaa", fontStyle: "bold" }));

    this.readyButton = this.add.text(width / 2, height / 2, "[ 準備 OK ]", {
      fontSize: "32px", color: "#7ee787", backgroundColor: "#222",
      padding: { x: 16, y: 8 } as any, fontStyle: "bold",
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(1000);
    this.readyButton.on("pointerdown", () => {
      this.room.send("ready");
      this.readyButton.setText("準備済み...").disableInteractive();
    });

    // CPU 追加 / 削除（ロビー中のみ表示）
    this.addCpuButton = this.add.text(width / 2 - 90, height / 2 + 60, "[ ＋CPU ]", {
      fontSize: "20px", color: "#7ec0e7", backgroundColor: "#222",
      padding: { x: 12, y: 6 } as any, fontStyle: "bold",
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(1000);
    this.addCpuButton.on("pointerdown", () => this.room.send("addBot"));

    this.removeCpuButton = this.add.text(width / 2 + 90, height / 2 + 60, "[ －CPU ]", {
      fontSize: "20px", color: "#e7a07e", backgroundColor: "#222",
      padding: { x: 12, y: 6 } as any, fontStyle: "bold",
    }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(1000);
    this.removeCpuButton.on("pointerdown", () => this.room.send("removeBot"));

    this.keys = addMoveKeys(this);
    this.keys.SPACE.on("down", () => this.room.send("placeBomb"));
    this.input.keyboard!.on("keydown-ESC", () => this.room.leave());

    const $ = getStateCallbacks(this.room);

    $(state).players.onAdd((p: any, id: string) => this.addPlayer(id, p));
    $(state).players.onRemove((_p: any, id: string) => this.removePlayer(id));

    $(state).softBlocks.onAdd((sb: any, key: string) => this.addSoftBlock(key, sb));
    $(state).softBlocks.onRemove((_sb: any, key: string) => this.removeSoftBlock(key));

    $(state).bombs.onAdd((b: any, id: string) => this.addBomb(id, b));
    $(state).bombs.onRemove((_b: any, id: string) => this.removeBomb(id));

    $(state).flames.onAdd((f: any, id: string) => this.addFlame(id, f));
    $(state).flames.onRemove((_f: any, id: string) => this.removeFlame(id));

    $(state).items.onAdd((it: any, id: string) => this.addItem(id, it));
    $(state).items.onRemove((_it: any, id: string) => this.removeItem(id));

    $(state).listen("phase", () => this.onPhaseChanged());

    this.room.onLeave(() => this.scene.start("BombermanLobby"));

    this.onPhaseChanged();
  }

  update(_t: number, dtMs: number) {
    const state: any = this.room.state;

    // 押下状態から「先押し優先の単一方向」を求める。
    // 斜め同時押しでも1方向だけに絞ることで、予測とサーバーの判断を一致させ
    // 本番のレイテンシ下での壁めり込み/ズレを防ぐ。
    const held = {
      up: this.keys.W.isDown || this.keys.UP.isDown,
      down: this.keys.S.isDown || this.keys.DOWN.isDown,
      left: this.keys.A.isDown || this.keys.LEFT.isDown,
      right: this.keys.D.isDown || this.keys.RIGHT.isDown,
    };
    // 新たに押された方向を順序の末尾へ、離された方向は除去
    (["up", "down", "left", "right"] as const).forEach((d) => {
      if (held[d] && !this.dirOrder.includes(d)) this.dirOrder.push(d);
      if (!held[d]) this.dirOrder = this.dirOrder.filter((x) => x !== d);
    });
    // 最も古く押された（=先に押した）方向だけを有効にする
    const active = this.dirOrder[0];
    const up = active === "up";
    const down = active === "down";
    const left = active === "left";
    const right = active === "right";

    const myEntity: any = state.players.get(this.myId);
    const canPredict = myEntity && state.phase === "playing" && myEntity.alive && !myEntity.isBot;

    if (canPredict) {
      // サーバー確定位置へ予測を再構築し、未確定入力を再適用（リコンシリエーション）
      this.reconcile(myEntity);

      // 固定タイムステップで予測を進める。各ステップで seq採番→送信→pending積み→即適用。
      this.predictAccum += Math.min(dtMs, 250) / 1000;
      let steps = 0;
      while (this.predictAccum >= FIXED_DT && steps < 5) {
        this.predictAccum -= FIXED_DT;
        steps++;
        const seq = ++this.inputSeq;
        const cmd: PendingInput = { seq, up, down, left, right };
        this.pending.push(cmd);
        this.room.send("input", cmd);
        this.applyStep(this.predict!, cmd, myEntity.speed);
      }
    } else {
      this.predict = null;       // 死亡/非プレイ/bot は予測せずサーバー位置に従う
      this.pending = [];
      this.predictAccum = 0;
    }

    state.players.forEach((p: any, id: string) => {
      const v = this.players.get(id);
      if (!v) return;

      let sx: number, sy: number;
      if (id === this.myId && this.predict) {
        // 自分は予測位置へ「補間で」追従する。予測が再同期で飛んでも（テレポート）、
        // 画面表示はスッと寄るだけなので瞬間移動に見えない。通常移動は予測がほぼ等速
        // なので補間でも遅延を感じない。大きく飛んだ時だけ即座に合わせる。
        sx = this.offsetX + this.predict.x;
        sy = this.offsetY + this.predict.y;
        const jump = Math.hypot(sx - v.container.x, sy - v.container.y);
        if (jump > this.ts * 2.5) {
          v.container.setPosition(sx, sy); // 初回配置など極端な差は即合わせ
        } else {
          v.container.setPosition(
            Phaser.Math.Linear(v.container.x, sx, 0.4),
            Phaser.Math.Linear(v.container.y, sy, 0.4),
          );
        }
      } else {
        // 他者はサーバー位置へ補間
        sx = this.offsetX + p.x;
        sy = this.offsetY + p.y;
        v.container.setPosition(
          Phaser.Math.Linear(v.container.x, sx, 0.35),
          Phaser.Math.Linear(v.container.y, sy, 0.35),
        );
      }
      v.container.setDepth(sy);

      // 向き（dir: 0=下/front, 1=左, 2=右, 3=上/back）。自分は予測の向きを優先（即時）。
      const dirVal = (id === this.myId && this.predict) ? this.predict.dir : p.dir;
      if (dirVal === 0) { v.dir = "front"; v.flip = false; }
      else if (dirVal === 3) { v.dir = "back"; v.flip = false; }
      else if (dirVal === 1) { v.dir = "side"; v.flip = true; }
      else if (dirVal === 2) { v.dir = "side"; v.flip = false; }

      // 歩行/待機ポーズの適用
      const moving = Math.hypot(sx - v.lastX, sy - v.lastY) > 0.4 && p.alive;
      v.lastX = sx; v.lastY = sy;
      applyCharPose(v.sprite, v.dir, moving ? "walk" : "idle", v.flip, CHAR_DISPLAY_H);

      if (v.wasAlive && !p.alive) {
        v.wasAlive = false;
        this.killEffect(v);
      }
      v.container.setAlpha(p.alive ? 1 : 0.25);

      if (v.nameLabel) v.nameLabel.setPosition(v.container.x, v.container.y - 40);
    });

    if (state.phase === "playing") {
      this.timerText.setText(state.timeLeft.toFixed(1));
      const aliveCount = Array.from(state.players.values()).filter((p: any) => p.alive).length;
      this.hud.setText(`生存: ${aliveCount}/${state.players.size}`);
    } else if (state.phase === "lobby") {
      this.timerText.setText("");
      this.hud.setText(`ロビー — 人数: ${state.players.size}/4`);
    } else {
      this.timerText.setText("END");
      this.hud.setText("");
    }

    this.refreshScoreboard();
  }

  // --- クライアント予測（サーバーリコンシリエーション） ---

  // サーバー確定状態から予測を再構築し、未確定入力(pending)を固定ステップで再適用する。
  // これにより平常時は予測とサーバーが完全一致し、ズレ＝テレポートが起きない。
  private reconcile(entity: any) {
    // 確定状態で予測を作り直す
    this.predict = {
      col: entity.col, row: entity.row,
      x: entity.x, y: entity.y, dir: entity.dir,
      move: entity.moveTargetCol >= 0
        ? { targetCol: entity.moveTargetCol, targetRow: entity.moveTargetRow }
        : null,
    };
    // サーバーが処理済みの入力を pending から破棄
    this.pending = this.pending.filter((c) => c.seq > entity.lastSeq);
    // 残りの未確定入力を順に再適用
    for (const c of this.pending) this.applyStep(this.predict, c, entity.speed);
  }

  // 固定タイムステップ1回ぶんの移動を予測状態に適用する。
  // サーバー movePlayer と同一ロジック（速度・SNAP_EPS・到達スナップ）でなければならない。
  private applyStep(pr: PredictState, cmd: PendingInput, speedLevel: number) {
    const ts = this.ts;
    const hasInput = cmd.up || cmd.down || cmd.left || cmd.right;

    // 移動中でなく、入力があれば次の目標セルを決める
    if (!pr.move && hasInput) {
      let dc = 0, dr = 0, dir = pr.dir;
      if (cmd.up) { dr = -1; dir = 3; }
      else if (cmd.down) { dr = 1; dir = 0; }
      else if (cmd.left) { dc = -1; dir = 1; }
      else if (cmd.right) { dc = 1; dir = 2; }
      if (dc !== 0 || dr !== 0) {
        pr.dir = dir;
        const ncol = pr.col + dc, nrow = pr.row + dr;
        if (this.isPassable(ncol, nrow)) pr.move = { targetCol: ncol, targetRow: nrow };
      }
    }

    if (!pr.move) return;

    const tx = pr.move.targetCol * ts + ts / 2;
    const ty = pr.move.targetRow * ts + ts / 2;
    const speed = BASE_SPEED * (1 + (speedLevel - 1) * SPEED_PER_LEVEL);
    const step = speed * FIXED_DT;
    const ddx = tx - pr.x, ddy = ty - pr.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist <= step + SNAP_EPS) {
      pr.x = tx; pr.y = ty;
      pr.col = pr.move.targetCol; pr.row = pr.move.targetRow;
      pr.move = null;
    } else {
      pr.x += (ddx / dist) * step;
      pr.y += (ddy / dist) * step;
    }
  }

  // クライアント側の通行判定（サーバー isPassable と同じルール）
  private isPassable(col: number, row: number): boolean {
    const state: any = this.room.state;
    const cols = state.cols, rows = state.rows;
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    if (this.isHardWall(col, row, cols, rows)) return false;
    if (this.softBlocks.has(`${col}_${row}`)) return false;
    // 爆弾セルは通れない（state.bombs を走査）
    let blocked = false;
    state.bombs.forEach((b: any) => { if (b.col === col && b.row === row) blocked = true; });
    return !blocked;
  }

  private cellCenter(col: number, row: number): { x: number; y: number } {
    return {
      x: this.offsetX + col * this.ts + this.ts / 2,
      y: this.offsetY + row * this.ts + this.ts / 2,
    };
  }

  private isHardWall(col: number, row: number, cols: number, rows: number): boolean {
    if (col <= 0 || row <= 0 || col >= cols - 1 || row >= rows - 1) return true;
    return col % 2 === 0 && row % 2 === 0;
  }

  private addPlayer(id: string, p: any) {
    const sx = this.offsetX + p.x;
    const sy = this.offsetY + p.y;
    const container = this.add.container(sx, sy);
    const shadow = this.add.ellipse(0, 0, 26, 9, 0x000000, 0.4);
    const sprite = this.add.sprite(0, 0, CHAR_INITIAL_TEX).setOrigin(0.5, 0.96);
    applyCharPose(sprite, "front", "idle", false, CHAR_DISPLAY_H);
    sprite.setTint(COLORS[p.colorIndex % COLORS.length]);
    if (id === this.myId) {
      const ring = this.add.ellipse(0, 2, 30, 12, 0xffe066, 0).setStrokeStyle(2, 0xffe066);
      container.add(ring);
    }
    container.add([shadow, sprite]);
    this.worldLayer.add(container);

    this.players.set(id, { container, sprite, shadow, lastX: sx, lastY: sy, wasAlive: true, dir: "front", flip: false });
    this.updateLabelForPhase(id, p);
  }

  private removePlayer(id: string) {
    const v = this.players.get(id);
    if (!v) return;
    v.container.destroy();
    v.nameLabel?.destroy();
    this.players.delete(id);
  }

  private killEffect(v: PlayerView) {
    sfxHitPlayer();
    this.cameras.main.shake(120, 0.004);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const star = this.add.star(v.container.x, v.container.y, 4, 3, 7, 0xffffff).setDepth(6000);
      this.tweens.add({
        targets: star,
        x: v.container.x + Math.cos(angle) * 36,
        y: v.container.y + Math.sin(angle) * 36,
        alpha: 0, duration: 400, ease: "Quad.easeOut",
        onComplete: () => star.destroy(),
      });
    }
  }

  private updateLabelForPhase(id: string, p: any) {
    const v = this.players.get(id);
    if (!v) return;
    const phase = (this.room.state as any).phase;
    const showLabel = phase === "lobby" || phase === "ended";
    if (showLabel && !v.nameLabel) {
      const labelColor = id === this.myId ? "#ffe066" : "#ffffff";
      const text = (p.name || "?") + (id === this.myId ? " (YOU)" : "");
      v.nameLabel = this.add.text(v.container.x, v.container.y - 40, text, {
        fontSize: "12px", color: labelColor, stroke: "#000", strokeThickness: 3,
      }).setOrigin(0.5).setDepth(5000);
    } else if (!showLabel && v.nameLabel) {
      v.nameLabel.destroy();
      v.nameLabel = undefined;
    }
  }

  private addSoftBlock(key: string, sb: any) {
    const c = this.cellCenter(sb.col, sb.row);
    const r = this.add.rectangle(c.x, c.y, this.ts - 4, this.ts - 4, 0xb07a3a).setStrokeStyle(2, 0x7a5326);
    r.setDepth(c.y - 1);
    this.softBlocks.set(key, r);
  }

  private removeSoftBlock(key: string) {
    const r = this.softBlocks.get(key);
    if (!r) return;
    this.tweens.add({ targets: r, scaleX: 0, scaleY: 0, alpha: 0, duration: 160, ease: "Back.easeIn", onComplete: () => r.destroy() });
    this.softBlocks.delete(key);
  }

  private addBomb(id: string, b: any) {
    const c = this.cellCenter(b.col, b.row);
    const cont = this.add.container(c.x, c.y).setDepth(c.y);
    const body = this.add.circle(0, 2, this.ts * 0.32, 0x222222).setStrokeStyle(2, 0x000000);
    const hi = this.add.circle(-this.ts * 0.1, -this.ts * 0.06, this.ts * 0.07, 0xaaaaaa);
    const fuse = this.add.rectangle(0, -this.ts * 0.32, 3, 8, 0xffaa44);
    cont.add([body, hi, fuse]);
    this.worldLayer.add(cont);
    this.bombs.set(id, cont);
    this.tweens.add({ targets: cont, scaleX: 1.18, scaleY: 1.18, duration: 280, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  }

  private removeBomb(id: string) {
    const cont = this.bombs.get(id);
    if (cont) { cont.destroy(); this.bombs.delete(id); }
  }

  private addFlame(id: string, f: any) {
    const c = this.cellCenter(f.col, f.row);
    const r = this.add.rectangle(c.x, c.y, this.ts - 2, this.ts - 2, 0xff8a3c, 0.9).setDepth(5500);
    this.flames.set(id, r);
    const inner = this.add.rectangle(c.x, c.y, this.ts * 0.5, this.ts * 0.5, 0xffe066, 0.95).setDepth(5501);
    this.tweens.add({ targets: [r, inner], alpha: 0, duration: 480, onComplete: () => inner.destroy() });
  }

  private removeFlame(id: string) {
    const r = this.flames.get(id);
    if (r) { r.destroy(); this.flames.delete(id); }
  }

  private addItem(id: string, it: any) {
    const c = this.cellCenter(it.col, it.row);
    const cont = this.add.container(c.x, c.y).setDepth(c.y - 500);
    const color = it.kind === "bomb" ? 0x333333 : it.kind === "fire" ? 0xff5533 : 0x44aaff;
    const box = this.add.rectangle(0, 0, this.ts * 0.6, this.ts * 0.6, 0xffffff, 0.95).setStrokeStyle(2, color);
    const icon = this.add.circle(0, 0, this.ts * 0.16, color);
    cont.add([box, icon]);
    this.worldLayer.add(cont);
    this.items.set(id, cont);
    this.tweens.add({ targets: cont, y: c.y - 4, duration: 600, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  }

  private removeItem(id: string) {
    const cont = this.items.get(id);
    if (cont) {
      sfxScore();
      cont.destroy();
      this.items.delete(id);
    }
  }

  private onPhaseChanged() {
    const state: any = this.room.state;
    const phase = state.phase;
    state.players?.forEach((p: any, id: string) => this.updateLabelForPhase(id, p));

    if (phase === "lobby") {
      this.phaseText.setText("LOBBY — 「準備 OK」or CPUと対戦");
      this.readyButton.setVisible(true).setInteractive({ useHandCursor: true }).setText("[ 準備 OK ]");
      this.addCpuButton.setVisible(true);
      this.removeCpuButton.setVisible(true);
    } else if (phase === "playing") {
      this.phaseText.setText("START!");
      this.time.delayedCall(1200, () => {
        if ((this.room.state as any).phase === "playing") this.phaseText.setText("");
      });
      this.readyButton.setVisible(false);
      this.addCpuButton.setVisible(false);
      this.removeCpuButton.setVisible(false);
      sfxRoundStart();
      this.players.forEach(v => { v.wasAlive = true; });
    } else if (phase === "ended") {
      sfxRoundEnd();
      const players = Array.from(state.players.values()) as any[];
      const alive = players.filter(p => p.alive);
      const msg = alive.length === 1 ? `WINNER: ${alive[0].name}` : "DRAW";
      this.phaseText.setText(msg);
      this.readyButton.setVisible(false);
      this.addCpuButton.setVisible(false);
      this.removeCpuButton.setVisible(false);
    }
  }

  private refreshScoreboard() {
    const state: any = this.room.state;
    const players = Array.from(state.players.values()) as any[];
    players.sort((a, b) => b.score - a.score);

    while (this.scoreLines.length < players.length) {
      const line = this.add.text(0, 20 + this.scoreLines.length * 22, "", { fontSize: "16px", color: "#ffffff" });
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
