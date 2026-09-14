あいうえバトル Web v0.21 / 共通オンライン規格対応版

このフォルダ内のファイルを、現在の GitHub Pages 側へアップロードしてください。
既存接続先は config.js の以下を維持しています。
https://aiue-online.naitoryo7110.workers.dev

v0.21 はクライアント側のみの変更です。Cloudflare Workers の再デプロイは不要です。


v0.21 BGM:
- assets/MEGALOVANIA.m4a を無限ループ再生
- 初期音量 5%
- トップバーのBGMボタンから1%刻みで0〜100%調整
- ブラウザの自動再生制限により、最初のクリック/タップ/キー入力時に再生開始


v0.21 ターン通知音:
- 自分のターン開始時に4種類からランダムで1つ再生
- 同じturnTokenでは1回だけ再生し、state再受信で連続再生しない
- 初期音量5%
- トップバーの「通知」ボタンから1%刻みで0〜100%調整
- assets/turn_mutou.m4a / turn_pegasus.m4a / turn_yugi.m4a / turn_kaiba.m4a
