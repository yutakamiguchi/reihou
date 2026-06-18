// プレイヤー名の保持。
// - 未ログイン/ゲスト: 端末ごとの localStorage に保存（従来どおり）。
// - メール本登録アカウント: アカウントの表示名(profiles.display_name)を「正」とし、
//   端末をまたいで同じ名前を使えるようにする（PCで決めた名前がスマホでも出る）。

import { getUser, getMyProfile, setDisplayName } from "../auth";

const KEY = "playerName";
const DEFAULT_DISPLAY_NAME = "Player"; // profiles の既定値（未設定とみなす）

export function loadPlayerName(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved.trim()) return saved.slice(0, 16);
  } catch { /* localStorage 不可環境は無視 */ }
  return "Player" + Math.floor(Math.random() * 1000);
}

export function savePlayerName(name: string) {
  const n = name.trim().slice(0, 16);
  if (!n) return;
  try { localStorage.setItem(KEY, n); } catch { /* 無視 */ }
}

/**
 * 本登録アカウントなら、その表示名を返す（端末横断で共通の名前）。
 * 未ログイン・ゲスト・既定名のままなどで「アカウント側に名前が無い」場合は null。
 * 呼び出し側は null のとき localStorage 名（loadPlayerName）にフォールバックする。
 */
export async function resolveAccountName(): Promise<string | null> {
  try {
    const user = await getUser();
    if (!user || user.is_anonymous) return null; // ゲストは端末ローカル運用
    const p = await getMyProfile();
    const name = p?.display_name?.trim();
    if (name && name !== DEFAULT_DISPLAY_NAME) return name.slice(0, 16);
    return null;
  } catch {
    return null;
  }
}

/**
 * 名前を保存する。端末ローカルに加え、本登録アカウントなら表示名へも同期し、
 * 次回別端末でログインしたときに同じ名前が出るようにする。
 */
export function persistPlayerName(name: string) {
  savePlayerName(name);
  void syncAccountName(name);
}

async function syncAccountName(name: string) {
  const n = name.trim().slice(0, 16);
  if (!n) return;
  try {
    const user = await getUser();
    if (!user || user.is_anonymous) return; // ゲストはアカウント側へ同期しない
    await setDisplayName(n);
  } catch { /* 同期失敗は致命的でないため握りつぶす */ }
}
