-- ============================================================================
-- explore_pull_for: 指定プロフィールに対する在庫払い出し（service_role 専用）
--   MMO世界の mob討伐ドロップ / フィールド拾得 から、サーバー(service_role)が
--   「そのプレイヤーの profile_id」を指定して在庫から1枚払い出すために使う。
--   explore_pull は auth.uid() の本人用。サーバーは uid を持たないのでこちらを使う。
--   挙動は explore_pull と同じ（legend除外・在庫からの重み付き抽選・保存則維持）。
-- ============================================================================
create or replace function public.explore_pull_for(p_profile uuid, p_season int default 1)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pick int;
begin
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

  if v_pick is null then return null; end if;

  update public.cards set world_reserve = world_reserve - 1
  where id = v_pick and world_reserve > 0;
  if not found then return null; end if;

  insert into public.user_cards (profile_id, card_id, count)
  values (p_profile, v_pick, 1)
  on conflict (profile_id, card_id) do update set count = public.user_cards.count + 1;

  return v_pick;
end;
$$;

revoke execute on function public.explore_pull_for(uuid, int) from public, anon, authenticated;
grant  execute on function public.explore_pull_for(uuid, int) to service_role;
