import Phaser from "phaser";
import { joinPublicRoom, createPrivateRoom, joinRoomByCode } from "../net";
import { enableSfx } from "../sfx";
import { makeInput, makeButton } from "./nameInput";
import { tryJoin } from "./connectFlow";
import { loadPlayerName, savePlayerName } from "./playerName";

export interface LobbyConfig {
  title: string;          // 大見出し
  subtitle: string;       // 説明文
  roomName: string;       // Colyseus ルーム名（unspottable / bomberman / mmo）
  gameSceneKey: string;   // 参加成功後に遷移するゲームシーン
  quickLabel: string;     // クイック参加ボタンの文言
  hint: string;           // 画面下の操作説明
  enableCode?: boolean;   // プライベート作成＋コード参加を出すか（既定 false=クイックのみ）
  // 追加UI（アイテム凡例など）。レイアウトの基準として hint の y を渡す。
  extra?: (scene: Phaser.Scene, hintY: number) => void;
}

// 3ゲーム共通のロビー画面を構築する。各 XxxLobbyScene は create() でこれを呼ぶだけ。
export function buildLobby(scene: Phaser.Scene, cfg: LobbyConfig) {
  const { width, height } = scene.scale;

  scene.add.text(width / 2, 90, cfg.title, {
    fontSize: "56px", color: "#ffffff", fontStyle: "bold",
  }).setOrigin(0.5);

  scene.add.text(width / 2, 160, cfg.subtitle, {
    fontSize: "18px", color: "#cccccc",
  }).setOrigin(0.5);

  makeButton(scene, 90, 40, "← ハブ", "#aaaaaa", () => scene.scene.start("Hub"));

  const nameInput = makeInput(scene, "名前", 16, loadPlayerName(), width / 2, 230);
  let codeInput: HTMLInputElement | null = null;

  const status = scene.add.text(width / 2, height - 130, "", {
    fontSize: "16px", color: "#ff8888",
  }).setOrigin(0.5);

  const getName = (): string => {
    const name = nameInput.value.trim() || "Player";
    savePlayerName(name);
    return name;
  };
  const cleanup = () => { nameInput.remove(); codeInput?.remove(); };

  if (cfg.enableCode) {
    makeButton(scene, width / 2, 320, cfg.quickLabel, "#7ee787", () => {
      tryJoin(scene, status, () => joinPublicRoom(cfg.roomName, getName()), cfg.gameSceneKey, cleanup);
    });
    makeButton(scene, width / 2, 380, "[ プライベートルームを作成 ]", "#7ec0e7", () => {
      tryJoin(scene, status, () => createPrivateRoom(cfg.roomName, getName()), cfg.gameSceneKey, cleanup);
    });
    scene.add.text(width / 2 - 110, 450, "コード:", {
      fontSize: "18px", color: "#cccccc",
    }).setOrigin(1, 0.5);
    codeInput = makeInput(scene, "4桁", 4, "", width / 2 + 10, 450, 110);
    codeInput.inputMode = "numeric";
    codeInput.pattern = "[0-9]*";
    makeButton(scene, width / 2 + 170, 450, "[ 参加 ]", "#ffe066", () => {
      const code = codeInput!.value.trim();
      if (!/^\d{4}$/.test(code)) { status.setText("4桁のコードを入力してください"); return; }
      tryJoin(scene, status, () => joinRoomByCode(cfg.roomName, getName(), code), cfg.gameSceneKey, cleanup);
    });
  } else {
    makeButton(scene, width / 2, 340, cfg.quickLabel, "#7ee787", () => {
      tryJoin(scene, status, () => joinPublicRoom(cfg.roomName, getName()), cfg.gameSceneKey, cleanup);
    });
  }

  // 追加UI（hint より上に余白を取る場合は hint を上げる）
  const hintY = cfg.extra ? height - 90 : height - 60;
  scene.add.text(width / 2, hintY, cfg.hint, {
    fontSize: "14px", color: "#888888",
  }).setOrigin(0.5);
  cfg.extra?.(scene, hintY);

  scene.input.once("pointerdown", () => enableSfx());
  scene.events.once("shutdown", cleanup);
}
