# 霊宝コレクション（仮）— データモデル v0.1（Supabase / Postgres）

> HANDOFF.md「5. 次の一手 ②」。[GAME_DESIGN.md](GAME_DESIGN.md) の保存則 INV-1〜6 を、
> Supabase(Postgres) のスキーマ・制約・トランザクション(RPC)に落とした設計。
> 確定済み方針（[PLATFORM_AND_SERVER.md](PLATFORM_AND_SERVER.md)）：
> Supabase=真実源 / アカウントはポータル共通 / ログインが基本 / 見た目はゲーム毎スキン(B) / 無課金。
> **本書は設計。実マイグレーション(SQL適用)はSupabaseプロジェクト作成後に行う（未着手）。**

---

## 1. 設計原則（これだけは絶対）

1. **真実源は1つ＝このDB**。Colyseusサーバーもクライアントも、在庫・所有・取引はここを介してのみ変更する。
2. **クライアントは `cards` / `user_cards` / `trades` を直接UPDATEしない**。すべて **RPC関数（SECURITY DEFINER）経由**。RLSで直接書き込みを禁止し、不変条件を関数内に閉じ込める。
3. **カードの増減は2経路だけ**：①探索の払い出し（在庫→所有）②取引のスワップ（所有↔所有）。どちらも**単一トランザクションで原子的**に。
4. **秘宝の発生は季節開始時のシード1回のみ**（唯一の faucet）。運用中に純増する経路は作らない。

---

## 2. ER概観

```
auth.users (Supabase内蔵)
   └─ profiles (★ポータル共通アカウント)
        ├─ game_appearance   (game_key毎の選択中スキン)      ← 見た目B
        ├─ cosmetics_owned   (game_key毎の解放済みスキン)    ← 見た目B
        ├─ game_stats        (game_key毎の戦績/進行 jsonb)
        ├─ user_cards        (霊宝：所有 count / locked)      ← 霊宝
        └─ trades            (霊宝：提案/成立。proposer/responder で2回参照)
                └─ trade_items (取引の中身：offer/request × card × qty)

cards (霊宝マスタ：world_supply / world_reserve)   ← アカウント非依存・全体共通
seasons (季節：どの世界が現役か)
```

---

## 3. テーブル定義（DDLスケッチ）

> 型・制約の意図を示すスケッチ。実適用時に Supabase の RLS/ポリシーと合わせて確定する。

### 3.1 共通アカウント

```sql
-- ポータル共通のゲームアカウント
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 16),
  created_at   timestamptz not null default now()
);

-- 見た目（ゲーム毎スキン B）：選択中の外見
create table game_appearance (
  profile_id uuid not null references profiles(id) on delete cascade,
  game_key   text not null,                 -- 'bomberman' | 'unspottable' | 'mmo' | 'spirit' ...
  appearance jsonb not null default '{}',   -- 例: {"charSet":"red","hat":"none"}
  updated_at timestamptz not null default now(),
  primary key (profile_id, game_key)
);

-- 解放済みスキン（アンロック式にする場合。game_key で分離）
create table cosmetics_owned (
  profile_id  uuid not null references profiles(id) on delete cascade,
  game_key    text not null,
  cosmetic_id text not null,
  acquired_at timestamptz not null default now(),
  primary key (profile_id, game_key, cosmetic_id)
);

-- 戦績/進行（MMOのレベル/EXP等もここに jsonb で。必要なら専用テーブルに分離可）
create table game_stats (
  profile_id uuid not null references profiles(id) on delete cascade,
  game_key   text not null,
  stats      jsonb not null default '{}',   -- 例: {"wins":3,"plays":10} / {"level":5,"exp":40}
  updated_at timestamptz not null default now(),
  primary key (profile_id, game_key)
);
```

### 3.2 霊宝マスタ・季節

```sql
create table seasons (
  id        int primary key,
  name      text not null,           -- '原初'
  active    boolean not null default false,
  opened_at timestamptz
);

create table cards (
  id            int primary key,
  season_id     int not null references seasons(id),
  name          text not null,
  rarity        text not null check (rarity in ('common','rare','legend')),
  world_supply  int  not null check (world_supply >= 0),   -- 固定（季節の世界総数）
  world_reserve int  not null check (world_reserve >= 0),  -- 未発掘の残量（探索で減る）
  -- 探索で出ない秘宝は world_reserve=0 で開始
  check (world_reserve <= world_supply)
);
```

> **核となる恒等式（INV-1）**：任意の `cards.c` について
> `c.world_reserve + (Σ user_cards.count where card_id=c.id) == c.world_supply`。
> reserve列とuser_cardsの和で常に保つ。後述RPCがこの和を壊さない。

### 3.3 霊宝の所有（エスクロー対応）

```sql
create table user_cards (
  profile_id uuid not null references profiles(id) on delete restrict, -- カード保持者は安易に消さない
  card_id    int  not null references cards(id),
  count      int  not null default 0 check (count >= 0),
  locked     int  not null default 0 check (locked >= 0),
  primary key (profile_id, card_id),
  check (locked <= count)        -- INV-6: ロックは所有を超えない
);
-- 自由枚数 free = count - locked （探索消費・新規出品に使えるのは free のみ）
```

