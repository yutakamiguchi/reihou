import Phaser from "phaser";
import { HubScene } from "./scenes/HubScene";
import { UnspottableLobbyScene } from "./scenes/unspottable/UnspottableLobbyScene";
import { UnspottableGameScene } from "./scenes/unspottable/UnspottableGameScene";
import { BombermanLobbyScene } from "./scenes/bomberman/BombermanLobbyScene";
import { BombermanGameScene } from "./scenes/bomberman/BombermanGameScene";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 1280,
  height: 720,
  backgroundColor: "#2a2f3a",
  scene: [
    HubScene,
    UnspottableLobbyScene, UnspottableGameScene,
    BombermanLobbyScene, BombermanGameScene,
  ],
  pixelArt: true,
});
