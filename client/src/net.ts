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

// --- ルーム名を引数に取る汎用接続関数（各ミニゲームから利用） ---

export async function joinPublicRoom(roomName: string, name: string): Promise<JoinResult> {
  const room = await client.joinOrCreate(roomName, { name, code: "" });
  await waitForInitialState(room);
  return { room };
}

export async function createPrivateRoom(roomName: string, name: string): Promise<JoinResult> {
  const code = generateCode();
  const room = await client.create(roomName, { name, code });
  await waitForInitialState(room);
  return { room };
}

export async function joinRoomByCode(roomName: string, name: string, code: string): Promise<JoinResult> {
  const room = await client.join(roomName, { name, code });
  await waitForInitialState(room);
  return { room };
}

// --- 既存 Unspottable 呼び出しの互換ラッパ ---

export const joinPublic = (name: string) => joinPublicRoom("unspottable", name);
export const createPrivate = (name: string) => createPrivateRoom("unspottable", name);
export const joinByCode = (name: string, code: string) => joinRoomByCode("unspottable", name, code);

/**
 * 初期stateが届くまで待つ。全ミニゲーム共通の判定として
 * 「state が定義され、phase と players を持つ」ことを使う。
 */
function waitForInitialState(room: Room): Promise<void> {
  return new Promise((resolve) => {
    const ready = () => {
      const s: any = room.state;
      return !!s && s.phase !== undefined && s.players !== undefined;
    };
    if (ready()) { resolve(); return; }
    const interval = setInterval(() => {
      if (ready()) { clearInterval(interval); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(interval); resolve(); }, 8000);
  });
}

function generateCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}
