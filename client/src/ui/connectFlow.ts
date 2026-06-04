import Phaser from "phaser";
import { warmUp, type JoinResult } from "../net";

// ロビーから部屋に入る共通フロー。
// warmUp（コールドスタート対策）→ join → 成功でゲームシーンへ遷移。
// 失敗は status テキストに表示する。cleanup は遷移直前に呼ばれる（HTML input の除去など）。
export async function tryJoin(
  scene: Phaser.Scene,
  status: Phaser.GameObjects.Text,
  joinFn: () => Promise<JoinResult>,
  gameSceneKey: string,
  cleanup?: () => void,
): Promise<void> {
  status.setColor("#aaaaaa");
  status.setText("サーバーに接続中...");
  try {
    // 無料プランはアイドルからの復帰に時間がかかるので先にHTTPで起こす
    let warmedQuickly = true;
    const warmTimer = setTimeout(() => { warmedQuickly = false; }, 2500);
    await warmUp((sec) => {
      if (!warmedQuickly) {
        status.setText(`サーバー起動中…(${Math.floor(sec)}秒)　無料サーバーのため初回は最大2分ほどかかります`);
      }
    });
    clearTimeout(warmTimer);

    status.setText("ルームに参加中...");
    const { room } = await joinFn();
    cleanup?.();
    scene.scene.start(gameSceneKey, { room });
  } catch (e: any) {
    const msg = e?.message || String(e);
    status.setColor("#ff8888");
    status.setText("失敗: " + msg);
  }
}
