-- ============================================================================
-- 霊宝コレクション（仮） 初期スキーマ
--   設計: docs/spirit-cards/DATA_MODEL.md（保存則 INV-1〜6）
--   方針: Supabase=真実源 / アカウントはポータル共通 / 見た目はゲーム毎(B) / 無課金
--
-- セキュリティの要:
--   - クライアントは cards / user_cards / trades を直接書けない（RLS + GRANT で禁止）
--   - 在庫・所有・取引の変更は SECURITY DEFINER の RPC 経由のみ
--   - RPC は所有者(postgres)権限で動くので RLS を貫通して「正しい増減」だけ行う
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 共通アカウント（ポータル共通）
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Player'
               check (char_length(display_name) between 1 and 16),
  created_at   timestamptz not null default now()
);

-- 新規ユーザー作成時に profiles を自動生成
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), 'Player'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 見た目（ゲーム毎スキン B）
create table if not exists public.game_appearance (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  game_key   text not null,                  -- 'bomberman' | 'unspottable' | 'mmo' | 'spirit' ...
  appearance jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (profile_id, game_key)
);

-- 解放済みスキン（アンロック式・ゲーム毎）
create table if not exists public.cosmetics_owned (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  game_key    text not null,
  cosmetic_id text not null,
  acquired_at timestamptz not null default now(),
  primary key (profile_id, game_key, cosmetic_id)
);

-- 戦績/進行（MMOのレベル/EXP等も jsonb で。ゲーム毎）
create table if not exists public.game_stats (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  game_key   text not null,
  stats      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (profile_id, game_key)
);

-- ---------------------------------------------------------------------------
-- 2. 霊宝：季節とカードマスタ
-- ---------------------------------------------------------------------------
create table if not exists public.seasons (
  id        int primary key,
  name      text not null,
  active    boolean not null default false,
  opened_at timestamptz
);

create table if not exists public.cards (
  id            int primary key,
  season_id     int  not null references public.seasons(id),
  name          text not null,
  rarity        text not null check (rarity in ('common','rare','legend')),
  world_supply  int  not null check (world_supply  >= 0),  -- 固定（世界総数）
  world_reserve int  not null check (world_reserve >= 0),  -- 未発掘の残量
  check (world_reserve <= world_supply)
);

-- ---------------------------------------------------------------------------
-- 3. 霊宝：所有（エスクロー対応）
-- ---------------------------------------------------------------------------
create table if not exists public.user_cards (
  profile_id uuid not null references public.profiles(id) on delete restrict,
  card_id    int  not null references public.cards(id),
  count      int  not null default 0 check (count  >= 0),
  locked     int  not null default 0 check (locked >= 0),
  primary key (profile_id, card_id),
  check (locked <= count)                 -- INV-6
);
create index if not exists idx_user_cards_card on public.user_cards(card_id);

-- ---------------------------------------------------------------------------
-- 4. 霊宝：取引
-- ---------------------------------------------------------------------------
create table if not exists public.trades (
  id           bigint generated always as identity primary key,
  proposer_id  uuid not null references public.profiles(id),
  responder_id uuid          references public.profiles(id),  -- null=オープン提案
  status       text not null default 'open'
               check (status in ('open','accepted','cancelled','expired')),
  created_at   timestamptz not null default now(),
  settled_at   timestamptz
);
create index if not exists idx_trades_status on public.trades(status);

create table if not exists public.trade_items (
  trade_id bigint not null references public.trades(id) on delete cascade,
  side     text   not null check (side in ('offer','request')),
  card_id  int    not null references public.cards(id),
  qty      int    not null check (qty > 0),
  primary key (trade_id, side, card_id)
);

-- ============================================================================
-- 5. RPC（SECURITY DEFINER）— 在庫/所有/取引の変更はここだけ
-- ============================================================================

