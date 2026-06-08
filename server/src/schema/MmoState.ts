import { Schema, MapSchema, type } from "@colyseus/schema";

// MMO（共有ワールド）のプレイヤー。entities/players は分けず1マップに統合。
export class MmoPlayer extends Schema {
  @type("string") id: string = "";   // = sessionId
  @type("string") name: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") vx: number = 0;
  @type("number") vy: number = 0;
  @type("number") dir: number = 0;
  @type("number") hp: number = 100;
  @type("number") maxHp: number = 100;
  @type("number") atk: number = 10;
  @type("number") def: number = 1;    // 防御力（被ダメ軽減。= 1 + bonusDef）
  @type("number") level: number = 1;
  // 巻物による恒久ボーナス（永続。atk/maxHp/def はこれ＋レベル由来から再計算）
  @type("number") bonusAtk: number = 0;
  @type("number") bonusDef: number = 0;
  @type("number") bonusMaxHp: number = 0;
  @type("number") exp: number = 0;
  @type("number") nextExp: number = 20;
  @type("number") attackUntil: number = 0;
  @type("boolean") dead: boolean = false;
  @type("number") respawnAt: number = 0;
  @type("number") colorIndex: number = 0;
  @type("number") kills: number = 0;     // 累計討伐数（永続）
  @type("number") playSec: number = 0;   // 累計プレイ時間(秒、永続)
  @type("number") gold: number = 0;      // 所持ゴールド（永続）
  @type({ map: "number" }) items = new MapSchema<number>(); // 所持アイテム（itemId→個数、永続）
  @type({ map: "number" }) gear = new MapSchema<number>();  // 未装備の所持装備（equipId→個数、永続）
  @type({ map: "string" }) equip = new MapSchema<string>(); // 装備中（slot→equipId、永続）
  @type("number") buffAtkUntil: number = 0;   // 攻撃バフの有効期限(Date.now)
  @type("number") buffSpeedUntil: number = 0; // 速度バフの有効期限(Date.now)
}

// モンスター。
export class Mob extends Schema {
  @type("string") id: string = "";
  @type("string") kind: string = "grunt"; // grunt/swift/tank/brute/boss（見た目・強さ）
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") dir: number = 0;
  @type("number") hp: number = 30;
  @type("number") maxHp: number = 30;
  @type("number") atk: number = 5;
  @type("number") level: number = 1;
  @type("boolean") alive: boolean = true;
  @type("number") hitUntil: number = 0; // 被弾フラッシュ用
}

// フィールドに湧く霊宝ノード（拾得で在庫から払い出し）。
export class Relic extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
}

// フィールドに湧く宝箱（[E]で開封 → バフ薬＋ゴールド）。
export class Treasure extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
}

// エリア間を移動するゲート（近づいてEで移動）。
export class Gate extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") toArea: string = ""; // 移動先エリア
  @type("string") label: string = "";  // 表示名
}

export class MmoState extends Schema {
  @type({ map: MmoPlayer }) players = new MapSchema<MmoPlayer>();
  @type({ map: Mob }) mobs = new MapSchema<Mob>();
  @type({ map: Relic }) relics = new MapSchema<Relic>();
  @type({ map: Treasure }) treasures = new MapSchema<Treasure>();
  @type({ map: Gate }) gates = new MapSchema<Gate>();
  @type("string") area: string = "town"; // "town" / "hunt:<ground>:<floor>"
  @type("string") ground: string = "town"; // テーマ用ID: town / grass / cave
  @type("string") groundName: string = "ホームタウン"; // 表示名
  @type("number") floor: number = 0; // 階層（0=町）
  @type("string") phase: string = "world"; // 固定（waitForInitialState 通過用）
  @type("number") mapWidth: number = 2560;
  @type("number") mapHeight: number = 1440;
}
