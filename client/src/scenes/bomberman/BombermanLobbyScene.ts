import Phaser from "phaser";
import { joinPublicRoom, createPrivateRoom, joinRoomByCode } from "../../net";
import { enableSfx } from "../../sfx";
import { makeInput, makeButton } from "../../ui/nameInput";
import { tryJoin } from "../../ui/connectFlow";
import { loadPlayerName, savePlayerName } from "../../ui/playerName";

const ROOM = "bomberman";

export class BombermanLobbyScene extends Phaser.Scene {
  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;

  constructor() { super("BombermanLobby"); }

  create() {
    const { width, height } = this.scale;

    this.add.text(width / 2, 90, "ボンバーマン", {
      fontSize: "56px", color: "#ffffff", fontStyle: "bold",
    }).setOrigin(0.5);

    this.add.text(width / 2, 160, "爆弾でブロックを壊し、相手を吹き飛ばせ", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(0.5);

    makeButton(this, 90, 40, "← ハブ", "#aaaaaa", () => this.scene.start("Hub"));

    this.nameInput = makeInput(this, "名前", 16, loadPlayerName(),
      width / 2, 230);

    const status = this.add.text(width / 2, height - 130, "", {
      fontSize: "16px", color: "#ff8888",
    }).setOrigin(0.5);

    const cleanup = () => { this.nameInput.remove(); this.codeInput.remove(); };

    makeButton(this, width / 2, 320, "[ クイック参加 ]", "#7ee787", () => {
      tryJoin(this, status, () => joinPublicRoom(ROOM, this.getName()), "BombermanGame", cleanup);
    });

    makeButton(this, width / 2, 380, "[ プライベートルームを作成 ]", "#7ec0e7", () => {
      tryJoin(this, status, () => createPrivateRoom(ROOM, this.getName()), "BombermanGame", cleanup);
    });

    this.add.text(width / 2 - 110, 450, "コード:", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(1, 0.5);

    this.codeInput = makeInput(this, "4桁", 4, "", width / 2 + 10, 450, 110);
    this.codeInput.inputMode = "numeric";
    this.codeInput.pattern = "[0-9]*";

    makeButton(this, width / 2 + 170, 450, "[ 参加 ]", "#ffe066", () => {
      const code = this.codeInput.value.trim();
      if (!/^\d{4}$/.test(code)) { status.setText("4桁のコードを入力してください"); return; }
      tryJoin(this, status, () => joinRoomByCode(ROOM, this.getName(), code), "BombermanGame", cleanup);
    });

    this.add.text(width / 2, height - 90,
      "操作: WASD/矢印で移動、Space で爆弾設置  /  2人以上揃って「準備」で開始", {
      fontSize: "14px", color: "#888888",
    }).setOrigin(0.5);

    // アイテム凡例（ブロックを壊すと出現。色はゲーム内アイコンと対応）
    this.add.text(width / 2, height - 58, "アイテム（ブロックを壊すと出現）", {
      fontSize: "13px", color: "#aaaaaa", fontStyle: "bold",
    }).setOrigin(0.5);
    this.makeItemLegend(width / 2, height - 32, [
      { color: 0x333333, label: "爆弾＋ (同時に置ける爆弾が増える)" },
      { color: 0xff5533, label: "火力＋ (爆風が伸びる)" },
      { color: 0x44aaff, label: "速度＋ (移動が速くなる)" },
    ]);

    this.input.once("pointerdown", () => enableSfx());

    this.events.once("shutdown", () => {
      this.nameInput?.remove();
      this.codeInput?.remove();
    });
  }

  // 色つきアイコン＋説明を横並びで中央寄せに配置する。
  private makeItemLegend(cx: number, y: number, items: { color: number; label: string }[]) {
    const fontSize = 13;
    const iconSize = 14;
    const iconGap = 6;   // アイコンとラベルの間
    const itemGap = 24;  // 項目同士の間

    // 各項目の幅を測って全体幅を求め、中央寄せの開始xを決める
    const widths = items.map(it => {
      const t = this.add.text(0, 0, it.label, { fontSize: `${fontSize}px` }).setVisible(false);
      const w = iconSize + iconGap + t.width;
      t.destroy();
      return w;
    });
    const total = widths.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);
    let x = cx - total / 2;

    items.forEach((it, i) => {
      this.add.rectangle(x + iconSize / 2, y, iconSize, iconSize, 0xffffff, 0.95)
        .setStrokeStyle(2, it.color);
      this.add.circle(x + iconSize / 2, y, iconSize * 0.28, it.color);
      this.add.text(x + iconSize + iconGap, y, it.label, {
        fontSize: `${fontSize}px`, color: "#cccccc",
      }).setOrigin(0, 0.5);
      x += widths[i] + itemGap;
    });
  }

  private getName(): string {
    const name = this.nameInput.value.trim() || "Player";
    savePlayerName(name);
    return name;
  }
}
