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
  // canvas と同じ親(#game)に入れ、canvas に対する相対位置で配置する。
  // ビューポート/スクロール/セーフエリア/iOS の visual viewport などの基準ズレは
  // 「canvas と el を同じ座標系で差分計算」することで打ち消され、横画面でもズレない。
  const host = (scene.game.canvas.parentElement as HTMLElement) || document.body;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  Object.assign(el.style, {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    margin: "0",
    boxSizing: "border-box",
    padding: "8px 12px",
    border: "2px solid #888",
    borderRadius: "6px",
    background: "#1a1d24",
    color: "#fff",
    outline: "none",
    textAlign: "center",
  } as CSSStyleDeclaration);

  // canvas の現在位置・スケールに合わせて配置を更新する。
  // 画面回転やウィンドウリサイズで canvas の矩形が変わるため毎回取り直す。
  const reposition = () => {
    const canvas = scene.game.canvas;
    const cRect = canvas.getBoundingClientRect();
    const hRect = host.getBoundingClientRect();
    const scaleX = cRect.width / scene.scale.width;
    const scaleY = cRect.height / scene.scale.height;
    // host 内ローカル座標 = canvas の host に対する相対位置（同一座標系の差分）
    const localLeft = cRect.left - hRect.left;
    const localTop = cRect.top - hRect.top;
    el.style.left = `${localLeft + x * scaleX}px`;
    el.style.top = `${localTop + y * scaleY}px`;
    el.style.width = `${width * scaleX}px`;
    el.style.fontSize = `${18 * scaleY}px`;
  };
  host.appendChild(el);
  reposition();

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
