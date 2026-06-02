import Phaser from "phaser";
import { makeInput, makeButton } from "../../ui/nameInput";
import {
  getUser, signInWithEmail, signUpWithEmail, signInAsGuest,
  upgradeGuestToEmail, signOut, getMyProfile, setDisplayName,
} from "../../auth";

// ポータル共通アカウントのログイン/アカウント画面。
// init data: { returnTo?: sceneKey }  ログイン成功後に遷移する先（既定 Hub）。
export class LoginScene extends Phaser.Scene {
  private returnTo = "Hub";
  private mode: "login" | "signup" = "login";
  private dom: HTMLElement[] = [];
  private msg?: Phaser.GameObjects.Text;

  constructor() { super("Login"); }

  init(data: { returnTo?: string }) {
    this.returnTo = data?.returnTo || "Hub";
  }

  create() {
    this.events.once("shutdown", () => this.clearDom());
    this.rebuild();
  }

  private clearDom() {
    this.dom.forEach((el) => el.remove());
    this.dom = [];
  }

  private async rebuild() {
    this.clearDom();
    this.children.removeAll();
    const { width } = this.scale;
    const cx = width / 2;

    this.add.text(cx, 90, "アカウント", { fontSize: "40px", color: "#fff", fontStyle: "bold" }).setOrigin(0.5);

    const user = await getUser();
    const isGuest = user?.is_anonymous === true;

    if (user && !isGuest) {
      await this.renderLoggedIn(cx, user.email ?? "(メール未設定)");
    } else {
      this.renderForm(cx, isGuest);
    }

    this.msg = this.add.text(cx, 560, "", { fontSize: "16px", color: "#ffb347" }).setOrigin(0.5);
    makeButton(this, cx, 630, "← ポータルへ戻る", "#aaaaaa", () => this.scene.start("Hub"));
  }

  // --- ログイン済み（メールあり）---
  private async renderLoggedIn(cx: number, email: string) {
    const profile = await getMyProfile();
    this.add.text(cx, 195, `ログイン中`, { fontSize: "20px", color: "#7ee787" }).setOrigin(0.5);
    this.add.text(cx, 230, email, { fontSize: "20px", color: "#fff" }).setOrigin(0.5);

    // 表示名の変更
    this.add.text(cx, 285, "表示名（霊宝の世界で表示）", { fontSize: "14px", color: "#cccccc" }).setOrigin(0.5);
    const nameInput = makeInput(this, "表示名", 16, profile?.display_name ?? "", cx - 40, 320, 200);
    this.dom.push(nameInput);
    makeButton(this, cx + 140, 320, "変更", "#7ec0e7", () => this.changeName(nameInput.value));

    makeButton(this, cx, 400, `▶ ${this.returnTo === "Spirit" ? "霊宝へ" : "戻る"}`, "#7ee787", () => this.scene.start(this.returnTo));
    makeButton(this, cx, 465, "ログアウト", "#e08a8a", async () => {
      await signOut();
      this.setMsg("ログアウトしました");
      this.rebuild();
    });
  }

  private async changeName(name: string) {
    const n = name.trim();
    if (!n) { this.setMsg("名前を入力してください", "#e08a8a"); return; }
    this.setMsg("変更中…", "#cccccc");
    try {
      await setDisplayName(n);
      this.setMsg("表示名を変更しました（霊宝の世界は次回入場時に反映）", "#7ee787");
      this.rebuild();
    } catch (e: any) {
      this.setMsg(`失敗: ${e?.message ?? e}`, "#e08a8a");
    }
  }

  // --- 未ログイン / ゲスト：ログイン・新規登録フォーム ---
  private renderForm(cx: number, isGuest: boolean) {
    // モード切替タブ
    const loginTab = makeButton(this, cx - 80, 175, "ログイン", this.mode === "login" ? "#7ee787" : "#888", () => {
      this.mode = "login"; this.rebuild();
    });
    const signupTab = makeButton(this, cx + 80, 175, "新規登録", this.mode === "signup" ? "#7ee787" : "#888", () => {
      this.mode = "signup"; this.rebuild();
    });
    void loginTab; void signupTab;

    const email = makeInput(this, "メールアドレス", 120, "", cx, 250, 320, "email");
    const pass = makeInput(this, "パスワード（6文字以上）", 64, "", cx, 320, 320, "password");
    this.dom.push(email, pass);

    const label = this.mode === "login" ? "ログイン" : "登録する";
    makeButton(this, cx, 410, label, "#7ee787", () => this.submitEmail(email.value, pass.value));

    if (isGuest) {
      this.add.text(cx, 470, "※ ゲストで遊んだ進行をアカウントに引き継げます", { fontSize: "13px", color: "#cccccc" }).setOrigin(0.5);
    } else {
      makeButton(this, cx, 480, "ゲストで遊ぶ", "#9bb0d0", () => this.guest());
    }
  }

  private setMsg(text: string, color = "#ffb347") {
    this.msg?.setText(text).setColor(color);
  }

  private async submitEmail(email: string, password: string) {
    email = email.trim();
    if (!email || password.length < 6) {
      this.setMsg("メールと6文字以上のパスワードを入力してください");
      return;
    }
    this.setMsg("処理中…", "#cccccc");
    try {
      const user = await getUser();
      const isGuest = user?.is_anonymous === true;

      if (this.mode === "signup") {
        if (isGuest) {
          // ゲスト進行を保持したままメール登録へ昇格
          await upgradeGuestToEmail(email, password);
          this.setMsg("アカウントを作成しました", "#7ee787");
        } else {
          const { session } = await signUpWithEmail(email, password);
          if (!session) {
            this.setMsg("確認メールを送信しました。受信後にログインしてください", "#7ee787");
            return;
          }
          this.setMsg("登録しました", "#7ee787");
        }
      } else {
        await signInWithEmail(email, password);
        this.setMsg("ログインしました", "#7ee787");
      }
      this.scene.start(this.returnTo);
    } catch (e: any) {
      this.setMsg(`失敗: ${e?.message ?? e}`, "#e08a8a");
    }
  }

  private async guest() {
    this.setMsg("ゲスト開始中…", "#cccccc");
    try {
      await signInAsGuest();
      this.scene.start(this.returnTo);
    } catch (e: any) {
      this.setMsg(`ゲスト開始に失敗: ${e?.message ?? e}（Supabaseで匿名ログイン有効化が必要）`, "#e08a8a");
    }
  }
}
