import Phaser from "phaser";

// Phaser canvas 上に HTML の <input> をオーバーレイ配置するヘルパ。
// canvas のスケール（CSSサイズ / ゲーム内解像度）に合わせて位置・サイズを補正する。
export function makeInput(
  scene: Phaser.Scene,
  placeholder: string, maxLen: number, defaultVal: string,
  x: number, y: number, width = 240,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.placeholder = placeholder;
  el.maxLength = maxLen;
  el.value = defaultVal;
  const canvas = scene.game.canvas;
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / scene.scale.width;
  const scaleY = rect.height / scene.scale.height;
  Object.assign(el.style, {
    position: "absolute",
    left: `${rect.left + x * scaleX}px`,
    top: `${rect.top + y * scaleY}px`,
    transform: "translate(-50%, -50%)",
    width: `${width * scaleX}px`,
    fontSize: `${18 * scaleY}px`,
    padding: "8px 12px",
    border: "2px solid #888",
    borderRadius: "6px",
    background: "#1a1d24",
    color: "#fff",
    outline: "none",
    textAlign: "center",
  } as CSSStyleDeclaration);
  document.body.appendChild(el);
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
