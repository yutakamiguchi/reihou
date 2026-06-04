import Phaser from "phaser";
import { HubScene } from "./scenes/HubScene";
import { UnspottableLobbyScene } from "./scenes/unspottable/UnspottableLobbyScene";
import { UnspottableGameScene } from "./scenes/unspottable/UnspottableGameScene";
import { BombermanLobbyScene } from "./scenes/bomberman/BombermanLobbyScene";
import { BombermanGameScene } from "./scenes/bomberman/BombermanGameScene";
import { MmoLobbyScene } from "./scenes/mmo/MmoLobbyScene";
import { MmoGameScene } from "./scenes/mmo/MmoGameScene";
import { LoginScene } from "./scenes/auth/LoginScene";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  // 内部解像度（シャープさと描画負荷のバランス）。1600x900＝1280比でくっきり、
  // 1920比で描画ピクセル約-30%＝軽い。FITでブラウザに合わせて表示。
  width: 1600,
  height: 900,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  backgroundColor: "#2a2f3a",
  scene: [
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
