import Phaser from "phaser";
import { joinPublic, createPrivate, joinByCode } from "../../net";
import { enableSfx } from "../../sfx";
import { makeInput, makeButton } from "../../ui/nameInput";
import { tryJoin } from "../../ui/connectFlow";
import { loadPlayerName, savePlayerName } from "../../ui/playerName";

export class UnspottableLobbyScene extends Phaser.Scene {
  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;

  constructor() { super("UnspottableLobby"); }

  create() {
    const { width, height } = this.scale;

    this.add.text(width / 2, 90, "Unspottable Web", {
      fontSize: "56px", color: "#ffffff", fontStyle: "bold",
    }).setOrigin(0.5);

    this.add.text(width / 2, 160, "群衆に紛れて他プレイヤーを見つけて叩け", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(0.5);

    // ハブに戻る
    makeButton(this, 90, 40, "← ハブ", "#aaaaaa", () => this.scene.start("Hub"));

    // --- 名前入力 ---
    this.nameInput = makeInput(this, "名前", 16, loadPlayerName(),
      width / 2, 230);

    // --- 3つの参加方法 ---
    const status = this.add.text(width / 2, height - 130, "", {
      fontSize: "16px", color: "#ff8888",
    }).setOrigin(0.5);

    const cleanup = () => { this.nameInput.remove(); this.codeInput.remove(); };

    // クイック参加
    makeButton(this, width / 2, 320, "[ クイック参加 ]", "#7ee787", () => {
      tryJoin(this, status, () => joinPublic(this.getName()), "UnspottableGame", cleanup);
    });

    // プライベート作成
    makeButton(this, width / 2, 380, "[ プライベートルームを作成 ]", "#7ec0e7", () => {
      tryJoin(this, status, () => createPrivate(this.getName()), "UnspottableGame", cleanup);
    });

    // コードで参加
    this.add.text(width / 2 - 110, 450, "コード:", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(1, 0.5);

    this.codeInput = makeInput(this, "4桁", 4, "", width / 2 + 10, 450, 110);
    this.codeInput.inputMode = "numeric";
    this.codeInput.pattern = "[0-9]*";

    makeButton(this, width / 2 + 170, 450, "[ 参加 ]", "#ffe066", () => {
      const code = this.codeInput.value.trim();
      if (!/^\d{4}$/.test(code)) { status.setText("4桁のコードを入力してください"); return; }
      tryJoin(this, status, () => joinByCode(this.getName(), code), "UnspottableGame", cleanup);
    });

    this.add.text(width / 2, height - 60,
      "操作: WASD/矢印で移動、Space で叩く  /  2人以上揃って「準備」で開始", {
      fontSize: "14px", color: "#888888",
    }).setOrigin(0.5);

    // SFX はユーザー操作後に有効化（自動再生制限対策）。ロビーのどのボタンでもOKだが念のため。
    this.input.once("pointerdown", () => enableSfx());

    this.events.once("shutdown", () => {
      this.nameInput?.remove();
      this.codeInput?.remove();
    });
  }

  private getName(): string {
    const name = this.nameInput.value.trim() || "Player";
    savePlayerName(name);
    return name;
  }
}
