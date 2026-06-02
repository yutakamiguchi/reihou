// Supabase クライアント（ブラウザ側・公開キーのみ）。
// 在庫/所有/取引の変更は必ず RPC 経由（rpc()）。テーブル直書きはしない/できない（RLS）。
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured) {
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。client/.env または Netlify の環境変数を確認してください。"
  );
}

// createClient は空URLだと例外を投げるため、未設定時はプレースホルダで生成（霊宝以外は動作）。
export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  anonKey || "placeholder",
  { auth: { persistSession: true, autoRefreshToken: true } },
);
