# マップ編集用ソース（配信されない）

ここは Tiled でマップを編集するための**元データ置き場**。
ビルド（Vercel）には含まれない。実行時に使うのは `client/public/map/` の
`town.json`（書き出し結果）と `town_tiles.png`（タイルセット画像）だけ。

## 構成
- `town.tmx` … Tiledで開く編集ファイル（**層フォーマットはCSV**）
- `ウディタ2_32x32mapchip_20210215/` … pipoya 素材（タイルセット元画像）

## 再書き出し手順
1. `town.tmx` を Tiled で開いて編集
2. ファイル → 書き出し（Export As） → `../client/public/map/town.json`
3. タイルセット画像を変えたら、その画像を `client/public/map/town_tiles.png` に
   コピーし直す（コード側は `addTilesetImage("grass","townTiles")` で紐付け）

## 注意
- 層フォーマットは必ず **CSV**（マップ→プロパティ→タイル層フォーマット=CSV）。
  Base64+zlib だと Phaser が展開できず地面が空になる。
- 素材の生ファイル群は再配布禁止ライセンスのため `public`（配信対象）に置かない。
