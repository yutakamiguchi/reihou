-- 霊宝: 登録ユーザーの「進行＋所持霊宝」を初期化する（アカウントは残す）。
-- ⚠ 不可逆。Supabase Dashboard → SQL Editor に貼って実行する手動メンテ用。
-- ⚠ migrations/ には絶対に置かないこと（デプロイ毎に走ってデータが消える）。
-- 有限供給の保存則 world_supply = world_reserve + Σowned を維持する。

begin;

-- 1) トレードを全消去（locked の参照を解消）
delete from public.trade_items;
delete from public.trades;

-- 2) 全員の所持枚数を在庫(world_reserve)へ戻す
update public.cards c
set world_reserve = world_reserve + coalesce(
  (select sum(uc.count) from public.user_cards uc where uc.card_id = c.id), 0);

-- 3) 所持をクリア
delete from public.user_cards;

-- 4) 霊宝の進行（レベル/EXP/討伐数/プレイ時間/実績）をリセット
delete from public.game_stats where game_key = 'spirit';

commit;

-- 確認: 戻した結果、全カードで world_reserve = world_supply になっているはず（0件ならOK）
select count(*) as mismatched
from public.cards
where world_reserve <> world_supply;
