import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";
import {
  preloadCharTextures, ensureCharAnims, applyCharPose,
  dirFromVector, dirFromAngle, CHAR_INITIAL_TEX, type Dir,
} from "../../character";
import { sfxHitPlayer, sfxHitNpc, sfxScore, sfxFootstep, sfxRoundStart } from "../../sfx";
import { addMoveKeys } from "../../ui/inputKeys";
import { fetchCards, fetchMyCards, type Card } from "../../spirit";
import { CARD_ICON, RARITY_META } from "../spirit/cards-meta";
import { getMyProfile, getUser } from "../../auth";

const PLAYER_SPEED = 140;
const ENTITY_RADIUS = 14;
const CHAR_DISPLAY_H = 56;
const MOB_DISPLAY_H = 52;

interface PlayerView {
  container: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Ellipse;
  sprite: Phaser.GameObjects.Sprite;
  nameLabel: Phaser.GameObjects.Text;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFg: Phaser.GameObjects.Rectangle;
  dir: Dir;
  flip: boolean;
  punching: boolean;
  lastStep: number;
}

interface MobView {
  container: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Ellipse;
  sprite: Phaser.GameObjects.Sprite;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFg: Phaser.GameObjects.Rectangle;
  dir: Dir;
  flip: boolean;
}

export class MmoGameScene extends Phaser.Scene {
  private room!: Room;
  private myId!: string;
  private players = new Map<string, PlayerView>();
  private mobs = new Map<string, MobView>();
  private relicViews = new Map<string, Phaser.GameObjects.Container>();
  private worldLayer!: Phaser.GameObjects.Layer;
  private predictReady = false;
  private cardById = new Map<number, Card>(); // 霊宝メタ（ドロップ表示用）
  private binderLayer?: Phaser.GameObjects.Container;
  private statusLayer?: Phaser.GameObjects.Container;
  private binderTab: "common" | "rare" | "legend" = "common";

  // HUD
  private hpBarBg!: Phaser.GameObjects.Rectangle;
  private hpBarFg!: Phaser.GameObjects.Rectangle;
  private expBarBg!: Phaser.GameObjects.Rectangle;
  private expBarFg!: Phaser.GameObjects.Rectangle;
  private hudText!: Phaser.GameObjects.Text;
  private deadText!: Phaser.GameObjects.Text;

  private keys!: {
    W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    UP: Phaser.Input.Keyboard.Key; DOWN: Phaser.Input.Keyboard.Key;
    LEFT: Phaser.Input.Keyboard.Key; RIGHT: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };
  private lastInputSent = { up: false, down: false, left: false, right: false };

  constructor() { super("MmoGame"); }

  init(data: { room: Room }) {
    this.room = data.room;
    this.myId = this.room.sessionId;
  }

  preload() {
    preloadCharTextures(this);
    // モンスター画像があれば使う（無ければキャラ緑染めで代用）
    this.load.image("mob", "/char/mob_idle.png");
  }

