import Phaser from "phaser";
import { getStateCallbacks, type Room } from "colyseus.js";
import {
  preloadCharTextures, ensureCharAnims, applyCharPose,
  dirFromVector, dirFromAngle, CHAR_INITIAL_TEX, type Dir,
} from "../../character";
import { sfxHitPlayer, sfxHitNpc, sfxScore, sfxFootstep, sfxRoundStart } from "../../sfx";
import { addMoveKeys } from "../../ui/inputKeys";
import { makeInput } from "../../ui/nameInput";
import {
  fetchCards, fetchMyCards, fetchOpenTrades, proposeTrade, acceptTrade, cancelTrade,
  type Card, type UserCard,
} from "../../spirit";
import { CARD_ICON, CARD_DESC, RARITY_META, RELIC_IMAGE_NAMES, relicTexKey } from "../spirit/cards-meta";
import { ITEM_META, ITEM_ORDER, SPEED_BUFF_MUL, SHOP_ITEMS, SELL_PRICES } from "../spirit/items-meta";
import { EQUIP_META, SLOTS, EQUIP_SHOP, EQUIP_SELL } from "../spirit/equip-meta";
import { ACHIEVEMENTS } from "../spirit/achievements";
import { getMyProfile, getUser } from "../../auth";
import { joinPublicRoom } from "../../net";
import { loadPlayerName } from "../../ui/playerName";
import { FIELD_DECOR } from "./field-decor";
import { CAVE_DECOR } from "./cave-decor";

const PLAYER_SPEED = 140;
const ENTITY_RADIUS = 14;
const CHAR_DISPLAY_H = 56;
const MOB_DISPLAY_H = 52;
const MMO_VIEW_W = 985; // カメラに映す「ワールドの横幅(px)」。解像度に依らず見える範囲を一定にするための基準

// 世界地図のエリア定義。key=地形ID（state.ground と一致）、travel=移動先エリア文字列。
// mx,my は地図パネル内の相対位置 0..1（worldmap.png の地点と一致させる）。エリア追加はここに足すだけ。
const WORLD_AREAS: Array<{ key: string; travel: string; name: string; icon: string; mx: number; my: number; blurb: string }> = [
  { key: "town", travel: "town", name: "ホームタウン", icon: "🏠", mx: 0.22, my: 0.56, blurb: "霊宝を整える安全な拠点。台帳を眺め、次の探索に備える。" },
  { key: "grass", travel: "hunt:grass:1", name: "草原", icon: "🌿", mx: 0.54, my: 0.66, blurb: "魔物が徘徊する広野。B1〜B5、深いほど強敵とレアな霊宝が待つ。" },
  { key: "cave", travel: "hunt:cave:1", name: "洞窟", icon: "🕳️", mx: 0.80, my: 0.30, blurb: "山に穿たれた暗い洞窟。屈強な魔物が巣くう。B1〜B5。" },
];
// 地形同士の繋がり（双方向）。町をハブに各狩場へ。
const WORLD_LINKS: Array<[string, string]> = [
  ["town", "grass"],
  ["town", "cave"],
];

// 敵の種別ごとの見た目（色・大きさ）。server の MOB_KINDS と対応。
// 専用イラストは client/public/mobs/<種別>.png を置き、MOB_IMAGE_KINDS に種別を足すと切り替わる。
const MOB_STYLE: Record<string, { tint: number; scale: number; label?: string }> = {
  grunt:    { tint: 0x88dd88, scale: 0.85 },
  swift:    { tint: 0x9b7ad0, scale: 1.05 },
  tank:     { tint: 0xc8a06a, scale: 1.95 },
  brute:    { tint: 0xe0644a, scale: 1.55 },
  slime:    { tint: 0x6be36b, scale: 0.72 },
  spider:   { tint: 0x8a5ad0, scale: 1.0 },
  skeleton: { tint: 0xdddddd, scale: 1.35 },
  scorpion: { tint: 0xd0a85a, scale: 1.25 },
  serpent:  { tint: 0x7ad06b, scale: 1.15 },
  boss:     { tint: 0xb05ad0, scale: 2.1, label: "災厄の主" },
};
// 専用イラスト(PNG)を用意した種別。client/public/mobs/<種別>.png。
const MOB_IMAGE_KINDS: string[] = [
  "grunt", "swift", "tank", "brute", "slime",
  "spider", "skeleton", "scorpion", "serpent", "boss",
];
const mobTexKey = (kind: string) => `mob:${kind}`;

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
  body: Phaser.GameObjects.Container; // イラスト or 仮の塊
  hpBg: Phaser.GameObjects.Rectangle;
  hpFg: Phaser.GameObjects.Rectangle;
}

export class MmoGameScene extends Phaser.Scene {
  private room!: Room;
  private myId!: string;
  private players = new Map<string, PlayerView>();
  private mobs = new Map<string, MobView>();
  private relicViews = new Map<string, Phaser.GameObjects.Container>();
  private treasureViews = new Map<string, Phaser.GameObjects.Container>();
  private gates: Array<{ x: number; y: number; toArea: string; label: string }> = [];
  private gatePrompt?: Phaser.GameObjects.Text;
  private nearGate: { toArea: string; label: string } | null = null;
  private nearTreasure: string | null = null; // 近接している宝箱のid
  private shopPos?: { x: number; y: number }; // 町のショップ地点（近接でE）
  private nearShop = false;
  private shopLayer?: Phaser.GameObjects.Container;
  private shopTab: "buy" | "equip" | "sell" = "buy";
  private traveling = false;
  private chatOpen = false;
  private chatInput?: HTMLInputElement;
  private chatLog!: Phaser.GameObjects.Text;
  private chatLines: string[] = [];
  private worldLayer!: Phaser.GameObjects.Layer;
  private uiLayer!: Phaser.GameObjects.Layer; // 画面固定UI（ズーム非対象・uiCamで描画）
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  // 当たり判定（サーバーと一致させる）。予測移動でのめり込み防止に使う
  private obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
  private predictReady = false;
  private cardById = new Map<number, Card>(); // 霊宝メタ（ドロップ表示用）
  private binderLayer?: Phaser.GameObjects.Container;
  private statusLayer?: Phaser.GameObjects.Container;
  private statusTab: "status" | "items" | "equip" | "other" = "status";
  private statusContent?: Phaser.GameObjects.Container;
  private statusTabs: Array<{ key: string; bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }> = [];
  private statusData?: { cards: any[]; mine: any[]; profile: any; user: any };
  private statusErr?: string;
  private statusPanel?: { px: number; py: number; pw: number; ph: number };
  private worldmapLayer?: Phaser.GameObjects.Container;
  private worldmapSel = 0; // 世界地図で選択中の「移動先候補」index
  private binderTab: "common" | "rare" | "legend" = "common";
  private binderSel = 0; // 台帳の選択カーソル（現在タブのリスト内index）
  private binderDetail = false; // 詳細表示中か
  private binderCache?: { cards: Card[]; owned: Map<number, number> };
  // 取引所（町・近接でE）。掲示板方式（オープン提案）
  private tradePos?: { x: number; y: number };
  private nearTrade = false;
  private tradeLayer?: Phaser.GameObjects.Container;
  private tradeTab: "browse" | "mine" | "create" = "browse";
  private myProfileId?: string;
  private tradeOpen: any[] = [];        // fetchOpenTrades() の結果
  private tradeMyCards: UserCard[] = []; // 自分の所持（count/locked）
  private tradeErr?: string;
  private tradeLoading = false;
  private createOffer?: number;          // 出品で「出す」card_id
  private createRequest?: number;        // 出品で「欲しい」card_id

