import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

export class Obstacle extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") w: number = 0;
  @type("number") h: number = 0;
  @type("string") kind: string = "pillar"; // pillar | bench | crate
}

export class Entity extends Schema {
  @type("string") id!: string;
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") vx: number = 0;
  @type("number") vy: number = 0;
  @type("number") dir: number = 0;
  @type("boolean") isPlayer: boolean = false;
  @type("boolean") stunned: boolean = false;
  @type("number") stunUntil: number = 0;
  @type("number") attackUntil: number = 0;
  @type("number") colorIndex: number = 0;
}

export class Player extends Schema {
  @type("string") name: string = "";
  @type("string") entityId: string = "";
  @type("number") score: number = 0;
  @type("boolean") ready: boolean = false;
}

export class GameState extends Schema {
  @type({ map: Entity }) entities = new MapSchema<Entity>();
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Obstacle]) obstacles = new ArraySchema<Obstacle>();
  @type("string") phase: string = "lobby"; // lobby | playing | ended
  @type("number") timeLeft: number = 0;
  @type("number") roundDuration: number = 90;
  @type("number") mapWidth: number = 1280;
  @type("number") mapHeight: number = 720;
  @type("string") code: string = ""; // 空文字 = パブリック、それ以外 = 4桁コード
}