  create() {
    const { width, height } = this.scale;
    ensureCharAnims(this);
    const state: any = this.room.state;
    const mapW = state.mapWidth, mapH = state.mapHeight;

    // --- 背景（広いマップ。個別タイルは重いので大きい矩形＋疎なグリッド線） ---
    this.add.rectangle(mapW / 2, mapH / 2, mapW, mapH, 0x3a6b3f);
    const grid = this.add.graphics();
    grid.lineStyle(2, 0x000000, 0.08);
    for (let x = 0; x <= mapW; x += 128) grid.lineBetween(x, 0, x, mapH);
    for (let y = 0; y <= mapH; y += 128) grid.lineBetween(0, y, mapW, y);
    // 外周フェンス
    this.add.rectangle(mapW / 2, mapH / 2, mapW, mapH, 0, 0).setStrokeStyle(8, 0x2a3a2c);

    this.worldLayer = this.add.layer();

    // --- カメラ ---
    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.cameras.main.setBackgroundColor(0x223024);

    // --- HUD（画面固定） ---
    this.add.rectangle(12, 12, 240, 78, 0x000000, 0.5)
      .setOrigin(0, 0).setStrokeStyle(2, 0x666666).setScrollFactor(0).setDepth(1000);
    this.hudText = this.add.text(20, 18, "", {
      fontSize: "15px", color: "#ffffff", fontStyle: "bold",
    }).setScrollFactor(0).setDepth(1001);
    // HP バー
    this.hpBarBg = this.add.rectangle(20, 44, 220, 14, 0x401515)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1001);
    this.hpBarFg = this.add.rectangle(20, 44, 220, 14, 0xe04545)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1002);
    // EXP バー
    this.expBarBg = this.add.rectangle(20, 64, 220, 10, 0x2a2a40)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1001);
    this.expBarFg = this.add.rectangle(20, 64, 0, 10, 0x66aaff)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(1002);

    this.deadText = this.add.text(width / 2, height / 2, "", {
      fontSize: "40px", color: "#ff6666", fontStyle: "bold", stroke: "#000", strokeThickness: 5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2000).setVisible(false);

    this.add.text(width - 12, height - 10, "B: 台帳　/　C: ステータス　/　ESC: ハブに戻る", {
      fontSize: "13px", color: "#aaaaaa",
    }).setOrigin(1, 1).setScrollFactor(0).setDepth(1000);

    // --- 入力 ---
    this.keys = addMoveKeys(this);
    this.keys.SPACE.on("down", () => this.room.send("attack"));
    this.input.keyboard!.on("keydown-ESC", () => {
      if (this.statusLayer) this.closeStatus();
      else if (this.binderLayer) this.closeBinder();
      else this.room.leave();
    });
    this.input.keyboard!.on("keydown-B", () => this.toggleBinder());
    this.input.keyboard!.on("keydown-C", () => this.toggleStatus());

    // --- state 購読 ---
    const $ = getStateCallbacks(this.room);

    $(state).players.onAdd((p: any, id: string) => {
      this.addPlayerView(id, p);
      if (id === this.myId) {
        const v = this.players.get(id);
        if (v) this.cameras.main.startFollow(v.container, true, 0.15, 0.15);
      }
      $(p).listen("attackUntil", (val: number) => {
        if (val > Date.now()) this.showAttackFx(id, p);
      });
      $(p).listen("hp", (nv: number, ov: number | undefined) => {
        this.updatePlayerHpBar(id, p);
        if (ov !== undefined && nv < ov) { this.flashHit(id, true); this.popDamage(id, ov - nv); }
      });
      $(p).listen("level", (nv: number, ov: number | undefined) => {
        if (ov !== undefined && nv > ov) this.popLevelUp(id);
      });
    });
    $(state).players.onRemove((_p: any, id: string) => this.removePlayerView(id));

    $(state).mobs.onAdd((m: any, id: string) => {
      this.addMobView(id, m);
      $(m).listen("hp", (nv: number, ov: number | undefined) => {
        this.updateMobHpBar(id, m);
        if (ov !== undefined && nv < ov) this.flashHit(id, false);
      });
    });
    $(state).mobs.onRemove((m: any, id: string) => this.removeMobView(id, m));

    $(state).relics.onAdd((r: any, id: string) => this.addRelicView(id, r));
    $(state).relics.onRemove((_r: any, id: string) => this.removeRelicView(id));

    this.room.onLeave(() => this.scene.start("MmoLobby"));

    // 霊宝：カードメタ取得＋ドロップ通知
    void fetchCards().then((cs) => { this.cardById = new Map(cs.map((c) => [c.id, c])); }).catch(() => {});
    this.room.onMessage("relicFound", (m: { cardId: number }) => this.showRelicFound(m.cardId));
  }

  // --- フィールドの霊宝ノード ---

  private addRelicView(id: string, r: any) {
    const cont = this.add.container(r.x, r.y);
    const glow = this.add.circle(0, 0, 16, 0xffe066, 0.25);
    const gem = this.add.text(0, 0, "💎", { fontSize: "26px" }).setOrigin(0.5);
    cont.add([glow, gem]);
    cont.setDepth(r.y);
    this.worldLayer.add(cont);
    this.tweens.add({ targets: gem, y: -6, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.tweens.add({ targets: glow, alpha: { from: 0.15, to: 0.4 }, scale: { from: 0.8, to: 1.2 }, duration: 900, yoyo: true, repeat: -1 });
    this.relicViews.set(id, cont);
  }

  private removeRelicView(id: string) {
    const c = this.relicViews.get(id);
    if (!c) return;
    this.spawnStarBurst(c.x, c.y); // 拾得演出
    c.destroy();
    this.relicViews.delete(id);
  }

  // mob討伐などで霊宝を入手したときのポップアップ（画面固定）。
  private showRelicFound(cardId: number) {
    const c = this.cardById.get(cardId);
    const meta = c ? RARITY_META[c.rarity] : null;
    const cx = this.scale.width / 2;
    const cont = this.add.container(cx, 150).setScrollFactor(0).setDepth(5000);
    const bg = this.add.rectangle(0, 0, 320, 92, 0x15101f, 0.96).setStrokeStyle(3, meta?.colorNum ?? 0xe8b04b);
    const icon = this.add.text(-128, 0, CARD_ICON[cardId] ?? "✨", { fontSize: "42px" }).setOrigin(0.5);
    const title = this.add.text(-92, -18, "✦ 霊宝を発見！", { fontSize: "16px", color: "#e8c87e", fontStyle: "bold" }).setOrigin(0, 0.5);
    const name = this.add.text(-92, 14, c?.name ?? `#${cardId}`, { fontSize: "22px", color: "#ece7f5", fontStyle: "bold" }).setOrigin(0, 0.5);
    cont.add([bg, icon, title, name]);
    cont.setAlpha(0).setScale(0.85);
    this.tweens.add({ targets: cont, alpha: 1, scale: 1, duration: 250, ease: "Back.easeOut" });
    sfxScore();
    this.time.delayedCall(2600, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, y: 130, duration: 300, onComplete: () => cont.destroy() });
    });
    if (this.binderLayer) void this.openBinder(); // 開いていれば即反映
  }

  // --- ステータスパネル（Cキー。蒐集進捗＋RPG＋アカウント情報）---

  private toggleStatus() {
    if (this.statusLayer) this.closeStatus();
    else void this.openStatus();
  }

  private closeStatus() {
    this.statusLayer?.destroy();
    this.statusLayer = undefined;
  }

  private async openStatus() {
    this.closeBinder(); // 同時には開かない
    const { width, height } = this.scale;
    this.statusLayer?.destroy();
    const layer = this.add.container(0, 0).setScrollFactor(0).setDepth(7000);
    this.statusLayer = layer;
    const T = (x: number, y: number, t: string, size: number, color: string, bold = false) => {
      const o = this.add.text(x, y, t, { fontSize: `${size}px`, color, fontStyle: bold ? "bold" : "normal" });
      layer.add(o); return o;
    };

    layer.add(this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.8).setInteractive());
    T(width / 2, 34, "ステータス", 30, "#e8c87e", true).setOrigin(0.5);
    const close = T(width - 30, 30, "✕ 閉じる (C)", 16, "#cccccc").setOrigin(1, 0).setInteractive({ useHandCursor: true });
    close.on("pointerover", () => close.setColor("#fff"));
    close.on("pointerout", () => close.setColor("#cccccc"));
    close.on("pointerdown", () => this.closeStatus());

    // RPGステータス（state からライブ取得）
    const me: any = (this.room.state as any).players.get(this.myId);
    const leftX = width / 2 - 300, rightX = width / 2 + 30;

    T(leftX, 100, "▸ アカウント", 18, "#7ee787", true);
    const acc = T(leftX, 132, "読み込み中…", 16, "#ece7f5");

    T(leftX, 250, "▸ RPGステータス", 18, "#7ee787", true);
    if (me) {
      const fmtTime = (sec: number) => {
        const s = Math.max(0, Math.floor(sec || 0));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        return h > 0 ? `${h}時間${m}分` : `${m}分${ss}秒`;
      };
      T(leftX, 282, `レベル    ${me.level}`, 16, "#ece7f5");
      T(leftX, 308, `EXP      ${me.exp} / ${me.nextExp}`, 16, "#ece7f5");
      T(leftX, 334, `HP       ${me.hp} / ${me.maxHp}`, 16, "#ece7f5");
      T(leftX, 360, `ATK      ${me.atk}`, 16, "#ece7f5");
      T(leftX, 386, `討伐数    ${me.kills ?? 0}`, 16, "#ece7f5");
      T(leftX, 412, `プレイ時間 ${fmtTime(me.playSec)}`, 16, "#ece7f5");
    } else {
      T(leftX, 282, "（世界に入ると表示）", 14, "#9b93b0");
    }

    T(rightX, 100, "▸ 蒐集進捗", 18, "#7ee787", true);
    const col = T(rightX, 132, "読み込み中…", 16, "#ece7f5");

    try {
      const [cards, mine, profile, user] = await Promise.all([
        fetchCards(), fetchMyCards(), getMyProfile(), getUser(),
      ]);
      if (this.statusLayer !== layer) return;

      const created = profile?.created_at ? new Date(profile.created_at).toLocaleDateString("ja-JP") : "-";
      acc.setText(
        `表示名 : ${profile?.display_name ?? "-"}\n` +
        `メール : ${user?.email ?? "(ゲスト)"}\n` +
        `登録日 : ${created}`
      ).setLineSpacing(8);

      const owned = new Map(mine.map((m) => [m.card_id, m.count]));
      const rar: Record<string, { have: number; total: number }> = {
        common: { have: 0, total: 0 }, rare: { have: 0, total: 0 }, legend: { have: 0, total: 0 },
      };
      let ownedTotal = 0, dup = 0;
      cards.forEach((c) => {
        rar[c.rarity].total++;
        const n = owned.get(c.id) ?? 0;
        if (n > 0) rar[c.rarity].have++;
        ownedTotal += n;
        if (n > 1) dup += n - 1;
      });
      const collected = rar.common.have + rar.rare.have + rar.legend.have;
      const total = cards.length;
      col.setText(
        `蒐集     ${collected} / ${total} 種\n\n` +
        `${RARITY_META.common.label}   ${rar.common.have} / ${rar.common.total}\n` +
        `${RARITY_META.rare.label}   ${rar.rare.have} / ${rar.rare.total}\n` +
        `${RARITY_META.legend.label}   ${rar.legend.have} / ${rar.legend.total}\n\n` +
        `所持総数 ${ownedTotal} 枚（重複 ${dup}）\n\n` +
        `（一覧は B キーの台帳で）`
      ).setLineSpacing(8);
    } catch (e: any) {
      if (this.statusLayer === layer) col.setText(`読み込み失敗: ${e?.message ?? e}`).setColor("#e08a8a");
    }
  }

  // --- 台帳パネル（Bキーで開閉。世界内で自分のコレクションを見る）---

  private toggleBinder() {
    if (this.statusLayer) this.closeStatus(); // 同時には開かない
    if (this.binderLayer) this.closeBinder();
    else void this.openBinder();
  }

  private closeBinder() {
    this.binderLayer?.destroy();
    this.binderLayer = undefined;
  }

  private async openBinder() {
    this.closeStatus(); // 同時には開かない
    const { width, height } = this.scale;
    this.binderLayer?.destroy();
    const layer = this.add.container(0, 0).setScrollFactor(0).setDepth(7000);
    this.binderLayer = layer;

    layer.add(this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.85).setInteractive());
    const cx = width / 2;
    layer.add(this.add.text(cx, 26, "霊宝台帳", { fontSize: "26px", color: "#e8c87e", fontStyle: "bold" }).setOrigin(0.5));
    const info = this.add.text(cx, 58, "読み込み中…", { fontSize: "14px", color: "#9b93b0" }).setOrigin(0.5);
    layer.add(info);
    const close = this.add.text(width - 30, 24, "✕ 閉じる (B)", { fontSize: "16px", color: "#cccccc" }).setOrigin(1, 0)
      .setInteractive({ useHandCursor: true });
    close.on("pointerover", () => close.setColor("#fff"));
    close.on("pointerout", () => close.setColor("#cccccc"));
    close.on("pointerdown", () => this.closeBinder());
    layer.add(close);

    // レアリティ・タブ
    const tabs: Array<{ key: "common" | "rare" | "legend"; label: string }> = [
      { key: "common", label: "普通" }, { key: "rare", label: "希少" }, { key: "legend", label: "秘宝" },
    ];
    tabs.forEach((t, i) => {
      const sel = this.binderTab === t.key;
      const btn = this.add.text(cx - 120 + i * 120, 92, t.label, {
        fontSize: "18px", fontStyle: "bold",
        color: sel ? "#15101f" : RARITY_META[t.key].colorStr,
        backgroundColor: sel ? RARITY_META[t.key].colorStr : "#1c1530",
        padding: { x: 16, y: 6 } as any,
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      btn.on("pointerdown", () => { this.binderTab = t.key; void this.openBinder(); });
      layer.add(btn);
    });

    try {
      const [cards, mine] = await Promise.all([fetchCards(), fetchMyCards()]);
      if (this.binderLayer !== layer) return; // 閉じられた/再描画された
      const owned = new Map(mine.map((m) => [m.card_id, m.count]));
      const rar: Record<string, { have: number; total: number }> = {
        common: { have: 0, total: 0 }, rare: { have: 0, total: 0 }, legend: { have: 0, total: 0 },
      };
      cards.forEach((c) => { rar[c.rarity].total++; if ((owned.get(c.id) ?? 0) > 0) rar[c.rarity].have++; });
      const collected = rar.common.have + rar.rare.have + rar.legend.have;
      info.setText(`蒐集 ${collected} / ${cards.length}　・　普通 ${rar.common.have}/${rar.common.total}　希少 ${rar.rare.have}/${rar.rare.total}　秘宝 ${rar.legend.have}/${rar.legend.total}`);

      const list = cards.filter((c) => c.rarity === this.binderTab);
      const cols = 9, cellW = 128, cellH = 116, gapX = 6, gapY = 12;
      const totalW = cols * cellW + (cols - 1) * gapX;
      const startX = (width - totalW) / 2 + cellW / 2;
      const startY = 180;
      list.forEach((c, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const x = startX + col * (cellW + gapX);
        const y = startY + row * (cellH + gapY);
        const count = owned.get(c.id) ?? 0;
        const has = count > 0;
        const meta = RARITY_META[c.rarity];
        const bg = this.add.rectangle(x, y, cellW, cellH, 0x1c1530, has ? 0.98 : 0.5).setStrokeStyle(2, has ? meta.colorNum : 0x3a3550);
        const icon = this.add.text(x, y - 26, CARD_ICON[c.id] ?? "❔", { fontSize: "34px" }).setOrigin(0.5).setAlpha(has ? 1 : 0.22);
        const name = this.add.text(x, y + 26, has ? c.name : "？？？", { fontSize: "13px", color: has ? "#ece7f5" : "#4a4360", align: "center", wordWrap: { width: cellW - 12 } }).setOrigin(0.5);
        layer.add([bg, icon, name]);
        if (count > 1) {
          const badge = this.add.text(x + cellW / 2 - 16, y - cellH / 2 + 11, `×${count}`, {
            fontSize: "11px", color: "#15101f", fontStyle: "bold", backgroundColor: "#e8b04b", padding: { x: 4, y: 1 } as any,
          }).setOrigin(0.5);
          layer.add(badge);
        }
      });
    } catch (e: any) {
      if (this.binderLayer === layer) info.setText(`読み込み失敗: ${e?.message ?? e}`).setColor("#e08a8a");
    }
  }

  update(_t: number, dtMs: number) {
    const state: any = this.room.state;
    const me: any = state.players.get(this.myId);

    // 入力送信
    const up = this.keys.W.isDown || this.keys.UP.isDown;
    const down = this.keys.S.isDown || this.keys.DOWN.isDown;
    const left = this.keys.A.isDown || this.keys.LEFT.isDown;
    const right = this.keys.D.isDown || this.keys.RIGHT.isDown;
    const last = this.lastInputSent;
    if (up !== last.up || down !== last.down || left !== last.left || right !== last.right) {
      this.lastInputSent = { up, down, left, right };
      this.room.send("input", this.lastInputSent);
    }

    // プレイヤー描画
    state.players.forEach((p: any, id: string) => {
      const v = this.players.get(id);
      if (!v) return;
      let cx: number, cy: number;
      if (id === this.myId && !p.dead) {
        ({ x: cx, y: cy } = this.predictSelf(v, p, dtMs, up, down, left, right));
      } else {
        const t = id === this.myId ? 0.4 : 0.25;
        cx = Phaser.Math.Linear(v.container.x, p.x, t);
        cy = Phaser.Math.Linear(v.container.y, p.y, t);
      }
      v.container.setPosition(cx, cy);
      v.container.setDepth(cy);

      // 向き・歩行
      let dx: number, dy: number, moving: boolean;
      if (id === this.myId && !p.dead) {
        dx = (right ? 1 : 0) - (left ? 1 : 0);
        dy = (down ? 1 : 0) - (up ? 1 : 0);
        moving = up || down || left || right;
      } else {
        dx = p.vx; dy = p.vy;
        moving = Math.hypot(p.vx, p.vy) > 5 && !p.dead;
      }
      if (!v.punching) {
        if (moving) {
          const d = dirFromVector(dx, dy);
          if (d) { v.dir = d.dir; v.flip = d.flip; }
          applyCharPose(v.sprite, v.dir, "walk", v.flip, CHAR_DISPLAY_H);
        } else {
          applyCharPose(v.sprite, v.dir, "idle", v.flip, CHAR_DISPLAY_H);
        }
      }
      if (moving && !v.punching && id === this.myId) {
        const step = v.sprite.anims.currentFrame?.index ?? 0;
        if (step !== v.lastStep) { sfxFootstep(); v.lastStep = step; }
      }
      v.container.setAlpha(p.dead ? 0.3 : 1);
    });

    // モンスター描画
    state.mobs.forEach((m: any, id: string) => {
      const v = this.mobs.get(id);
      if (!v) return;
      const cx = Phaser.Math.Linear(v.container.x, m.x, 0.3);
      const cy = Phaser.Math.Linear(v.container.y, m.y, 0.3);
      v.container.setPosition(cx, cy);
      v.container.setDepth(cy);
      const d = dirFromAngle(m.dir);
      v.dir = d.dir; v.flip = d.flip;
      applyCharPose(v.sprite, v.dir, "walk", v.flip, MOB_DISPLAY_H);
    });

    // HUD
    if (me) {
      this.hudText.setText(`Lv.${me.level}   ${me.name}`);
      this.hpBarFg.width = 220 * Math.max(0, me.hp / me.maxHp);
      this.expBarFg.width = 220 * Math.max(0, Math.min(1, me.exp / me.nextExp));
      this.deadText.setVisible(me.dead);
      if (me.dead) {
        const sec = Math.max(0, (me.respawnAt - Date.now()) / 1000);
        this.deadText.setText(`やられた！\n復活まで ${sec.toFixed(1)}秒`);
      }
    }
  }

  // --- クライアント予測（UnspottableGameScene 流用） ---

  private predictSelf(
    v: PlayerView, entity: any, dtMs: number,
    up: boolean, down: boolean, left: boolean, right: boolean,
  ): { x: number; y: number } {
    const dt = Math.min(dtMs, 50) / 1000;
    let px = v.container.x, py = v.container.y;
    if (!this.predictReady) { this.predictReady = true; px = entity.x; py = entity.y; }
    let dx = 0, dy = 0;
    if (up) dy -= 1; if (down) dy += 1; if (left) dx -= 1; if (right) dx += 1;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    const mapW = (this.room.state as any).mapWidth;
    const mapH = (this.room.state as any).mapHeight;
    let nx = px + dx * PLAYER_SPEED * dt;
    let ny = py + dy * PLAYER_SPEED * dt;
    nx = Phaser.Math.Clamp(nx, ENTITY_RADIUS, mapW - ENTITY_RADIUS);
    ny = Phaser.Math.Clamp(ny, ENTITY_RADIUS, mapH - ENTITY_RADIUS);
    const drift = Math.hypot(entity.x - nx, entity.y - ny);
    const corr = drift > 50 ? 0.3 : 0.04;
    nx = Phaser.Math.Linear(nx, entity.x, corr);
    ny = Phaser.Math.Linear(ny, entity.y, corr);
    return { x: nx, y: ny };
  }

  // --- プレイヤー ---

  private addPlayerView(id: string, p: any) {
    const container = this.add.container(p.x, p.y);
    const shadow = this.add.ellipse(0, 0, 24, 8, 0x000000, 0.4);
    const sprite = this.add.sprite(0, 0, CHAR_INITIAL_TEX).setOrigin(0.5, 0.96);
    applyCharPose(sprite, "front", "idle", false, CHAR_DISPLAY_H);
    const hpBg = this.add.rectangle(0, -CHAR_DISPLAY_H - 8, 36, 5, 0x000000, 0.6);
    const hpFg = this.add.rectangle(-18, -CHAR_DISPLAY_H - 8, 36, 5, 0x6be36b).setOrigin(0, 0.5);
    const nameLabel = this.add.text(0, -CHAR_DISPLAY_H - 18,
      p.name + (id === this.myId ? " (YOU)" : ""), {
      fontSize: "12px", color: id === this.myId ? "#ffe066" : "#ffffff",
      stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5);
    container.add([shadow, sprite, hpBg, hpFg, nameLabel]);
    this.worldLayer.add(container);
    this.players.set(id, {
      container, shadow, sprite, nameLabel, hpBg, hpFg,
      dir: "front", flip: false, punching: false, lastStep: 0,
    });
    this.updatePlayerHpBar(id, p);
  }

  private updatePlayerHpBar(id: string, p: any) {
    const v = this.players.get(id);
    if (!v) return;
    const ratio = Math.max(0, p.hp / p.maxHp);
    v.hpFg.width = 36 * ratio;
    v.hpFg.fillColor = ratio > 0.5 ? 0x6be36b : ratio > 0.25 ? 0xe3c84b : 0xe04545;
  }

  private removePlayerView(id: string) {
    const v = this.players.get(id);
    if (!v) return;
    v.container.destroy();
    this.players.delete(id);
  }

  // --- モンスター ---

  private addMobView(id: string, m: any) {
    const container = this.add.container(m.x, m.y);
    const shadow = this.add.ellipse(0, 0, 22, 7, 0x000000, 0.4);
    // モンスター画像が読めていればそれを、無ければキャラを緑染めで代用
    const hasMobTex = this.textures.exists("mob") && this.textures.get("mob").key !== "__MISSING";
    let sprite: Phaser.GameObjects.Sprite;
    if (hasMobTex) {
      sprite = this.add.sprite(0, 0, "mob").setOrigin(0.5, 0.96);
      const h = sprite.frame.realHeight || MOB_DISPLAY_H;
      sprite.setScale(MOB_DISPLAY_H / h);
    } else {
      sprite = this.add.sprite(0, 0, CHAR_INITIAL_TEX).setOrigin(0.5, 0.96);
      applyCharPose(sprite, "front", "idle", false, MOB_DISPLAY_H);
      sprite.setTint(0x66dd66); // 緑染めでモンスター代用
    }
    const hpBg = this.add.rectangle(0, -MOB_DISPLAY_H - 6, 30, 4, 0x000000, 0.6);
    const hpFg = this.add.rectangle(-15, -MOB_DISPLAY_H - 6, 30, 4, 0xff7777).setOrigin(0, 0.5);
    container.add([shadow, sprite, hpBg, hpFg]);
    this.worldLayer.add(container);
    this.mobs.set(id, { container, shadow, sprite, hpBg, hpFg, dir: "front", flip: false });
    this.updateMobHpBar(id, m);
  }

  private updateMobHpBar(id: string, m: any) {
    const v = this.mobs.get(id);
    if (!v) return;
    v.hpFg.width = 30 * Math.max(0, m.hp / m.maxHp);
  }

  private removeMobView(id: string, _m: any) {
    const v = this.mobs.get(id);
    if (!v) return;
    // 撃破演出
    this.spawnStarBurst(v.container.x, v.container.y);
    sfxScore();
    v.container.destroy();
    this.mobs.delete(id);
  }

  // --- FX ---

  private flashHit(id: string, isPlayer: boolean) {
    const v = isPlayer ? this.players.get(id) : this.mobs.get(id);
    if (!v) return;
    const sprite = v.sprite;
    const prevTint = sprite.tintTopLeft;
    const wasTinted = sprite.isTinted;
    sprite.setTintFill(0xffffff);
    this.time.delayedCall(110, () => {
      if (!sprite.active) return;
      if (wasTinted && !isPlayer) sprite.setTint(prevTint);
      else sprite.clearTint();
    });
    this.spawnStarBurst(v.container.x, v.container.y);
    if (isPlayer) { sfxHitPlayer(); this.cameras.main.shake(80, 0.004); }
    else sfxHitNpc();
  }

  private spawnStarBurst(x: number, y: number) {
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.4;
      const star = this.add.star(x, y, 4, 3, 6, 0xffe066).setDepth(6000);
      this.tweens.add({
        targets: star,
        x: x + Math.cos(angle) * 30,
        y: y + Math.sin(angle) * 30,
        alpha: { from: 1, to: 0 }, scale: { from: 1, to: 0.4 },
        duration: 360, ease: "Quad.easeOut",
        onComplete: () => star.destroy(),
      });
    }
  }

  private showAttackFx(id: string, entity: any) {
    const v = this.players.get(id);
    if (!v) return;
    const cos = Math.cos(entity.dir);
    const d = dirFromAngle(entity.dir);
    v.punching = true;
    v.dir = d.dir; v.flip = d.flip;
    applyCharPose(v.sprite, d.dir, "punch", d.flip, CHAR_DISPLAY_H);
    this.tweens.add({
      targets: v.sprite,
      x: cos * 8, y: -Math.abs(Math.sin(entity.dir)) * 2,
      duration: 70, ease: "Quad.easeOut", yoyo: true, hold: 30,
      onComplete: () => v.sprite.setPosition(0, 0),
    });
    this.time.delayedCall(220, () => {
      if (!v.sprite.active) return;
      v.punching = false;
      applyCharPose(v.sprite, v.dir, "idle", v.flip, CHAR_DISPLAY_H);
      v.sprite.setPosition(0, 0);
    });
    this.spawnConeFlash(v.container.x, v.container.y, entity.dir);
  }

  private spawnConeFlash(x: number, y: number, dir: number) {
    const length = 72, width = 40;
    const cx = x + Math.cos(dir) * (length / 2);
    const cy = y + Math.sin(dir) * (length / 2);
    const rect = this.add.rectangle(cx, cy, length, width, 0xffffff, 0.2)
      .setRotation(dir).setDepth(4900);
    this.tweens.add({ targets: rect, alpha: 0, duration: 160, onComplete: () => rect.destroy() });
  }

  private popDamage(id: string, dmg: number) {
    const v = this.players.get(id);
    if (!v) return;
    const t = this.add.text(v.container.x, v.container.y - CHAR_DISPLAY_H, `-${Math.round(dmg)}`, {
      fontSize: "20px", color: "#ff7878", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(6500);
    this.tweens.add({
      targets: t, y: t.y - 36, alpha: { from: 1, to: 0 },
      duration: 700, ease: "Quad.easeOut", onComplete: () => t.destroy(),
    });
  }

  private popLevelUp(id: string) {
    const v = this.players.get(id);
    if (!v) return;
    if (id === this.myId) sfxRoundStart();
    const t = this.add.text(v.container.x, v.container.y - CHAR_DISPLAY_H - 20, "LEVEL UP!", {
      fontSize: "22px", color: "#ffe066", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(6600);
    this.tweens.add({
      targets: t, y: t.y - 40, alpha: { from: 1, to: 0 }, scale: { from: 1.4, to: 1 },
      duration: 900, ease: "Quad.easeOut", onComplete: () => t.destroy(),
    });
  }
}