### 3.4 取引

```sql
create table trades (
  id           bigint generated always as identity primary key,
  proposer_id  uuid not null references profiles(id),
  responder_id uuid,                          -- 指名取引なら相手、オープン提案なら null
  status       text not null default 'open'
               check (status in ('open','accepted','cancelled','expired')),
  created_at   timestamptz not null default now(),
  settled_at   timestamptz
);

create table trade_items (
  trade_id bigint not null references trades(id) on delete cascade,
  side     text   not null check (side in ('offer','request')), -- offer=提案者が渡す / request=提案者が欲しい
  card_id  int    not null references cards(id),
  qty      int    not null check (qty > 0),
  primary key (trade_id, side, card_id)
);
```

---

## 4. 不変条件 INV → 実装機構の対応

| INV | 内容 | DBでの担保 |
|---|---|---|
| **INV-1 保存則** | `reserve + Σowned == world_supply` | reserve列とuser_cardsを**同一Txでのみ**増減するRPC。reserveを減らした分だけownedを増やす（探索）／ownedの移動のみ（取引・reserve不変） |
| **INV-2 非負** | reserve≥0, count≥0 | `check` 制約（cards.world_reserve, user_cards.count） |
| **INV-3 探索の健全性** | reserve>0 のときのみ発掘 | `update cards set world_reserve=world_reserve-1 where id=$c and world_reserve>0` が**1行更新できた時だけ**ownedを+1（0行=売り切れ） |
| **INV-4 取引の原子性** | 双方の所有を1Txで入替 | RPC `accept_trade` が全UPDATEを1トランザクション内で実行、失敗時ロールバック |
| **INV-5 秘宝の封印** | legendは探索で増えない | `world_reserve=0` で開始＋探索RPCはreserve>0のみ対象（係数0との二重保証） |
| **INV-6 エスクロー整合** | ロック中は他用途に回さない | `user_cards.locked`＋`check(locked<=count)`。探索・新規出品は `free=count-locked` のみ消費 |

---

## 5. 主要トランザクション（RPC関数の擬似コード）

> すべて `security definer`。クライアントは `auth.uid()` の本人としてのみ呼べる（RLS/関数内チェック）。
> Colyseusサーバーは service_role キーで同じ関数を呼ぶ（権威の一本化）。

### 5.1 探索の払い出し `explore_pull(p_profile, p_season)`

```
-- 競合に強い「在庫から1枚引く」。RNGと重み付けは関数内で行い、引いた瞬間に確定させる。
BEGIN
  -- 1) 在庫が残る対象を行ロックして取得（rarity係数: common10/rare3/legend0）
  --    legendは係数0かつreserve=0なので必ず除外される（INV-5）
  pick := weighted_random(
            select id, (case rarity when 'common' then 10 when 'rare' then 3 else 0 end) * world_reserve as w
            from cards where season_id=p_season and world_reserve>0 and rarity<>'legend'
            for update);          -- 行ロックで二重発掘を防ぐ
  if pick is null then return 'sold_out'; end if;

  -- 2) 在庫を1減（INV-2/3：reserve>0条件付き）
  update cards set world_reserve = world_reserve - 1
   where id = pick and world_reserve > 0;
  if not found then return 'sold_out'; end if;   -- 競合で先に売れていたら中断

  -- 3) 所有を1増（同一Tx → INV-1保持）
  insert into user_cards(profile_id, card_id, count) values (p_profile, pick, 1)
   on conflict (profile_id, card_id) do update set count = user_cards.count + 1;

  return pick;
END;  -- ここまで原子的。途中失敗で reserve も owned もロールバック
```

> スタミナ消費（時間回復制・GAME_DESIGN §4）は `game_stats` か専用列で管理し、この関数の前段でチェック。

### 5.2 取引提案 `propose_trade(offer[], request[], responder?)`

```
BEGIN
  -- 提案者の offer 分を free から確保（エスクロー）。INV-6
  for each item in offer:
    update user_cards set locked = locked + item.qty
     where profile_id = auth.uid() and card_id = item.card_id
       and count - locked >= item.qty;          -- free が足りる時だけ
    if not found then RAISE 'insufficient_free'; end if;  -- ロールバック
  insert trades(...) ; insert trade_items(...) ;
  return trade_id;
END;
```

### 5.3 取引成立 `accept_trade(trade_id)`（核：原子的スワップ）

