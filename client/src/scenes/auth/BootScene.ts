import Phaser from "phaser";
import { getSession } from "../../auth";

// 起動時の振り分け。
// - ログイン済み（セッションあり）→ ハブへスキップ
// - 未ログイン → ログイン画面
// ログインフォームが一瞬見えてから消えるのを避けるため、判定専用のシーンを挟む。
export class BootScene extends Phaser.Scene {
  constructor() { super("Boot"); }

  create() {
    const { width, height } = this.scale;
    this.add.text(width / 2, height / 2, "読み込み中…", {
      fontSize: "24px", color: "#cccccc",
    }).setOrigin(0.5);

    void (async () => {
      try {
        const session = await getSession();
        this.scene.start(session ? "Hub" : "Login");
      } catch {
        // 取得失敗時はログイン画面へ（そこから先へ進める）
        this.scene.start("Login");
      }
    })();
  }
}
