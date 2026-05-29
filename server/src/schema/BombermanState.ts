import { Schema, MapSchema, type } from "@colyseus/schema";

// 破壊可能ブロック。key は `${col}_${row}`。
export class SoftBlock extends Schema {
  @type("number") col: number = 0;
  @type("number") row: number = 0;
}

export class Bomb extends Schema {
  @type("string") id!: string;
  @type("string") owner: string = "";
  @type("number") col: number = 0;
  @type("number") row: number = 0;
  @type("number") explodesAt: number = 0; // Date.now() ベース
  @type("number") range: number = 1;
}

export class Flame extends Schema {
  @type("string") id!: string;
  @type("number") col: number = 0;
  @type("number") row: number = 0;
  @type("number") until: number = 0; // 消滅時刻 Date.now() ベース
}

export class Item extends Schema {
  @type("string") id!: string;
  @type("number") col: number = 0;
  @type("number") row: number = 0;
  @type("string") kind: string = "bomb"; // bomb | fire | speed
}

export class BPlayer extends Schema {
  @type("string") name: string = "";
  @type("string") entityId: string = "";
  @type("number") col: number = 0;
  @type("number") row: number = 0;
  @type("number") x: number = 0; // 補間用の連続座標（px）
  @type("number") y: number = 0;
  @type("number") dir: number = 0; // 0:下 1:左 2:右 3:上（描画の向き参考用）
  @type("boolean") alive: boolean = true;
  @type("number") maxBombs: number = 1;
  @type("number") activeBombs: number = 0;
  @type("number") range: number = 1;
  @type("number") speed: number = 1;
  @type("number") score: number = 0; // 勝利数
  @type("boolean") ready: boolean = false;
  @type("number") colorIndex: number = 0;
}

export class BombermanState extends Schema {
  @type({ map: BPlayer }) players = new MapSchema<BPlayer>();
  @type({ map: Bomb }) bombs = new MapSchema<Bomb>();
  @type({ map: Flame }) flames = new MapSchema<Flame>();
  @type({ map: Item }) items = new MapSchema<Item>();
  @type({ map: SoftBlock }) softBlocks = new MapSchema<SoftBlock>();
  @type("number") cols: number = 13;
  @type("number") rows: number = 11;
  @type("number") tileSize: number = 48;
  @type("string") phase: string = "lobby"; // lobby | playing | ended
  @type("number") timeLeft: number = 0;
  @type("number") roundDuration: number = 120;
  @type("string") code: string = "";
}
