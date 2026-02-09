"""
Video Desk — 自習室アプリ（会員制）

他端末（スマホ等）からローカルIPでアクセスする場合、カメラは HTTPS でないと利用できません。
ngrok / cloudflared で HTTPS 公開する手順は README.md の「他端末からアクセスする場合」を参照してください。
"""
from werkzeug.middleware.proxy_fix import ProxyFix
import os
import time
import secrets
import eventlet
from flask import Flask, render_template, request, redirect, url_for, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from flask_sqlalchemy import SQLAlchemy
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv

# ローカル .env を読む（Render 等で設定した環境変数は上書きしない＝Render の値を優先）
load_dotenv()

app = Flask(__name__)

app.secret_key = os.environ.get("SECRET_KEY") or "fallback_secret_key_for_local"
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
# セッション・永続ログイン: 30日間
app.config['PERMANENT_SESSION_LIFETIME'] = 30 * 24 * 60 * 60  # 30日（秒）
app.config['REMEMBER_COOKIE_DURATION'] = 30 * 24 * 60 * 60    # 30日（秒）
app.config['REMEMBER_COOKIE_SECURE'] = False  # HTTPS でない環境でも動作させる場合
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

# DB: Render の DATABASE_URL があれば優先、なければ SQLite
db_url = os.environ.get('DATABASE_URL', 'sqlite:///db.sqlite3')
if db_url.startswith('postgres://'):
    db_url = db_url.replace('postgres://', 'postgresql://', 1)
app.config['SQLALCHEMY_DATABASE_URI'] = db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'index'
oauth = OAuth(app)
# Render では gunicorn + eventlet で起動するため、async_mode を eventlet に統一
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')


# ---------- User モデル ----------
class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    google_id = db.Column(db.String(128), unique=True, nullable=False)
    name = db.Column(db.String(256))
    email = db.Column(db.String(256))
    profile_image = db.Column(db.String(512))
    total_study_time = db.Column(db.Integer, default=0)  # 分単位

    def get_id(self):
        return str(self.id)

    @property
    def is_authenticated(self):
        return True

    @property
    def is_active(self):
        return True

    @property
    def is_anonymous(self):
        return False


@login_manager.user_loader
def load_user(user_id):
    try:
        return User.query.get(int(user_id))
    except (ValueError, TypeError):
        return None


# Google OAuth: 環境変数 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を config に渡す
app.config['GOOGLE_CLIENT_ID'] = os.environ.get('GOOGLE_CLIENT_ID', '')
app.config['GOOGLE_CLIENT_SECRET'] = os.environ.get('GOOGLE_CLIENT_SECRET', '')
oauth.register(
    'google',
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid profile email'},
)

# room_id -> { sid -> { user_name, role } }  (legacy lookup; private_rooms でも使用)
room_users = {}
# room_id -> { sid -> bool (hand raised) }
hand_raise_states = {}
# sid -> room_id (for disconnect cleanup)
sid_to_room = {}
# private session_id -> { main_room, admin_sid, student_sid }
private_rooms = {}

# ----- ルーム管理（メインルーム・最大4人・サーバーが唯一の正解） -----
# room_id -> [ { sid, user_name, role, user_id, connected }, ... ] 入室順・最大4、先頭がホスト
room_participants = {}


def get_room():
    return request.referrer or request.args.get('room')  # fallback


def get_hand_states(room):
    return [
        {"sid": sid, "user_name": room_users.get(room, {}).get(sid, {}).get("user_name", ""), "role": room_users.get(room, {}).get(sid, {}).get("role", "student"), "raised": hand_raise_states.get(room, {}).get(sid, False)}
        for sid in hand_raise_states.get(room, {})
    ]


def is_main_room(room_id):
    return room_id and not room_id.startswith('private_')


def get_connected_count(participants_list):
    return sum(1 for p in participants_list if p.get('connected'))


def _participant_total_study_minutes(user_db_id):
    """DBの user_db_id (User.id) から総勉強時間（分）を返す。"""
    if user_db_id is None:
        return 0
    try:
        u = User.query.get(int(user_db_id))
        return (u.total_study_time or 0) if u else 0
    except (ValueError, TypeError):
        return 0


