import { Client, Room } from "colyseus.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "ws://localhost:2567";

export const client = new Client(SERVER_URL);

export interface JoinResult { room: Room; }

/**
 * 無料ホスティングのコールドスタート対策。
 * /health に200が返るまで /または最大90秒/ 待つ。
 */
export async function warmUp(onProgress?: (sec: number) => void): Promise<void> {
  const httpUrl = SERVER_URL.replace(/^ws/, "http") + "/health";
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(httpUrl, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return;
    } catch { /* リトライ */ }
    const elapsed = (Date.now() - startedAt) / 1000;
    onProgress?.(elapsed);
    if (elapsed > 90) throw new Error("サーバーの起動に失敗しました");
    await new Promise(r => setTimeout(r, attempt < 3 ? 1000 : 2000));
  }
}

export async function joinPublic(name: string): Promise<JoinResult> {
  const room = await client.joinOrCreate("game", { name, code: "" });
  return { room };
}

export async function createPrivate(name: string): Promise<JoinResult> {
  const code = generateCode();
  const room = await client.create("game", { name, code });
  return { room };
}

export async function joinByCode(name: string, code: string): Promise<JoinResult> {
  const room = await client.join("game", { name, code });
  return { room };
}

function generateCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}
