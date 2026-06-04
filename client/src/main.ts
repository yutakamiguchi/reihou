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
  width: 1280,
  height: 720,
  // 内部解像度は1280x720のまま、ブラウザいっぱいに拡大表示（比率維持・中央寄せ）
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
