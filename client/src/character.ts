// キャラのイラスト素材（client/public/char/）を方向別に読み込んで使う。
// 全キャラ同一の見た目（群衆に紛れる仕様）。
// 方向: front=手前向き / back=奥向き / side=横向き（右向きで描かれている。左は反転）。
// 各方向に idle(立ち1枚) / walk(歩行2コマ) / punch(攻撃1枚)。

export type Dir = "front" | "back" | "side";
export type CharMode = "idle" | "walk" | "punch";

const POSES = ["idle", "walk1", "walk2", "punch"] as const;
const DIRS: Dir[] = ["front", "back", "side"];

function texKey(dir: Dir, pose: string) { return `char_${dir}_${pose}`; }
function walkAnimKey(dir: Dir) { return `charwalk_${dir}`; }

// 各シーンの preload() で呼ぶ。テクスチャは常駐するので再入場時はスキップ。
export function preloadCharTextures(scene: Phaser.Scene) {
  for (const dir of DIRS) {
    for (const pose of POSES) {
      const key = texKey(dir, pose);
      if (!scene.textures.exists(key)) scene.load.image(key, `/char/${dir}_${pose}.png`);
    }
  }
}

// 方向別の歩行アニメ（walk1↔walk2）を定義する。create() で1度呼ぶ。
export function ensureCharAnims(scene: Phaser.Scene) {
  for (const dir of DIRS) {
    const key = walkAnimKey(dir);
    if (scene.anims.exists(key)) continue;
    scene.anims.create({
      key,
      frames: [{ key: texKey(dir, "walk1") }, { key: texKey(dir, "walk2") }],
      frameRate: 6,
      repeat: -1,
    });
  }
}

// スプライトに方向＋モードのポーズを適用する。
// flip は side のとき左向きにするフラグ（front/back では無視）。
// displayH は望む表示高さ(px)。画像ごとに高さが違うので毎回スケールを合わせる。
export function applyCharPose(
  sprite: Phaser.GameObjects.Sprite,
  dir: Dir, mode: CharMode, flip: boolean, displayH: number,
) {
  if (mode === "walk") {
    const key = walkAnimKey(dir);
    if (sprite.anims.currentAnim?.key !== key) sprite.play(key, true);
  } else {
    if (sprite.anims.isPlaying) sprite.stop();
    const key = texKey(dir, mode === "punch" ? "punch" : "idle");
    if (sprite.texture.key !== key) sprite.setTexture(key);
  }
  // 現在フレームの元画像高さに合わせてスケール（画像ごとの高さ差を吸収）
  const h = sprite.frame.realHeight || displayH;
  sprite.setScale(displayH / h);
  // side のみ左右反転。front/back は反転しない。
  sprite.setFlipX(dir === "side" && flip);
}

// 立ち絵の最初のテクスチャキー（addView 時の初期表示用）。
export const CHAR_INITIAL_TEX = texKey("front", "idle");

// ── ボンバーマン専用キャラ（プレイヤー別 1p〜4p、方向3枚のみ・ポーズ無し）──────
// client/public/char-bomberman/{1..4}p_{front|side|back}.png
export function bombermanTexKey(playerNo: number, dir: Dir) {
  const n = Math.min(4, Math.max(1, playerNo || 1));
  return `bchar_${n}_${dir}`;
}

export function preloadBombermanChars(scene: Phaser.Scene) {
  for (let p = 1; p <= 4; p++) {
    for (const dir of DIRS) {
      const key = bombermanTexKey(p, dir);
      if (!scene.textures.exists(key)) scene.load.image(key, `/char-bomberman/${p}p_${dir}.png`);
    }
  }
}

// プレイヤー別の方向ポーズを適用（walk/punch は無いので方向画像を流用、side は左反転）。
export function applyBombermanPose(
  sprite: Phaser.GameObjects.Sprite,
  playerNo: number, dir: Dir, flip: boolean, displayH: number,
) {
  const key = bombermanTexKey(playerNo, dir);
  if (sprite.texture.key !== key) sprite.setTexture(key);
  const h = sprite.frame.realHeight || displayH;
  sprite.setScale(displayH / h);
  sprite.setFlipX(dir === "side" && flip);
}

// 移動ベクトル(dx,dy)から向きと左反転を求める。停止時は null。
export function dirFromVector(dx: number, dy: number): { dir: Dir; flip: boolean } | null {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return null;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return { dir: dy > 0 ? "front" : "back", flip: false };
  }
  return { dir: "side", flip: dx < 0 };
}

// 角度(ラジアン)から向きと左反転を求める（攻撃方向などに使う）。
export function dirFromAngle(angle: number): { dir: Dir; flip: boolean } {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (Math.abs(s) >= Math.abs(c)) return { dir: s > 0 ? "front" : "back", flip: false };
  return { dir: "side", flip: c < 0 };
}
