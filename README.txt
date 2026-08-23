このフォルダ内のファイルをGitHub Pages用リポジトリへアップしてください。

config.js の SERVER_URL は aiue-online.naitoryo7110.workers.dev に設定済みです。
実際のWorkers URLが異なる場合だけ config.js を変更してください。

v0.12:
- index.html から style.css / config.js / app.js を ?v=0.12 付きで読み込みます。
- GitHub Pagesやブラウザに旧app.jsが残っても、ゲーム開始後の画面が旧DOM参照で停止しにくいよう互換処理を追加しています。


v0.12:
- 最大文字数ぶんの「？」枠を常時表示します。
- HIT文字は本来の位置だけ公開し、左詰めしません。
- 自分の回答は本人にだけ常時表示し、HIT位置のみ赤背景＋黒文字です。
- .hidden の display:none と文字枠が衝突していた問題を修正しました。


v0.12:
- 「最低文字数 / 最高文字数」表示を「最低 / 最高」に短縮。
- HITした文字枠は自分・相手とも赤背景＋黒文字に統一。
