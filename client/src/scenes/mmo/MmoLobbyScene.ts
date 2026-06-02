import Phaser from "phaser";
import { buildLobby } from "../../ui/lobby";

export class MmoLobbyScene extends Phaser.Scene {
  constructor() { super("MmoLobby"); }

  create() {
    buildLobby(this, {
      title: "霊宝コレクション",
      subtitle: "広い世界を探索し、限定供給の霊宝を集めよう",
      roomName: "mmo",
      gameSceneKey: "MmoGame",
      quickLabel: "[ 世界に入る ]",
      hint: "操作: WASD/矢印で移動、Space で攻撃 / モンスター討伐・💎拾得で霊宝入手 / B で台帳",
      enableCode: false,
    });
  }
}
