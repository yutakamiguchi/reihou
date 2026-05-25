import { Client, Room } from "colyseus.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "ws://localhost:2567";

export const client = new Client(SERVER_URL);

export interface JoinResult { room: Room; }

// パブリックルームに参加 / なければ作る（コードなし）
export async function joinPublic(name: string): Promise<JoinResult> {
  const room = await client.joinOrCreate("game", { name, code: "" });
  return { room };
}

// 4桁コードで新規プライベートルームを作る
export async function createPrivate(name: string): Promise<JoinResult> {
  const code = generateCode();
  const room = await client.create("game", { name, code });
  return { room };
}

// コードを指定して既存ルームに参加（無ければエラー）
export async function joinByCode(name: string, code: string): Promise<JoinResult> {
  const room = await client.join("game", { name, code });
  return { room };
}

function generateCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}
