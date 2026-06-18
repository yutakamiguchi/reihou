import Phaser from "phaser";
import { enableSfx } from "../sfx";
import { getUser, getMyProfile } from "../auth";

interface GameCard {
  title: string;
  desc: string;
  color: number;
  sceneKey: string;
  enabled: boolean;
  requiresAccount?: boolean; // 本登録アカウント必須（霊宝）
}

const CARDS: GameCard[] = [
  {
    title: "Unspottable",
    desc: "群衆に紛れて\n他プレイヤーを叩け",
    color: 0xc84646,
    sceneKey: "UnspottableLobby",
    enabled: true,
  },
  {
    title: "ボンバーマン",
    desc: "爆弾でブロックを壊し\n相手を吹き飛ばせ",
    color: 0x4a7ec9,
    sceneKey: "BombermanLobby",
    enabled: true,
  },
  {
    title: "霊宝コレクション",
    desc: "広い世界を探索し\n限定供給の霊宝を集めよ",
    color: 0xe8b04b,
    sceneKey: "MmoLobby",
    enabled: true,
    requiresAccount: true,
  },
];

export class HubScene extends Phaser.Scene {
  private rotateOverlay?: Phaser.GameObjects.Container;

  constructor() { super("Hub"); }

  create() {
    const { width, height } = this.scale;

    // ユーザーの最初の操作で SFX を有効化（自動再生制限対策）
    this.input.once("pointerdown", () => enableSfx());

    this.add.text(width / 2, 110, "ミニゲーム ポータル", {
      fontSize: "52px", color: "#ffffff", fontStyle: "bold",
    }).setOrigin(0.5);

    this.add.text(width / 2, 175, "遊ぶゲームを選んでください", {
      fontSize: "20px", color: "#cccccc",
    }).setOrigin(0.5);

    // 右上：アカウント状態（クリックでログイン/アカウント画面へ）
    this.makeAccountStatus(width);

    // カードを横並びに配置
    const cardW = 250;
    const cardH = 340;
    const gap = 36;
    const totalW = CARDS.length * cardW + (CARDS.length - 1) * gap;
    const startX = (width - totalW) / 2 + cardW / 2;
    const cy = height / 2 + 40;

    CARDS.forEach((card, i) => {
      const cx = startX + i * (cardW + gap);
      this.makeCard(cx, cy, cardW, cardH, card);
    });

    // 縦持ち時の「横向きにしてください」オーバーレイ（最前面）。各ゲーム画面と同じ仕組み。
    this.rotateOverlay = this.add.container(0, 0).setDepth(99999);
    this.rotateOverlay.add([
      this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.92),
      this.add.text(width / 2, height / 2, "📱 横向きにしてください", {
        fontSize: "44px", color: "#ffffff", fontStyle: "bold",
      }).setOrigin(0.5),
    ]);

    // 向き判定。Phaser の RESIZE に加え、window の resize/orientationchange でも拾う
    // （端末/ブラウザによって発火が異なるため取りこぼし防止）。表示制御のみ。
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyOrientation, this);
    window.addEventListener("resize", this.onWinOrient);
    window.addEventListener("orientationchange", this.onWinOrient);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.applyOrientation, this);
      window.removeEventListener("resize", this.onWinOrient);
      window.removeEventListener("orientationchange", this.onWinOrient);
    });
    this.applyOrientation();
  }

  // window の resize/orientationchange 用。回転直後は寸法が未確定なことがあるので遅延でも再判定。
  private onWinOrient = () => {
    this.applyOrientation();
    window.setTimeout(() => this.applyOrientation(), 250);
  };

  // 縦持ちなら「横向きにしてください」を表示。端末（ウィンドウ）の実寸で判定する。
  private applyOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    this.rotateOverlay?.setVisible(portrait);
  }

  update() {
    // 毎フレーム向きを見て案内を切替（イベント発火に依存せず確実）。
    const portrait = window.innerHeight > window.innerWidth;
    if (this.rotateOverlay && this.rotateOverlay.visible !== portrait) {
      this.rotateOverlay.setVisible(portrait);
    }
  }

  private makeCard(cx: number, cy: number, w: number, h: number, card: GameCard) {
    const container = this.add.container(cx, cy);

    const bg = this.add.rectangle(0, 0, w, h, 0x1a1d24)
      .setStrokeStyle(3, card.enabled ? card.color : 0x444444);

    // 上部の色帯
    const banner = this.add.rectangle(0, -h / 2 + 60, w, 120, card.color, card.enabled ? 0.9 : 0.3);

    const title = this.add.text(0, -h / 2 + 60, card.title, {
      fontSize: "30px", color: "#ffffff", fontStyle: "bold",
      stroke: "#000", strokeThickness: 3, align: "center",
    }).setOrigin(0.5);

    const desc = this.add.text(0, 30, card.desc, {
      fontSize: "18px", color: "#cccccc", align: "center", lineSpacing: 8,
    }).setOrigin(0.5);

    const cta = this.add.text(0, h / 2 - 50, card.enabled ? "▶ あそぶ" : "準備中", {
      fontSize: "22px", color: card.enabled ? "#7ee787" : "#777777", fontStyle: "bold",
    }).setOrigin(0.5);

    container.add([bg, banner, title, desc, cta]);

    if (!card.enabled) return;

    bg.setInteractive({ useHandCursor: true });
    bg.on("pointerover", () => {
      bg.setFillStyle(0x242832);
      container.setScale(1.04);
    });
    bg.on("pointerout", () => {
      bg.setFillStyle(0x1a1d24);
      container.setScale(1);
    });
    bg.on("pointerdown", async () => {
      enableSfx();
      if (card.requiresAccount) {
        const user = await getUser();
        if (!user || user.is_anonymous) {
          // 本登録が必要：ログイン画面へ（成功後に当該ゲームへ）
          this.scene.start("Login", { returnTo: card.sceneKey });
          return;
        }
      }
      this.scene.start(card.sceneKey);
    });
  }

  // 右上のアカウント状態表示。クリックでログイン/アカウント管理へ。
  private makeAccountStatus(width: number) {
    // 画面最上部はノッチ/システムUIで隠れたり押しにくいので少し下げ、
    // 背景パディングでタップ範囲を広げる。
    const label = this.add.text(width - 20, 46, "…", {
      fontSize: "16px", color: "#cccccc", align: "right",
      backgroundColor: "#1a1d24", padding: { x: 10, y: 8 } as any,
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });

    label.on("pointerover", () => label.setColor("#ffffff"));
    label.on("pointerout", () => label.setColor("#cccccc"));
    label.on("pointerdown", () => this.scene.start("Login", { returnTo: "Hub" }));

    void (async () => {
      try {
        const user = await getUser();
        if (!user) {
          label.setText("未ログイン ▸ ログイン");
        } else if (user.is_anonymous) {
          label.setText("ゲスト ▸ アカウント作成");
        } else {
          const p = await getMyProfile();
          label.setText(`${p?.display_name ?? user.email ?? "アカウント"} ▸ 管理`);
        }
      } catch {
        label.setText("ログイン");
      }
    })();
  }
}