```
BEGIN
  t := select * from trades where id=trade_id and status='open' for update;  -- 取引行ロック
  if not found then return 'unavailable'; end if;
  responder := auth.uid();

  -- responder が request 分を free で持っているか確認
  for each r in request_items(trade_id):
    if free(responder, r.card_id) < r.qty then RAISE 'responder_short'; end if;

  -- offer（提案者→responder）：提案者はロック分から払う
  for each o in offer_items(trade_id):
    update user_cards set count = count - o.qty, locked = locked - o.qty
      where profile_id=t.proposer_id and card_id=o.card_id;          -- 既にロック済
    insert user_cards(responder, o.card_id, o.qty) on conflict do update count+=o.qty;

  -- request（responder→提案者）
  for each r in request_items(trade_id):
    update user_cards set count = count - r.qty
      where profile_id=responder and card_id=r.card_id and count-locked >= r.qty;
    if not found then RAISE 'responder_short'; end if;
    insert user_cards(t.proposer_id, r.card_id, r.qty) on conflict do update count+=r.qty;

  update trades set status='accepted', responder_id=responder, settled_at=now() where id=trade_id;
  return 'ok';
END;  -- reserveには一切触れない → INV-1は所有移動だけで自動的に保たれる
```

### 5.4 取消/失効 `cancel_trade(trade_id)`

```
-- proposer 本人 or 期限切れ。offer のロックを解放して status を更新。
update user_cards set locked = locked - qty ... (offer分)
update trades set status = 'cancelled'|'expired'
```

---

## 6. 秘宝のシード（唯一の faucet・季節開始時1回）

探索で出ない秘宝(legend)を世界に投入する**唯一の正規手段**。管理操作 or 頂点クエスト報酬（§9-A未決）。

**【改良】legend も `world_reserve = world_supply` で開始する**（reserve=0にしない）。探索は rarity='legend' を**除外**するので結局掘り出せない。faucet は「reserveから1枚をプレイヤーへ移す」だけ＝探索と同じ機構の管理者版。これで `supply = reserve + owned` が**シード時も含めて常に成立**し、INV-1を一瞬も破らない。

```
-- 管理者(service_role)専用RPC。legendを含む任意カードを reserve→owned へ1枚移す。
grant_card(card_id, profile_id):
  update cards set world_reserve = world_reserve - 1 where id=card_id and world_reserve>0;  -- 失敗=在庫切れ
  insert user_cards(profile_id, card_id, 1) on conflict do update count+=1;
-- legendを各3枚、対象プレイヤーへ。reserveが尽きたら以後そのlegendは取引でしか動かない。
```

> faucet も「在庫からの移動」に統一。**無からカードを作る瞬間は存在しない**（季節シードで `world_supply=world_reserve` を入れた時点が発行）。以後は探索(common/rareのreserve)・faucet(legend含むreserve)・取引(移動)のみ。

---

## 7. RLS / 書き込み経路（最重要）

| テーブル | クライアントの読み | クライアントの書き |
|---|---|---|
| `cards` / `seasons` | 全員 read 可（マスタ） | **不可**（RPC/管理のみ） |
| `user_cards` | 本人＋（取引表示に必要な範囲で他者の出品分） | **直接不可**。`explore_pull`/`*_trade` RPC のみ |
| `trades`/`trade_items` | 当事者（proposer/responder）＋オープン提案は一覧可 | RPC のみ |
| `profiles` | 本人（表示名は他者にも公開可） | 本人の表示名等のみ |
| `game_appearance`/`cosmetics_owned`/`game_stats` | 本人（外見は他者表示用に公開可） | 本人のみ（または検証付きRPC） |

- **不変条件はRLSではなくRPC関数内に閉じ込める**。RLSは「直接書き込み禁止」の壁、RPCが「正しい増減」の門。
- Colyseusサーバーは `service_role` で同じRPCを叩く。**人間クライアントもサーバーも同じ門を通る**ので、権威が一本化され二重取得・消失が起きない。

---

## 8. Colyseus（リアルタイム世界）との関係

- リアルタイム位置同期などの**揮発状態はColyseusのメモリのまま**でよい（消えてよい）。
- **耐久が要るもの（カード所有・在庫・取引・見た目・戦績）だけ Supabase**。
- 例：MMO内で霊宝をmob討伐ドロップにする場合 → Colyseusが討伐判定 → `explore_pull` RPCを呼ぶ → 結果をstateに反映。在庫の真実はDB側にあるので、サーバーが落ちても再起動しても世界総数は不変。

---

## 9. 未決（実装前に確定）

- **秘宝シード方式**（GAME_DESIGN §9-A）：管理投入 / 頂点クエスト報酬 / ランダム初期配布
- **スタミナの保存先**：`game_stats` の jsonb か専用列か（時間回復ロジックの置き場）
- **取引の形**：MVPは指名/オープンの1対1・複数枚。オークションは後
- **他者の出品カードをどこまで read 可能にするか**（取引一覧のUI要件次第）
- **game_stats を汎用jsonbにするか、MMO進行だけ専用テーブルにするか**

---

## 10. 次の一手

1. （あなた）Supabaseプロジェクト作成・APIキー取得
2. 本書のDDL＋RLS＋RPCを実SQL（マイグレーション）に起こす
3. `explore_pull` / `propose_trade` / `accept_trade` の**INVテスト**（保存則が常に成立するか）を先に書く
4. クライアント/Colyseusから接続（`.env`・gitignore済）
