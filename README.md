# Video Desk — 自習室アプリ（会員制）

Flask + Socket.IO によるビデオ自習室（Zoom風）アプリです。**Googleログイン**で会員制となり、**ダッシュボード（ロビー）**から自習室へ入室し、**学習時間**が自動で記録されます。

## 起動方法

```bash
pip install -r requirements.txt
python app.py
```

ブラウザで **http://127.0.0.1:10000** を開きます。

---

## Render で公開する場合

このリポジトリには `render.yaml` が含まれています。Render のダッシュボードで「New > Web Service」からリポジトリを連携し、Blueprint でデプロイするか、手動で次のように設定してください。

- **Build Command**: `pip install -r requirements.txt`
- **Start Command**: `gunicorn --worker-class eventlet -w 1 -b 0.0.0.0:$PORT app:app`

**環境変数**（Render の「Environment」で設定。ここで設定した値が優先され、ローカルの `.env` は上書きしません）:

| 変数名 | 説明 |
|--------|------|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 のクライアントID（会員ログインに必須） |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 のクライアントシークレット |
| `SECRET_KEY` | Flask セッション用（未設定時はデフォルト値） |
| `ADMIN_PASSWORD` | 管理者ログイン用パスワード（管理者機能を使う場合） |
| `DATABASE_URL` | 本番用DB（未設定時はローカルで `sqlite:///db.sqlite3` を使用） |

---

## 他端末からアクセスする場合（HTTPS が必要）

スマホやタブレットなど、**同じネットワーク内の他端末**から **http://192.168.x.x:10000** のようなローカルIPで開くと、ブラウザのセキュリティ制限（Secure Context）により **カメラが使えません**（`getUserMedia` は HTTPS または localhost のみ対応）。

次のいずれかで **HTTPS のURL** を用意してください。

### 方法1: ngrok で HTTPS トンネルを張る

1. [ngrok](https://ngrok.com/) に登録し、アプリまたは `ngrok` コマンドをインストールする。
2. アプリを起動した状態で、**別ターミナル**で次を実行する（ポートは `app.py` のポートに合わせる）:

   ```bash
   ngrok http 10000
   ```

3. 表示された **https://xxxx.ngrok.io** のURLを、スマホ等のブラウザで開く。

### 方法2: cloudflared（Cloudflare Tunnel）で HTTPS を発行

1. [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) をインストールする。
2. アプリを起動した状態で、**別ターミナル**で:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:10000
   ```

3. 表示された **https://xxxx.trycloudflare.com** のURLを、スマホ等のブラウザで開く。

### 方法3: Chrome のフラグで HTTP を「安全」扱いにする（開発用）

**Chrome（Android 含む）** のみ利用可能です。

1. アドレスバーに `chrome://flags` と入力して開く。
2. 「Insecure origin treated as secure」または「安全でないオリジンを安全として扱う」を検索する。
3. テキスト欄に **http://あなたのPCのIP:10000**（例: `http://192.168.1.10:10000`）を追加する。
4. 有効化してブラウザを再起動し、その HTTP のURLで再度アクセスする。

※ 本番環境では必ず HTTPS（ngrok / cloudflared 等）の利用を推奨します。
