このフォルダ内のファイルをGitHub Pages用リポジトリへアップしてください。

config.js の SERVER_URL は aiue-online.naitoryo7110.workers.dev に設定済みです。
実際のWorkers URLが異なる場合だけ config.js を変更してください。

v0.10:
- index.html から style.css / config.js / app.js を ?v=0.10 付きで読み込みます。
- GitHub Pagesやブラウザに旧app.jsが残っても、ゲーム開始後の画面が旧DOM参照で停止しにくいよう互換処理を追加しています。
