// ボンバーマンのマップ。
// tiles は row-major のグリッド文字列（長さ = COLS*ROWS）。charAt(row*COLS + col) で参照。
//   '#' = ハードウォール / '.' = 床 / '^v<>' = ベルト(上下左右) / '0'..'9' = ワープ(同じ数字が対で1組)
//
// ベルト/ワープの位置はラウンドごとにサーバーが乱数生成する（generateTiles）。
// 生成後の tiles は state 経由でクライアントへ送られ、クライアントはその 1 本から
// 盤面・ベルト・ワープを完全復元するため、移動予測は決定論的に一致する。
// ソフトブロックは tiles とは別に generateMap で乱数配置する。

export const MAP_COLS = 17;
export const MAP_ROWS = 13;

// マップ定義は「どれだけギミックを撒くか」だけを持つ。具体配置は毎回ランダム。
export interface BombermanMap {
  id: string;
  name: string;
  belts: number; // 生成するベルト本数（各3マス以上の独立した直線）
  warps: number; // 生成するワープ対の数
}

export const BOMBERMAN_MAPS: BombermanMap[] = [
  { id: "classic", name: "クラシック", belts: 0, warps: 0 },
  { id: "belts", name: "ベルト", belts: 4, warps: 0 },
  { id: "warps", name: "ワープ", belts: 0, warps: 3 },
  { id: "mixed", name: "ミックス", belts: 2, warps: 2 },
];

export const MAP_IDS = [...BOMBERMAN_MAPS.map((m) => m.id), "random"];

export function getMapById(id: string): BombermanMap | undefined {
  return BOMBERMAN_MAPS.find((m) => m.id === id);
}

export function pickRandomMap(): BombermanMap {
  return BOMBERMAN_MAPS[Math.floor(Math.random() * BOMBERMAN_MAPS.length)];
}

// --- 盤面生成 ---

function isHardWall(col: number, row: number): boolean {
  if (col <= 0 || row <= 0 || col >= MAP_COLS - 1 || row >= MAP_ROWS - 1) return true;
  return col % 2 === 0 && row % 2 === 0;
}

// 四隅スポーンとその L 字（隣接2セル）。ここにはギミックを置かない。
// BombermanRoom.spawnCellFor / isSpawnSafe と同一定義。
function isSpawnSafe(col: number, row: number): boolean {
  const corners: Array<[number, number]> = [
    [1, 1], [2, 1], [1, 2],
    [MAP_COLS - 2, 1], [MAP_COLS - 3, 1], [MAP_COLS - 2, 2],
    [1, MAP_ROWS - 2], [2, MAP_ROWS - 2], [1, MAP_ROWS - 3],
    [MAP_COLS - 2, MAP_ROWS - 2], [MAP_COLS - 3, MAP_ROWS - 2], [MAP_COLS - 2, MAP_ROWS - 3],
  ];
  return corners.some(([c, r]) => c === col && r === row);
}

function baseGrid(): string[][] {
  const g: string[][] = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    const row: string[] = [];
    for (let c = 0; c < MAP_COLS; c++) row.push(isHardWall(c, r) ? "#" : ".");
    g.push(row);
  }
  return g;
}

const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

// ベルトを1本置けるか試す。置けたら true。
// - 水平は奇数行、垂直は奇数列（その列/行は壁が無く全床）に長さ len(3以上)の直線で置く。
// - セグメント本体＋両端の1マス先が床('.')で空き、かつスポーン安全地帯に掛からないことを要求。
//   両端が床なので「運ばれて端に着いたら床へ降りて自由」になり、ループ/往復で詰まらない。
function tryPlaceBelt(g: string[][]): boolean {
  const horizontal = Math.random() < 0.5;
  const len = randInt(3, 6);
  if (horizontal) {
    // 内側の奇数行のみ（スポーン行 row1 / row ROWS-2 は避ける）
    const rowCandidates: number[] = [];
    for (let r = 3; r <= MAP_ROWS - 4; r += 2) rowCandidates.push(r);
    const row = rowCandidates[randInt(0, rowCandidates.length - 1)];
    // 本体 [start, start+len-1]、両端の先 start-1 / start+len も内側に収める
    const start = randInt(2, MAP_COLS - 3 - len + 1);
    if (start < 2 || start + len > MAP_COLS - 2) return false;
    for (let c = start - 1; c <= start + len; c++) {
      if (g[row][c] !== "." || isSpawnSafe(c, row)) return false;
    }
    const ch = Math.random() < 0.5 ? ">" : "<";
    for (let c = start; c < start + len; c++) g[row][c] = ch;
    return true;
  } else {
    const colCandidates: number[] = [];
    for (let c = 3; c <= MAP_COLS - 4; c += 2) colCandidates.push(c);
    const col = colCandidates[randInt(0, colCandidates.length - 1)];
    const start = randInt(2, MAP_ROWS - 3 - len + 1);
    if (start < 2 || start + len > MAP_ROWS - 2) return false;
    for (let r = start - 1; r <= start + len; r++) {
      if (g[r][col] !== "." || isSpawnSafe(col, r)) return false;
    }
    const ch = Math.random() < 0.5 ? "v" : "^";
    for (let r = start; r < start + len; r++) g[r][col] = ch;
    return true;
  }
}

// ワープ対を1組置けるか試す。離れた2つの床セルに同じ数字を置く。
function tryPlaceWarp(g: string[][], digit: string): boolean {
  const pick = (): [number, number] | null => {
    for (let t = 0; t < 40; t++) {
      const c = randInt(1, MAP_COLS - 2);
      const r = randInt(1, MAP_ROWS - 2);
      if (g[r][c] === "." && !isSpawnSafe(c, r)) return [c, r];
    }
    return null;
  };
  const a = pick();
  if (!a) return false;
  let b: [number, number] | null = null;
  for (let t = 0; t < 40; t++) {
    const cand = pick();
    if (!cand) continue;
    const md = Math.abs(cand[0] - a[0]) + Math.abs(cand[1] - a[1]);
    if (md >= 8) { b = cand; break; } // 十分離れている対のみ採用
  }
  if (!b) return false;
  g[a[1]][a[0]] = digit;
  g[b[1]][b[0]] = digit;
  return true;
}

// マップ定義に従いベルト/ワープをランダム配置した tiles 文字列を生成する。
export function generateTiles(def: BombermanMap): string {
  const g = baseGrid();
  for (let i = 0, placed = 0; placed < def.belts && i < 200; i++) {
    if (tryPlaceBelt(g)) placed++;
  }
  for (let i = 0, placed = 0; placed < def.warps && placed < 10 && i < 200; i++) {
    if (tryPlaceWarp(g, String(placed))) placed++;
  }
  return g.map((row) => row.join("")).join("");
}
