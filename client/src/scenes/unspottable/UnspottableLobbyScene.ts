import Phaser from "phaser";
import { buildLobby } from "../../ui/lobby";

export class UnspottableLobbyScene extends Phaser.Scene {
  constructor() { super("UnspottableLobby"); }

  create() {
    buildLobby(this, {
      title: "Unspottable Web",
      subtitle: "群衆に紛れて他プレイヤーを見つけて叩け",
      roomName: "unspottable",
      gameSceneKey: "UnspottableGame",
      quickLabel: "[ クイック参加 ]",
      hint: "操作: WASD/矢印で移動、Space で叩く  /  2人以上揃って「準備」で開始",
      enableCode: true,
    });
  }
}
