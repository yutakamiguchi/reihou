import Phaser from "phaser";
import { joinPublicRoom } from "../../net";
import { enableSfx } from "../../sfx";
import { makeInput, makeButton } from "../../ui/nameInput";
import { tryJoin } from "../../ui/connectFlow";
import { loadPlayerName, savePlayerName } from "../../ui/playerName";

const ROOM = "mmo";

export class MmoLobbyScene extends Phaser.Scene {
  private nameInput!: HTMLInputElement;

  constructor() { super("MmoLobby"); }

  create() {
    const { width, height } = this.scale;

    this.add.text(width / 2, 90, "MMO ワールド", {
      fontSize: "56px", color: "#ffffff", fontStyle: "bold",
    }).setOrigin(0.5);

    this.add.text(width / 2, 160, "広い世界でモンスターを倒し、レベルを上げよう", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(0.5);

    makeButton(this, 90, 40, "← ハブ", "#aaaaaa", () => this.scene.start("Hub"));

    this.nameInput = makeInput(this, "名前", 16, loadPlayerName(), width / 2, 250);

    const status = this.add.text(width / 2, height - 130, "", {
      fontSize: "16px", color: "#ff8888",
    }).setOrigin(0.5);

    const cleanup = () => { this.nameInput.remove(); };

    makeButton(this, width / 2, 340, "[ ワールドに入る ]", "#7ee787", () => {
      tryJoin(this, status, () => joinPublicRoom(ROOM, this.getName()), "MmoGame", cleanup);
    });

    this.add.text(width / 2, height - 60,
      "操作: WASD/矢印で移動、Space で攻撃  /  モンスターを倒してレベルアップ", {
      fontSize: "14px", color: "#888888",
    }).setOrigin(0.5);

    this.input.once("pointerdown", () => enableSfx());

    this.events.once("shutdown", () => { this.nameInput?.remove(); });
  }

  private getName(): string {
    const name = this.nameInput.value.trim() || "Player";
    savePlayerName(name);
    return name;
  }
}