  // HUD
  private hpBarBg!: Phaser.GameObjects.Rectangle;
  private hpBarFg!: Phaser.GameObjects.Rectangle;
  private expBarBg!: Phaser.GameObjects.Rectangle;
  private expBarFg!: Phaser.GameObjects.Rectangle;
  private hudText!: Phaser.GameObjects.Text;
  private hudExtra!: Phaser.GameObjects.Text; // ゴールド＋バフ残り（HUD下）
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
    // エリア移動で同シーンを再起動するため、インスタンス状態を初期化
    this.players.clear();
    this.mobs.clear();
    this.relicViews.clear();
    this.treasureViews.clear();
    this.gates = [];
    this.obstacles = [];
    this.nearGate = null;
    this.nearTreasure = null;
    this.shopPos = undefined;
    this.nearShop = false;
    this.shopLayer = undefined;
    this.tradePos = undefined;
    this.nearTrade = false;
    this.tradeLayer = undefined;
    this.traveling = false;
    this.predictReady = false;
    this.lastInputSent = { up: false, down: false, left: false, right: false };
    this.binderLayer = undefined;
    this.statusLayer = undefined;
    this.worldmapLayer = undefined;
    this.binderDetail = false;
    this.cardById.clear();
    this.chatInput?.remove();
    this.chatInput = undefined;
    this.chatOpen = false;
    this.chatLines = [];
  }

  preload() {
    preloadCharTextures(this);
    // モンスター画像があれば使う（無ければキャラ緑染めで代用）
    this.load.image("mob", "/char/mob_idle.png");
    // 霊宝イラスト（用意されたものだけ。無いカードは絵文字表示）
    for (const name of RELIC_IMAGE_NAMES) {
      this.load.image(relicTexKey(name), `/relics/${encodeURIComponent(name)}.png`);
    }
    // 敵イラスト（用意された種別だけ。無い種別は仮の塊で表示）
    for (const kind of MOB_IMAGE_KINDS) {
      this.load.image(mobTexKey(kind), `/mobs/${kind}.png`);
    }
    // タイルマップ（Tiled製：ホームタウン＝町、field＝狩場）
    this.load.tilemapTiledJSON("townmap", "/map/town.json");
    this.load.image("townTiles", "/map/town_tiles.png");
    this.load.tilemapTiledJSON("fieldmap", "/map/field.json");
    this.load.image("fieldTiles", "/map/field_tiles.png");
    this.load.tilemapTiledJSON("cavemap", "/map/cave.json");
    this.load.image("caveTiles", "/map/cave_tiles.png");
    this.load.image("worldmap", "/map/worldmap.png"); // 世界地図の地形背景
    // 装飾（建物・木・花・地面など。BaseChip素材から切り出し）
    for (const k of MmoGameScene.DECO_KEYS) {
      this.load.image(`deco:${k}`, `/map/deco/${k}.png`);
    }
  }

  // 装飾テクスチャ（/map/deco/<key>.png）
  private static readonly DECO_KEYS = [
    "house_brick", "house_wood", "house_tan",
    "tree_green", "tree_green2", "tree_autumn", "tree_dead",
    "bush", "bush2", "rock", "rock2", "grass_tuft", "longgrass",
    "flower_white", "flower_pink", "flower_blue", "sunflower",
    "well", "signpost", "scarecrow", "corn", "pumpkin", "cabbage",
    "path_cobble", "path_dirt",
  ];

  // ホームタウンの装飾を配置（広場・道・建物・畑・木々）。座標は 1280x768 前提。
  private buildTownDecor() {
    if (!this.textures.exists("deco:house_brick")) return;
    const tex = (k: string) => `deco:${k}`;
    // 地面（石畳の広場・道・畑の土）を TileSprite で塗る
    const fill = (k: string, x0: number, y0: number, x1: number, y1: number) => {
      const ts = this.add.tileSprite(x0, y0, x1 - x0, y1 - y0, tex(k)).setOrigin(0, 0).setDepth(-50);
      this.worldLayer.add(ts);
    };
    fill("path_cobble", 512, 320, 768, 512); // 中央広場
    fill("path_cobble", 768, 352, 1216, 448); // 広場→右の門への道
    fill("path_dirt", 96, 560, 288, 704); // 畑の土
    // オブジェクト [key, 中心x, 足元y]（足元yで奥行きソート＝プレイヤーが背後に回り込める）
    const objs: Array<[string, number, number]> = [
      ["house_brick", 250, 250], ["house_tan", 640, 250], ["house_wood", 1040, 250],
      ["tree_green", 130, 470], ["tree_green", 1210, 560], ["tree_green2", 430, 560],
      ["tree_green2", 900, 580], ["tree_autumn", 180, 720], ["tree_autumn", 1150, 720],
      ["tree_green", 760, 210],
      ["well", 640, 440], ["signpost", 1090, 440],
      ["scarecrow", 190, 640], ["corn", 130, 600], ["corn", 250, 600],
      ["pumpkin", 160, 690], ["cabbage", 220, 690],
      ["bush", 350, 420], ["bush2", 880, 660], ["bush", 1090, 620],
      ["rock", 560, 600], ["rock2", 470, 300], ["bush2", 300, 520],
      ["flower_white", 470, 470], ["flower_pink", 720, 540], ["flower_blue", 360, 640],
      ["sunflower", 980, 540], ["flower_pink", 560, 300], ["flower_white", 840, 470],
    ];
    for (const [k, cx, fy] of objs) {
      const im = this.add.image(cx, fy, tex(k)).setOrigin(0.5, 1).setDepth(fy);
      this.worldLayer.add(im);
    }
    // 当たり判定（サーバーの buildTownObstacles と座標を一致させる）
    const box = (x: number, y: number, w: number, h: number) => this.obstacles.push({ x, y, w, h });
    const house = (cx: number, fy: number) => box(cx - 46, fy - 70, 92, 70);
    house(250, 250); house(640, 250); house(1040, 250);
    box(640 - 16, 440 - 28, 32, 28); // 井戸
    box(1090 - 10, 440 - 18, 20, 18); // 看板
    const trunk = (cx: number, fy: number) => box(cx - 10, fy - 16, 20, 16);
    trunk(130, 470); trunk(1210, 560); trunk(430, 560); trunk(900, 580);
    trunk(180, 720); trunk(1150, 720); trunk(760, 210);
    box(560 - 14, 600 - 12, 28, 12); // 岩
    box(470 - 14, 300 - 12, 28, 12);

    // ショップ（看板＋のれん）。近づくと [E] で開く
    const sx = 880, sy = 250;
    this.shopPos = { x: sx, y: sy + 30 };
    const awning = this.add.rectangle(sx, sy - 18, 96, 26, 0xc0533a).setStrokeStyle(2, 0x7a2f1f).setDepth(sy);
    const stall = this.add.rectangle(sx, sy + 6, 96, 40, 0x6b4a2a).setStrokeStyle(2, 0x3a2814).setDepth(sy);
    const sicon = this.add.text(sx, sy + 6, "🛒", { fontSize: "26px" }).setOrigin(0.5).setDepth(sy);
    const slabel = this.add.text(sx, sy - 40, "ショップ", { fontSize: "15px", color: "#ffe08a", fontStyle: "bold", stroke: "#000", strokeThickness: 3 }).setOrigin(0.5).setDepth(sy);
    this.worldLayer.add([awning, stall, sicon, slabel]);
    box(sx - 48, sy - 14, 96, 40); // ショップの当たり判定

    // 取引所（掲示板＋台）。近づくと [E] でトレード画面（プレイヤー間カード交換）
    const tx = 400, ty = 250;
    this.tradePos = { x: tx, y: ty + 30 };
    const tboard = this.add.rectangle(tx, ty - 16, 92, 30, 0x2f6b53).setStrokeStyle(2, 0x1c4636).setDepth(ty);
    const tstall = this.add.rectangle(tx, ty + 8, 92, 38, 0x4a6b6b).setStrokeStyle(2, 0x29403f).setDepth(ty);
    const ticon = this.add.text(tx, ty + 8, "🔄", { fontSize: "24px" }).setOrigin(0.5).setDepth(ty);
    const tlabel = this.add.text(tx, ty - 40, "取引所", { fontSize: "15px", color: "#9fe0c0", fontStyle: "bold", stroke: "#000", strokeThickness: 3 }).setOrigin(0.5).setDepth(ty);
    this.worldLayer.add([tboard, tstall, ticon, tlabel]);
    box(tx - 46, ty - 12, 92, 38); // 取引所の当たり判定
  }

  // 狩場の装飾を散布（テーマで内容が変わる）。非衝突＝見た目のみ
  private buildHuntDecor(ground: string) {
    if (!this.textures.exists("deco:tree_dead")) return;
    const decor = ground === "cave" ? CAVE_DECOR : FIELD_DECOR;
    for (const [k, cx, fy] of decor) {
      if (!this.textures.exists(`deco:${k}`)) continue;
      const im = this.add.image(cx, fy, `deco:${k}`).setOrigin(0.5, 1).setDepth(fy);
      this.worldLayer.add(im);
    }
  }

  // 霊宝のアイコン：イラストがあればスプライト、無ければ絵文字。boxPx 内に収める。
  private makeRelicIcon(x: number, y: number, name: string, cardId: number, boxPx: number, dim: boolean): Phaser.GameObjects.GameObject {
    const key = relicTexKey(name);
    if (name && this.textures.exists(key)) {
      const sp = this.add.sprite(x, y, key).setOrigin(0.5);
      sp.setScale(boxPx / Math.max(sp.width, sp.height));
      if (dim) sp.setAlpha(0.25);
      return sp;
    }
    const t = this.add.text(x, y, CARD_ICON[cardId] ?? "❔", { fontSize: `${Math.round(boxPx * 0.62)}px` }).setOrigin(0.5);
    if (dim) t.setAlpha(0.22);
    return t;
  }

  // 「全面イラスト＋下部の名前帯」の霊宝カード。中心(0,0)・サイズ w×h のコンテナを返す。
  // 台帳グリッド・詳細表示・ドロップ演出で共通利用（イラスト主役レイアウト）。
  private makeRelicCard(opts: {
    cardId: number; name: string; rarity: "common" | "rare" | "legend";
    w: number; h: number; owned: boolean; count?: number; selected?: boolean;
  }): Phaser.GameObjects.Container {
    const { cardId, name, rarity, w, h, owned } = opts;
    const sel = !!opts.selected;
    const meta = RARITY_META[rarity];
    const cont = this.add.container(0, 0);
    cont.setSize(w, h);

    // 背景：レアリティ色を深く沈めた地色（未所持はほぼ黒）
    const baseCol = owned
      ? Phaser.Display.Color.IntegerToColor(meta.colorNum).darken(72).color
      : 0x131019;
    const bg = this.add.rectangle(0, 0, w, h, baseCol, owned || sel ? 1 : 0.6)
      .setStrokeStyle(sel ? 3 : 2, sel ? 0xffe066 : (owned ? meta.colorNum : 0x39354a));
    cont.add(bg);
    // 上端のレアリティ・アクセント
    cont.add(this.add.rectangle(0, -h / 2 + 3, w, 4, meta.colorNum, owned ? 0.9 : 0.4));

    // イラスト（主役）：カード上〜中央に大きく
    const artBox = Math.min(w * 0.92, h * 0.64);
    cont.add(this.makeRelicIcon(0, -h * 0.10, name, cardId, artBox, !owned));

    // 下部の名前帯
    const bandH = Math.max(24, Math.round(h * 0.22));
    const bandY = h / 2 - bandH / 2;
    cont.add(this.add.rectangle(0, bandY, w, bandH, 0x0b0810, 0.85));
    cont.add(this.add.rectangle(0, bandY - bandH / 2, w, 1, meta.colorNum, owned ? 0.7 : 0.3));
    const nameSize = Math.max(11, Math.min(Math.round(w * 0.12), 18));
    cont.add(this.add.text(0, bandY, owned ? name : "？？？", {
      fontSize: `${nameSize}px`, color: owned ? "#f3eeff" : "#4a4360",
      fontStyle: "bold", align: "center", wordWrap: { width: w - 12 },
    }).setOrigin(0.5));

    // 所持数バッジ（複数所持時）
    const count = opts.count ?? 0;
    if (count > 1) {
      cont.add(this.add.text(w / 2 - 14, -h / 2 + 14, `×${count}`, {
        fontSize: `${Math.max(10, Math.round(w * 0.1))}px`, color: "#15101f",
        fontStyle: "bold", backgroundColor: "#e8b04b", padding: { x: 5, y: 1 } as any,
      }).setOrigin(0.5));
    }
    return cont;
  }

  create() {
    const { width, height } = this.scale;
    ensureCharAnims(this);
    const state: any = this.room.state;
    const mapW = state.mapWidth, mapH = state.mapHeight;
    const ground: string = state.ground || (state.area === "town" ? "town" : "grass");
    const isTown = ground === "town";

    // ワールド層（カメラはこの層をズーム＆追従。UI層とは別カメラで描画）
    this.worldLayer = this.add.layer();

    // --- 背景（Tiled製タイルマップ：町=草地 / 草原=ワイルド草地 / 洞窟=暗い石床）→ worldLayer ---
    // テーマ → [tilemapキー, tilesetキー, tileset名]
    const THEME: Record<string, [string, string, string]> = {
      town: ["townmap", "townTiles", "grass"],
      grass: ["fieldmap", "fieldTiles", "fieldgrass"],
      cave: ["cavemap", "caveTiles", "cavefloor"],
    };
    const tm = THEME[ground] ?? THEME.grass;
    if (this.cache.tilemap.has(tm[0])) {
      const tmap = this.make.tilemap({ key: tm[0] });
      const ts = tmap.addTilesetImage(tm[2], tm[1]);
      const layer = ts ? tmap.createLayer("ground", ts, 0, 0) : null;
      if (layer) { layer.setDepth(-100); this.worldLayer.add(layer); }
    } else {
      // フォールバック：ベタ塗り＋グリッド＋外周
      const bg = this.add.rectangle(mapW / 2, mapH / 2, mapW, mapH, isTown ? 0x6b5a3f : ground === "cave" ? 0x2c2a36 : 0x3a6b3f).setDepth(-100);
      const grid = this.add.graphics().setDepth(-99);
      grid.lineStyle(2, 0x000000, 0.08);
      for (let x = 0; x <= mapW; x += 128) grid.lineBetween(x, 0, x, mapH);
      for (let y = 0; y <= mapH; y += 128) grid.lineBetween(0, y, mapW, y);
      const fence = this.add.rectangle(mapW / 2, mapH / 2, mapW, mapH, 0, 0).setStrokeStyle(8, 0x2a3a2c).setDepth(-98);
      this.worldLayer.add([bg, grid, fence]);
    }

    // エリアごとの装飾を配置（buildXxxDecor 内で worldLayer に追加される）
    if (isTown) this.buildTownDecor();
    else this.buildHuntDecor(ground);

    // UI層（画面固定。ズーム非対象＝専用カメラで等倍描画）
    this.uiLayer = this.add.layer();

    // --- カメラ（main=ワールドをズーム＆追従 / uiCam=UIを等倍） ---
    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.cameras.main.setBackgroundColor(0x223024);
    this.cameras.main.setZoom(this.scale.width / MMO_VIEW_W); // 解像度に依らず見える範囲を一定に
    this.cameras.main.ignore(this.uiLayer); // ワールドカメラはUIを描かない
    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCam.ignore(this.worldLayer);      // UIカメラはワールドを描かない

    // --- HUD（画面固定・UI層） ---
    const hudBg = this.add.rectangle(12, 12, 240, 78, 0x000000, 0.5)
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

    const controlsHint = this.add.text(width - 12, height - 10, "B: 台帳　/　C: ステータス　/　M: 地図　/　1〜4: アイテム　/　ESC: ハブに戻る", {
      fontSize: "13px", color: "#aaaaaa",
    }).setOrigin(1, 1).setScrollFactor(0).setDepth(1000);
    this.hudExtra = this.add.text(16, 96, "", {
      fontSize: "13px", color: "#ffe08a", stroke: "#000", strokeThickness: 3,
    }).setScrollFactor(0).setDepth(1000);
    this.uiLayer.add([hudBg, this.hudText, this.hpBarBg, this.hpBarFg, this.expBarBg, this.expBarFg, this.deadText, controlsHint, this.hudExtra]);

    // --- 入力 ---
    this.keys = addMoveKeys(this);
    this.keys.SPACE.on("down", () => { if (!this.overlayOpen()) this.room.send("attack"); });
    // オーバーレイ表示中は矢印/WASDで選択カーソル移動（移動入力は update 側で抑止）
    const selKey = (dc: number, dr: number) => {
      if (this.worldmapLayer) this.moveWorldSel(dc);
      else if (this.binderLayer) this.moveBinderSel(dc, dr);
    };
    this.input.keyboard!.on("keydown-LEFT", () => selKey(-1, 0));
    this.input.keyboard!.on("keydown-RIGHT", () => selKey(1, 0));
    this.input.keyboard!.on("keydown-UP", () => selKey(0, -1));
    this.input.keyboard!.on("keydown-DOWN", () => selKey(0, 1));
    this.input.keyboard!.on("keydown-A", () => selKey(-1, 0));
    this.input.keyboard!.on("keydown-D", () => selKey(1, 0));
    this.input.keyboard!.on("keydown-W", () => selKey(0, -1));
    this.input.keyboard!.on("keydown-S", () => selKey(0, 1));
    this.input.keyboard!.on("keydown-ESC", () => {
      if (this.tradeLayer) this.closeTrade();
      else if (this.shopLayer) this.closeShop();
      else if (this.worldmapLayer) this.closeWorldMap();
      else if (this.statusLayer) this.closeStatus();
      else if (this.binderLayer && this.binderDetail) { this.binderDetail = false; this.drawBinder(); } // 詳細→一覧
      else if (this.binderLayer) this.closeBinder();
      else this.room.leave();
    });
    this.input.keyboard!.on("keydown-ENTER", () => {
      // 世界地図：選択中エリアへ移動
      if (this.worldmapLayer) { this.travelFromMap(); return; }
      // 台帳一覧→選択中の霊宝の詳細表示（トグル）
      if (!this.binderLayer || !this.binderCache) return;
      this.binderDetail = !this.binderDetail;
      this.drawBinder();
    });
    this.input.keyboard!.on("keydown-B", () => this.toggleBinder());
    this.input.keyboard!.on("keydown-C", () => this.toggleStatus());
    this.input.keyboard!.on("keydown-M", () => this.toggleWorldMap());
    // 数字キー：ステータス開=タブ(1〜4) / 台帳開=レアリティ(1〜3) / それ以外=アイテム即使用(1〜4)
    const numKey = (statusTab: "status" | "items" | "equip" | "other", binderTab: "common" | "rare" | "legend" | null, itemIdx: number) => {
      if (this.statusLayer) this.setStatusTab(statusTab);
      else if (this.binderLayer) { if (binderTab) this.setBinderTab(binderTab); }
      else if (!this.overlayOpen() && !this.chatOpen) this.useItem(ITEM_ORDER[itemIdx]);
    };
    this.input.keyboard!.on("keydown-ONE", () => numKey("status", "common", 0));
    this.input.keyboard!.on("keydown-TWO", () => numKey("items", "rare", 1));
    this.input.keyboard!.on("keydown-THREE", () => numKey("equip", "legend", 2));
    this.input.keyboard!.on("keydown-FOUR", () => numKey("other", null, 3));
    this.input.keyboard!.on("keydown-E", () => { // ショップ / ゲート / 宝箱
      if (this.overlayOpen()) return;
      if (this.nearShop) this.openShop();
      else if (this.nearTrade) void this.openTrade();
      else if (this.nearGate) void this.tryTravel();
      else if (this.nearTreasure) this.room.send("openTreasure", { id: this.nearTreasure });
    });

    // エリア名＋移動プロンプト（画面固定）。狩場は「草原 B2」のように階層も表示
    const areaTitle = isTown
      ? (state.groundName || "ホームタウン")
      : `${state.groundName || "狩場"}　B${state.floor || 1}`;
    const areaInfo = this.add.text(width / 2, 16, areaTitle, {
      fontSize: "20px", color: isTown ? "#ffd9a0" : ground === "cave" ? "#c9b6ff" : "#a0ffb0",
      fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(1000);
    this.gatePrompt = this.add.text(width / 2, height - 70, "", {
      fontSize: "18px", color: "#ffe066", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1500).setVisible(false);

    // チャットログ（左下）＋「/」で入力
    this.chatLog = this.add.text(12, height - 120, "", {
      fontSize: "14px", color: "#ffffff", stroke: "#000", strokeThickness: 3, lineSpacing: 4,
    }).setOrigin(0, 1).setScrollFactor(0).setDepth(1400);
    const chatHint = this.add.text(12, height - 10, "/ でチャット", { fontSize: "12px", color: "#888888" }).setScrollFactor(0).setDepth(1000).setOrigin(0, 1);
    this.uiLayer.add([areaInfo, this.gatePrompt, this.chatLog, chatHint]);
    this.input.keyboard!.on("keydown", (e: KeyboardEvent) => {
      if (e.key === "/" && !this.chatOpen && !this.overlayOpen() && !this.traveling) {
        e.preventDefault();
        this.openChat();
      }
    });
    this.events.once("shutdown", () => { this.chatInput?.remove(); this.chatInput = undefined; });

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

    $(state).treasures.onAdd((t: any, id: string) => this.addTreasureView(id, t));
    $(state).treasures.onRemove((_t: any, id: string) => this.removeTreasureView(id));

    $(state).gates.onAdd((g: any) => this.addGateView(g));

    // 移動中の room.leave では再joinするのでロビーへ戻さない
    this.room.onLeave(() => { if (!this.traveling) this.scene.start("MmoLobby"); });

    // 霊宝：カードメタ取得＋ドロップ通知
    void fetchCards().then((cs) => { this.cardById = new Map(cs.map((c) => [c.id, c])); }).catch(() => {});
    this.room.onMessage("relicFound", (m: { cardId: number }) => this.showRelicFound(m.cardId));
    this.room.onMessage("itemFound", (m: { id: string }) => this.showItemFound(m.id));
    this.room.onMessage("equipFound", (m: { id: string }) => this.showEquipFound(m.id));
    this.room.onMessage("treasureOpened", (m: { itemId: string; gold: number }) => this.showTreasureOpened(m.itemId, m.gold));
    this.room.onMessage("achievement", (m: { id: string; desc: string; cardId: number | null }) => this.showAchievement(m));
    this.room.onMessage("chat", (m: { name: string; text: string }) => this.addChatLine(`${m.name}: ${m.text}`));
  }

  // 達成課題クリア時のポップアップ。
  private showAchievement(m: { desc: string; cardId: number | null }) {
    const cont = this.add.container(this.scale.width / 2, 230).setScrollFactor(0).setDepth(5200);
    this.uiLayer.add(cont);
    const bg = this.add.rectangle(0, 0, 360, 88, 0x1a1530, 0.97).setStrokeStyle(3, 0xffd966);
    const title = this.add.text(0, -22, "🏅 達成！", { fontSize: "18px", color: "#ffd966", fontStyle: "bold" }).setOrigin(0.5);
    const desc = this.add.text(0, 6, m.desc, { fontSize: "15px", color: "#ece7f5" }).setOrigin(0.5);
    cont.add([bg, title, desc]);
    if (m.cardId != null) {
      const reward = this.add.text(0, 30, `報酬: ${CARD_ICON[m.cardId] ?? "✨"} を入手`, { fontSize: "13px", color: "#9b93b0" }).setOrigin(0.5);
      cont.add(reward);
    }
    cont.setAlpha(0).setScale(0.85);
    this.tweens.add({ targets: cont, alpha: 1, scale: 1, duration: 260, ease: "Back.easeOut" });
    sfxRoundStart();
    this.time.delayedCall(3200, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, y: 210, duration: 320, onComplete: () => cont.destroy() });
    });
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

  // --- フィールドの宝箱 ---

  private addTreasureView(id: string, t: any) {
    const cont = this.add.container(t.x, t.y);
    const glow = this.add.circle(0, 0, 18, 0xffcf66, 0.22);
    const box = this.add.text(0, 0, "📦", { fontSize: "30px" }).setOrigin(0.5);
    cont.add([glow, box]);
    cont.setDepth(t.y);
    this.worldLayer.add(cont);
    this.tweens.add({ targets: box, y: -5, duration: 800, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.tweens.add({ targets: glow, alpha: { from: 0.12, to: 0.36 }, scale: { from: 0.85, to: 1.2 }, duration: 1000, yoyo: true, repeat: -1 });
    this.treasureViews.set(id, cont);
  }

  private removeTreasureView(id: string) {
    const c = this.treasureViews.get(id);
    if (!c) return;
    this.spawnStarBurst(c.x, c.y); // 開封演出
    c.destroy();
    this.treasureViews.delete(id);
  }

  // 宝箱を開けた本人へのポップアップ（バフ薬＋ゴールド）。
  private showTreasureOpened(itemId: string, gold: number) {
    const meta = ITEM_META[itemId];
    const cont = this.add.container(this.scale.width / 2, 200).setScrollFactor(0).setDepth(5200);
    this.uiLayer.add(cont);
    const bg = this.add.rectangle(0, 0, 320, 84, 0x1a1530, 0.97).setStrokeStyle(3, 0xffcf66);
    const title = this.add.text(0, -22, "📦 宝箱を開けた！", { fontSize: "17px", color: "#ffcf66", fontStyle: "bold" }).setOrigin(0.5);
    const body = this.add.text(0, 8, `${meta?.icon ?? "🧪"} ${meta?.name ?? itemId}  ＋  🪙${gold}`, { fontSize: "16px", color: "#ece7f5" }).setOrigin(0.5);
    cont.add([bg, title, body]);
    cont.setAlpha(0).setScale(0.85);
    this.tweens.add({ targets: cont, alpha: 1, scale: 1, duration: 240, ease: "Back.easeOut" });
    sfxScore();
    this.time.delayedCall(2600, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, y: 180, duration: 300, onComplete: () => cont.destroy() });
    });
  }

  // --- エリア移動ゲート ---

  private addGateView(g: any) {
    this.gates.push({ x: g.x, y: g.y, toArea: g.toArea, label: g.label });
    const cont = this.add.container(g.x, g.y);
    const ring = this.add.circle(0, 0, 38, 0x4a7ec9, 0.35).setStrokeStyle(3, 0xbfe0ff);
    const door = this.add.text(0, 0, "🚪", { fontSize: "46px" }).setOrigin(0.5);
    const label = this.add.text(0, -54, g.label, { fontSize: "16px", color: "#bfe0ff", fontStyle: "bold", stroke: "#000", strokeThickness: 3 }).setOrigin(0.5);
    cont.add([ring, door, label]);
    cont.setDepth(g.y);
    this.worldLayer.add(cont);
    this.tweens.add({ targets: ring, scale: { from: 0.85, to: 1.15 }, alpha: { from: 0.25, to: 0.5 }, duration: 1100, yoyo: true, repeat: -1 });
  }

  private async tryTravel() {
    if (this.traveling || this.overlayOpen() || !this.nearGate) return;
    void this.travelToArea(this.nearGate.toArea);
  }

  // 指定エリアへ移動（ゲート / 世界地図 共通）。
  private async travelToArea(area: string) {
    if (this.traveling) return;
    if ((this.room.state as any).area === area) return; // 現在地は無視
    this.traveling = true;
    this.closeWorldMap();
    const { width, height } = this.scale;
    const travelBg = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.6).setScrollFactor(0).setDepth(9000);
    const travelTxt = this.add.text(width / 2, height / 2, "移動中…", { fontSize: "28px", color: "#ffffff", fontStyle: "bold" }).setOrigin(0.5).setScrollFactor(0).setDepth(9001);
    this.uiLayer.add([travelBg, travelTxt]);
    try {
      const { room } = await joinPublicRoom("mmo", loadPlayerName(), area);
      await this.room.leave();
      this.scene.start("MmoGame", { room });
    } catch {
      this.traveling = false;
      this.scene.start("MmoLobby");
    }
  }

  // --- 世界地図（Mキー。エリア相関図＋ファストトラベル）---

  // 現在の地形から行ける地形key一覧（WORLD_LINKS から算出）。
  private reachableAreas(): string[] {
    const cur = (this.room.state as any).ground || "town";
    const set = new Set<string>();
    for (const [a, b] of WORLD_LINKS) {
      if (a === cur) set.add(b);
      if (b === cur) set.add(a);
    }
    return WORLD_AREAS.filter((ar) => set.has(ar.key)).map((ar) => ar.key);
  }

  private toggleWorldMap() {
    if (this.worldmapLayer) this.closeWorldMap();
    else this.openWorldMap();
  }

  private closeWorldMap() {
    this.worldmapLayer?.destroy();
    this.worldmapLayer = undefined;
  }

  private moveWorldSel(dir: number) {
    const reach = this.reachableAreas();
    if (reach.length === 0) return;
    this.worldmapSel = (this.worldmapSel + dir + reach.length) % reach.length;
    this.drawWorldMap();
  }

  private travelFromMap() {
    const reach = this.reachableAreas();
    const key = reach[this.worldmapSel];
    const node = WORLD_AREAS.find((a) => a.key === key);
    if (node) void this.travelToArea(node.travel);
  }

  private openWorldMap() {
    if (this.overlayOpen()) { this.closeBinder(); this.closeStatus(); }
    this.worldmapSel = 0;
    const layer = this.add.container(0, 0).setScrollFactor(0).setDepth(7000);
    this.uiLayer.add(layer);
    this.worldmapLayer = layer;
    this.drawWorldMap();
  }

  private drawWorldMap() {
    const layer = this.worldmapLayer;
    if (!layer) return;
    layer.removeAll(true);
    const { width, height } = this.scale;
    const cur = (this.room.state as any).ground || "town";
    const reach = this.reachableAreas();
    const selKey = reach[this.worldmapSel];

    layer.add(this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.82).setInteractive());
    layer.add(this.add.text(width / 2, 34, "世界地図", { fontSize: "30px", color: "#e8c87e", fontStyle: "bold" }).setOrigin(0.5));

    // 地図パネル（地形イラスト＝worldmap、無ければ羊皮紙色のベタ＋繋がり線）
    const pw = Math.min(820, width - 80), ph = pw / (1640 / 880); // 地図画像のアスペクト比に合わせる
    const px = width / 2 - pw / 2, py = 86;
    const hasMap = this.textures.exists("worldmap");
    if (hasMap) {
      const bg = this.add.image(width / 2, py + ph / 2, "worldmap");
      bg.setDisplaySize(pw, ph);
      layer.add(bg);
    } else {
      layer.add(this.add.rectangle(width / 2, py + ph / 2, pw, ph, 0x2a2335, 0.96).setStrokeStyle(3, 0x6b5a8f));
    }
    const pos = (a: { mx: number; my: number }) => ({ x: px + a.mx * pw, y: py + a.my * ph });

    // 地図画像が無いときだけ、繋がりを線で描く（地図には小道が描き込み済み）
    if (!hasMap) {
      const g = this.add.graphics();
      g.lineStyle(4, 0x6b5a8f, 0.9);
      for (const [a, b] of WORLD_LINKS) {
        const A = WORLD_AREAS.find((w) => w.key === a), B = WORLD_AREAS.find((w) => w.key === b);
        if (!A || !B) continue;
        const pa = pos(A), pb = pos(B);
        g.lineBetween(pa.x, pa.y, pb.x, pb.y);
      }
      layer.add(g);
    }

    // エリアノード（地形マップ上のマーカー）
    for (const a of WORLD_AREAS) {
      const p = pos(a);
      const isCur = a.key === cur;
      const isSel = a.key === selKey;
      const ringColor = isCur ? 0xe8b04b : isSel ? 0x2aa6c0 : 0x6b4f2a;
      const ring = this.add.circle(p.x, p.y, 26, 0x231a12, 0.96).setStrokeStyle(isCur || isSel ? 5 : 3, ringColor);
      layer.add(ring);
      if (isSel && !isCur) {
        this.tweens.add({ targets: ring, scale: { from: 1, to: 1.15 }, duration: 600, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      }
      layer.add(this.add.text(p.x, p.y, a.icon, { fontSize: "24px" }).setOrigin(0.5));
      layer.add(this.add.text(p.x, p.y + 38, a.name, {
        fontSize: "17px", color: "#fff4dc", fontStyle: "bold", stroke: "#3a2a18", strokeThickness: 4,
      }).setOrigin(0.5));
      if (isCur) layer.add(this.add.text(p.x, p.y - 40, "現在地", {
        fontSize: "13px", color: "#ffe08a", fontStyle: "bold", stroke: "#3a2a18", strokeThickness: 4,
      }).setOrigin(0.5));
    }

    // 下部：選択中エリアの説明＋操作
    const sel = WORLD_AREAS.find((a) => a.key === selKey);
    const by = py + ph + 24;
    if (sel) {
      layer.add(this.add.text(width / 2, by, `▸ ${sel.name} へ移動`, { fontSize: "20px", color: "#5fd0e0", fontStyle: "bold" }).setOrigin(0.5));
      layer.add(this.add.text(width / 2, by + 30, sel.blurb, { fontSize: "15px", color: "#cfc7e0", wordWrap: { width: pw - 40 } }).setOrigin(0.5, 0));
    } else {
      layer.add(this.add.text(width / 2, by, "ここから行ける場所はまだありません", { fontSize: "16px", color: "#9b93b0" }).setOrigin(0.5));
    }
    layer.add(this.add.text(width / 2, height - 24, "← → 選択　・　Enter 移動　・　M / Esc 閉じる", { fontSize: "13px", color: "#6a6285" }).setOrigin(0.5));
  }

  // mob討伐などで霊宝を入手したときのポップアップ（画面固定）。
  private showRelicFound(cardId: number) {
    const c = this.cardById.get(cardId);
    const meta = c ? RARITY_META[c.rarity] : null;
    const cx = this.scale.width / 2;
    const cont = this.add.container(cx, 150).setScrollFactor(0).setDepth(5000);
    this.uiLayer.add(cont);
    const bg = this.add.rectangle(0, 0, 340, 116, 0x15101f, 0.96).setStrokeStyle(3, meta?.colorNum ?? 0xe8b04b);
    const card = this.makeRelicCard({ cardId, name: c?.name ?? "", rarity: c?.rarity ?? "legend", w: 74, h: 100, owned: true });
    card.setPosition(-122, 0);
    const title = this.add.text(-78, -20, "✦ 霊宝を発見！", { fontSize: "16px", color: "#e8c87e", fontStyle: "bold" }).setOrigin(0, 0.5);
    const name = this.add.text(-78, 14, c?.name ?? `#${cardId}`, { fontSize: "22px", color: "#ece7f5", fontStyle: "bold" }).setOrigin(0, 0.5);
    cont.add([bg, card, title, name]);
    cont.setAlpha(0).setScale(0.85);
    this.tweens.add({ targets: cont, alpha: 1, scale: 1, duration: 250, ease: "Back.easeOut" });
    sfxScore();
    this.time.delayedCall(2600, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, y: 130, duration: 300, onComplete: () => cont.destroy() });
    });
    if (this.binderLayer) void this.openBinder(); // 開いていれば即反映
  }

  // アイテム入手ポップアップ（バフ薬ドロップ時）
  private showItemFound(id: string) {
    const meta = ITEM_META[id];
    const cx = this.scale.width / 2;
    const cont = this.add.container(cx, 150).setScrollFactor(0).setDepth(5000);
    this.uiLayer.add(cont);
    const bg = this.add.rectangle(0, 0, 320, 84, 0x15101f, 0.96).setStrokeStyle(3, 0x7ee787);
    const icon = this.add.text(-128, 0, meta?.icon ?? "🎁", { fontSize: "40px" }).setOrigin(0.5);
    const title = this.add.text(-92, -16, "🎁 アイテム入手！", { fontSize: "15px", color: "#7ee787", fontStyle: "bold" }).setOrigin(0, 0.5);
    const name = this.add.text(-92, 14, meta?.name ?? id, { fontSize: "20px", color: "#ece7f5", fontStyle: "bold" }).setOrigin(0, 0.5);
    cont.add([bg, icon, title, name]);
    cont.setAlpha(0).setScale(0.85);
    this.tweens.add({ targets: cont, alpha: 1, scale: 1, duration: 250, ease: "Back.easeOut" });
    sfxScore();
    this.time.delayedCall(2400, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, y: 130, duration: 300, onComplete: () => cont.destroy() });
    });
    if (this.statusLayer && this.statusTab === "items") this.drawStatusTab();
  }

  // 装備入手ポップアップ（討伐ドロップ時）
  private showEquipFound(id: string) {
    const meta = EQUIP_META[id];
    const cx = this.scale.width / 2;
    const cont = this.add.container(cx, 150).setScrollFactor(0).setDepth(5000);
    this.uiLayer.add(cont);
    const bg = this.add.rectangle(0, 0, 320, 84, 0x15101f, 0.96).setStrokeStyle(3, 0xe8c87e);
    const icon = this.add.text(-128, 0, meta?.icon ?? "⚔️", { fontSize: "40px" }).setOrigin(0.5);
    const title = this.add.text(-92, -16, "⚔️ 装備入手！", { fontSize: "15px", color: "#e8c87e", fontStyle: "bold" }).setOrigin(0, 0.5);
    const name = this.add.text(-92, 14, meta?.name ?? id, { fontSize: "20px", color: "#ece7f5", fontStyle: "bold" }).setOrigin(0, 0.5);
    cont.add([bg, icon, title, name]);
    cont.setAlpha(0).setScale(0.85);
    this.tweens.add({ targets: cont, alpha: 1, scale: 1, duration: 250, ease: "Back.easeOut" });
    sfxScore();
    this.time.delayedCall(2400, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, y: 130, duration: 300, onComplete: () => cont.destroy() });
    });
    if (this.statusLayer && this.statusTab === "equip") this.drawStatusTab();
  }

  // --- ショップ（町でEキー。ゴールドで回復薬を購入）---

  private closeShop() {
    this.shopLayer?.destroy();
    this.shopLayer = undefined;
  }

  private openShop() {
    if (this.overlayOpen()) return;
    this.shopTab = "buy";
    const layer = this.add.container(0, 0).setScrollFactor(0).setDepth(7000);
    this.uiLayer.add(layer);
    this.shopLayer = layer;
    this.drawShop();
  }

  private drawShop() {
    const layer = this.shopLayer; if (!layer) return;
    layer.removeAll(true);
    const { width, height } = this.scale;
    const cx = width / 2;
    const me: any = (this.room.state as any).players.get(this.myId);
    const pw = Math.min(720, width - 80), ph = Math.min(520, height - 80);
    const px = cx - pw / 2, py = (height - ph) / 2;
    const T = (x: number, y: number, t: string, size: number, color: string, bold = false) => {
      const o = this.add.text(x, y, t, { fontSize: `${size}px`, color, fontStyle: bold ? "bold" : "normal" });
      layer.add(o); return o;
    };
    layer.add(this.add.rectangle(cx, height / 2, width, height, 0x000000, 0.85).setInteractive());
    layer.add(this.add.rectangle(cx, py + ph / 2, pw, ph, 0x161122, 0.98).setStrokeStyle(2, 0x6b5a8f));
    T(px + 28, py + 22, "🛒 ショップ", 24, "#e8c87e", true);
    T(px + pw - 28, py + 26, `所持 🪙 ${me?.gold ?? 0}`, 17, "#ffd966", true).setOrigin(1, 0);
    const close = T(px + pw - 28, py + ph - 30, "✕ 閉じる (Esc / E)", 14, "#cccccc").setOrigin(1, 0).setInteractive({ useHandCursor: true });
    close.on("pointerdown", () => this.closeShop());

    // 購入/装備/売却タブ
    const tabs: Array<["buy" | "equip" | "sell", string]> = [["buy", "購入"], ["equip", "装備"], ["sell", "売却"]];
    tabs.forEach(([key, label], i) => {
      const tw = 96, tx = px + 28 + i * (tw + 8), ty = py + 56;
      const on = this.shopTab === key;
      const tab = this.add.rectangle(tx, ty, tw, 32, on ? 0x3a2f5a : 0x1c1530, 0.95).setOrigin(0, 0)
        .setStrokeStyle(1, on ? 0x8a7ab5 : 0x3a3550).setInteractive({ useHandCursor: true });
      tab.on("pointerdown", () => { this.shopTab = key; this.drawShop(); });
      layer.add(tab);
      T(tx + tw / 2, ty + 16, label, 15, on ? "#ece7f5" : "#9b93b0", on).setOrigin(0.5);
    });

    const rowH = 56, listX = px + 28, listW = pw - 56, top = py + 100;
    if (this.shopTab === "buy") {
      SHOP_ITEMS.forEach((s, i) => {
        const meta = ITEM_META[s.id];
        const owned = (me?.items?.get(s.id) ?? 0) as number;
        const ry = top + i * (rowH + 12);
        layer.add(this.add.rectangle(listX, ry, listW, rowH, 0x1c1530, 0.85).setOrigin(0, 0).setStrokeStyle(1, 0x3a3550));
        T(listX + 18, ry + rowH / 2, meta?.icon ?? "🧪", 28, "#ffffff").setOrigin(0, 0.5);
        T(listX + 64, ry + 12, `${meta?.name ?? s.id}`, 17, "#ece7f5", true);
        T(listX + 64, ry + 36, `${meta?.desc ?? ""}　／　所持 ×${owned}`, 13, "#bdb6d0");
        const canBuy = (me?.gold ?? 0) >= s.price;
        const btnW = 130, btnX = listX + listW - btnW - 12, btnY = ry + rowH / 2;
        const btn = this.add.rectangle(btnX, btnY, btnW, 38, canBuy ? 0x2f7d4f : 0x3a3550).setOrigin(0, 0.5)
          .setStrokeStyle(1, canBuy ? 0x57c084 : 0x4a4360);
        if (canBuy) btn.setInteractive({ useHandCursor: true }).on("pointerdown", () => this.buyItem(s.id));
        layer.add(btn);
        T(btnX + btnW / 2, btnY, `🪙${s.price} 購入`, 15, canBuy ? "#ffffff" : "#7a7390", true).setOrigin(0.5);
      });
      T(cx, py + ph - 30, "ゴールドは討伐で貯まる", 12, "#6a6285").setOrigin(0.5);
    } else if (this.shopTab === "equip") {
      // 装備購入：EQUIP_SHOP を一覧。購入で gear（未装備の所持）へ。
      const eqRowH = 50;
      EQUIP_SHOP.forEach((s, i) => {
        const meta = EQUIP_META[s.id];
        const owned = (me?.gear?.get(s.id) ?? 0) as number;
        const ry = top + i * (eqRowH + 8);
        layer.add(this.add.rectangle(listX, ry, listW, eqRowH, 0x1c1530, 0.85).setOrigin(0, 0).setStrokeStyle(1, 0x3a3550));
        T(listX + 18, ry + eqRowH / 2, meta?.icon ?? "⚔️", 26, "#ffffff").setOrigin(0, 0.5);
        T(listX + 60, ry + 10, `${meta?.name ?? s.id}`, 16, "#ece7f5", true);
        T(listX + 60, ry + 32, `${meta?.desc ?? ""}　／　所持 ×${owned}`, 12, "#bdb6d0");
        const canBuy = (me?.gold ?? 0) >= s.price;
        const btnW = 124, btnX = listX + listW - btnW - 12, btnY = ry + eqRowH / 2;
        const btn = this.add.rectangle(btnX, btnY, btnW, 36, canBuy ? 0x2f7d4f : 0x3a3550).setOrigin(0, 0.5)
          .setStrokeStyle(1, canBuy ? 0x57c084 : 0x4a4360);
        if (canBuy) btn.setInteractive({ useHandCursor: true }).on("pointerdown", () => this.buyItem(s.id));
        layer.add(btn);
        T(btnX + btnW / 2, btnY, `🪙${s.price} 購入`, 14, canBuy ? "#ffffff" : "#7a7390", true).setOrigin(0.5);
      });
      T(cx, py + ph - 30, "購入した装備は ステータス画面(C)の装備タブで装着", 12, "#6a6285").setOrigin(0.5);
    } else {
      // 売却：所持している売却可能アイテム＋未装備の装備を一覧
      const ownedItems = ITEM_ORDER.filter((id) => SELL_PRICES[id] != null && (me?.items?.get(id) ?? 0) > 0)
        .map((id) => ({ id, n: (me?.items?.get(id) ?? 0) as number, price: SELL_PRICES[id], meta: ITEM_META[id] }));
      const ownedGear = Object.keys(EQUIP_META).filter((id) => EQUIP_SELL[id] != null && (me?.gear?.get(id) ?? 0) > 0)
        .map((id) => ({ id, n: (me?.gear?.get(id) ?? 0) as number, price: EQUIP_SELL[id], meta: EQUIP_META[id] }));
      const owned = [...ownedItems, ...ownedGear];
      if (owned.length === 0) {
        T(cx, top + 40, "売却できるアイテムを持っていません", 14, "#6a6285").setOrigin(0.5);
      } else {
        owned.forEach((o, i) => {
          const ry = top + i * (rowH + 10);
          layer.add(this.add.rectangle(listX, ry, listW, rowH, 0x1c1530, 0.85).setOrigin(0, 0).setStrokeStyle(1, 0x3a3550));
          T(listX + 18, ry + rowH / 2, o.meta?.icon ?? "❔", 28, "#ffffff").setOrigin(0, 0.5);
          T(listX + 64, ry + 12, `${o.meta?.name ?? o.id}`, 17, "#ece7f5", true);
          T(listX + 64, ry + 36, `${o.meta?.desc ?? ""}　／　所持 ×${o.n}`, 13, "#bdb6d0");
          const btnW = 130, btnX = listX + listW - btnW - 12, btnY = ry + rowH / 2;
          const btn = this.add.rectangle(btnX, btnY, btnW, 38, 0x7d5a2f).setOrigin(0, 0.5).setStrokeStyle(1, 0xc0894f)
            .setInteractive({ useHandCursor: true });
          btn.on("pointerdown", () => this.sellItem(o.id));
          layer.add(btn);
          T(btnX + btnW / 2, btnY, `🪙${o.price} 売却`, 15, "#ffffff", true).setOrigin(0.5);
        });
      }
      T(cx, py + ph - 30, "不要なアイテム・装備をゴールドに換える", 12, "#6a6285").setOrigin(0.5);
    }
  }

  private buyItem(id: string) {
    const me: any = (this.room.state as any).players.get(this.myId);
    const shop = SHOP_ITEMS.find((s) => s.id === id) ?? EQUIP_SHOP.find((s) => s.id === id);
    if (!shop || (me?.gold ?? 0) < shop.price) return;
    this.room.send("buyItem", { id });
    sfxScore();
    this.time.delayedCall(160, () => { if (this.shopLayer) this.drawShop(); });
  }

  private sellItem(id: string) {
    const me: any = (this.room.state as any).players.get(this.myId);
    const isEquip = EQUIP_SELL[id] != null;
    const have = isEquip ? (me?.gear?.get(id) ?? 0) : (me?.items?.get(id) ?? 0);
    if ((isEquip ? EQUIP_SELL[id] : SELL_PRICES[id]) == null || have <= 0) return;
    this.room.send("sellItem", { id });
    sfxScore();
    this.time.delayedCall(160, () => { if (this.shopLayer) this.drawShop(); });
  }

  // --- 取引所（町でEキー。プレイヤー間カード交換・掲示板方式）---

  private closeTrade() {
    this.tradeLayer?.destroy();
    this.tradeLayer = undefined;
  }

  private async openTrade() {
    if (this.overlayOpen()) return;
    this.tradeTab = "browse";
    this.createOffer = undefined;
    this.createRequest = undefined;
    this.tradeErr = undefined;
    this.tradeLoading = true;
    const layer = this.add.container(0, 0).setScrollFactor(0).setDepth(7000);
    this.uiLayer.add(layer);
    this.tradeLayer = layer;
    this.drawTrade();
    try {
      const [user, open, mine, cards] = await Promise.all([
        getUser(), fetchOpenTrades(), fetchMyCards(), fetchCards(),
      ]);
      this.myProfileId = user?.id;
      this.tradeOpen = open as any[];
      this.tradeMyCards = mine;
      this.cardById = new Map(cards.map((c) => [c.id, c]));
    } catch (e: any) {
      this.tradeErr = e?.message ?? String(e);
    }
    this.tradeLoading = false;
    if (this.tradeLayer) this.drawTrade();
  }

  // 取引データを再取得して再描画（操作後に呼ぶ）
  private async reloadTrade() {
    try {
      const [open, mine] = await Promise.all([fetchOpenTrades(), fetchMyCards()]);
      this.tradeOpen = open as any[];
      this.tradeMyCards = mine;
    } catch (e: any) { this.tradeErr = e?.message ?? String(e); }
    if (this.tradeLayer) this.drawTrade();
  }

  // カードのメタ（名前・レアリティ）。cardById から引く。
  private tCard(id: number): { name: string; rarity: "common" | "rare" | "legend" } {
    const c = this.cardById.get(id);
    return { name: c?.name ?? `#${id}`, rarity: (c?.rarity ?? "common") as any };
  }

  // 自由に使える枚数（count - locked）。
  private freeOf(cardId: number): number {
    const c = this.tradeMyCards.find((u) => u.card_id === cardId);
    return c ? c.count - c.locked : 0;
  }

  // 1枚ぶんのカード表示（アイコン＋名前）。layerに追加。
  private tradeChip(layer: Phaser.GameObjects.Container, x: number, y: number, cardId: number, box = 30) {
    const info = this.tCard(cardId);
    layer.add(this.makeRelicIcon(x + box / 2, y, info.name, cardId, box, false));
    const rm = RARITY_META[info.rarity] ?? RARITY_META.common;
    layer.add(this.add.text(x + box + 8, y, info.name, { fontSize: "13px", color: rm.colorStr, fontStyle: "bold" }).setOrigin(0, 0.5));
  }

  // 取引のトースト通知（成立/失敗）。showRelicFound と同パターン。
  private showTradeToast(text: string, ok = true) {
    const cx = this.scale.width / 2;
    const cont = this.add.container(cx, 150).setScrollFactor(0).setDepth(5300);
    this.uiLayer.add(cont);
    const bg = this.add.rectangle(0, 0, 360, 56, 0x15101f, 0.97).setStrokeStyle(3, ok ? 0x7ee787 : 0xe08a8a);
    const t = this.add.text(0, 0, text, { fontSize: "16px", color: ok ? "#7ee787" : "#e08a8a", fontStyle: "bold" }).setOrigin(0.5);
    cont.add([bg, t]);
    cont.setAlpha(0).setScale(0.9);
    this.tweens.add({ targets: cont, alpha: 1, scale: 1, duration: 220, ease: "Back.easeOut" });
    this.time.delayedCall(2200, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, y: 130, duration: 300, onComplete: () => cont.destroy() });
    });
  }

  // 取引のエラー理由を日本語に。
  private tradeReason(code: string): string {
    if (code.startsWith("responder_short")) return "あなたの在庫が不足しています";
    if (code === "unavailable") return "この取引はすでに成立/取消済みです";
    if (code === "not_for_you") return "この取引はあなた宛てではありません";
    if (code === "not_found") return "取引が見つかりません";
    if (code.startsWith("insufficient_free")) return "出すカードの在庫が不足しています";
    if (code === "cannot_trade_self") return "自分とは取引できません";
    if (code === "cannot_accept_own") return "自分の出品は承認できません";
    return code;
  }

  private drawTrade() {
    const layer = this.tradeLayer; if (!layer) return;
    layer.removeAll(true);
    const { width, height } = this.scale;
    const cx = width / 2;
    const pw = Math.min(760, width - 60), ph = Math.min(560, height - 60);
    const px = cx - pw / 2, py = (height - ph) / 2;
    const T = (x: number, y: number, t: string, size: number, color: string, bold = false) => {
      const o = this.add.text(x, y, t, { fontSize: `${size}px`, color, fontStyle: bold ? "bold" : "normal" });
      layer.add(o); return o;
    };
    layer.add(this.add.rectangle(cx, height / 2, width, height, 0x000000, 0.85).setInteractive());
    layer.add(this.add.rectangle(cx, py + ph / 2, pw, ph, 0x141a16, 0.98).setStrokeStyle(2, 0x4a7a64));
    T(px + 28, py + 22, "🔄 取引所", 24, "#9fe0c0", true);
    T(px + pw - 28, py + 26, "カード ↔ カードの交換", 13, "#7fae98", false).setOrigin(1, 0);
    const close = T(px + pw - 28, py + ph - 28, "✕ 閉じる (Esc / E)", 14, "#cccccc").setOrigin(1, 0).setInteractive({ useHandCursor: true });
    close.on("pointerdown", () => this.closeTrade());

    // タブ
    const tabs: Array<["browse" | "mine" | "create", string]> = [["browse", "取引所"], ["mine", "自分の出品"], ["create", "新規出品"]];
    tabs.forEach(([key, label], i) => {
      const tw = 120, tx = px + 28 + i * (tw + 8), ty = py + 58;
      const on = this.tradeTab === key;
      const tab = this.add.rectangle(tx, ty, tw, 32, on ? 0x2f5a47 : 0x1c2a24, 0.95).setOrigin(0, 0)
        .setStrokeStyle(1, on ? 0x7ab59a : 0x35443d).setInteractive({ useHandCursor: true });
      tab.on("pointerdown", () => { this.tradeTab = key; this.drawTrade(); });
      layer.add(tab);
      T(tx + tw / 2, ty + 16, label, 15, on ? "#ece7f5" : "#8fae9f", on).setOrigin(0.5);
    });

    const top = py + 104, listX = px + 28, listW = pw - 56;
    if (this.tradeLoading) { T(cx, top + 60, "読み込み中…", 16, "#ece7f5").setOrigin(0.5); return; }
    if (this.tradeErr) { T(cx, top + 60, `エラー: ${this.tradeErr}`, 14, "#e08a8a").setOrigin(0.5); return; }
    if (!this.myProfileId) { T(cx, top + 60, "取引にはアカウントが必要です（ログインしてください）", 14, "#e08a8a").setOrigin(0.5); return; }

    if (this.tradeTab === "browse") this.drawTradeBrowse(layer, T, listX, top, listW, py + ph);
    else if (this.tradeTab === "mine") this.drawTradeMine(layer, T, listX, top, listW, py + ph);
    else this.drawTradeCreate(layer, T, listX, top, listW, py + ph);
  }

  // offer/request の最初のアイテムを取り出す（1↔1前提）。
  private tradePair(t: any): { offer?: { card_id: number; qty: number }; request?: { card_id: number; qty: number } } {
    const items: any[] = t.trade_items ?? [];
    return {
      offer: items.find((x) => x.side === "offer"),
      request: items.find((x) => x.side === "request"),
    };
  }

  private drawTradeRow(layer: Phaser.GameObjects.Container, listX: number, ry: number, listW: number, t: any,
    btnLabel: string, btnColor: number, btnStroke: number, enabled: boolean, onClick: () => void) {
    const rowH = 56;
    layer.add(this.add.rectangle(listX, ry, listW, rowH, 0x1c2a24, 0.85).setOrigin(0, 0).setStrokeStyle(1, 0x35443d));
    const { offer, request } = this.tradePair(t);
    const my = ry + rowH / 2;
    if (offer) this.tradeChip(layer, listX + 14, my, offer.card_id, 30);
    layer.add(this.add.text(listX + listW * 0.40, my, "⇄", { fontSize: "20px", color: "#9fe0c0" }).setOrigin(0.5));
    if (request) this.tradeChip(layer, listX + listW * 0.46, my, request.card_id, 30);
    const btnW = 120, btnX = listX + listW - btnW - 12, btnY = my;
    const btn = this.add.rectangle(btnX, btnY, btnW, 38, enabled ? btnColor : 0x35443d).setOrigin(0, 0.5)
      .setStrokeStyle(1, enabled ? btnStroke : 0x4a4360);
    if (enabled) btn.setInteractive({ useHandCursor: true }).on("pointerdown", onClick);
    layer.add(btn);
    layer.add(this.add.text(btnX + btnW / 2, btnY, btnLabel, { fontSize: "15px", color: enabled ? "#ffffff" : "#7a8a82", fontStyle: "bold" }).setOrigin(0.5));
  }

  private drawTradeBrowse(layer: Phaser.GameObjects.Container, T: any, listX: number, top: number, listW: number, bottom: number) {
    T(listX, top, "▸ 公開中の取引（承認すると即交換）", 15, "#9fe0c0", true);
    const list = this.tradeOpen.filter((t) => t.proposer_id !== this.myProfileId);
    if (list.length === 0) { T(listX + listW / 2, top + 70, "公開中の取引はありません", 14, "#6a8278").setOrigin(0.5); return; }
    const rowH = 56, gap = 10; let ry = top + 30;
    for (const t of list) {
      if (ry + rowH > bottom - 44) break; // パネル下端まで（MVP：スクロール無し）
      const { request } = this.tradePair(t);
      const can = !!request && this.freeOf(request.card_id) >= (request.qty ?? 1);
      this.drawTradeRow(layer, listX, ry, listW, t, can ? "承認" : "所持不足", 0x2f7d4f, 0x57c084, can, async () => {
        const r = await acceptTrade(t.id);
        if (r === "ok") { this.showTradeToast("交換が成立しました", true); sfxScore(); }
        else this.showTradeToast(this.tradeReason(r), false);
        void this.reloadTrade();
      });
      ry += rowH + gap;
    }
    T(listX, bottom - 34, "「欲しいカード」を所持していれば承認できます", 12, "#6a8278");
  }

  private drawTradeMine(layer: Phaser.GameObjects.Container, T: any, listX: number, top: number, listW: number, bottom: number) {
    T(listX, top, "▸ 自分の出品（取消でロック解除）", 15, "#9fe0c0", true);
    const list = this.tradeOpen.filter((t) => t.proposer_id === this.myProfileId);
    if (list.length === 0) { T(listX + listW / 2, top + 70, "出品中の取引はありません", 14, "#6a8278").setOrigin(0.5); return; }
    const rowH = 56, gap = 10; let ry = top + 30;
    for (const t of list) {
      if (ry + rowH > bottom - 44) break;
      this.drawTradeRow(layer, listX, ry, listW, t, "取消", 0x7d5a2f, 0xc0894f, true, async () => {
        const r = await cancelTrade(t.id);
        if (r === "ok") this.showTradeToast("出品を取り消しました", true);
        else this.showTradeToast(this.tradeReason(r), false);
        void this.reloadTrade();
      });
      ry += rowH + gap;
    }
    T(listX, bottom - 34, "出したカードは成立まで「ロック」され他で使えません", 12, "#6a8278");
  }

  private drawTradeCreate(layer: Phaser.GameObjects.Container, T: any, listX: number, top: number, listW: number, bottom: number) {
    // 選択中の表示＋出品ボタン
    T(listX, top, "▸ 新規出品（出す1枚 ⇄ 欲しい1枚）", 15, "#9fe0c0", true);
    const selY = top + 36;
    layer.add(this.add.rectangle(listX, selY, listW, 44, 0x10160f, 0.9).setOrigin(0, 0).setStrokeStyle(1, 0x35443d));
    T(listX + 12, selY + 22, "出す:", 13, "#8fae9f").setOrigin(0, 0.5);
    if (this.createOffer != null) this.tradeChip(layer, listX + 56, selY + 22, this.createOffer, 26);
    else T(listX + 56, selY + 22, "未選択", 13, "#6a8278").setOrigin(0, 0.5);
    layer.add(this.add.text(listX + listW * 0.46, selY + 22, "⇄", { fontSize: "18px", color: "#9fe0c0" }).setOrigin(0.5));
    T(listX + listW * 0.50, selY + 22, "欲しい:", 13, "#8fae9f").setOrigin(0, 0.5);
    if (this.createRequest != null) this.tradeChip(layer, listX + listW * 0.50 + 50, selY + 22, this.createRequest, 26);
    else T(listX + listW * 0.50 + 50, selY + 22, "未選択", 13, "#6a8278").setOrigin(0, 0.5);
    const canPost = this.createOffer != null && this.createRequest != null;
    const pbW = 130, pbX = listX + listW - pbW, pbY = selY + 22;
    const pbtn = this.add.rectangle(pbX, pbY, pbW, 36, canPost ? 0x2f7d4f : 0x35443d).setOrigin(0, 0.5)
      .setStrokeStyle(1, canPost ? 0x57c084 : 0x4a4360);
    if (canPost) pbtn.setInteractive({ useHandCursor: true }).on("pointerdown", async () => {
      const offer = this.createOffer!, request = this.createRequest!;
      try {
        await proposeTrade([{ card_id: offer, qty: 1 }], [{ card_id: request, qty: 1 }]);
        this.showTradeToast("出品しました", true); sfxScore();
        this.createOffer = undefined; this.createRequest = undefined; this.tradeTab = "mine";
        void this.reloadTrade();
      } catch (e: any) {
        this.showTradeToast(this.tradeReason(e?.message ?? String(e)), false);
      }
    });
    layer.add(pbtn);
    layer.add(this.add.text(pbX + pbW / 2, pbY, "出品する", { fontSize: "14px", color: canPost ? "#ffffff" : "#7a8a82", fontStyle: "bold" }).setOrigin(0.5));

    // 出すカード候補（重複所持＝count-locked>0）
    const offY = selY + 60;
    T(listX, offY, "出すカード（重複して持っているカード）", 13, "#bdb6d0");
    const dups = this.tradeMyCards.filter((u) => u.count - u.locked > 0).sort((a, b) => a.card_id - b.card_id);
    if (dups.length === 0) {
      T(listX + 8, offY + 26, "出せるカードがありません（同じカードを2枚以上持つと出品できます）", 12, "#6a8278");
    } else {
      this.cardGrid(layer, listX, offY + 22, listW, dups.map((u) => u.card_id), this.createOffer, (id) => { this.createOffer = id; this.drawTrade(); }, dups);
    }

    // 欲しいカード候補（全種）
    const reqY = offY + 22 + 2 * 46 + 16;
    T(listX, reqY, "欲しいカード（全種から選択）", 13, "#bdb6d0");
    const all = [...this.cardById.values()].sort((a, b) => a.id - b.id).map((c) => c.id);
    this.cardGrid(layer, listX, reqY + 22, listW, all, this.createRequest, (id) => { this.createRequest = id; this.drawTrade(); });
  }

  // カードを小アイコンのグリッドで並べ、クリックで選択。selected はハイライト。
  // counts を渡すと所持枚数バッジを表示。
  private cardGrid(layer: Phaser.GameObjects.Container, x: number, y: number, w: number,
    ids: number[], selected: number | undefined, onPick: (id: number) => void, counts?: UserCard[]) {
    const cell = 42, gap = 8, cols = Math.max(1, Math.floor((w + gap) / (cell + gap)));
    ids.forEach((id, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      if (row > 1) return; // MVP：2行まで（はみ出し防止）
      const cxp = x + col * (cell + gap) + cell / 2, cyp = y + row * (cell + gap) + cell / 2;
      const sel = selected === id;
      const box = this.add.rectangle(cxp, cyp, cell, cell, sel ? 0x2f5a47 : 0x1c2a24)
        .setStrokeStyle(2, sel ? 0x9fe0c0 : 0x35443d).setInteractive({ useHandCursor: true });
      box.on("pointerdown", () => onPick(id));
      layer.add(box);
      layer.add(this.makeRelicIcon(cxp, cyp, this.tCard(id).name, id, cell - 12, false));
      if (counts) {
        const c = counts.find((u) => u.card_id === id);
        const free = c ? c.count - c.locked : 0;
        layer.add(this.add.text(cxp + cell / 2 - 4, cyp + cell / 2 - 4, `×${free}`, { fontSize: "11px", color: "#ffffff", fontStyle: "bold", stroke: "#000", strokeThickness: 2 }).setOrigin(1, 1));
      }
    });
    if (Math.ceil(ids.length / cols) > 2) {
      layer.add(this.add.text(x + w, y - 18, `先頭 ${Math.min(ids.length, cols * 2)}/${ids.length} 種を表示`, { fontSize: "11px", color: "#6a8278" }).setOrigin(1, 0));
    }
  }

  // --- ステータスパネル（Cキー。蒐集進捗＋RPG＋アカウント情報）---

  private toggleStatus() {
    if (this.statusLayer) this.closeStatus();
    else void this.openStatus();
  }

  private closeStatus() {
    this.statusLayer?.destroy();
    this.statusLayer = undefined;
    this.statusContent = undefined;
    this.statusTabs = [];
    this.statusPanel = undefined;
  }

  private async openStatus() {
    this.closeBinder(); // 同時には開かない
    const { width, height } = this.scale;
    const cx = width / 2;
    this.statusLayer?.destroy();
    const layer = this.add.container(0, 0).setScrollFactor(0).setDepth(7000);
    this.uiLayer.add(layer);
    this.statusLayer = layer;
    this.statusTab = "status";
    this.statusTabs = [];
    this.statusData = undefined;
    this.statusErr = undefined;

    // 背景＋パネル
    layer.add(this.add.rectangle(cx, height / 2, width, height, 0x000000, 0.85).setInteractive());
    const pw = Math.min(1120, width - 80), ph = Math.min(720, height - 70);
    const px = cx - pw / 2, py = (height - ph) / 2;
    this.statusPanel = { px, py, pw, ph };
    layer.add(this.add.rectangle(cx, py + ph / 2, pw, ph, 0x161122, 0.98).setStrokeStyle(2, 0x6b5a8f));
    const close = this.add.text(px + pw - 18, py + 14, "✕ 閉じる (C)", { fontSize: "15px", color: "#cccccc" })
      .setOrigin(1, 0).setInteractive({ useHandCursor: true });
    close.on("pointerover", () => close.setColor("#ffffff"));
    close.on("pointerout", () => close.setColor("#cccccc"));
    close.on("pointerdown", () => this.closeStatus());
    layer.add(close);

    // タブバー（クリック / 数字キー1〜4）
    const tabs: Array<["status" | "items" | "equip" | "other", string]> = [
      ["status", "ステータス"], ["items", "アイテム"], ["equip", "装備"], ["other", "その他"],
    ];
    const tabW = 148, tabH = 34, gap = 6;
    const totalW = tabs.length * tabW + (tabs.length - 1) * gap;
    let tabX = cx - totalW / 2;
    const tabY = py + 18;
    for (const [key, label] of tabs) {
      const bg = this.add.rectangle(tabX, tabY, tabW, tabH, 0x241c38).setOrigin(0, 0)
        .setStrokeStyle(1, 0x4a4360).setInteractive({ useHandCursor: true });
      const t = this.add.text(tabX + tabW / 2, tabY + tabH / 2, label, { fontSize: "15px", color: "#bdb6d0" }).setOrigin(0.5);
      bg.on("pointerdown", () => this.setStatusTab(key));
      layer.add([bg, t]);
      this.statusTabs.push({ key, bg, label: t });
      tabX += tabW + gap;
    }

    // コンテンツ領域（タブ切替で中身を差し替え）
    this.statusContent = this.add.container(0, 0);
    layer.add(this.statusContent);
    this.drawStatusTab();

    // データ取得（キャッシュ）→ ステータスタブなら再描画
    try {
      const [cards, mine, profile, user] = await Promise.all([
        fetchCards(), fetchMyCards(), getMyProfile(), getUser(),
      ]);
      if (this.statusLayer !== layer) return;
      this.statusData = { cards, mine, profile, user };
    } catch (e: any) {
      if (this.statusLayer !== layer) return;
      this.statusErr = e?.message ?? String(e);
    }
    if (this.statusTab === "status") this.drawStatusTab();
  }

  private setStatusTab(key: "status" | "items" | "equip" | "other") {
    if (!this.statusLayer) return;
    this.statusTab = key;
    this.drawStatusTab();
  }

  // タブのハイライト更新＋コンテンツ再描画
  private drawStatusTab() {
    const c = this.statusContent, p = this.statusPanel;
    if (!c || !p) return;
    for (const t of this.statusTabs) {
      const on = t.key === this.statusTab;
      t.bg.setFillStyle(on ? 0x4a3a78 : 0x241c38);
      t.label.setColor(on ? "#ffffff" : "#bdb6d0");
    }
    c.removeAll(true);
    if (this.statusTab === "status") this.drawStatusInfo(c, p);
    else if (this.statusTab === "items") this.drawItemsTab(c, p);
    else if (this.statusTab === "equip") this.drawEquipTab(c, p);
    else this.drawOtherTab(c, p);
  }

  // コンテナへ要素を足すヘルパ群（タブ共通）
  private sTxt(c: Phaser.GameObjects.Container, x: number, y: number, t: string, size: number, color: string, bold = false) {
    const o = this.add.text(x, y, t, { fontSize: `${size}px`, color, fontStyle: bold ? "bold" : "normal" });
    c.add(o); return o;
  }
  private sRect(c: Phaser.GameObjects.Container, x: number, y: number, w: number, h: number, color: number, alpha = 1) {
    const r = this.add.rectangle(x, y, w, h, color, alpha); c.add(r); return r;
  }
  // 空スロット枠（アイテム/装備で共通）
  private slot(c: Phaser.GameObjects.Container, x: number, y: number, s: number, label?: string) {
    c.add(this.add.rectangle(x, y, s, s, 0x221b34).setStrokeStyle(2, 0x4a4360));
    if (label) c.add(this.add.text(x, y + s / 2 + 12, label, { fontSize: "12px", color: "#9b93b0" }).setOrigin(0.5));
  }

  // --- タブ内容 ---

  private drawStatusInfo(c: Phaser.GameObjects.Container, p: { px: number; py: number; pw: number; ph: number }) {
    const { px, py, pw } = p;
    const colLX = px + 40, colRX = px + pw * 0.54, colW = pw * 0.40;
    const top = py + 78;
    const fmtTime = (sec: number) => {
      const s = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      return h > 0 ? `${h}時間${m}分` : `${m}分${ss}秒`;
    };
    const header = (x: number, y: number, label: string) => {
      this.sTxt(c, x, y, label, 17, "#7ee787", true);
      this.sRect(c, x, y + 26, colW, 2, 0x4a4360).setOrigin(0, 0.5);
    };
    const bar = (x: number, y: number, w: number, frac: number, color: number) => {
      this.sRect(c, x, y, w, 12, 0x2a2440).setOrigin(0, 0.5);
      this.sRect(c, x, y, Math.max(0, Math.min(1, frac)) * w, 12, color).setOrigin(0, 0.5);
    };
    const me: any = (this.room.state as any).players.get(this.myId);

    // 左：キャラクター
    header(colLX, top, "▸ キャラクター");
    const portrait = this.add.sprite(colLX + 44, top + 96, CHAR_INITIAL_TEX).setOrigin(0.5);
    applyCharPose(portrait, "front", "idle", false, 100);
    c.add(portrait);
    this.sTxt(c, colLX + 104, top + 50, me?.name ?? loadPlayerName(), 20, "#ffffff", true);
    this.sTxt(c, colLX + 104, top + 82, `Lv. ${me?.level ?? 1}`, 16, "#ffe066", true);
    if (me) {
      this.sTxt(c, colLX + 104, top + 110, `HP  ${Math.round(me.hp)} / ${me.maxHp}`, 13, "#ff9a9a");
      bar(colLX + 104, top + 132, colW - 110, me.maxHp ? me.hp / me.maxHp : 0, 0xe04545);
      this.sTxt(c, colLX + 104, top + 150, `EXP  ${me.exp} / ${me.nextExp}`, 13, "#9ab8ff");
      bar(colLX + 104, top + 172, colW - 110, me.nextExp ? me.exp / me.nextExp : 0, 0x66aaff);
    }
    const statY = top + 210;
    const now = Date.now();
    const buffs: string[] = [];
    if (me && now < (me.buffAtkUntil ?? 0)) buffs.push(`💪攻撃UP ${Math.ceil((me.buffAtkUntil - now) / 1000)}s`);
    if (me && now < (me.buffSpeedUntil ?? 0)) buffs.push(`👟速度UP ${Math.ceil((me.buffSpeedUntil - now) / 1000)}s`);
    const rows: Array<[string, string]> = me
      ? [["攻撃力", `${me.atk}`], ["防御力", `${me.def ?? 0}`], ["討伐数", `${me.kills ?? 0}`], ["ゴールド", `🪙 ${me.gold ?? 0}`],
         ["プレイ時間", fmtTime(me.playSec)], ["効果中", buffs.length ? buffs.join("  ") : "なし"]]
      : [["", "（世界に入ると表示）"]];
    rows.forEach((r, i) => {
      this.sTxt(c, colLX, statY + i * 28, r[0], 15, "#bdb6d0");
      this.sTxt(c, colLX + colW, statY + i * 28, r[1], 15, buffs.length && r[0] === "効果中" ? "#7ee787" : "#ffffff", true).setOrigin(1, 0);
    });
    const achY = statY + 178;
    header(colLX, achY, "▸ 達成課題");

    // 右：蒐集進捗＋アカウント
    header(colRX, top, "▸ 蒐集進捗");
    header(colRX, top + 250, "▸ アカウント");

    const data = this.statusData;
    if (this.statusErr) {
      this.sTxt(c, colRX, top + 34, `読み込み失敗: ${this.statusErr}`, 14, "#e08a8a");
      return;
    }
    if (!data) { this.sTxt(c, colRX, top + 34, "読み込み中…", 15, "#ece7f5"); return; }

    const { cards, mine, profile, user } = data;
    const created = profile?.created_at ? new Date(profile.created_at).toLocaleDateString("ja-JP") : "-";
    this.sTxt(c, colRX, top + 286, `表示名 : ${profile?.display_name ?? "-"}\nメール : ${user?.email ?? "(ゲスト)"}\n登録日 : ${created}`, 14, "#ece7f5").setLineSpacing(8);

    const owned = new Map(mine.map((m: any) => [m.card_id, m.count]));
    const rar: Record<string, { have: number; total: number }> = {
      common: { have: 0, total: 0 }, rare: { have: 0, total: 0 }, legend: { have: 0, total: 0 },
    };
    let ownedTotal = 0, dup = 0;
    cards.forEach((cd: any) => {
      rar[cd.rarity].total++;
      const n = (owned.get(cd.id) as number) ?? 0;
      if (n > 0) rar[cd.rarity].have++;
      ownedTotal += n; if (n > 1) dup += n - 1;
    });
    const collected = rar.common.have + rar.rare.have + rar.legend.have;
    this.sTxt(c, colRX, top + 34, `蒐集  ${collected} / ${cards.length} 種`, 15, "#ffffff", true);
    (["common", "rare", "legend"] as const).forEach((k, i) => {
      const meta = RARITY_META[k];
      const yy = top + 78 + i * 32;
      this.sTxt(c, colRX, yy - 6, meta.label, 13, meta.colorStr);
      this.sTxt(c, colRX + colW, yy - 6, `${rar[k].have} / ${rar[k].total}`, 13, "#ffffff").setOrigin(1, 0);
      bar(colRX, yy + 14, colW, rar[k].total ? rar[k].have / rar[k].total : 0, meta.colorNum);
    });
    this.sTxt(c, colRX, top + 182, `所持総数 ${ownedTotal} 枚（重複 ${dup}）`, 13, "#bdb6d0");
    this.sTxt(c, colRX, top + 204, "一覧は B キーの台帳で", 12, "#6a6285");

    ACHIEVEMENTS.forEach((a, i) => {
      const cur = a.type === "kills" ? (me?.kills ?? 0)
        : a.type === "level" ? (me?.level ?? 0)
          : a.type === "playSec" ? (me?.playSec ?? 0)
            : collected;
      const done = cur >= a.need;
      const prog = a.type === "playSec" ? `${Math.floor(cur / 60)}/${Math.floor(a.need / 60)}分` : `${cur}/${a.need}`;
      this.sTxt(c, colLX, achY + 32 + i * 20, `${done ? "✓" : "・"} ${a.desc}  ${done ? "" : prog}`, 13, done ? "#7ee787" : "#9b93b0");
    });
  }

  private drawItemsTab(c: Phaser.GameObjects.Container, p: { px: number; py: number; pw: number; ph: number }) {
    const { px, py, pw, ph } = p;
    const x0 = px + 40, top = py + 78, listW = pw - 80;
    const me: any = (this.room.state as any).players.get(this.myId);
    this.sTxt(c, x0, top, "▸ アイテム", 17, "#7ee787", true);
    this.sTxt(c, x0 + listW, top + 2, `🪙 ${me?.gold ?? 0}`, 16, "#ffd966", true).setOrigin(1, 0);
    this.sRect(c, x0, top + 26, listW, 2, 0x4a4360).setOrigin(0, 0.5);
    this.sTxt(c, x0, top + 36, "クリック または 数字キー1〜4 で使用（バフ薬は討伐でドロップ）", 12, "#9b93b0");

    const listY = top + 62, rowH = 46, pad = 14;
    this.sRect(c, x0, listY, listW, rowH, 0x241c38).setOrigin(0, 0);
    this.sTxt(c, x0 + 60, listY + 14, "アイテム", 13, "#bdb6d0", true);
    this.sTxt(c, x0 + listW * 0.46, listY + 14, "効果", 13, "#bdb6d0", true);
    this.sTxt(c, x0 + listW - pad, listY + 14, "個数", 13, "#bdb6d0", true).setOrigin(1, 0);

    // 所持アイテム（ITEM_ORDER順、個数>0のみ）
    const owned = ITEM_ORDER.filter((id) => (me?.items?.get(id) ?? 0) > 0);
    if (owned.length === 0) {
      this.sRect(c, x0, listY + rowH, listW, ph - (listY + rowH - py) - 40, 0x120e1e).setOrigin(0, 0).setStrokeStyle(1, 0x3a3550);
      this.sTxt(c, x0 + listW / 2, listY + rowH + 60, "所持しているアイテムはありません", 14, "#6a6285").setOrigin(0.5);
      this.sTxt(c, x0 + listW / 2, listY + rowH + 86, "回復薬は町のショップ／バフ薬・巻物は討伐でドロップ", 12, "#544c6a").setOrigin(0.5);
      return;
    }
    owned.forEach((id, i) => {
      const meta = ITEM_META[id]; const n = me.items.get(id) as number;
      const ry = listY + rowH * (i + 1);
      const row = this.add.rectangle(x0, ry, listW, rowH, 0x1c1530, 0.6).setOrigin(0, 0)
        .setStrokeStyle(1, 0x3a3550).setInteractive({ useHandCursor: true });
      c.add(row);
      row.on("pointerover", () => row.setFillStyle(0x2a2150, 0.9));
      row.on("pointerout", () => row.setFillStyle(0x1c1530, 0.6));
      row.on("pointerdown", () => this.useItem(id));
      this.sTxt(c, x0 + pad + 8, ry + rowH / 2, meta?.icon ?? "❔", 22, "#ffffff").setOrigin(0, 0.5);
      this.sTxt(c, x0 + 60, ry + rowH / 2, `${i < 4 ? `${i + 1}. ` : ""}${meta?.name ?? id}`, 15, "#ece7f5").setOrigin(0, 0.5);
      this.sTxt(c, x0 + listW * 0.46, ry + rowH / 2, meta?.desc ?? "", 13, "#bdb6d0").setOrigin(0, 0.5);
      this.sTxt(c, x0 + listW - pad, ry + rowH / 2, `×${n}`, 15, "#ffffff", true).setOrigin(1, 0.5);
    });
  }

  // アイテム使用をサーバーへ依頼し、少し後に画面を更新
  private useItem(id: string) {
    if ((((this.room.state as any).players.get(this.myId)?.items?.get(id)) ?? 0) <= 0) return;
    this.room.send("useItem", { id });
    this.time.delayedCall(160, () => { if (this.statusLayer) this.drawStatusTab(); });
  }

  private drawEquipTab(c: Phaser.GameObjects.Container, p: { px: number; py: number; pw: number; ph: number }) {
    const { px, py, pw } = p;
    const x0 = px + 40, top = py + 78, listW = pw - 80;
    const me: any = (this.room.state as any).players.get(this.myId);
    this.sTxt(c, x0, top, "▸ 装備", 17, "#7ee787", true);
    this.sTxt(c, x0 + listW, top + 2, `🪙 ${me?.gold ?? 0}`, 16, "#ffd966", true).setOrigin(1, 0);
    this.sRect(c, x0, top + 26, listW, 2, 0x4a4360).setOrigin(0, 0.5);
    this.sTxt(c, x0, top + 36, "下の所持装備をクリックで装備／スロットをクリックで外す", 12, "#9b93b0");

    // 装備スロット（2行×3列）。装備中はアイコン＋名称を表示し、クリックで解除。
    const cols = 3, s = 76, gapY = 46;
    const gapX = (listW - cols * s) / (cols - 1);
    const gx = x0 + s / 2, gy = top + 92 + s / 2;
    SLOTS.forEach((slot, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const cxp = gx + col * (s + gapX), cyp = gy + row * (s + gapY);
      const equippedId = me?.equip?.get(slot.key) as string | undefined;
      const meta = equippedId ? EQUIP_META[equippedId] : undefined;
      const filled = !!meta;
      const box = this.add.rectangle(cxp, cyp, s, s, filled ? 0x2a2150 : 0x221b34)
        .setStrokeStyle(2, filled ? 0x8a7ab5 : 0x4a4360);
      c.add(box);
      if (filled) {
        box.setInteractive({ useHandCursor: true });
        box.on("pointerover", () => box.setFillStyle(0x3a2f5a));
        box.on("pointerout", () => box.setFillStyle(0x2a2150));
        box.on("pointerdown", () => this.unequipItem(slot.key));
        this.sTxt(c, cxp, cyp - 4, meta!.icon, 30, "#ffffff").setOrigin(0.5);
        this.sTxt(c, cxp, cyp + s / 2 + 12, meta!.name, 11, "#ece7f5").setOrigin(0.5);
      } else {
        this.sTxt(c, cxp, cyp + s / 2 + 12, slot.label, 12, "#9b93b0").setOrigin(0.5);
      }
    });

    // 所持装備（未装備）一覧。クリックで装備。
    const listY = gy + s / 2 + gapY + s + 30;
    this.sTxt(c, x0, listY, "▸ 所持装備（クリックで装備）", 14, "#7ee787", true);
    this.sRect(c, x0, listY + 22, listW, 2, 0x4a4360).setOrigin(0, 0.5);
    const owned = Object.keys(EQUIP_META).filter((id) => (me?.gear?.get(id) ?? 0) > 0);
    if (owned.length === 0) {
      this.sTxt(c, x0, listY + 40, "所持している装備はありません", 13, "#6a6285");
      this.sTxt(c, x0, listY + 62, "装備は町のショップ（装備タブ）で購入できます", 12, "#544c6a");
      return;
    }
    const rowH = 38, pad = 14;
    owned.forEach((id, i) => {
      const meta = EQUIP_META[id]; const n = me.gear.get(id) as number;
      const ry = listY + 38 + i * (rowH + 6);
      const rowMid = ry + rowH / 2;
      const row = this.add.rectangle(x0, ry, listW, rowH, 0x1c1530, 0.6).setOrigin(0, 0)
        .setStrokeStyle(1, 0x3a3550).setInteractive({ useHandCursor: true });
      c.add(row);
      row.on("pointerover", () => row.setFillStyle(0x2a2150, 0.9));
      row.on("pointerout", () => row.setFillStyle(0x1c1530, 0.6));
      row.on("pointerdown", () => this.equipItem(id));
      this.sTxt(c, x0 + pad + 4, rowMid, meta?.icon ?? "❔", 20, "#ffffff").setOrigin(0, 0.5);
      this.sTxt(c, x0 + 52, rowMid, meta?.name ?? id, 14, "#ece7f5").setOrigin(0, 0.5);
      this.sTxt(c, x0 + listW * 0.42, rowMid, meta?.desc ?? "", 12, "#bdb6d0").setOrigin(0, 0.5);
      this.sTxt(c, x0 + listW - pad, rowMid, `×${n}`, 14, "#ffffff", true).setOrigin(1, 0.5);
    });
  }

  // 装備をサーバーへ依頼し、少し後に画面を更新
  private equipItem(id: string) {
    if ((((this.room.state as any).players.get(this.myId)?.gear?.get(id)) ?? 0) <= 0) return;
    this.room.send("equipItem", { id });
    this.time.delayedCall(160, () => { if (this.statusLayer) this.drawStatusTab(); });
  }

  private unequipItem(slot: string) {
    if (!((this.room.state as any).players.get(this.myId)?.equip?.get(slot))) return;
    this.room.send("unequipItem", { slot });
    this.time.delayedCall(160, () => { if (this.statusLayer) this.drawStatusTab(); });
  }

  private drawOtherTab(c: Phaser.GameObjects.Container, p: { px: number; py: number; pw: number; ph: number }) {
    const { px, py, pw } = p;
    const x0 = px + 40, top = py + 78;
    this.sTxt(c, x0, top, "▸ その他", 17, "#7ee787", true);
    this.sRect(c, x0, top + 26, pw - 80, 2, 0x4a4360).setOrigin(0, 0.5);
    const items = ["称号（今後実装）", "ランキング（今後実装）", "設定（今後実装）"];
    items.forEach((t, i) => this.sTxt(c, x0, top + 50 + i * 30, `・ ${t}`, 14, "#9b93b0"));
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

  private overlayOpen(): boolean { return !!(this.binderLayer || this.statusLayer || this.worldmapLayer || this.shopLayer || this.tradeLayer); }

  // --- チャット（/ で開く）---

  private addChatLine(line: string) {
    this.chatLines.push(line.slice(0, 140));
    if (this.chatLines.length > 7) this.chatLines.shift();
    this.chatLog.setText(this.chatLines.join("\n"));
  }

  private openChat() {
    if (this.chatOpen) return;
    this.chatOpen = true;
    this.input.keyboard!.enabled = false; // ゲーム操作を止めて入力に専念
    const { width, height } = this.scale;
    const el = makeInput(this, "メッセージ（Enter送信 / Escで閉じる）", 120, "", width / 2, height - 40, 460);
    this.chatInput = el;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.sendChat(); }
      else if (e.key === "Escape") { e.preventDefault(); this.closeChat(); }
    });
    setTimeout(() => el.focus(), 0);
  }

  private sendChat() {
    const text = (this.chatInput?.value ?? "").trim();
    if (text) this.room.send("chat", { text });
    this.closeChat();
  }

  private closeChat() {
    if (!this.chatOpen) return;
    this.chatOpen = false;
    this.chatInput?.remove();
    this.chatInput = undefined;
    this.input.keyboard!.enabled = true;
  }

  private static readonly BINDER_COLS = 9;

  // キーで台帳のレアリティタブを切替（開いている時だけ有効。再取得せず再描画）。
  private setBinderTab(tab: "common" | "rare" | "legend") {
    if (!this.binderLayer || this.binderTab === tab) return;
    this.binderTab = tab;
    this.binderSel = 0;
    this.drawBinder();
  }

  // 矢印/WASDで台帳の選択カーソルを移動（開いている時だけ）。
  private moveBinderSel(dCol: number, dRow: number) {
    if (!this.binderLayer || !this.binderCache) return;
    const list = this.binderCache.cards.filter((c) => c.rarity === this.binderTab);
    if (list.length === 0) return;
    let i = this.binderSel + dCol + dRow * MmoGameScene.BINDER_COLS;
    i = Math.max(0, Math.min(i, list.length - 1));
    if (i !== this.binderSel) { this.binderSel = i; this.drawBinder(); }
  }

  private async openBinder() {
    this.closeStatus(); // 同時には開かない
    this.binderLayer?.destroy();
    const layer = this.add.container(0, 0).setScrollFactor(0).setDepth(7000);
    this.uiLayer.add(layer);
    this.binderLayer = layer;
    this.binderSel = 0;
    this.binderDetail = false;
    this.binderCache = undefined;
    this.drawBinder(); // まず「読み込み中」枠を描く
    try {
      const [cards, mine] = await Promise.all([fetchCards(), fetchMyCards()]);
      if (this.binderLayer !== layer) return; // 閉じられた
      this.binderCache = { cards, owned: new Map(mine.map((m) => [m.card_id, m.count])) };
      this.drawBinder();
    } catch (e: any) {
      if (this.binderLayer === layer) this.drawBinder(`読み込み失敗: ${e?.message ?? e}`);
    }
  }

  // 台帳の中身を（キャッシュから）描き直す。詳細表示中は detail を描く。
  private drawBinder(errorMsg?: string) {
    const layer = this.binderLayer;
    if (!layer) return;
    layer.removeAll(true); // 既存の子（と回転tween）を破棄して描き直す
    if (this.binderDetail && this.binderCache && !errorMsg) { this.drawBinderDetail(); return; }
    const { width, height } = this.scale;
    const cx = width / 2;

    layer.add(this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.85).setInteractive());
    layer.add(this.add.text(cx, 26, "霊宝台帳", { fontSize: "26px", color: "#e8c87e", fontStyle: "bold" }).setOrigin(0.5));
    const info = this.add.text(cx, 58, "読み込み中…", { fontSize: "14px", color: "#9b93b0" }).setOrigin(0.5);
    layer.add(info);
    const close = this.add.text(width - 30, 24, "✕ 閉じる (B)", { fontSize: "16px", color: "#cccccc" }).setOrigin(1, 0);
    layer.add(close);

    const tabs: Array<{ key: "common" | "rare" | "legend"; label: string; num: string }> = [
      { key: "common", label: "普通", num: "1" }, { key: "rare", label: "希少", num: "2" }, { key: "legend", label: "秘宝", num: "3" },
    ];
    tabs.forEach((t, i) => {
      const on = this.binderTab === t.key;
      layer.add(this.add.text(cx - 130 + i * 130, 92, `${t.num}: ${t.label}`, {
        fontSize: "18px", fontStyle: "bold",
        color: on ? "#15101f" : RARITY_META[t.key].colorStr,
        backgroundColor: on ? RARITY_META[t.key].colorStr : "#1c1530",
        padding: { x: 14, y: 6 } as any,
      }).setOrigin(0.5));
    });
    layer.add(this.add.text(cx, 120, "1/2/3 タブ　・　矢印/WASD 選択　・　B 閉じる", { fontSize: "12px", color: "#6a6285" }).setOrigin(0.5));

    if (errorMsg) { info.setText(errorMsg).setColor("#e08a8a"); return; }
    const cache = this.binderCache;
    if (!cache) return; // 読み込み中

    const { cards, owned } = cache;
    const rar: Record<string, { have: number; total: number }> = {
      common: { have: 0, total: 0 }, rare: { have: 0, total: 0 }, legend: { have: 0, total: 0 },
    };
    cards.forEach((c) => { rar[c.rarity].total++; if ((owned.get(c.id) ?? 0) > 0) rar[c.rarity].have++; });
    const collected = rar.common.have + rar.rare.have + rar.legend.have;
    info.setText(`蒐集 ${collected} / ${cards.length}　・　普通 ${rar.common.have}/${rar.common.total}　希少 ${rar.rare.have}/${rar.rare.total}　秘宝 ${rar.legend.have}/${rar.legend.total}`);

    const list = cards.filter((c) => c.rarity === this.binderTab);
    this.binderSel = Math.max(0, Math.min(this.binderSel, list.length - 1));
    const cols = MmoGameScene.BINDER_COLS, cellW = 104, cellH = 138, gapX = 10, gapY = 16;
    const totalW = cols * cellW + (cols - 1) * gapX;
    const startX = (width - totalW) / 2 + cellW / 2;
    const startY = 188;
    list.forEach((c, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = startX + col * (cellW + gapX);
      const y = startY + row * (cellH + gapY);
      const count = owned.get(c.id) ?? 0;
      const isSel = i === this.binderSel;
      const card = this.makeRelicCard({ cardId: c.id, name: c.name, rarity: c.rarity, w: cellW, h: cellH, owned: count > 0, count, selected: isSel });
      card.setPosition(x, y);
      if (isSel) card.setScale(1.04);
      layer.add(card);
    });
    layer.add(this.add.text(cx, height - 30, "Enter で選択中の霊宝を詳細表示", { fontSize: "13px", color: "#7ee787" }).setOrigin(0.5));
  }

  // 詳細表示：左に拡大した霊宝（水平＝縦軸まわりに反時計回転、90度で縦線）、右に説明文。
  private drawBinderDetail() {
    const layer = this.binderLayer!;
    const cache = this.binderCache!;
    const { width, height } = this.scale;
    layer.add(this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.9).setInteractive());

    const list = cache.cards.filter((c) => c.rarity === this.binderTab);
    this.binderSel = Math.max(0, Math.min(this.binderSel, list.length - 1));
    const c = list[this.binderSel];
    if (!c) return;
    const count = cache.owned.get(c.id) ?? 0;
    const has = count > 0;
    const meta = RARITY_META[c.rarity];
    const cy = height / 2 - 10;
    const leftX = width * 0.28;

    // 左：大きな霊宝カード。縦軸まわりの回転を scaleX=cos で擬似（90度で縦線）
    const card = this.makeRelicCard({ cardId: c.id, name: c.name, rarity: c.rarity, w: 300, h: 410, owned: has, count });
    card.setPosition(leftX, cy);
    layer.add(card);
    const spin = { t: 0 };
    this.tweens.add({
      targets: spin, t: 1, duration: 12000, repeat: -1, ease: "Linear",
      onUpdate: () => { if (card.active) card.scaleX = Math.cos(spin.t * Math.PI * 2); },
    });
    layer.add(this.add.text(leftX, cy + 230, meta.label, { fontSize: "20px", color: meta.colorStr, fontStyle: "bold" }).setOrigin(0.5));

    // 右：説明
    const rx = width * 0.55;
    layer.add(this.add.text(rx, cy - 130, has ? c.name : "？？？", { fontSize: "36px", color: has ? "#ece7f5" : "#6a6285", fontStyle: "bold" }).setOrigin(0, 0.5));
    layer.add(this.add.text(rx, cy - 78, `レアリティ：${meta.label}`, { fontSize: "18px", color: meta.colorStr }).setOrigin(0, 0.5));
    const desc = has ? (CARD_DESC[c.id] ?? "失われた霊宝のひとつ。") : "未発見の霊宝。集めて解き明かそう。";
    layer.add(this.add.text(rx, cy - 40, desc, { fontSize: "19px", color: "#cccccc", wordWrap: { width: width * 0.4 }, lineSpacing: 8 }).setOrigin(0, 0));
    layer.add(this.add.text(rx, cy + 60, `世界総数：${c.world_supply}\n残り在庫：${c.world_reserve}\n所持：${count}`, { fontSize: "16px", color: "#9b93b0", lineSpacing: 8 }).setOrigin(0, 0));

    layer.add(this.add.text(width / 2, height - 30, "← → / WASD で隣の霊宝　・　ESC または Enter で一覧へ", { fontSize: "13px", color: "#6a6285" }).setOrigin(0.5));
  }

  update(_t: number, dtMs: number) {
    const state: any = this.room.state;
    const me: any = state.players.get(this.myId);

    // 入力送信（台帳/ステータス/チャット中は移動しない）
    const ov = this.overlayOpen() || this.chatOpen;
    const up = !ov && (this.keys.W.isDown || this.keys.UP.isDown);
    const down = !ov && (this.keys.S.isDown || this.keys.DOWN.isDown);
    const left = !ov && (this.keys.A.isDown || this.keys.LEFT.isDown);
    const right = !ov && (this.keys.D.isDown || this.keys.RIGHT.isDown);
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

    // モンスター描画（絵文字。位置だけ補間）
    state.mobs.forEach((m: any, id: string) => {
      const v = this.mobs.get(id);
      if (!v) return;
      const cx = Phaser.Math.Linear(v.container.x, m.x, 0.3);
      const cy = Phaser.Math.Linear(v.container.y, m.y, 0.3);
      v.container.setPosition(cx, cy);
      v.container.setDepth(cy);
    });

    // HUD
    if (me) {
      this.hudText.setText(`Lv.${me.level}   ${me.name}`);
      this.hpBarFg.width = 220 * Math.max(0, me.hp / me.maxHp);
      this.expBarFg.width = 220 * Math.max(0, Math.min(1, me.exp / me.nextExp));
      const nowMs = Date.now();
      const bf: string[] = [`🪙 ${me.gold ?? 0}`];
      if (nowMs < (me.buffAtkUntil ?? 0)) bf.push(`💪${Math.ceil((me.buffAtkUntil - nowMs) / 1000)}s`);
      if (nowMs < (me.buffSpeedUntil ?? 0)) bf.push(`👟${Math.ceil((me.buffSpeedUntil - nowMs) / 1000)}s`);
      this.hudExtra.setText(bf.join("   "));
      this.deadText.setVisible(me.dead);
      if (me.dead) {
        const sec = Math.max(0, (me.respawnAt - Date.now()) / 1000);
        this.deadText.setText(`やられた！\n復活まで ${sec.toFixed(1)}秒`);
      }
    }

    // ゲート／ショップ／宝箱 近接判定（近づくと [E] プロンプト）
    if (me && !this.overlayOpen() && !me.dead) {
      let near: { toArea: string; label: string } | null = null;
      for (const g of this.gates) {
        if (Math.hypot(me.x - g.x, me.y - g.y) <= 80) { near = { toArea: g.toArea, label: g.label }; break; }
      }
      this.nearGate = near;
      this.nearShop = !near && !!this.shopPos && Math.hypot(me.x - this.shopPos.x, me.y - this.shopPos.y) <= 90;
      this.nearTrade = !near && !this.nearShop && !!this.tradePos && Math.hypot(me.x - this.tradePos.x, me.y - this.tradePos.y) <= 90;
      this.nearTreasure = null;
      if (!near && !this.nearShop && !this.nearTrade) {
        let bestD = 44;
        this.treasureViews.forEach((c, id) => {
          const d = Math.hypot(me.x - c.x, me.y - c.y);
          if (d <= bestD) { bestD = d; this.nearTreasure = id; }
        });
      }
      if (near) this.gatePrompt?.setText(`[E] ${near.label}`).setVisible(true);
      else if (this.nearShop) this.gatePrompt?.setText("[E] ショップ").setVisible(true);
      else if (this.nearTrade) this.gatePrompt?.setText("[E] 取引所").setVisible(true);
      else if (this.nearTreasure) this.gatePrompt?.setText("[E] 宝箱を開ける").setVisible(true);
      else this.gatePrompt?.setVisible(false);
    } else {
      this.nearGate = null;
      this.nearShop = false;
      this.nearTrade = false;
      this.nearTreasure = null;
      this.gatePrompt?.setVisible(false);
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
    // 俊足の薬バフ中はサーバーと同じく速度を上げる（予測一致＝巻き戻り防止）
    const spd = PLAYER_SPEED * (Date.now() < (entity.buffSpeedUntil ?? 0) ? SPEED_BUFF_MUL : 1);
    // 軸分離（サーバーの moveEntity と同じ順序）で障害物に当てる
    let nx = px, ny = py;
    if (dx !== 0) nx = this.collideAxis(px + dx * spd * dt, py, dx > 0, true);
    if (dy !== 0) ny = this.collideAxis(nx, py + dy * spd * dt, dy > 0, false);
    nx = Phaser.Math.Clamp(nx, ENTITY_RADIUS, mapW - ENTITY_RADIUS);
    ny = Phaser.Math.Clamp(ny, ENTITY_RADIUS, mapH - ENTITY_RADIUS);
    const drift = Math.hypot(entity.x - nx, entity.y - ny);
    const corr = drift > 50 ? 0.3 : 0.04;
    nx = Phaser.Math.Linear(nx, entity.x, corr);
    ny = Phaser.Math.Linear(ny, entity.y, corr);
    return { x: nx, y: ny };
  }

  // 移動先(x,y)を障害物(半径ENTITY_RADIUS膨張)から押し戻す。サーバーと同じロジック
  private collideAxis(x: number, y: number, positive: boolean, isX: boolean): number {
    const R = ENTITY_RADIUS;
    for (const o of this.obstacles) {
      const x0 = o.x - R, y0 = o.y - R, x1 = o.x + o.w + R, y1 = o.y + o.h + R;
      if (x > x0 && x < x1 && y > y0 && y < y1) {
        if (isX) x = positive ? x0 : x1;
        else y = positive ? y0 : y1;
      }
    }
    return isX ? x : y;
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
    const style = MOB_STYLE[m.kind] ?? MOB_STYLE.grunt;
    const sizePx = Math.round(116 * style.scale); // 基準サイズ（種別ごとの比率は MOB_STYLE.scale）
    const cyOff = -sizePx * 0.4;
    const container = this.add.container(m.x, m.y);
    const shadow = this.add.ellipse(0, 4, 24 * style.scale, 8 * style.scale, 0x000000, 0.4);

    // 本体：専用イラストがあればそれ、無ければ色付きの塊（目つき）で代用
    const body = this.add.container(0, cyOff);
    const texKey = mobTexKey(m.kind);
    if (this.textures.exists(texKey)) {
      const sp = this.add.sprite(0, 0, texKey).setOrigin(0.5);
      sp.setScale(sizePx / Math.max(sp.width, sp.height));
      body.add(sp);
    } else {
      const r = sizePx * 0.5;
      const blob = this.add.ellipse(0, 0, r * 2, r * 1.75, style.tint, 1).setStrokeStyle(3, 0x20202c);
      const eyeL = this.add.circle(-r * 0.34, -r * 0.18, r * 0.16, 0xffffff);
      const eyeR = this.add.circle(r * 0.34, -r * 0.18, r * 0.16, 0xffffff);
      const pupL = this.add.circle(-r * 0.34, -r * 0.14, r * 0.07, 0x111111);
      const pupR = this.add.circle(r * 0.34, -r * 0.14, r * 0.07, 0x111111);
      body.add([blob, eyeL, eyeR, pupL, pupR]);
    }

    const barY = cyOff - sizePx * 0.6 - 6;
    const hpBg = this.add.rectangle(0, barY, 30, 4, 0x000000, 0.6);
    const hpFg = this.add.rectangle(-15, barY, 30, 4, 0xff7777).setOrigin(0, 0.5);
    container.add([shadow, body, hpBg, hpFg]);
    if (style.label) {
      container.add(this.add.text(0, barY - 14, style.label, {
        fontSize: "13px", color: "#e0b3ff", fontStyle: "bold", stroke: "#000", strokeThickness: 3,
      }).setOrigin(0.5));
    }
    this.worldLayer.add(container);
    this.mobs.set(id, { container, shadow, body, hpBg, hpFg });
    this.updateMobHpBar(id, m);
    this.tweens.add({ targets: body, y: cyOff - 4, duration: 800 + Math.random() * 400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
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
    if (isPlayer) {
      const v = this.players.get(id);
      if (!v) return;
      const sprite = v.sprite;
      sprite.setTintFill(0xffffff);
      this.time.delayedCall(110, () => { if (sprite.active) sprite.clearTint(); });
      this.spawnStarBurst(v.container.x, v.container.y);
      sfxHitPlayer(); this.cameras.main.shake(80, 0.004);
    } else {
      const v = this.mobs.get(id);
      if (!v) return;
      this.tweens.add({ targets: v.body, scaleX: 1.3, scaleY: 1.3, duration: 70, yoyo: true });
      this.spawnStarBurst(v.container.x, v.container.y);
      sfxHitNpc();
    }
  }

  private spawnStarBurst(x: number, y: number) {
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.4;
      const star = this.add.star(x, y, 4, 3, 6, 0xffe066).setDepth(6000);
      this.worldLayer.add(star);
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
    this.worldLayer.add(rect);
    this.tweens.add({ targets: rect, alpha: 0, duration: 160, onComplete: () => rect.destroy() });
  }

  private popDamage(id: string, dmg: number) {
    const v = this.players.get(id);
    if (!v) return;
    const t = this.add.text(v.container.x, v.container.y - CHAR_DISPLAY_H, `-${Math.round(dmg)}`, {
      fontSize: "20px", color: "#ff7878", fontStyle: "bold", stroke: "#000", strokeThickness: 4,
    }).setOrigin(0.5).setDepth(6500);
    this.worldLayer.add(t);
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
    this.worldLayer.add(t);
    this.tweens.add({
      targets: t, y: t.y - 40, alpha: { from: 1, to: 0 }, scale: { from: 1.4, to: 1 },
      duration: 900, ease: "Quad.easeOut", onComplete: () => t.destroy(),
    });
  }
}
