// Supabase 管理クライアント（サーバー側・service_role / secret キー）。
// RLS を貫通する全権限。faucet(grant_card) や権威操作に使う。クライアントには絶対に出さない。
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseConfigured = Boolean(url && serviceKey);

if (!isSupabaseConfigured) {
  console.warn(
    "[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定。霊宝機能は無効化（他ゲームは通常動作）。"
  );
}

// createClient は空URLだと例外を投げ起動ごとクラッシュするため、未設定時はプレースホルダで生成。
// 実際の利用箇所はすべて isSupabaseConfigured で守られており、プレースホルダは呼ばれない。
export const supabaseAdmin = createClient(
  url || "https://placeholder.supabase.co",
  serviceKey || "placeholder",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** 秘宝シード等：reserve から1枚をプレイヤーへ付与（service_role 専用RPC）。 */
export async function grantCard(cardId: number, profileId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("grant_card", { p_card: cardId, p_profile: profileId });
  if (error) throw error;
}
