# Supabase（霊宝コレクション バックエンド）

霊宝コレクション（仮）の真実源。スキーマ/RLS/RPC の定義一式。
設計の出典：[../docs/spirit-cards/DATA_MODEL.md](../docs/spirit-cards/DATA_MODEL.md)

## 構成

- `migrations/0001_init.sql` — テーブル・RLS・RPC（`explore_pull` / `propose_trade` / `accept_trade` / `cancel_trade` / `grant_card` / `check_conservation`）
- `seed.sql` — 季節「原初」＋カード16種

## 適用方法

### 方法A：SQL Editor（最速・お試し）

Supabaseダッシュボード → **SQL Editor** に、次の順で貼って実行：
1. `migrations/0001_init.sql` の中身
2. `seed.sql` の中身

### 方法B：Supabase CLI（推奨・履歴管理）

```bash
# リポジトリ直下で
npm i -D supabase            # 未導入なら
npx supabase login           # ブラウザ認証
npx supabase link --project-ref <PROJECT_REF>   # Settings→General の Reference ID
npx supabase db push         # migrations/ を反映
# seed は db reset 時に自動適用。リモートへ流すなら SQL Editor で seed.sql を実行
```

## 秘宝(legend)のシード

`grant_card(card_id, profile_id)` は **service_role 専用**（クライアント不可）。
プレイヤーが登録された後、各 legend(id 14/15/16) を対象プレイヤーへ3枚ずつ付与する。
MVPは手動投入（① 方式）。SQL Editor で service_role 実行：

```sql
select public.grant_card(14, '<profile_uuid>');  -- 不死鳥の心臓を1枚
```

## 動作確認（保存則）

```sql
select * from public.check_conservation();   -- 全行 ok=true なら INV-1 健全
```

## キー（.env・コミット禁止）

- `server/.env`：`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`（秘密）
- `client/.env`：`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `service_role` は全権限。クライアントには絶対に置かない。
