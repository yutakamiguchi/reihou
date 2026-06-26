import Phaser from "phaser";

// スマホ向けの画面上タッチ操作（左:仮想ジョイスティック / 右:アクションボタン）。
// 各ゲームシーンは held を毎フレーム読み、onAction を攻撃/ボム設置などに繋ぐ。
// 内部解像度(1600x900)のシーン座標で配置し、Scale.FIT でそのまま縮小される。

export interface TouchControls {
  // 毎フレーム読む移動の押下状態（キーボードと OR して使う想定）
  held: { up: boolean; down: boolean; left: boolean; right: boolean };
  // タッチ端末でコントロールを表示しているか（false ならキーボードのみ）
  readonly enabled: boolean;
  destroy(): void;
}

interface Opts {
  onAction: () => void;   // アクションボタン押下時（攻撃/ボム設置など）
  actionLabel?: string;   // ボタンに出す文字（例: "💣" / "攻撃"）
  deadZone?: number;      // 入力とみなす最小距離(px)
  maxRadius?: number;     // スティックの最大振れ幅(px)
  // ボタン/スティックの大きさ上書き（省略時は既定値。スマホで押しやすく大型化したい時に指定）
  actionRadius?: number;  // アクションボタン半径（既定100）
  stickBaseRadius?: number;  // スティック土台の半径（既定110）
  stickThumbRadius?: number; // スティックつまみの半径（既定52）
  // 2カメラ構成のシーンで、生成した操作UIをこのLayer(=UI専用カメラ側)に載せる。
  // 省略時はシーン直下（単一カメラのシーン用）。
  layer?: Phaser.GameObjects.Layer;
}

// タッチ端末判定。デスクトップ(マウス)では表示しない。
function isTouchDevice(scene: Phaser.Scene): boolean {
  const dev = scene.sys.game.device;
  return dev.input.touch && !dev.os.desktop;
}

export function addTouchControls(scene: Phaser.Scene, opts: Opts): TouchControls {
  const held = { up: false, down: false, left: false, right: false };

  if (!isTouchDevice(scene)) {
    return { held, enabled: false, destroy() {} };
  }

  const deadZone = opts.deadZone ?? 22;
  const maxRadius = opts.maxRadius ?? 90;
  const DEPTH = 5000;

  const W = scene.scale.width;
  const H = scene.scale.height;

  // 2本指（スティック＋ボタン）を同時に拾えるようにする
  scene.input.addPointer(2);

  // --- 仮想ジョイスティック（左半分のどこを触ってもそこに出現） ---
  const baseR = opts.stickBaseRadius ?? 110;
  const thumbR = opts.stickThumbRadius ?? 52;
  const stickBase = scene.add.circle(0, 0, baseR, 0x000000, 0.22)
    .setStrokeStyle(4, 0xffffff, 0.35).setScrollFactor(0).setDepth(DEPTH).setVisible(false);
  const stickThumb = scene.add.circle(0, 0, thumbR, 0xffffff, 0.45)
    .setScrollFactor(0).setDepth(DEPTH + 1).setVisible(false);

  let stickPointerId = -1;
  let originX = 0, originY = 0;

  // --- アクションボタン（右下固定） ---
  const btnR = opts.actionRadius ?? 100;
  const btnX = W - btnR - 70;
  const btnY = H - btnR - 70;
  const actionBtn = scene.add.circle(btnX, btnY, btnR, 0xff5555, 0.30)
    .setStrokeStyle(5, 0xff7777, 0.7).setScrollFactor(0).setDepth(DEPTH);
  const actionTxt = scene.add.text(btnX, btnY, opts.actionLabel ?? "●", {
    fontSize: `${Math.round(btnR * 0.48)}px`, color: "#ffffff", fontStyle: "bold",
  }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 1);
  let actionPointerId = -1;

  // 2カメラ構成: 操作UIをUI専用Layerへ載せる（ワールドカメラのズーム対象から外す）。
  opts.layer?.add([stickBase, stickThumb, actionBtn, actionTxt]);

  function inActionBtn(x: number, y: number): boolean {
    // ボタンの実サイズ内だけをアクション扱いにする（余白を足さない）。
    // こうすることでボタン周辺も含めて画面のほぼ全域を移動スティックに使える。
    return Phaser.Math.Distance.Between(x, y, btnX, btnY) <= btnR;
  }

  function resetStick() {
    stickPointerId = -1;
    held.up = held.down = held.left = held.right = false;
    stickBase.setVisible(false);
    stickThumb.setVisible(false);
  }

  function updateStick(px: number, py: number) {
    let dx = px - originX;
    let dy = py - originY;
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }
    stickThumb.setPosition(originX + dx, originY + dy);

    if (dist < deadZone) {
      held.up = held.down = held.left = held.right = false;
      return;
    }
    // 8方向: 各軸が半径の一定割合を超えたら ON（斜めも許可）
    const th = maxRadius * 0.35;
    held.left = dx < -th;
    held.right = dx > th;
    held.up = dy < -th;
    held.down = dy > th;
  }

  const onDown = (p: Phaser.Input.Pointer) => {
    if (inActionBtn(p.x, p.y)) {
      if (actionPointerId === -1) {
        actionPointerId = p.id;
        actionBtn.setFillStyle(0xff5555, 0.55);
        opts.onAction();
      }
      return;
    }
    // ボタン等の Interactive な UI 上ならスティックを出さない（準備/CPU/マップ選択など）
    if (scene.input.hitTestPointer(p).length > 0) return;
    // それ以外（=左/中央）の最初のタッチをスティックにする
    if (stickPointerId === -1) {
      stickPointerId = p.id;
      originX = p.x; originY = p.y;
      stickBase.setPosition(originX, originY).setVisible(true);
      stickThumb.setPosition(originX, originY).setVisible(true);
      updateStick(p.x, p.y);
    }
  };

  const onMove = (p: Phaser.Input.Pointer) => {
    if (p.id === stickPointerId && p.isDown) updateStick(p.x, p.y);
  };

  const onUp = (p: Phaser.Input.Pointer) => {
    if (p.id === stickPointerId) resetStick();
    if (p.id === actionPointerId) {
      actionPointerId = -1;
      actionBtn.setFillStyle(0xff5555, 0.30);
    }
  };

  scene.input.on("pointerdown", onDown);
  scene.input.on("pointermove", onMove);
  scene.input.on("pointerup", onUp);
  scene.input.on("pointerupoutside", onUp);

  // シーン終了時のリスナ/オブジェクト掃除
  const destroy = () => {
    scene.input.off("pointerdown", onDown);
    scene.input.off("pointermove", onMove);
    scene.input.off("pointerup", onUp);
    scene.input.off("pointerupoutside", onUp);
    stickBase.destroy(); stickThumb.destroy();
    actionBtn.destroy(); actionTxt.destroy();
  };
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, destroy);

  return { held, enabled: true, destroy };
}
