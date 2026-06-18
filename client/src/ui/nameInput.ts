import Phaser from "phaser";

// Phaser canvas 上に HTML の <input> をオーバーレイ配置するヘルパ。
// canvas のスケール（CSSサイズ / ゲーム内解像度）に合わせて位置・サイズを補正する。
export function makeInput(
  scene: Phaser.Scene,
  placeholder: string, maxLen: number, defaultVal: string,
  x: number, y: number, width = 240, type: string = "text",
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  el.placeholder = placeholder;
  el.maxLength = maxLen;
  el.value = defaultVal;
  Object.assign(el.style, {
    // fixed = ビューポート基準。getBoundingClientRect もビューポート基準なので
    // ページのスクロール量に左右されず canvas と正確に揃う（absolute だと
    // スクロール分だけ上下にずれる＝横画面で「少し上による」原因になる）。
    position: "fixed",
    transform: "translate(-50%, -50%)",
    padding: "8px 12px",
    border: "2px solid #888",
    borderRadius: "6px",
    background: "#1a1d24",
    color: "#fff",
    outline: "none",
    textAlign: "center",
  } as CSSStyleDeclaration);

  // canvas の現在位置・スケールに合わせて配置を更新する。
  // 画面回転やウィンドウリサイズで canvas の矩形が変わるため、毎回 getBoundingClientRect で取り直す。
  // これをしないと回転後に入力欄が画面外へずれて見えなくなる。
  const reposition = () => {
    const canvas = scene.game.canvas;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / scene.scale.width;
    const scaleY = rect.height / scene.scale.height;
    el.style.left = `${rect.left + x * scaleX}px`;
    el.style.top = `${rect.top + y * scaleY}px`;
    el.style.width = `${width * scaleX}px`;
    el.style.fontSize = `${18 * scaleY}px`;
  };
  reposition();
  document.body.appendChild(el);

  // リサイズ/回転に追従。回転直後は寸法が未確定なことがあるので遅延でも再配置する。
  const onResize = () => { reposition(); window.setTimeout(reposition, 250); };
  scene.scale.on(Phaser.Scale.Events.RESIZE, reposition);
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  const detach = () => {
    scene.scale.off(Phaser.Scale.Events.RESIZE, reposition);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
  };
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, detach);
  // 呼び出し側が el.remove() で破棄したときもリスナーを確実に外す。
  const origRemove = el.remove.bind(el);
  el.remove = () => { detach(); origRemove(); };

  return el;
}

// Phaser テキストをボタン風に。ホバーで白、クリックで onClick。
export function makeButton(
  scene: Phaser.Scene,
  x: number, y: number, text: string, color: string,
  onClick: () => void,
): Phaser.GameObjects.Text {
  const btn = scene.add.text(x, y, text, {
    fontSize: "22px", color, fontStyle: "bold",
    backgroundColor: "#1a1d24", padding: { x: 14, y: 8 } as any,
  }).setOrigin(0.5).setInteractive({ useHandCursor: true });
  btn.on("pointerover", () => btn.setColor("#ffffff"));
  btn.on("pointerout", () => btn.setColor(color));
  btn.on("pointerdown", onClick);
  return btn;
}
