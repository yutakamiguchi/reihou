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
  backgroundColor: "#2a2f3a",
  scene: [
    HubScene,
    LoginScene,
    UnspottableLobbyScene, UnspottableGameScene,
    BombermanLobbyScene, BombermanGameScene,
    MmoLobbyScene, MmoGameScene,
  ],
  pixelArt: true,
});
