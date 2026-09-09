# NAS選定ツール（試作）

I-O DATA「NASセレクター」の代替として作成中の、法人向けNAS比較ツールです。

## 構成

```
index.html         比較ツール本体（GitHub Pagesで公開）
style.css
app.js
data/products.json 商品データ（機種＋容量バリエーション＋機能タグ＋販売状況）
scripts/scrape.mjs Playwrightスクレイパーの雛形（要・実装）
.github/workflows/scrape.yml  月1回の自動スクレイピング → Pull Request作成
```

## セットアップ

### 1. GitHub Pagesを有効化する

このリポジトリを **パブリックリポジトリ** としてGitHubに作成し、`Settings > Pages` で
`Deploy from a branch` → `main` / `/ (root)` を選択してください。
数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。
独自ドメインは使わない前提なので、追加設定は不要です。

### 2. スクレイパーを完成させる

`scripts/scrape.mjs` は雛形の状態です。`TODO` と書かれた箇所を、実際のページ構造に
合わせて埋めてください。手順の目安：

1. `npx playwright install chromium` でブラウザをインストール
2. `node scripts/scrape.mjs` を実際に動かしながら、ブラウザのDevTools（Networkタブ）で
   絞り込み結果がJSON APIとして取れないか確認する
3. JSON APIがあればそれを叩く実装に、なければDOM解析の実装にする
4. 商品ページ側で「保証年数」「店頭在庫限り／生産終了品」の判定ロジックを実装する

### 3. 動作確認

ローカルで `data/products.json` を更新したら、`index.html` をブラウザで開いて
（または `npx serve .` などの簡易サーバーで）表示を確認してください。

### 4. 自動化を有効にする

`.github/workflows/scrape.yml` は毎月1日に自動実行され、変更点をPull Requestとして
作成します。即座に本番反映はされません。PRの差分（価格変更・生産終了ステータスの変化）
を確認してからマージしてください。マージするとGitHub Pagesが自動で再デプロイされます。

`Actions` タブから `workflow_dispatch` で手動実行することもできます。

## 今後の検討事項

- 商品ページのDOM構造に合わせたスクレイパーの実装
- 保証年数・在庫状況の判定ロジックの精度確認
- モバイル表示時のフィルターパネルの扱い（アコーディオン化など）