def build_room_state(room_id):
    """メインルーム用: 最大4スロットの参加者リストとホストsidを返す。"""
    if not is_main_room(room_id) or room_id not in room_participants:
        return {'participants': [], 'host_sid': None}
    plist = room_participants[room_id]
    host_sid = plist[0]['sid'] if plist else None
    participants = []
    for i, p in enumerate(plist):
        total_min = _participant_total_study_minutes(p.get('user_db_id'))
        participants.append({
            'sid': p['sid'],
            'user_name': p.get('user_name', ''),
            'role': p.get('role', 'student'),
            'connected': p.get('connected', True),
            'is_host': (i == 0),
            'total_study_time_minutes': total_min,
        })
    return {'participants': participants, 'host_sid': host_sid}


def record_study_time_if_entered():
    """セッションに enter_time とログインユーザーがあれば学習時間を加算してクリアする。"""
    enter_time = session.pop('enter_time', None)
    if enter_time is None:
        return
    user = None
    if current_user.is_authenticated:
        user = current_user
    else:
        try:
            uid = session.get('_user_id')
            if uid:
                user = User.query.get(int(uid))
        except (ValueError, TypeError):
            pass
    if not user:
        return
    try:
        duration_sec = max(0, time.time() - enter_time)
        duration_min = int(duration_sec / 60)
        if duration_min > 0:
            user.total_study_time = (user.total_study_time or 0) + duration_min
            db.session.commit()
    except Exception:
        db.session.rollback()


# ---------- Routes ----------

@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return render_template('landing.html', error=None)


@app.route('/login/google')
def login_google():
    redirect_uri = url_for('google_authorized', _external=True)
    return oauth.google.authorize_redirect(redirect_uri)


@app.route('/login/google/authorized')
def google_authorized():
    try:
        token = oauth.google.authorize_access_token()
    except Exception:
        return redirect(url_for('index'))
    userinfo = token.get('userinfo')
    if not userinfo:
        return redirect(url_for('index'))
    google_id = userinfo.get('sub')
    if not google_id:
        return redirect(url_for('index'))
    user = User.query.filter_by(google_id=google_id).first()
    if not user:
        user = User(
            google_id=google_id,
            name=userinfo.get('name') or '',
            email=userinfo.get('email') or '',
            profile_image=userinfo.get('picture') or '',
        )
        db.session.add(user)
        db.session.commit()
    else:
        user.name = userinfo.get('name') or user.name
        user.email = userinfo.get('email') or user.email
        user.profile_image = userinfo.get('picture') or user.profile_image
        db.session.commit()
    session.permanent = True
    login_user(user, remember=True)
    session['role'] = 'student'
    session['user_name'] = user.name or user.email or 'ユーザー'
    return redirect(url_for('dashboard'))


@app.route('/dashboard')
@login_required
def dashboard():
    user = current_user
    total_min = user.total_study_time or 0
    hours, mins = divmod(total_min, 60)
    total_display = f'{hours}時間 {mins}分'
    return render_template(
        'dashboard.html',
        user=user,
        total_study_time_display=total_display,
    )


@app.route('/admin_login')
def admin_login_redirect():
    """旧管理者ログインURLはダッシュボードへリダイレクト（裏口のみ有効）"""
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return redirect(url_for('index'))


@app.route('/admin_login_secret', methods=['GET', 'POST'])
@login_required
def admin_login_secret():
    """管理者用裏口ログイン（URLを知っている者のみパスワードで管理者に昇格）"""
    if session.get('role') == 'admin':
        return redirect(url_for('dashboard'))
    if request.method == 'GET':
        return render_template('admin_login.html', error=None)
    password = request.form.get('password', '')
    admin_password = os.environ.get('ADMIN_PASSWORD', '')
    if admin_password and password == admin_password:
        session['role'] = 'admin'
        session['user_name'] = '管理者'
        return redirect(url_for('dashboard'))
    return render_template('admin_login.html', error='パスワードが正しくありません'), 401


@app.route('/settings', methods=['GET', 'POST'])
@login_required
def settings():
    if request.method == 'POST':
        display_name = (request.form.get('display_name') or '').strip()
        if display_name:
            current_user.name = display_name
            db.session.commit()
            session['user_name'] = display_name
        return redirect(url_for('dashboard'))
    return render_template(
        'settings.html',
        user=current_user,
        current_display_name=current_user.name or current_user.email or 'ユーザー',
    )


@app.route('/room')
@login_required
def room():
    session['enter_time'] = time.time()
    room_arg = request.args.get('room')
    if room_arg:
        session['room'] = room_arg
    room_id = session.get('room', '')
    total_min = current_user.total_study_time or 0
    hours, mins = divmod(total_min, 60)
    total_study_time_display = f'{hours}時間 {mins}分'
    return render_template(
        'room.html',
        role=session.get('role', 'student'),
        user_name=session.get('user_name', current_user.name or ''),
        room_id=room_id,
        profile_image=current_user.profile_image or '',
        total_study_time_display=total_study_time_display,
        total_study_time_minutes=total_min,
    )