-- 5.1 探索の払い出し：在庫から重み付き抽選で1枚。legendは rarity 除外で必ず対象外。
create or replace function public.explore_pull(p_season int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_pick int;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  -- 重み = レアリティ係数(common10/rare3) × 在庫。Gumbel/指数トリックで重み付き1件抽選＋行ロック。
  select id into v_pick
  from public.cards
  where season_id = p_season
    and rarity <> 'legend'
    and world_reserve > 0
  order by power(random(),
                 1.0 / ((case rarity when 'common' then 10 when 'rare' then 3 else 0 end) * world_reserve)
          ) desc
  limit 1
  for update;

  if v_pick is null then
    return null;                 -- 売り切れ（探索可能な在庫なし）
  end if;

  update public.cards set world_reserve = world_reserve - 1
  where id = v_pick and world_reserve > 0;
  if not found then
    return null;                 -- 競合で先に売れた→クライアント再試行可
  end if;

  insert into public.user_cards (profile_id, card_id, count)
  values (v_uid, v_pick, 1)
  on conflict (profile_id, card_id) do update set count = public.user_cards.count + 1;

  return v_pick;                 -- INV-1: reserve-1 と owned+1 が同一Tx → 保存則維持
end;
$$;

-- 5.2 取引提案：offer分を free から確保（エスクロー）し trade を作る。
--     p_offer / p_request: jsonb 配列 [{"card_id":1,"qty":2}, ...]
create or replace function public.propose_trade(p_offer jsonb, p_request jsonb, p_responder uuid default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_trade bigint;
  v_item  jsonb;
  v_cid   int;
  v_qty   int;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if coalesce(jsonb_array_length(p_offer),0) = 0 or coalesce(jsonb_array_length(p_request),0) = 0 then
    raise exception 'empty_offer_or_request';
  end if;
  if p_responder = v_uid then raise exception 'cannot_trade_self'; end if;

  insert into public.trades (proposer_id, responder_id)
  values (v_uid, p_responder)
  returning id into v_trade;

  -- offer をエスクロー（INV-6: free=count-locked が足りる時だけ locked を増やす）
  for v_item in select * from jsonb_array_elements(p_offer) loop
    v_cid := (v_item->>'card_id')::int;
    v_qty := (v_item->>'qty')::int;
    update public.user_cards set locked = locked + v_qty
    where profile_id = v_uid and card_id = v_cid and count - locked >= v_qty;
    if not found then raise exception 'insufficient_free:card=%', v_cid; end if;
    insert into public.trade_items (trade_id, side, card_id, qty)
    values (v_trade, 'offer', v_cid, v_qty);
  end loop;

  for v_item in select * from jsonb_array_elements(p_request) loop
    insert into public.trade_items (trade_id, side, card_id, qty)
    values (v_trade, 'request', (v_item->>'card_id')::int, (v_item->>'qty')::int);
  end loop;

  return v_trade;
end;
$$;

-- 5.3 取引成立：双方の所有を1Txで原子的にスワップ（INV-4）。reserveには一切触れない。
create or replace function public.accept_trade(p_trade bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  t     record;
  it    record;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into t from public.trades where id = p_trade for update;
  if not found            then return 'not_found';   end if;
  if t.status <> 'open'   then return 'unavailable'; end if;
  if t.proposer_id = v_uid then raise exception 'cannot_accept_own'; end if;
  if t.responder_id is not null and t.responder_id <> v_uid then return 'not_for_you'; end if;

  -- offer: proposer(ロック分) -> responder
  for it in select card_id, qty from public.trade_items where trade_id = p_trade and side = 'offer' loop
    update public.user_cards set count = count - it.qty, locked = locked - it.qty
    where profile_id = t.proposer_id and card_id = it.card_id and locked >= it.qty and count >= it.qty;
    if not found then raise exception 'proposer_escrow_broken:card=%', it.card_id; end if;
    insert into public.user_cards (profile_id, card_id, count)
    values (v_uid, it.card_id, it.qty)
    on conflict (profile_id, card_id) do update set count = public.user_cards.count + it.qty;
  end loop;

  -- request: responder(free) -> proposer
  for it in select card_id, qty from public.trade_items where trade_id = p_trade and side = 'request' loop
    update public.user_cards set count = count - it.qty
    where profile_id = v_uid and card_id = it.card_id and count - locked >= it.qty;
    if not found then raise exception 'responder_short:card=%', it.card_id; end if;
    insert into public.user_cards (profile_id, card_id, count)
    values (t.proposer_id, it.card_id, it.qty)
    on conflict (profile_id, card_id) do update set count = public.user_cards.count + it.qty;
  end loop;

  update public.trades set status = 'accepted', responder_id = v_uid, settled_at = now()
  where id = p_trade;
  return 'ok';
end;
$$;

-- 5.4 取引取消：提案者本人。offerのロックを解放。
create or replace function public.cancel_trade(p_trade bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  t     record;
  it    record;
begin
  select * into t from public.trades where id = p_trade for update;
  if not found          then return 'not_found';   end if;
  if t.status <> 'open' then return 'unavailable'; end if;
  if t.proposer_id <> v_uid then raise exception 'not_owner'; end if;

  for it in select card_id, qty from public.trade_items where trade_id = p_trade and side = 'offer' loop
    update public.user_cards set locked = locked - it.qty
    where profile_id = t.proposer_id and card_id = it.card_id and locked >= it.qty;
  end loop;

  update public.trades set status = 'cancelled' where id = p_trade;
  return 'ok';
end;
$$;

-- 5.5 faucet（管理者専用）：reserveから1枚をプレイヤーへ。legend含む。
--     EXECUTE は service_role のみ（後段でGRANT制御）。
create or replace function public.grant_card(p_card int, p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.cards set world_reserve = world_reserve - 1
  where id = p_card and world_reserve > 0;
  if not found then raise exception 'no_reserve:card=%', p_card; end if;
  insert into public.user_cards (profile_id, card_id, count)
  values (p_profile, p_card, 1)
  on conflict (profile_id, card_id) do update set count = public.user_cards.count + 1;
end;
$$;

-- 5.6 保存則チェック（INVテスト/監視用）。ok=false の行があれば保存則違反。
create or replace function public.check_conservation()
returns table(card_id int, world_supply int, world_reserve int, owned_total bigint, ok boolean)
language sql
stable
set search_path = public
as $$
  select c.id, c.world_supply, c.world_reserve,
         coalesce(sum(uc.count), 0) as owned_total,
         c.world_reserve + coalesce(sum(uc.count), 0) = c.world_supply as ok
  from public.cards c
  left join public.user_cards uc on uc.card_id = c.id
  group by c.id, c.world_supply, c.world_reserve
  order by c.id;
$$;

-- ============================================================================
-- 6. RLS（行レベルセキュリティ）— 直接書き込みを塞ぐ壁
-- ============================================================================
alter table public.profiles        enable row level security;
alter table public.game_appearance enable row level security;
alter table public.cosmetics_owned enable row level security;
alter table public.game_stats      enable row level security;
alter table public.seasons         enable row level security;
alter table public.cards           enable row level security;
alter table public.user_cards      enable row level security;
alter table public.trades          enable row level security;
alter table public.trade_items     enable row level security;

-- profiles: 認証ユーザーは表示名を閲覧可、更新は本人のみ
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- game_appearance: 本人のみ読み書き（自分の見た目を設定）
create policy ga_select on public.game_appearance for select to authenticated using (profile_id = auth.uid());
create policy ga_upsert on public.game_appearance for insert to authenticated with check (profile_id = auth.uid());
create policy ga_update on public.game_appearance for update to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- cosmetics_owned / game_stats: 本人 select のみ（書き込みは service_role/RPC）
create policy co_select on public.cosmetics_owned for select to authenticated using (profile_id = auth.uid());
create policy gs_select on public.game_stats      for select to authenticated using (profile_id = auth.uid());

-- seasons / cards: マスタは全員 read（書き込みポリシー無し＝service_roleのみ）
create policy seasons_select on public.seasons for select to anon, authenticated using (true);
create policy cards_select   on public.cards   for select to anon, authenticated using (true);

-- user_cards: 本人の所有のみ閲覧（書き込みポリシー無し＝RPC経由のみ）
create policy uc_select on public.user_cards for select to authenticated using (profile_id = auth.uid());

-- trades: 当事者＋オープン提案を閲覧（書き込みポリシー無し＝RPC経由のみ）
create policy trades_select on public.trades for select to authenticated
  using (proposer_id = auth.uid() or responder_id = auth.uid() or status = 'open');
create policy trade_items_select on public.trade_items for select to authenticated
  using (exists (
    select 1 from public.trades t
    where t.id = trade_items.trade_id
      and (t.proposer_id = auth.uid() or t.responder_id = auth.uid() or t.status = 'open')
  ));

-- ============================================================================
-- 7. GRANT（「Automatically expose new tables = OFF」前提で明示付与）
-- ============================================================================
grant usage on schema public to anon, authenticated, service_role;

-- service_role（サーバー/管理）はRLSを貫通する信頼ロール。全テーブル/関数へ付与。
-- ※「Automatically expose new tables = OFF」だと自動付与が効かないため明示する。
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- 読み取り（実アクセスは上のRLSが制御）
grant select on public.seasons, public.cards to anon, authenticated;
grant select on public.profiles, public.user_cards, public.trades, public.trade_items,
                public.game_appearance, public.cosmetics_owned, public.game_stats to authenticated;
-- 見た目だけ本人が直接書ける
grant insert, update on public.game_appearance to authenticated;

-- RPC 実行権限
grant execute on function public.explore_pull(int)              to authenticated;
grant execute on function public.propose_trade(jsonb,jsonb,uuid) to authenticated;
grant execute on function public.accept_trade(bigint)           to authenticated;
grant execute on function public.cancel_trade(bigint)           to authenticated;
grant execute on function public.check_conservation()           to authenticated;

-- faucet は service_role(サーバー/管理)のみ。クライアントからは呼べない。
revoke execute on function public.grant_card(int, uuid) from public, anon, authenticated;
grant  execute on function public.grant_card(int, uuid) to service_role;
