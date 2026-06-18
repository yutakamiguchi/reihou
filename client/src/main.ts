import Phaser from "phaser";
import { HubScene } from "./scenes/HubScene";
import { UnspottableLobbyScene } from "./scenes/unspottable/UnspottableLobbyScene";
import { UnspottableGameScene } from "./scenes/unspottable/UnspottableGameScene";
import { BombermanLobbyScene } from "./scenes/bomberman/BombermanLobbyScene";
import { BombermanGameScene } from "./scenes/bomberman/BombermanGameScene";
import { MmoLobbyScene } from "./scenes/mmo/MmoLobbyScene";
import { MmoGameScene } from "./scenes/mmo/MmoGameScene";
import { BootScene } from "./scenes/auth/BootScene";
import { LoginScene } from "./scenes/auth/LoginScene";

// 横画面固定（ベストエフォート）。Android等の対応ブラウザでは効く。
// iOS Safari は未対応のため reject されるが、各シーンの「横にして」案内で補う。
try {
  (screen.orientation as any)?.lock?.("landscape").catch(() => {});
} catch { /* 未対応環境は無視 */ }

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  // 内部解像度（シャープさと描画負荷のバランス）。
  width: 1600,
  height: 900,
  scale: {
    mode: Phaser.Scale.FIT,
    // センタリングは index.html の #game(flex) 側で行う。
    // ここで CENTER_BOTH にすると canvas に margin が付き、flex の中央寄せと
    // 二重にずれて画面端（特に上）が見切れるため NO_CENTER にする。
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  backgroundColor: "#2a2f3a",
  scene: [
    BootScene,
    HubScene,
    LoginScene,
    UnspottableLobbyScene, UnspottableGameScene,
    BombermanLobbyScene, BombermanGameScene,
    MmoLobbyScene, MmoGameScene,
  ],
  // イラスト主体＆半端なズーム/FIT拡大のため、最近傍(pixelArt)ではなく
  // スムージング(アンチエイリアス)で拡大 → 画素の荒れを防ぐ
  antialias: true,
  roundPixels: false,
});