@app.route('/room/exit')
@login_required
def room_exit():
    record_study_time_if_entered()
    session.pop('room', None)
    return redirect(url_for('dashboard'))


@app.route('/room/<room_id>')
@login_required
def room_by_id(room_id):
    session['room'] = room_id
    return redirect(url_for('room'))


@app.route('/logout')
def logout():
    record_study_time_if_entered()
    logout_user()
    session.clear()
    return redirect(url_for('index'))


# ---------- SocketIO ----------

@socketio.on('connect')
def on_connect():
    pass


@socketio.on('join_room')
def on_join_room(data):
    from flask import request as req
    req_room = data.get('room')  # 招待URL等で指定されたルーム（あれば）
    user_name = data.get('user_name', '')
    role = data.get('role', 'student')
    user_id = (data.get('user_id') or '').strip()  # クライアント用UUID（永続用）
    user_db_id = data.get('user_db_id')  # DBのUser.id（総勉強時間取得用）
    sid = req.sid

    # 個別ルーム（private_）の場合は従来どおり
    if req_room and req_room.startswith('private_'):
        if not req_room or req_room not in private_rooms:
            return
        old_room = sid_to_room.get(sid)
        if old_room and old_room != req_room:
            leave_room(old_room)
            if old_room in room_users and sid in room_users[old_room]:
                del room_users[old_room][sid]
        join_room(req_room)
        sid_to_room[sid] = req_room
        if req_room not in room_users:
            room_users[req_room] = {}
        room_users[req_room][sid] = {"user_name": user_name, "role": role}
        hand_raise_states.setdefault(req_room, {})[sid] = False
        emit('hand_states', {"states": get_hand_states(req_room)}, room=sid)
        emit('user_joined', {"sid": sid, "user_name": user_name, "role": role}, room=req_room, include_self=False)
        return

    # ----- メインルーム: 4人制限・サーバーが唯一の正解（Source of Truth） -----
    room = None

    # 1) 招待URL/セッションで指定されたルームIDがあれば、それを最優先で使用する
    #    （最初の1人目の場合でも、そのIDで room_participants を初期化する）
    if req_room and is_main_room(req_room):
        if req_room in room_participants:
            # 既存ルームが満室なら、新しいルームへ（5人目以降）
            if len(room_participants[req_room]) >= 4:
                req_room = None  # 5人目は別室へ
            else:
                room = req_room
        else:
            # まだ誰もいない指定ルーム → そのIDでルームを作成
            room = req_room
            room_participants[room] = []

    # 2) 空きがある既存ルームを探す（4未満のみ）
    if not room:
        for rid, plist in list(room_participants.items()):
            if is_main_room(rid) and len(plist) < 4:
                room = rid
                break

    # 3) 見つからなければ新規ルーム（この人がホスト）
    if not room:
        room = secrets.token_hex(4)
        room_participants[room] = []

    plist = room_participants[room]
    if len(plist) >= 4:
        room = secrets.token_hex(4)
        room_participants[room] = []
        plist = room_participants[room]

    old_room = sid_to_room.get(sid)
    if old_room and old_room != room:
        leave_room(old_room)
    join_room(room)
    sid_to_room[sid] = room

    plist.append({
        'sid': sid,
        'user_name': user_name,
        'role': role,
        'user_id': user_id or None,
        'user_db_id': user_db_id,
        'connected': True,
    })
    room_users.setdefault(room, {})[sid] = {"user_name": user_name, "role": role}
    hand_raise_states.setdefault(room, {})[sid] = False

    is_host = (len(plist) == 1)
    state = build_room_state(room)
    # #region agent log
    try:
        _log_path = os.path.join(os.path.dirname(__file__), '.cursor', 'debug.log')
        _plist_sids = [p.get('sid') for p in plist]
        with open(_log_path, 'a', encoding='utf-8') as _f:
            import json
            _f.write(json.dumps({'location': 'app.py:on_join_room', 'message': 'main_room_join_emit_user_joined', 'data': {'room_id': room, 'joiner_sid': sid, 'plist_sids': _plist_sids, 'emit_to_room': room}, 'timestamp': __import__('time').time() * 1000, 'sessionId': 'debug-session', 'hypothesisId': 'H4'}) + '\n')
    except Exception:
        pass
    # #endregion
    join_total_min = _participant_total_study_minutes(user_db_id)
    emit('room_assigned', {'room_id': room, 'is_host': is_host, 'participants': state['participants']}, room=sid)
    emit('user_joined', {'sid': sid, 'user_name': user_name, 'role': role, 'total_study_time_minutes': join_total_min}, room=room, include_self=False)
    emit('hand_states', {"states": get_hand_states(room)}, room=room)


