-- ============================================================================
-- 季節「原初」シードデータ
--   GAME_DESIGN.md §2 のカード16種・供給数。
--   world_reserve = world_supply で開始（legend含む）。探索は rarity='legend' を除外するので
--   legend は探索で掘れず、faucet(grant_card) でのみ reserve→owned へ動く。
--   → supply = reserve + owned が常に成立（INV-1）。
--
--   supabase CLI なら `supabase db reset` 時に自動実行される。
-- ============================================================================

insert into public.seasons (id, name, active, opened_at)
values (1, '原初', true, now())
on conflict (id) do update set name = excluded.name, active = excluded.active;

insert into public.cards (id, season_id, name, rarity, world_supply, world_reserve) values
  ( 1, 1, '灯火の精',     'common', 300, 300),
  ( 2, 1, '川の囁き',     'common', 300, 300),
  ( 3, 1, '苔むす石',     'common', 300, 300),
  ( 4, 1, '風の使い',     'common', 300, 300),
  ( 5, 1, '夜鳴鳥',       'common', 250, 250),
  ( 6, 1, '古びた鍵',     'common', 250, 250),
  ( 7, 1, '旅人の靴',     'common', 250, 250),
  ( 8, 1, '銅の護符',     'common', 250, 250),
  ( 9, 1, '月光の鏡',     'rare',    40,  40),
  (10, 1, '双子の炎',     'rare',    40,  40),
  (11, 1, '霧の女王',     'rare',    35,  35),
  (12, 1, '雷鳴の角笛',   'rare',    35,  35),
  (13, 1, '影縫いの針',   'rare',    20,  20),
  (14, 1, '不死鳥の心臓', 'legend',   3,   3),
  (15, 1, '星詠みの書',   'legend',   3,   3),
  (16, 1, '創世の宝珠',   'legend',   3,   3)
on conflict (id) do update set
  season_id     = excluded.season_id,
  name          = excluded.name,
  rarity        = excluded.rarity,
  world_supply  = excluded.world_supply,
  world_reserve = excluded.world_reserve;

-- 世界総数（参考）: common 2200 + rare 170 + legend 9 = 2379 個体
