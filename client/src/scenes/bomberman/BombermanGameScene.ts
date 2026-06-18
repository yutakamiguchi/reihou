import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";
import {
  preloadBombermanChars, applyBombermanPose, bombermanTexKey, type Dir,
} from "../../character";
import { sfxHitPlayer, sfxScore, sfxRoundStart, sfxRoundEnd } from "../../sfx";
import { addMoveKeys } from "../../ui/inputKeys";
import { addTouchControls, type TouchControls } from "../../ui/touchControls";

const CHAR_DISPLAY_H = 48;

// ロビーで選べるマップ（server/maps.ts の MAP_IDS と一致させる）。
const MAP_CHOICES: Array<{ id: string; name: string }> = [
  { id: "classic", name: "クラシック" },
  { id: "belts", name: "ベルト" },
  { id: "warps", name: "ワープ" },
  { id: "mixed", name: "ミックス" },
  { id: "random", name: "ランダム" },
];

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
  justWarped: boolean; // 直前にワープ着地したセルにいる間 true（再ワープ防止）
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
  playerNo: number;
}

export class BombermanGameScene extends Phaser.Scene {
  private room!: Room;
  private myId!: string;
  private offsetX = 0;
  private offsetY = 0;
  private ts = 48;

  private warpPairs = new Map<string, { col: number; row: number }>();
  private gridContainer?: Phaser.GameObjects.Container;

  private players = new Map<string, PlayerView>();
  private bombs = new Map<string, { cont: Phaser.GameObjects.Container; body: Phaser.GameObjects.Arc; explodesAt: number; fuseMs: number }>();
  private flames = new Map<string, Phaser.GameObjects.Rectangle>();
  private items = new Map<string, Phaser.GameObjects.Container>();
  private softBlocks = new Map<string, Phaser.GameObjects.Rectangle>();

  private worldLayer!: Phaser.GameObjects.Layer;  // 盤面・駒（main カメラ）
  private uiLayer!: Phaser.GameObjects.Layer;     // HUD・操作（uiCam）
  private uiCam!: Phaser.Cameras.Scene2D.Camera;  // UI 等倍カメラ
  private rotateOverlay!: Phaser.GameObjects.Container; // 縦持ち案内
  private timerText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private hud!: Phaser.GameObjects.Text;
  private scoreBox!: Phaser.GameObjects.Container;
  private scoreLines: Phaser.GameObjects.Text[] = [];
  private readyButton!: Phaser.GameObjects.Text;
  private addCpuButton!: Phaser.GameObjects.Text;
  private removeCpuButton!: Phaser.GameObjects.Text;
  private mapLabel!: Phaser.GameObjects.Text;
  private mapButtons: Phaser.GameObjects.Text[] = [];

  private keys!: {
    W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    UP: Phaser.Input.Keyboard.Key; DOWN: Phaser.Input.Keyboard.Key;
    LEFT: Phaser.Input.Keyboard.Key; RIGHT: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };
  // 押されている方向キーを「押した順」で保持。先に押した方向を優先する。
  private dirOrder: Array<"up" | "down" | "left" | "right"> = [];
  private touch!: TouchControls;  // スマホ向け画面上タッチ操作
  private goingHome = false;      // ホームボタンで退室したか（true なら Hub へ）

  // 自キャラのローカル予測。サーバー初回位置で初期化する。
  private predict: PredictState | null = null;
  private inputSeq = 0;                  // 送信した入力の通し番号
  private pending: PendingInput[] = [];  // サーバー未確定の入力キュー
  private predictAccum = 0;              // 固定ステップ用アキュムレータ

  constructor() { super("BombermanGame"); }

  init(data: { room: Room }) {
    this.room = data.room;
    this.myId = this.room.sessionId;
    // Phaser はシーンインスタンスを使い回す。前回ゲームの破棄済みオブジェクトへの
    // 参照が Map/配列に残ると、再入場時に updateBombColors / refreshScoreboard などが
    // それを触って例外→描画ループが停止し画面が固まる。再入場ごとに初期化する。
    this.warpPairs.clear();
    this.players.clear();
    this.bombs.clear();
    this.flames.clear();
    this.items.clear();
    this.softBlocks.clear();
    this.scoreLines = [];
    this.mapButtons = [];
    this.dirOrder = [];
    this.pending = [];
    this.predict = null;
    this.inputSeq = 0;
    this.predictAccum = 0;
    this.goingHome = false;
  }