@socketio.on('request_room_state')
def on_request_room_state(data):
    """クライアントが現在の参加者リストを再取得（同期・古い情報リセット用）"""
    from flask import request as req
    sid = req.sid
    room_id = data.get('room_id') or sid_to_room.get(sid)
    if not room_id or not is_main_room(room_id):
        return
    if room_id not in room_participants:
        emit('room_state', {'participants': [], 'host_sid': None}, room=sid)
        return
    # 自分がこのルームにいるか確認（sid_to_room と plist の sid のいずれかで参加中）
    plist = room_participants[room_id]
    if not any(p.get('sid') == sid for p in plist):
        return
    emit('room_state', build_room_state(room_id), room=sid)
    emit('hand_states', {'states': get_hand_states(room_id)}, room=sid)


@socketio.on('hand_raise')
def on_hand_raise(data):
    from flask import request as req
    raised = data.get('raised', False)
    sid = req.sid
    room = sid_to_room.get(sid)
    if not room or room not in room_users:
        return
    hand_raise_states[room][sid] = raised
    user_name = room_users[room][sid].get("user_name", "")
    emit('hand_raise_update', {"sid": sid, "user_name": user_name, "raised": raised}, room=room)


def _same_room(sid, target_sid):
    """同一ルーム（メイン or 対面用）にいるか（ICE/offer/answer の送信先チェック）"""
    if not target_sid or not sid:
        return False
    r1 = sid_to_room.get(sid)
    r2 = sid_to_room.get(target_sid)
    return r1 and r2 and r1 == r2


@socketio.on('offer')
def on_offer(data):
    from flask import request as req
    target = data.get('target')
    if target and _same_room(req.sid, target):
        emit('offer', data, room=target)


@socketio.on('answer')
def on_answer(data):
    from flask import request as req
    target = data.get('target')
    if target and _same_room(req.sid, target):
        emit('answer', data, room=target)


@socketio.on('ice_candidate')
def on_ice_candidate(data):
    from flask import request as req
    target = data.get('target')
    if target and _same_room(req.sid, target):
        emit('ice_candidate', data, room=target)


@socketio.on('disconnect')
def on_disconnect():
    from flask import request as req
    record_study_time_if_entered()
    sid = req.sid
    room = sid_to_room.pop(sid, None)
    if room:
        leave_room(room)
        if room.startswith('private_'):
            for session_id, info in list(private_rooms.items()):
                if info.get('admin_sid') == sid or info.get('student_sid') == sid:
                    other_sid = info['student_sid'] if sid == info['admin_sid'] else info['admin_sid']
                    emit('redirect_to_main_room', {'main_room': info['main_room']}, room=other_sid)
                    del private_rooms[session_id]
                    break
        else:
            # メインルーム: 即座にルームから削除し、退出通知＋参加者リストを全員に再配布
            left_name = (room_users.get(room, {}).get(sid) or {}).get('user_name', '') or '参加者'
            if room in room_users and sid in room_users[room]:
                del room_users[room][sid]
            if room in hand_raise_states and sid in hand_raise_states[room]:
                del hand_raise_states[room][sid]
            emit('user_left', {'sid': sid, 'user_name': left_name}, room=room)

            if room in room_participants:
                plist = room_participants[room]
                for idx, p in enumerate(plist):
                    if p.get('sid') == sid:
                        plist.pop(idx)
                        if not plist:
                            del room_participants[room]
                        else:
                            if idx == 0:
                                new_host = plist[0]
                                emit('host_changed', {
                                    'new_host_sid': new_host['sid'],
                                    'new_host_name': new_host.get('user_name', ''),
                                }, room=room)
                        break


# ---------- Private Session ----------

