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
    const label = this.add.text(width - 24, 30, "…", {
      fontSize: "16px", color: "#cccccc", align: "right",
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
