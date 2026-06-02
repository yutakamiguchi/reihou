// Supabase 管理クライアント（サーバー側・service_role / secret キー）。
// RLS を貫通する全権限。faucet(grant_card) や権威操作に使う。クライアントには絶対に出さない。
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.warn(
    "[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。server/.env を確認してください。"
  );
}

export const isSupabaseConfigured = Boolean(url && serviceKey);

export const supabaseAdmin = createClient(url ?? "", serviceKey ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 秘宝シード等：reserve から1枚をプレイヤーへ付与（service_role 専用RPC）。 */
export async function grantCard(cardId: number, profileId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("grant_card", { p_card: cardId, p_profile: profileId });
  if (error) throw error;
}