@socketio.on('start_private_session')
def on_start_private_session(data):
    from flask import request as req
    sid = req.sid
    student_sid = data.get('student_sid')
    room = sid_to_room.get(sid)
    if not room or not student_sid or room.startswith('private_'):
        return
    if room_users.get(room, {}).get(sid, {}).get('role') != 'admin':
        return
    if student_sid not in room_users.get(room, {}):
        return
    session_id = 'private_' + secrets.token_hex(8)
    private_rooms[session_id] = {'main_room': room, 'admin_sid': sid, 'student_sid': student_sid}
    emit('redirect_to_private', {'session_id': session_id, 'main_room': room}, room=sid)
    emit('redirect_to_private', {'session_id': session_id, 'main_room': room}, room=student_sid)


@socketio.on('join_private_room')
def on_join_private_room(data):
    from flask import request as req
    sid = req.sid
    session_id = data.get('session_id')
    user_name = data.get('user_name', '')
    role = data.get('role', 'student')
    if not session_id or session_id not in private_rooms:
        return
    old_room = sid_to_room.get(sid)
    if old_room:
        leave_room(old_room)
        if not old_room.startswith('private_'):
            if old_room in room_users and sid in room_users[old_room]:
                del room_users[old_room][sid]
            if old_room in hand_raise_states and sid in hand_raise_states[old_room]:
                del hand_raise_states[old_room][sid]
            if is_main_room(old_room) and old_room in room_participants:
                plist = room_participants[old_room]
                for idx, p in enumerate(plist):
                    if p.get('sid') == sid:
                        plist.pop(idx)
                        if not plist:
                            del room_participants[old_room]
                        break
            emit('user_left', {'sid': sid}, room=old_room)
    join_room(session_id)
    sid_to_room[sid] = session_id
    if session_id not in room_users:
        room_users[session_id] = {}
    room_users[session_id][sid] = {'user_name': user_name, 'role': role}
    participants = [{'sid': s, 'user_name': room_users[session_id][s].get('user_name', ''), 'role': room_users[session_id][s].get('role', '')} for s in room_users[session_id]]
    emit('private_participants', {'participants': participants}, room=session_id)
    emit('private_audio_sync', {}, room=session_id)


@socketio.on('private_media_ready')
def on_private_media_ready(data):
    from flask import request as req
    sid = req.sid
    session_id = sid_to_room.get(sid)
    if session_id and session_id.startswith('private_') and session_id in private_rooms:
        emit('private_audio_sync', {}, room=session_id)


@socketio.on('end_private_session')
def on_end_private_session(data):
    from flask import request as req
    sid = req.sid
    session_id = sid_to_room.get(sid)
    if not session_id or not session_id.startswith('private_') or session_id not in private_rooms:
        return
    info = private_rooms[session_id]
    main_room = info['main_room']
    emit('redirect_to_main_room', {'main_room': main_room}, room=session_id)
    if session_id in room_users:
        del room_users[session_id]
    del private_rooms[session_id]


@socketio.on('private_chat')
def on_private_chat(data):
    from flask import request as req
    sid = req.sid
    session_id = sid_to_room.get(sid)
    if not session_id or not session_id.startswith('private_'):
        return
    user_name = room_users.get(session_id, {}).get(sid, {}).get('user_name', '')
    # 他者には room で配信。送信者本人には room=sid で返す（クライアントで sender_sid 一致時は表示しない＝二重表示防止）
    emit('private_chat', {'sender_sid': sid, 'user_name': user_name, 'text': data.get('text', '')}, room=session_id, include_self=False)
    emit('private_chat', {'sender_sid': sid, 'user_name': user_name, 'text': data.get('text', '')}, room=sid)


@socketio.on('private_chat_image')
def on_private_chat_image(data):
    from flask import request as req
    sid = req.sid
    session_id = sid_to_room.get(sid)
    if not session_id or not session_id.startswith('private_'):
        return
    user_name = room_users.get(session_id, {}).get(sid, {}).get('user_name', '')
    emit('private_chat_image', {'sender_sid': sid, 'user_name': user_name, 'data_url': data.get('data_url', '')}, room=session_id, include_self=False)
    emit('private_chat_image', {'sender_sid': sid, 'user_name': user_name, 'data_url': data.get('data_url', '')}, room=sid)


with app.app_context():
    db.create_all()

if __name__ == '__main__':
    # ローカル開発時のみ（Render では gunicorn で起動する）
    port = int(os.environ.get("PORT", 10000))
    print("--- 他端末でカメラを使う場合: README.md の「他端末からアクセスする場合（HTTPS）」を参照 ---")
    socketio.run(app, debug=True, port=port, host='0.0.0.0', allow_unsafe_werkzeug=True)