  preload() {
    preloadBombermanChars(this);
  }

  create() {
    const state: any = this.room.state;
    this.ts = state.tileSize;
    const gridW = state.cols * this.ts;
    const gridH = state.rows * this.ts;

    // === 2カメラ方式（MmoGameScene を踏襲）===
    // world用カメラ(main)を一様ズームして盤面を画面いっぱいに拡大（歪み無し）、
    // UI/操作は等倍の uiCam で別建て。盤面の ts はサーバー座標と一致のため固定。
    const width = this.scale.width;   // 1600（FIT固定。端末を回しても不変）
    const height = this.scale.height; // 900
    // 盤面ワールドは原点(0,0)起点。cellCenter / プレイヤー描画(offsetX+p.x)と整合。
    this.offsetX = 0;
    this.offsetY = 0;

    // ワールド層（盤面・駒・爆風など。main カメラのみが描画）
    this.worldLayer = this.add.layer();

    this.buildWarpPairs();
    this.rebuildGrid(); // grid を worldLayer へ（rebuildGrid 内で add）
    // 盤面の枠線
    this.worldLayer.add(
      this.add.rectangle(gridW / 2, gridH / 2, gridW + 4, gridH + 4, 0, 0)
        .setStrokeStyle(4, 0x1a1d24).setDepth(-1)
    );

    // UI層（HUD・ロビー操作・タッチ操作。uiCam のみが等倍で描画）
    this.uiLayer = this.add.layer();

    // --- カメラ: main=盤面をズーム表示 / uiCam=UIを等倍 ---
    // セーフエリア自体は index.html の env(safe-area-inset-*) でキャンバスごと内側に
    // 寄せて回避済み。ここはその上で残るわずかな見切れ対策＋見栄え用の余白。
    const PAD = 56;
    const zoom = Math.min((width - PAD * 2) / gridW, (height - PAD * 2) / gridH); // contain・一様（歪まない）
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(gridW / 2, gridH / 2);
    this.cameras.main.setBackgroundColor(0xffffff);
    this.cameras.main.ignore(this.uiLayer);
    this.uiCam = this.cameras.add(0, 0, width, height);
    this.uiCam.ignore(this.worldLayer);

    // ===== HUD / 操作UI（全て uiLayer・画面端アンカー・1600x900）=====
    // タイマー（💣ボタンの上＝右下。上端はノッチ等で隠れやすいので避ける）
    this.timerText = this.add.text(width - 170, 520, "", {
      fontSize: "40px", color: "#ffffff", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5, 0).setDepth(1000);
    // 生存数（左上）
    this.hud = this.add.text(16, 16, "", { fontSize: "20px", color: "#cccccc" }).setDepth(1000);
    // ホームへ戻る（ハブ）ボタン（左・少し下げて押しやすく）
    const homeBtn = this.add.text(16, 110, "← ホーム", {
      fontSize: "22px", color: "#ffffff", backgroundColor: "#333",
      padding: { x: 14, y: 8 } as any, fontStyle: "bold",
    }).setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(1000);
    homeBtn.on("pointerdown", () => { this.goingHome = true; this.room.leave(); });
    this.uiLayer.add(homeBtn);
    // 大きな状態表示（START!/勝敗）は画面中央オーバーレイ
    this.phaseText = this.add.text(width / 2, height / 2, "", {
      fontSize: "56px", color: "#ffe066", stroke: "#000", strokeThickness: 6,
    }).setOrigin(0.5).setDepth(2000);
    this.uiLayer.add([this.timerText, this.hud, this.phaseText]);

    if (state.code) {
      const codeBox = this.add.text(16, height - 40, `ROOM CODE: ${state.code}`, {
        fontSize: "18px", color: "#ffe066", fontStyle: "bold",
        backgroundColor: "#1a1d24", padding: { x: 8, y: 4 } as any,
      }).setDepth(1000).setInteractive({ useHandCursor: true });
      codeBox.on("pointerdown", () => {
        navigator.clipboard?.writeText(state.code).catch(() => {});
        codeBox.setText(`COPIED!  ${state.code}`);
        this.time.delayedCall(1200, () => codeBox.setText(`ROOM CODE: ${state.code}`));
      });
      this.uiLayer.add(codeBox);
    }

    // WINS（プレイヤー名）パネル: タイマーの上＝右下。ノッチ等で隠れない位置へ。
    const winW = 200;
    const winCx = width - 170;        // 💣ボタンと同じ x 中心
    const winPanel = this.add.rectangle(winCx, 360, winW, 150, 0x000000, 0.5)
      .setOrigin(0.5, 0).setStrokeStyle(2, 0x666666).setDepth(999);
    this.scoreBox = this.add.container(winCx - winW / 2 + 12, 368).setDepth(1000);
    this.scoreBox.add(this.add.text(0, 0, "WINS", { fontSize: "16px", color: "#aaaaaa", fontStyle: "bold" }));
    this.uiLayer.add([winPanel, this.scoreBox]);

    // ロビー操作（ロビー中のみ表示）: 画面下・中央バンド。タップしやすい大きさに。
    const lobbyCx = width / 2;
    this.readyButton = this.add.text(lobbyCx, height - 220, "[ 準備 OK ]", {
      fontSize: "30px", color: "#7ee787", backgroundColor: "#222",
      padding: { x: 22, y: 12 } as any, fontStyle: "bold",
    }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true }).setDepth(1000);
    this.readyButton.on("pointerdown", () => {
      this.room.send("ready");
      this.readyButton.setText("準備済み...").disableInteractive();
    });

    this.addCpuButton = this.add.text(lobbyCx - 130, height - 162, "[ ＋CPU ]", {
      fontSize: "22px", color: "#7ec0e7", backgroundColor: "#222",
      padding: { x: 16, y: 10 } as any, fontStyle: "bold",
    }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true }).setDepth(1000);
    this.addCpuButton.on("pointerdown", () => this.room.send("addBot"));

