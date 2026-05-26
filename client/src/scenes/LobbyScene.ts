import Phaser from "phaser";
import { joinPublic, createPrivate, joinByCode, warmUp } from "../net";
import { enableSfx } from "../sfx";

export class LobbyScene extends Phaser.Scene {
  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;

  constructor() { super("Lobby"); }

  create() {
    const { width, height } = this.scale;

    this.add.text(width / 2, 90, "Unspottable Web", {
      fontSize: "56px", color: "#ffffff", fontStyle: "bold",
    }).setOrigin(0.5);

    this.add.text(width / 2, 160, "群衆に紛れて他プレイヤーを見つけて叩け", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(0.5);

    // --- 名前入力 ---
    this.nameInput = this.makeInput("名前", 16, "Player" + Math.floor(Math.random() * 1000),
      width / 2, 230);

    // --- 3つの参加方法 ---
    const status = this.add.text(width / 2, height - 130, "", {
      fontSize: "16px", color: "#ff8888",
    }).setOrigin(0.5);

    // クイック参加
    const btnQuick = this.makeButton(width / 2, 320, "[ クイック参加 ]", "#7ee787", async () => {
      await this.tryJoin(status, () => joinPublic(this.getName()));
    });

    // プライベート作成
    const btnCreate = this.makeButton(width / 2, 380, "[ プライベートルームを作成 ]", "#7ec0e7", async () => {
      await this.tryJoin(status, () => createPrivate(this.getName()));
    });

    // コードで参加
    this.add.text(width / 2 - 110, 450, "コード:", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(1, 0.5);

    this.codeInput = this.makeInput("4桁", 4, "", width / 2 + 10, 450, 110);
    this.codeInput.inputMode = "numeric";
    this.codeInput.pattern = "[0-9]*";

    const btnJoinCode = this.makeButton(width / 2 + 170, 450, "[ 参加 ]", "#ffe066", async () => {
      const code = this.codeInput.value.trim();
      if (!/^\d{4}$/.test(code)) { status.setText("4桁のコードを入力してください"); return; }
      await this.tryJoin(status, () => joinByCode(this.getName(), code));
    });

    void btnQuick; void btnCreate; void btnJoinCode;

    this.add.text(width / 2, height - 60,
      "操作: WASD/矢印で移動、Space で叩く  /  2人以上揃って「準備」で開始", {
      fontSize: "14px", color: "#888888",
    }).setOrigin(0.5);

    this.events.once("shutdown", () => {
      this.nameInput?.remove();
      this.codeInput?.remove();
    });
  }

  private getName(): string {
    return this.nameInput.value.trim() || "Player";
  }

  private async tryJoin(status: Phaser.GameObjects.Text, fn: () => Promise<{ room: any }>) {
    enableSfx();
    status.setColor("#aaaaaa");
    status.setText("サーバーに接続中...");
    try {
      // 無料プランはアイドルからの復帰に時間がかかるので先にHTTPで起こす
      let warmedQuickly = true;
      const warmTimer = setTimeout(() => { warmedQuickly = false; }, 2500);
      await warmUp((sec) => {
        if (!warmedQuickly) {
          status.setText(`サーバー起動中... (${Math.floor(sec)}秒 / 最大60秒)`);
        }
      });
      clearTimeout(warmTimer);

      status.setText("ルームに参加中...");
      const { room } = await fn();
      this.nameInput.remove();
      this.codeInput.remove();
      this.scene.start("Game", { room });
    } catch (e: any) {
      const msg = e?.message || String(e);
      status.setColor("#ff8888");
      status.setText("失敗: " + msg);
    }
  }

  private makeInput(placeholder: string, maxLen: number, defaultVal: string,
                    x: number, y: number, width = 240): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.placeholder = placeholder;
    el.maxLength = maxLen;
    el.value = defaultVal;
    const canvas = this.game.canvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / this.scale.width;
    const scaleY = rect.height / this.scale.height;
    Object.assign(el.style, {
      position: "absolute",
      left: `${rect.left + x * scaleX}px`,
      top: `${rect.top + y * scaleY}px`,
      transform: "translate(-50%, -50%)",
      width: `${width * scaleX}px`,
      fontSize: `${18 * scaleY}px`,
      padding: "8px 12px",
      border: "2px solid #888",
      borderRadius: "6px",
      background: "#1a1d24",
      color: "#fff",
      outline: "none",
      textAlign: "center",
    } as CSSStyleDeclaration);
    document.body.appendChild(el);
    return el;
  }

  private makeButton(x: number, y: number, text: string, color: string,
                     onClick: () => void): Phaser.GameObjects.Text {
    const btn = this.add.text(x, y, text, {
      fontSize: "22px", color, fontStyle: "bold",
      backgroundColor: "#1a1d24", padding: { x: 14, y: 8 } as any,
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    btn.on("pointerover", () => btn.setColor("#ffffff"));
    btn.on("pointerout", () => btn.setColor(color));
    btn.on("pointerdown", onClick);
    return btn;
  }
}
