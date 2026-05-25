# Unspottable Web

Unspottableをベースにした最大4人対戦のWebゲーム。

## 構成

- `client/` — Phaser 3 + TypeScript + Vite
- `server/` — Node.js + Colyseus（状態同期サーバー）

## 開発

```bash
# サーバー起動
cd server && npm install && npm run dev

# 別ターミナルでクライアント起動
cd client && npm install && npm run dev
```

クライアントは http://localhost:5173、サーバーは ws://localhost:2567 で起動。

## ゲーム仕様（MVP）

- 1マップ・90秒1ラウンド
- NPC約20体が群衆としてランダムウォーク（プレイヤーと同じ外見）
- 操作: 移動（WASD/矢印）+ 叩く（Space）
- 他プレイヤーを叩く: +1点、NPCを叩く: -1点、被弾: 短時間スタン
- 最高得点が勝利
