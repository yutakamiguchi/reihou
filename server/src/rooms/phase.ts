import { MapSchema } from "@colyseus/schema";

// ラウンド開始条件: 2人以上いて全員 ready。
// 各ミニゲームの Player スキーマは ready:boolean を持つ前提。
export function canStartRound(players: MapSchema<{ ready: boolean }>): boolean {
  const arr = Array.from(players.values());
  if (arr.length < 2) return false;
  return arr.every(p => p.ready);
}
