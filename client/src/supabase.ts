// Supabase クライアント（ブラウザ側・公開キーのみ）。
// 在庫/所有/取引の変更は必ず RPC 経由（rpc()）。テーブル直書きはしない/できない（RLS）。
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。client/.env を確認してください。"
  );
}

export const supabase = createClient(url ?? "", anonKey ?? "", {
  auth: {
    persistSession: true,    // ブラウザにセッション保持（再訪でログイン維持）
    autoRefreshToken: true,
  },
});

export const isSupabaseConfigured = Boolean(url && anonKey);
