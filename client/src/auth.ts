// ポータル共通アカウントの認証ヘルパー（匿名＋メール）。
// - カジュアル系ゲーム：匿名(ゲスト)で即プレイ可
// - 霊宝：メール登録（または匿名→後でメールに昇格）が前提
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export interface Profile {
  id: string;
  display_name: string;
  created_at: string;
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getUser(): Promise<User | null> {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

/** ゲスト開始：匿名サインイン（Authで Anonymous sign-ins を有効化しておくこと）。 */
export async function signInAsGuest(): Promise<User> {
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.user!;
}

/** 既存セッションが無ければゲストとして開始し、必ず User を返す。 */
export async function ensureSession(): Promise<User> {
  const existing = await getUser();
  if (existing) return existing;
  return signInAsGuest();
}

export async function signUpWithEmail(email: string, password: string, displayName?: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: displayName ? { display_name: displayName } : undefined },
  });
  if (error) throw error;
  return data;
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/** 匿名ユーザーをメール＋パスワードに「昇格」（ゲスト進行を保持したまま本登録）。 */
export async function upgradeGuestToEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.updateUser({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** 自分の profiles 行（新規ユーザーはトリガで自動生成済み）。 */
export async function getMyProfile(): Promise<Profile | null> {
  const user = await getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, created_at")
    .eq("id", user.id)
    .single();
  if (error) {
    console.warn("[auth] profile 取得失敗:", error.message);
    return null;
  }
  return data as Profile;
}

export async function setDisplayName(name: string) {
  const user = await getUser();
  if (!user) throw new Error("not_authenticated");
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: name.slice(0, 16) })
    .eq("id", user.id);
  if (error) throw error;
}

/** 認証状態の変化を購読（ログイン/ログアウトでUI更新するため）。 */
export function onAuthChange(cb: (session: Session | null) => void) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}
