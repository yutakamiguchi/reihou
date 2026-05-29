// プレイヤー名を localStorage に保持する。
// 初回や未保存時はランダムなデフォルト名を返す。

const KEY = "playerName";

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
