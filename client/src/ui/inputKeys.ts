import Phaser from "phaser";

// 全ゲーム共通の移動＋アクションキー（WASD / 矢印 / Space）。
export interface MoveKeys {
  W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
  S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
  UP: Phaser.Input.Keyboard.Key; DOWN: Phaser.Input.Keyboard.Key;
  LEFT: Phaser.Input.Keyboard.Key; RIGHT: Phaser.Input.Keyboard.Key;
  SPACE: Phaser.Input.Keyboard.Key;
}

// シーンに移動キーを登録して返す。Space の挙動は各シーンで .on("down") して決める。
export function addMoveKeys(scene: Phaser.Scene): MoveKeys {
  return scene.input.keyboard!.addKeys({
    W: Phaser.Input.Keyboard.KeyCodes.W,
    A: Phaser.Input.Keyboard.KeyCodes.A,
    S: Phaser.Input.Keyboard.KeyCodes.S,
    D: Phaser.Input.Keyboard.KeyCodes.D,
    UP: Phaser.Input.Keyboard.KeyCodes.UP,
    DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
    LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
    RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
    SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
  }) as unknown as MoveKeys;
}

// WASD/矢印を up/down/left/right の bool にまとめて読む。
export function readMove(keys: MoveKeys) {
  return {
    up: keys.W.isDown || keys.UP.isDown,
    down: keys.S.isDown || keys.DOWN.isDown,
    left: keys.A.isDown || keys.LEFT.isDown,
    right: keys.D.isDown || keys.RIGHT.isDown,
  };
}
