-- ============================================================================
-- explore_pull_for にレア寄せ(p_rare_bias)を追加。強い敵ほど希少が出やすくする用。
--   希少の重み係数を 3 → 3 + p_rare_bias*117（bias1.0で120≒普通と拮抗）に。
--   普通=10固定、秘宝=0（探索/ドロップでは出ない＝核は維持）。
--   旧 2引数版は破棄し 3引数版に統一。
-- ============================================================================
drop function if exists public.explore_pull_for(uuid, int);

create or replace function public.explore_pull_for(
  p_profile uuid, p_season int default 1, p_rare_bias double precision default 0
)
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
                 1.0 / ((case rarity
                           when 'common' then 10.0
                           when 'rare'   then 3.0 + greatest(0, p_rare_bias) * 117.0
                           else 0.0 end) * world_reserve)
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

revoke execute on function public.explore_pull_for(uuid, int, double precision) from public, anon, authenticated;
grant  execute on function public.explore_pull_for(uuid, int, double precision) to service_role;
