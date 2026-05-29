import "./polyfills";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import { createServer } from "http";
import { GameRoom } from "./rooms/GameRoom";
import { BombermanRoom } from "./rooms/bomberman/BombermanRoom";

const port = Number(process.env.PORT) || 2567;
const app = express();
// /health はクライアントのウォームアップから直接叩かれるので CORS を許可
app.get("/health", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ ok: true });
});

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("unspottable", GameRoom).filterBy(["code"]);
gameServer.define("bomberman", BombermanRoom).filterBy(["code"]);

gameServer.listen(port).then(() => {
  console.log(`[server] listening on ws://localhost:${port}`);
});
