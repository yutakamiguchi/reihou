// ボンバーマンのマッププリセット。
// tiles は row-major のグリッド文字列（長さ = COLS*ROWS）。charAt(row*COLS + col) で参照。
//   '#' = ハードウォール / '.' = 床 / '^v<>' = ベルト(上下左右) / '0'..'9' = ワープ(同じ数字が対で1組)
// 乱数を含まないため、クライアントは tiles 1本からマップを完全復元でき予測が決定論的に一致する。
// ソフトブロックだけは別途サーバーが乱数生成する（generateMap）。

export const MAP_COLS = 13;
export const MAP_ROWS = 11;

export interface BombermanMap {
  id: string;
  name: string;
  tiles: string;
  cols: number;
  rows: number;
}

// 四隅スポーンとその L 字（隣接2セル）。ここにはギミック・壁を置かない。
// BombermanRoom.spawnCellFor / isSpawnSafe と同一定義。
const SPAWN_SAFE: Array<[number, number]> = [
  [1, 1], [2, 1], [1, 2],
  [MAP_COLS - 2, 1], [MAP_COLS - 3, 1], [MAP_COLS - 2, 2],
  [1, MAP_ROWS - 2], [2, MAP_ROWS - 2], [1, MAP_ROWS - 3],
  [MAP_COLS - 2, MAP_ROWS - 2], [MAP_COLS - 3, MAP_ROWS - 2], [MAP_COLS - 2, MAP_ROWS - 3],
];

// 現行の isHardWall（外周 + 偶数×偶数）を完全再現したベースグリッド。
function classicGrid(): string[][] {
  const g: string[][] = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    const row: string[] = [];
    for (let c = 0; c < MAP_COLS; c++) {
      if (c === 0 || r === 0 || c === MAP_COLS - 1 || r === MAP_ROWS - 1) row.push("#");
      else if (c % 2 === 0 && r % 2 === 0) row.push("#");
      else row.push(".");
    }
    g.push(row);
  }
  return g;
}

function toTiles(g: string[][]): string {
  return g.map((row) => row.join("")).join("");
}

type Edit = [number, number, string]; // [col, row, char]

// classic を土台に、指定セルだけギミックへ上書きしたマップを作る。
function fromEdits(edits: Edit[]): string {
  const g = classicGrid();
  for (const [col, row, ch] of edits) {
    // 外周や安全地帯への誤配置は validateMap が後で弾く。ここでは素直に上書き。
    g[row][col] = ch;
  }
  return toTiles(g);
}

// 1行ぶんの水平ライン（内側 col=1..COLS-2）を ch で埋める edits を生成。
function hLine(row: number, ch: string): Edit[] {
  const e: Edit[] = [];
  for (let c = 1; c <= MAP_COLS - 2; c++) e.push([c, row, ch]);
  return e;
}

export const BOMBERMAN_MAPS: BombermanMap[] = [
  {
    id: "classic",
    name: "クラシック",
    tiles: toTiles(classicGrid()),
    cols: MAP_COLS, rows: MAP_ROWS,
  },
  {
    id: "belts",
    name: "ベルト",
    // 上段 row3 を右流れ、下段 row7 を左流れの横ベルト2本。どちらも奇数行で全床。
    tiles: fromEdits([...hLine(3, ">"), ...hLine(7, "<")]),
    cols: MAP_COLS, rows: MAP_ROWS,
  },
  {
    id: "warps",
    name: "ワープ",
    // 左右中央を結ぶワープ '0'、上下を結ぶワープ '1'。いずれも床・安全地帯外。
    tiles: fromEdits([
      [1, 5, "0"], [MAP_COLS - 2, 5, "0"],
      [5, 1, "1"], [7, MAP_ROWS - 2, "1"],
    ]),
    cols: MAP_COLS, rows: MAP_ROWS,
  },
  {
    id: "mixed",
    name: "ミックス",
    // 中央 row5 を右流れベルト＋斜向かいのワープ '0' を1対。
    tiles: fromEdits([
      ...hLine(5, ">"),
      [1, 3, "0"], [MAP_COLS - 2, 7, "0"],
    ]),
    cols: MAP_COLS, rows: MAP_ROWS,
  },
];

// ロビーで選べる ID 一覧（"random" を含む）。クライアントとも共有したい値。
export const MAP_IDS = [...BOMBERMAN_MAPS.map((m) => m.id), "random"];

export function getMapById(id: string): BombermanMap | undefined {
  return BOMBERMAN_MAPS.find((m) => m.id === id);
}

export function pickRandomMap(): BombermanMap {
  // index は呼び出し側で Math.random を使う（このモジュールは純粋に保つ）。
  return BOMBERMAN_MAPS[Math.floor(Math.random() * BOMBERMAN_MAPS.length)];
}

// プリセット定義ミスを起動時に検出する。スポーン安全地帯の床保証とワープ対=2個を検証。
export function validateMap(m: BombermanMap): void {
  const at = (col: number, row: number) => m.tiles.charAt(row * m.cols + col);
  if (m.tiles.length !== m.cols * m.rows) {
    throw new Error(`map ${m.id}: tiles length ${m.tiles.length} != ${m.cols * m.rows}`);
  }
  for (const [c, r] of SPAWN_SAFE) {
    if (at(c, r) !== ".") {
      throw new Error(`map ${m.id}: spawn-safe cell (${c},${r}) must be floor but is '${at(c, r)}'`);
    }
  }
  // ワープ（数字）の個数を集計し、各数字がちょうど2個であることを保証。
  const warpCounts = new Map<string, number>();
  for (const ch of m.tiles) {
    if (ch >= "0" && ch <= "9") warpCounts.set(ch, (warpCounts.get(ch) ?? 0) + 1);
  }
  for (const [ch, n] of warpCounts) {
    if (n !== 2) throw new Error(`map ${m.id}: warp '${ch}' must appear exactly 2 times but appears ${n}`);
  }
}

// モジュール読込時に全プリセットを検証（定義ミスはここで即落とす）。
for (const m of BOMBERMAN_MAPS) validateMap(m);
