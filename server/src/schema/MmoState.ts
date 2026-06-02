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
  @type("number") level: number = 1;
  @type("number") exp: number = 0;
  @type("number") nextExp: number = 20;
  @type("number") attackUntil: number = 0;
  @type("boolean") dead: boolean = false;
  @type("number") respawnAt: number = 0;
  @type("number") colorIndex: number = 0;
  @type("number") kills: number = 0;     // 累計討伐数（永続）
  @type("number") playSec: number = 0;   // 累計プレイ時間(秒、永続)
}

// モンスター。
export class Mob extends Schema {
  @type("string") id: string = "";
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

export class MmoState extends Schema {
  @type({ map: MmoPlayer }) players = new MapSchema<MmoPlayer>();
  @type({ map: Mob }) mobs = new MapSchema<Mob>();
  @type({ map: Relic }) relics = new MapSchema<Relic>();
  @type("string") phase: string = "world"; // 固定（waitForInitialState 通過用）
  @type("number") mapWidth: number = 2560;
  @type("number") mapHeight: number = 1440;
}
