// 霊宝コレクションのデータアクセス層（client）。
// すべて RPC / RLS 経由。テーブル直書きはしない（在庫・所有・取引はサーバー権威）。
// 設計: docs/spirit-cards/DATA_MODEL.md
import { supabase } from "./supabase";

export type Rarity = "common" | "rare" | "legend";

export interface Card {
  id: number;
  season_id: number;
  name: string;
  rarity: Rarity;
  world_supply: number;
  world_reserve: number;
}

export interface UserCard {
  card_id: number;
  count: number;
  locked: number;
}

export interface TradeItemInput {
  card_id: number;
  qty: number;
}

const SEASON = 1; // 季節「原初」

/** カードマスタ（公開read）。 */
export async function fetchCards(seasonId = SEASON): Promise<Card[]> {
  const { data, error } = await supabase
    .from("cards")
    .select("id, season_id, name, rarity, world_supply, world_reserve")
    .eq("season_id", seasonId)
    .order("id");
  if (error) throw error;
  return (data ?? []) as Card[];
}

/** 自分の所有（RLSで本人分のみ）。 */
export async function fetchMyCards(): Promise<UserCard[]> {
  const { data, error } = await supabase
    .from("user_cards")
    .select("card_id, count, locked");
  if (error) throw error;
  return (data ?? []) as UserCard[];
}

/** 探索：在庫から重み付きで1枚。返り値は card_id、在庫切れ/競合は null。 */
export async function explorePull(seasonId = SEASON): Promise<number | null> {
  const { data, error } = await supabase.rpc("explore_pull", { p_season: seasonId });
  if (error) throw error;
  return (data as number | null) ?? null;
}

/** 取引提案。offer をエスクローし trade_id を返す。 */
export async function proposeTrade(
  offer: TradeItemInput[],
  request: TradeItemInput[],
  responderId?: string
): Promise<number> {
  const { data, error } = await supabase.rpc("propose_trade", {
    p_offer: offer,
    p_request: request,
    p_responder: responderId ?? null,
  });
  if (error) throw error;
  return data as number;
}

/** 取引成立（原子的スワップ）。'ok' か失敗理由文字列を返す。 */
export async function acceptTrade(tradeId: number): Promise<string> {
  const { data, error } = await supabase.rpc("accept_trade", { p_trade: tradeId });
  if (error) throw error;
  return data as string;
}

/** 取引取消（提案者本人）。 */
export async function cancelTrade(tradeId: number): Promise<string> {
  const { data, error } = await supabase.rpc("cancel_trade", { p_trade: tradeId });
  if (error) throw error;
  return data as string;
}

/** 公開中の取引提案一覧（status='open'）。 */
export async function fetchOpenTrades() {
  const { data, error } = await supabase
    .from("trades")
    .select("id, proposer_id, responder_id, status, created_at, trade_items(side, card_id, qty)")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** デバッグ：保存則チェック（全行 ok=true なら健全）。 */
export async function checkConservation() {
  const { data, error } = await supabase.rpc("check_conservation");
  if (error) throw error;
  return data as { card_id: number; world_supply: number; world_reserve: number; owned_total: number; ok: boolean }[];
}
