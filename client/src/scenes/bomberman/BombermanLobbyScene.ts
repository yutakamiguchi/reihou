import Phaser from "phaser";
import { buildLobby } from "../../ui/lobby";

export class BombermanLobbyScene extends Phaser.Scene {
  constructor() { super("BombermanLobby"); }

  create() {
    buildLobby(this, {
      title: "ボンバーマン",
      subtitle: "爆弾でブロックを壊し、相手を吹き飛ばせ",
      roomName: "bomberman",
      gameSceneKey: "BombermanGame",
      quickLabel: "[ クイック参加 ]",
      hint: "操作: WASD/矢印で移動、Space で爆弾設置  /  2人以上揃って「準備」で開始",
      enableCode: true,
      extra: (scene, hintY) => this.drawItemLegend(scene, hintY),
    });
  }

  // アイテム凡例（ブロックを壊すと出現。色はゲーム内アイコンと対応）。ボンバーマン固有。
  private drawItemLegend(scene: Phaser.Scene, hintY: number) {
    const { width } = scene.scale;
    scene.add.text(width / 2, hintY + 32, "アイテム（ブロックを壊すと出現）", {
      fontSize: "13px", color: "#aaaaaa", fontStyle: "bold",
    }).setOrigin(0.5);
    const items = [
      { color: 0x333333, label: "爆弾＋ (同時に置ける爆弾が増える)" },
      { color: 0xff5533, label: "火力＋ (爆風が伸びる)" },
      { color: 0x44aaff, label: "速度＋ (移動が速くなる)" },
    ];
    const fontSize = 13, iconSize = 14, iconGap = 6, itemGap = 24;
    const y = hintY + 58;
    const widths = items.map(it => {
      const t = scene.add.text(0, 0, it.label, { fontSize: `${fontSize}px` }).setVisible(false);
      const w = iconSize + iconGap + t.width;
      t.destroy();
      return w;
    });
    const total = widths.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);
    let x = width / 2 - total / 2;
    items.forEach((it, i) => {
      scene.add.rectangle(x + iconSize / 2, y, iconSize, iconSize, 0xffffff, 0.95)
        .setStrokeStyle(2, it.color);
      scene.add.circle(x + iconSize / 2, y, iconSize * 0.28, it.color);
      scene.add.text(x + iconSize + iconGap, y, it.label, {
        fontSize: `${fontSize}px`, color: "#cccccc",
      }).setOrigin(0, 0.5);
      x += widths[i] + itemGap;
    });
  }
}