    this.removeCpuButton = this.add.text(lobbyCx + 130, height - 162, "[ －CPU ]", {
      fontSize: "22px", color: "#e7a07e", backgroundColor: "#222",
      padding: { x: 16, y: 10 } as any, fontStyle: "bold",
    }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true }).setDepth(1000);
    this.removeCpuButton.on("pointerdown", () => this.room.send("removeBot"));

    // マップ選択（ロビー中のみ）。誰でも変更可（CPUボタンに倣う）。
    this.mapLabel = this.add.text(lobbyCx, height - 110, "マップ:", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(0.5, 0).setDepth(1000);
    this.uiLayer.add([this.readyButton, this.addCpuButton, this.removeCpuButton, this.mapLabel]);
    const total = MAP_CHOICES.length;
    const bw = 110, gap = 12;
    const startX = lobbyCx - (total * bw + (total - 1) * gap) / 2 + bw / 2;
    MAP_CHOICES.forEach((m, i) => {
      const btn = this.add.text(startX + i * (bw + gap), height - 80, m.name, {
        fontSize: "20px", color: "#cccccc", backgroundColor: "#222",
        padding: { x: 10, y: 8 } as any,
      }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true }).setDepth(1000);
      btn.on("pointerdown", () => this.room.send("selectMap", { mapId: m.id }));
      this.mapButtons.push(btn);
      this.uiLayer.add(btn);
    });

    // 縦持ち時の「横向きにしてください」オーバーレイ（uiLayer・最前面）
    this.rotateOverlay = this.add.container(0, 0).setDepth(99999);
    this.rotateOverlay.add([
      this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.92),
      this.add.text(width / 2, height / 2, "📱 横向きにしてください", {
        fontSize: "44px", color: "#ffffff", fontStyle: "bold",
      }).setOrigin(0.5),
    ]);
    this.uiLayer.add(this.rotateOverlay);

    this.keys = addMoveKeys(this);
    this.keys.SPACE.on("down", () => this.room.send("placeBomb"));
    // スマホ: 仮想ジョイスティック＋ボムボタン（タッチ端末のみ表示。uiLayer に載せる）
    this.touch = addTouchControls(this, {
      onAction: () => this.room.send("placeBomb"),
      actionLabel: "💣",
      layer: this.uiLayer,
    });
    this.input.keyboard!.on("keydown-ESC", () => this.room.leave());

    // 向き判定。Phaser の RESIZE に加え、window の resize/orientationchange でも拾う
    // （端末/ブラウザによって発火が異なるため取りこぼし防止）。回転直後は寸法未確定の
    // ことがあるので遅延でも再判定する。表示制御のみ（restart不要）。
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyOrientation, this);
    window.addEventListener("resize", this.onWinOrient);
    window.addEventListener("orientationchange", this.onWinOrient);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.applyOrientation, this);
      window.removeEventListener("resize", this.onWinOrient);
      window.removeEventListener("orientationchange", this.onWinOrient);
    });
    this.applyOrientation();

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
    // マップ（tiles）が変わったら描画とワープ対を作り直す（ロビー選択・ランダム確定）
    $(state).listen("tiles", () => { this.buildWarpPairs(); this.rebuildGrid(); });
    // 選択マップが変わったらボタンのハイライト更新
    $(state).listen("mapId", () => this.refreshMapButtons());

    this.room.onLeave(() => this.scene.start(this.goingHome ? "Hub" : "BombermanLobby"));

    this.onPhaseChanged();
  }

  // window の resize/orientationchange 用。回転直後は寸法が未確定なことがあるので遅延でも再判定。
  private onWinOrient = () => {
    this.applyOrientation();
    window.setTimeout(() => this.applyOrientation(), 250);
  };

  // 縦持ちなら「横向きにしてください」を表示。
  // キャンバスの displaySize は FIT で 1600x900 比に固定され縦横が入れ替わらないため使えない。
  // 端末（ウィンドウ）の実寸で判定する。
  private applyOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    this.rotateOverlay?.setVisible(portrait);
  }

  update(_t: number, dtMs: number) {
    const state: any = this.room.state;
    // 毎フレーム向きを見て「横向きにしてください」を切替（イベント発火に依存せず確実）。
    const portrait = window.innerHeight > window.innerWidth;
    if (this.rotateOverlay && this.rotateOverlay.visible !== portrait) {
      this.rotateOverlay.setVisible(portrait);
    }
    this.updateBombColors(); // 爆弾を残り時間で赤くする

    // 押下状態から「先押し優先の単一方向」を求める。
    // 斜め同時押しでも1方向だけに絞ることで、予測とサーバーの判断を一致させ
    // 本番のレイテンシ下での壁めり込み/ズレを防ぐ。
    const t = this.touch.held;
    const held = {
      up: this.keys.W.isDown || this.keys.UP.isDown || t.up,
      down: this.keys.S.isDown || this.keys.DOWN.isDown || t.down,
      left: this.keys.A.isDown || this.keys.LEFT.isDown || t.left,
      right: this.keys.D.isDown || this.keys.RIGHT.isDown || t.right,
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

      // 表示補間はフレームレート非依存の指数スムージングにする。
      // 予測は30Hzの固定ステップで離散的に進むため、60fps表示で素のlerpだと
      // フレームごとの進み量のばらつきが小刻みな揺れ（カクつき）になる。
      // dtベースの係数にすることでフレームレートに依らず一定の滑らかさにする。
      const smooth = 1 - Math.exp(-30 * Math.min(dtMs, 100) / 1000);
      let sx: number, sy: number;
      if (id === this.myId && this.predict) {
        sx = this.offsetX + this.predict.x;
        sy = this.offsetY + this.predict.y;
        const jump = Math.hypot(sx - v.container.x, sy - v.container.y);
        if (jump > this.ts * 2.5) {
          v.container.setPosition(sx, sy); // 初回配置など極端な差は即合わせ
        } else {
          v.container.setPosition(
            Phaser.Math.Linear(v.container.x, sx, smooth),
            Phaser.Math.Linear(v.container.y, sy, smooth),
          );
        }
      } else {
        // 他者はサーバー位置へ補間
        sx = this.offsetX + p.x;
        sy = this.offsetY + p.y;
        v.container.setPosition(
          Phaser.Math.Linear(v.container.x, sx, smooth),
          Phaser.Math.Linear(v.container.y, sy, smooth),
        );
      }
      v.container.setDepth(sy);

      // 向き（dir: 0=下/front, 1=左, 2=右, 3=上/back）。自分は予測の向きを優先（即時）。
      const dirVal = (id === this.myId && this.predict) ? this.predict.dir : p.dir;
      if (dirVal === 0) { v.dir = "front"; v.flip = false; }
      else if (dirVal === 3) { v.dir = "back"; v.flip = false; }
      else if (dirVal === 1) { v.dir = "side"; v.flip = true; }
      else if (dirVal === 2) { v.dir = "side"; v.flip = false; }

      // プレイヤー別の方向ポーズ（walk/punch画像は無いので向きだけ反映）
      v.lastX = sx; v.lastY = sy;
      applyBombermanPose(v.sprite, v.playerNo, v.dir, v.flip, CHAR_DISPLAY_H);

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
      this.hud.setText("");
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
      justWarped: !!entity.justWarped,
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

    // ベルト（サーバーと同一）：入力が無くベルト上なら矢印方向へ1マス
    if (!pr.move && !hasInput) {
      const b = this.beltDir(this.tileAt(pr.col, pr.row));
      if (b) {
        pr.dir = b.dir;
        const ncol = pr.col + b.dc, nrow = pr.row + b.dr;
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
      this.predictWarp(pr); // ワープ上ならテレポート（サーバーと同一）
    } else {
      pr.x += (ddx / dist) * step;
      pr.y += (ddy / dist) * step;
    }
  }

  // tiles 文字（範囲外は壁）
  private tileAt(col: number, row: number): string {
    const s: any = this.room.state;
    if (col < 0 || row < 0 || col >= s.cols || row >= s.rows) return "#";
    const t: string = s.tiles || "";
    if (t.length !== s.cols * s.rows) return ".";
    return t.charAt(row * s.cols + col);
  }

  private beltDir(ch: string): { dc: number; dr: number; dir: number } | null {
    switch (ch) {
      case "^": return { dc: 0, dr: -1, dir: 3 };
      case "v": return { dc: 0, dr: 1, dir: 0 };
      case "<": return { dc: -1, dr: 0, dir: 1 };
      case ">": return { dc: 1, dr: 0, dir: 2 };
      default: return null;
    }
  }

  // ワープ予測（サーバー handleWarp と同一）
  private predictWarp(pr: PredictState) {
    const here = this.tileAt(pr.col, pr.row);
    if (here >= "0" && here <= "9") {
      if (!pr.justWarped) {
        const pair = this.warpPairs.get(`${pr.col}_${pr.row}`);
        if (pair) {
          pr.col = pair.col; pr.row = pair.row;
          pr.x = pair.col * this.ts + this.ts / 2;
          pr.y = pair.row * this.ts + this.ts / 2;
          pr.justWarped = true;
        }
      }
    } else {
      pr.justWarped = false;
    }
  }

  // tiles からワープ対を構築（同じ数字2個で1組）
  private buildWarpPairs() {
    this.warpPairs.clear();
    const s: any = this.room.state;
    const t: string = s.tiles || "";
    const by = new Map<string, Array<{ col: number; row: number }>>();
    for (let row = 0; row < s.rows; row++) {
      for (let col = 0; col < s.cols; col++) {
        const ch = t.charAt(row * s.cols + col);
        if (ch >= "0" && ch <= "9") {
          if (!by.has(ch)) by.set(ch, []);
          by.get(ch)!.push({ col, row });
        }
      }
    }
    for (const cells of by.values()) {
      if (cells.length === 2) {
        const [a, b] = cells;
        this.warpPairs.set(`${a.col}_${a.row}`, b);
        this.warpPairs.set(`${b.col}_${b.row}`, a);
      }
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

  // tiles から床/壁/ベルト矢印/ワープ穴を描画。マップ変更時に作り直す。
  private rebuildGrid() {
    const s: any = this.room.state;
    this.gridContainer?.destroy();
    const cont = this.add.container(0, 0).setDepth(-1);
    this.gridContainer = cont;
    this.worldLayer.add(cont); // ワールドカメラのみで描画（tiles変更で再生成のため毎回add）
    for (let row = 0; row < s.rows; row++) {
      for (let col = 0; col < s.cols; col++) {
        const c = this.cellCenter(col, row);
        if (this.isHardWall(col, row, s.cols, s.rows)) {
          cont.add(this.add.rectangle(c.x, c.y, this.ts, this.ts, 0x5a6270).setStrokeStyle(2, 0x3a4150));
          cont.add(this.add.rectangle(c.x, c.y - this.ts * 0.18, this.ts, this.ts * 0.3, 0x6e7686, 0.7));
          continue;
        }
        const shade = ((col + row) & 1) === 0 ? 0x3c8a4a : 0x46974f;
        cont.add(this.add.rectangle(c.x, c.y, this.ts, this.ts, shade));
        const ch = this.tileAt(col, row);
        if (this.beltDir(ch)) {
          cont.add(this.add.rectangle(c.x, c.y, this.ts - 4, this.ts - 4, 0x2b6b8a, 0.55));
          const arrow = ch === "^" ? "▲" : ch === "v" ? "▼" : ch === "<" ? "◀" : "▶";
          cont.add(this.add.text(c.x, c.y, arrow, { fontSize: `${Math.floor(this.ts * 0.5)}px`, color: "#cde7ff" }).setOrigin(0.5));
        } else if (ch >= "0" && ch <= "9") {
          cont.add(this.add.circle(c.x, c.y, this.ts * 0.34, 0x7a3ad4, 0.5).setStrokeStyle(2, 0xc89bff));
          cont.add(this.add.text(c.x, c.y, ch, { fontSize: `${Math.floor(this.ts * 0.38)}px`, color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5));
        }
      }
    }
  }

  private addPlayer(id: string, p: any) {
    const sx = this.offsetX + p.x;
    const sy = this.offsetY + p.y;
    const container = this.add.container(sx, sy);
    const shadow = this.add.ellipse(0, 0, 26, 9, 0x000000, 0.4);
    const sprite = this.add.sprite(0, 0, bombermanTexKey(p.playerNo, "front")).setOrigin(0.5, 0.96);
    applyBombermanPose(sprite, p.playerNo, "front", false, CHAR_DISPLAY_H);
    if (id === this.myId) {
      const ring = this.add.ellipse(0, 2, 30, 12, 0xffe066, 0).setStrokeStyle(2, 0xffe066);
      container.add(ring);
    }
    container.add([shadow, sprite]);
    this.worldLayer.add(container);

    this.players.set(id, { container, sprite, shadow, lastX: sx, lastY: sy, wasAlive: true, dir: "front", flip: false, playerNo: p.playerNo });
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
      this.worldLayer.add(star);
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
      this.worldLayer.add(v.nameLabel);
    } else if (!showLabel && v.nameLabel) {
      v.nameLabel.destroy();
      v.nameLabel = undefined;
    }
  }

  private addSoftBlock(key: string, sb: any) {
    const c = this.cellCenter(sb.col, sb.row);
    const r = this.add.rectangle(c.x, c.y, this.ts - 4, this.ts - 4, 0xb07a3a).setStrokeStyle(2, 0x7a5326);
    r.setDepth(c.y - 1);
    this.worldLayer.add(r);
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
    this.bombs.set(id, { cont, body, explodesAt: b.explodesAt, fuseMs: Math.max(1, b.explodesAt - Date.now()) });
    this.tweens.add({ targets: cont, scaleX: 1.18, scaleY: 1.18, duration: 280, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
  }

  // 爆発が近づくほど本体を赤くする（暗→赤）。update から毎フレーム呼ぶ。
  private updateBombColors() {
    const now = Date.now();
    this.bombs.forEach((e) => {
      const f = Phaser.Math.Clamp(1 - (e.explodesAt - now) / e.fuseMs, 0, 1); // 0=設置直後 → 1=爆発直前
      const r = Math.round(0x22 + (0xee - 0x22) * f);
      const b = Math.round(0x22 + (0x00 - 0x22) * f);
      e.body.setFillStyle(Phaser.Display.Color.GetColor(r, 0x22, b));
    });
  }

  private removeBomb(id: string) {
    const e = this.bombs.get(id);
    if (e) { e.cont.destroy(); this.bombs.delete(id); }
  }

  private addFlame(id: string, f: any) {
    const c = this.cellCenter(f.col, f.row);
    const r = this.add.rectangle(c.x, c.y, this.ts - 2, this.ts - 2, 0xff8a3c, 0.9).setDepth(5500);
    this.flames.set(id, r);
    const inner = this.add.rectangle(c.x, c.y, this.ts * 0.5, this.ts * 0.5, 0xffe066, 0.95).setDepth(5501);
    this.worldLayer.add([r, inner]);
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

  // 選択中マップを強調表示
  private refreshMapButtons() {
    const cur = (this.room.state as any).mapId;
    this.mapButtons.forEach((btn, i) => {
      const sel = MAP_CHOICES[i].id === cur;
      btn.setColor(sel ? "#1a1d24" : "#cccccc");
      btn.setBackgroundColor(sel ? "#ffe066" : "#222");
    });
  }

  private setMapUiVisible(v: boolean) {
    this.mapLabel.setVisible(v);
    this.mapButtons.forEach((b) => b.setVisible(v));
  }

  private onPhaseChanged() {
    const state: any = this.room.state;
    const phase = state.phase;
    state.players?.forEach((p: any, id: string) => this.updateLabelForPhase(id, p));
    // マップ選択UIはロビー中のみ表示
    this.setMapUiVisible(phase === "lobby");
    this.refreshMapButtons();

    if (phase === "lobby") {
      this.phaseText.setText(""); // 盤面中央オーバーレイなのでロビーでは出さない（下のボタンで案内）
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
