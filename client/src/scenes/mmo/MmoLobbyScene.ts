import Phaser from "phaser";
import { buildLobby } from "../../ui/lobby";

export class MmoLobbyScene extends Phaser.Scene {
  constructor() { super("MmoLobby"); }

  create() {
    buildLobby(this, {
      title: "MMO ワールド",
      subtitle: "広い世界でモンスターを倒し、レベルを上げよう",
      roomName: "mmo",
      gameSceneKey: "MmoGame",
      quickLabel: "[ ワールドに入る ]",
      hint: "操作: WASD/矢印で移動、Space で攻撃  /  モンスターを倒してレベルアップ",
      enableCode: false,
    });
  }
}
