"""
Video Desk — 自習室アプリ（会員制）

他端末（スマホ等）からローカルIPでアクセスする場合、カメラは HTTPS でないと利用できません。
ngrok / cloudflared で HTTPS 公開する手順は README.md の「他端末からアクセスする場合」を参照してください。
"""
from werkzeug.middleware.proxy_fix import ProxyFix
import os
import time
import secrets
import uuid
from functools import wraps
from datetime import timedelta, datetime as dt_datetime
import eventlet
from flask import Flask, render_template, request, redirect, url_for, session, jsonify, abort, make_response
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from flask_sqlalchemy import SQLAlchemy
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv
import stripe
import json
import google.generativeai as genai

# ローカル .env を読む（Render 等で設定した環境変数は上書きしない＝Render の値を優先）
load_dotenv()

# ---------- Stripe 初期設定 ----------
stripe.api_key = os.environ.get('STRIPE_SECRET_KEY')
STRIPE_PUBLISHABLE_KEY = os.environ.get('STRIPE_PUBLISHABLE_KEY', '')
STRIPE_PRICE_ID_STANDARD = os.environ.get('STRIPE_PRICE_ID_STANDARD', '') or 'price_1T4w1yPGu6k4Ef94QUpP17yA'
STRIPE_PRICE_ID_PRO = os.environ.get('STRIPE_PRICE_ID_PRO', '') or 'price_1T4w2aPGu6k4Ef94A9Tn9jaV'
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET', '')

app = Flask(__name__)

# セッション鍵: Render では SECRET_KEY を環境変数で固定し、なければコード内の固定文字列を使用
app.secret_key = os.environ.get("SECRET_KEY") or "fallback_secret_key_for_local"
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# セッション・永続ログイン: 31日間（ブラウザを閉じても維持）
SESSION_DAYS = 31
app.config['SESSION_PERMANENT'] = True
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=SESSION_DAYS)
app.config['REMEMBER_COOKIE_DURATION'] = timedelta(days=SESSION_DAYS)
app.config['REMEMBER_COOKIE_SECURE'] = False  # HTTPS 強制環境では True 推奨
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

# DB: Render の DATABASE_URL があれば必ずそれを使う。Render環境で未設定なら起動エラーにする。
db_url = os.environ.get('DATABASE_URL')
if not db_url:
    if os.environ.get('RENDER') == 'true':
        raise RuntimeError(
            "DATABASE_URL is not set. On Render, configure an external PostgreSQL "
            "and set DATABASE_URL to avoid data loss on ephemeral filesystem."
        )
    # ローカル開発のみ SQLite を許可
    db_url = 'sqlite:///db.sqlite3'

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
    grade = db.Column(db.String(32), nullable=True)
    target_school = db.Column(db.String(256), nullable=True)

    # --- ロール (RBAC) ---
    role = db.Column(db.String(20), default='user')  # user / mentor / super_admin

    # --- 面談利用フラグ ---
    has_used_free_meeting = db.Column(db.Boolean, default=False)
    has_used_pro_meeting = db.Column(db.Boolean, default=False)

    # --- 学習ルート（管理者が記入） ---
    learning_route_text = db.Column(db.Text, nullable=True)

    # --- Stripe サブスクリプション ---
    stripe_customer_id = db.Column(db.String(255), nullable=True)
    stripe_subscription_id = db.Column(db.String(255), nullable=True)
    is_active_subscription = db.Column(db.Boolean, default=False)
    plan_type = db.Column(db.String(20), default='free')            # free / standard / pro
    subscription_status = db.Column(db.String(30), default='none')  # none / trialing / active / canceled / past_due
    trial_end_date = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=dt_datetime.utcnow)

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

    @property
    def is_within_7_days(self):
        if not self.created_at:
            return False
        delta = dt_datetime.utcnow() - self.created_at
        return delta.days < 7


class StudyReservation(db.Model):
    __tablename__ = 'study_reservations'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    date = db.Column(db.String(10), nullable=False)
    time_slot = db.Column(db.String(5), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('user_id', 'date', 'time_slot', name='uq_user_date_slot'),
    )


class MeetingReservation(db.Model):
    __tablename__ = 'meeting_reservations'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    date = db.Column(db.String(10), nullable=False)      # YYYY-MM-DD
    time_slot = db.Column(db.String(5), nullable=False)   # HH:MM
    room_token = db.Column(db.String(64), unique=True, nullable=False)
    status = db.Column(db.String(20), default='scheduled')  # scheduled / completed / no_show / cancelled
    meeting_type = db.Column(db.String(10), default='regular')  # initial / regular

    user = db.relationship('User', backref='meeting_reservations')


class Notification(db.Model):
    __tablename__ = 'notifications'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    category = db.Column(db.String(20), default='system')   # system / direct / global
    title = db.Column(db.String(256), nullable=False)
    message = db.Column(db.Text, nullable=True)
    link_target = db.Column(db.String(128), default='')      # e.g. '#section-report'
    is_read = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=dt_datetime.utcnow)

    user = db.relationship('User', backref='notifications')


def create_notification(user_id, category, title, message, link_target=''):
    """ヘルパー: 通知レコードを作成して返す"""
    n = Notification(
        user_id=user_id,
        category=category,
        title=title,
        message=message,
        link_target=link_target,
    )
    db.session.add(n)
    db.session.commit()
    return n


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


# ---------- アクセス制御デコレータ ----------

def admin_required(f):
    """mentor または super_admin ロールのみアクセスを許可するデコレータ。"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated:
            return redirect(url_for('login_google'))
        user_role = getattr(current_user, 'role', 'user') or 'user'
        if user_role not in ('mentor', 'super_admin'):
            abort(403)
        return f(*args, **kwargs)
    return decorated_function


def subscription_required(f):
    """ログイン済み ＋ 課金済みユーザーのみアクセスを許可するデコレータ。
    ・未ログイン → ログインページへ（@login_required と同等）
    ・ログイン済み＆未課金 → サブスクリプション案内ページへ
    """
    @wraps(f)
    @login_required
    def decorated_function(*args, **kwargs):
        if not current_user.is_active_subscription:
            return redirect(url_for('subscription_page'))
        return f(*args, **kwargs)
    return decorated_function


# ---------- Routes ----------



@app.route('/')
def index():
    return redirect(url_for('dashboard'))


@app.route('/login/google')
def login_google():
    redirect_uri = url_for('google_authorized', _external=True)
    return oauth.google.authorize_redirect(redirect_uri, prompt='select_account')


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
    # --- スーパー管理者の自動昇格 ---
    SUPER_ADMIN_EMAILS = ['y.studyops@gmail.com']
    if user.email in SUPER_ADMIN_EMAILS and user.role != 'super_admin':
        user.role = 'super_admin'
        db.session.commit()
    # DB role に基づいてセッション設定
    user_role = user.role or 'user'
    if user_role in ('mentor', 'super_admin'):
        session['role'] = 'admin'
        session['user_name'] = user.name or '管理者'
        return redirect(url_for('admin_dashboard_page'))
    session['role'] = 'student'
    session['user_name'] = user.name or user.email or 'ユーザー'
    return redirect(url_for('dashboard'))


@app.route('/dashboard')
def dashboard():
    if current_user.is_authenticated:
        user = current_user
        total_min = user.total_study_time or 0
        hours, mins = divmod(total_min, 60)
        total_display = f'{hours}時間 {mins}分'
        role = session.get('role', 'student')
        user_name = session.get('user_name', user.name or user.email or 'ユーザー')
        room_id = session.get('room', '')
        # プラン表示用
        plan_type = user.plan_type or 'free'
        sub_status = user.subscription_status or 'none'
        trial_end = user.trial_end_date
        trial_end_display = trial_end.strftime('%Y年%m月%d日') if trial_end else ''
        return render_template(
            'dashboard.html',
            user=user,
            total_study_time_display=total_display,
            total_study_time_minutes=total_min,
            role=role,
            user_name=user_name,
            room_id=room_id,
            user_db_id=user.id,
            is_subscribed=user.is_active_subscription,
            plan_type=plan_type,
            subscription_status=sub_status,
            trial_end_display=trial_end_display,
            stripe_price_standard=STRIPE_PRICE_ID_STANDARD,
            stripe_price_pro=STRIPE_PRICE_ID_PRO,
        )
    # Guest (not logged in)
    return render_template(
        'dashboard.html',
        user=None,
        total_study_time_display='--',
        total_study_time_minutes=0,
        role='student',
        user_name='ゲスト',
        room_id='',
        user_db_id=0,
        is_subscribed=False,
        plan_type='free',
        subscription_status='none',
        trial_end_display='',
        stripe_price_standard=STRIPE_PRICE_ID_STANDARD,
        stripe_price_pro=STRIPE_PRICE_ID_PRO,
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
        # DB role を super_admin に昇格
        if current_user.role not in ('mentor', 'super_admin'):
            current_user.role = 'super_admin'
            db.session.commit()
        session['role'] = 'admin'
        session['user_name'] = '管理者'
        return redirect(url_for('admin_dashboard_page'))
    return render_template('admin_login.html', error='パスワードが正しくありません'), 401


# ---------- Admin Dashboard ----------

@app.route('/admin')
@admin_required
def admin_dashboard_page():
    """管理者専用ダッシュボード"""
    return render_template(
        'admin_dashboard.html',
        admin_user=current_user,
        admin_role=current_user.role or 'mentor',
    )


@app.route('/api/admin/toggle_subscription/<int:user_id>', methods=['POST'])
@admin_required
def api_admin_toggle_subscription(user_id):
    """【super_admin限定】生徒のプロプラン有効/無効切り替え"""
    if (current_user.role or 'user') != 'super_admin':
        return jsonify({'ok': False, 'error': 'super_admin only'}), 403
    user = User.query.get(user_id)
    if not user:
        return jsonify({'ok': False, 'error': 'not found'}), 404
    data = request.get_json(silent=True) or {}
    user.is_active_subscription = bool(data.get('is_subscribed', False))
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500
    return jsonify({'ok': True, 'is_subscribed': user.is_active_subscription})


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
@subscription_required
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


@app.route('/api/enter_room', methods=['POST'])
@login_required
def api_enter_room():
    return jsonify({'ok': True})


@app.route('/api/exit_room', methods=['POST'])
@login_required
def api_exit_room():
    session.pop('room', None)
    return jsonify({'ok': True})


@app.route('/api/update_study_time', methods=['POST'])
@login_required
def api_update_study_time():
    data = request.get_json(silent=True) or {}
    minutes = int(data.get('minutes', 0))
    if minutes < 1 or minutes > 10:
        return jsonify({'ok': False, 'error': 'invalid minutes'}), 400
    try:
        current_user.total_study_time = (current_user.total_study_time or 0) + minutes
        db.session.commit()
        total = current_user.total_study_time
        h, m = divmod(total, 60)
        return jsonify({'ok': True, 'total_minutes': total, 'display': f'{h}時間 {m}分'})
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False}), 500


@app.route('/api/get_study_time', methods=['GET'])
@login_required
def api_get_study_time():
    total = current_user.total_study_time or 0
    h, m = divmod(total, 60)
    return jsonify({'total_minutes': total, 'display': f'{h}時間 {m}分'})


@app.route('/api/update_profile', methods=['POST'])
@login_required
def api_update_profile():
    data = request.get_json(silent=True) or {}

    # Only update fields that are present in the request payload
    if 'nickname' in data:
        nickname = (data['nickname'] or '').strip()
        if nickname:
            current_user.name = nickname
            session['user_name'] = nickname

    if 'grade' in data:
        grade = (data['grade'] or '').strip()
        current_user.grade = grade or None

    if 'target_school' in data:
        target_school = (data['target_school'] or '').strip()
        current_user.target_school = target_school or None

    try:
        db.session.commit()
        return jsonify({
            'ok': True,
            'name': current_user.name or '',
            'grade': current_user.grade or '',
            'target_school': current_user.target_school or '',
        })
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500


# ---------- Reservation API ----------

from datetime import date as date_type, datetime as datetime_type

def _today_str():
    return date_type.today().isoformat()


@app.route('/api/reservations', methods=['GET'])
@login_required
def api_get_reservations():
    date_param = request.args.get('date')
    q = StudyReservation.query.filter_by(user_id=current_user.id)
    if date_param:
        q = q.filter_by(date=date_param)
    rows = q.order_by(StudyReservation.date, StudyReservation.time_slot).all()
    return jsonify([{'id': r.id, 'date': r.date, 'time_slot': r.time_slot} for r in rows])


@app.route('/api/reservations', methods=['POST'])
@login_required
def api_create_reservations():
    # Block free-plan users from creating reservations
    if not current_user.is_active_subscription:
        return jsonify({'ok': False, 'error': 'Premium plan required'}), 403

    data = request.get_json(silent=True) or {}
    slots = data.get('slots', [])
    if not slots:
        return jsonify({'ok': False, 'error': 'no slots'}), 400

    today_s = _today_str()
    created = []
    for s in slots:
        d = s.get('date', '')
        ts = s.get('time_slot', '')
        if not d or not ts:
            continue
        if d < today_s:
            return jsonify({'ok': False, 'error': f'過去の日付 {d} には予約できません'}), 400
        # Block past time slots on today
        if d == today_s:
            try:
                slot_time = datetime_type.strptime(d + ' ' + ts, '%Y-%m-%d %H:%M')
                if slot_time <= datetime_type.now():
                    return jsonify({'ok': False, 'error': '過去の時間は予約できません'}), 400
            except ValueError:
                return jsonify({'ok': False, 'error': '無効な時間形式です'}), 400
        existing = StudyReservation.query.filter_by(
            user_id=current_user.id, date=d, time_slot=ts
        ).first()
        if existing:
            continue
        r = StudyReservation(user_id=current_user.id, date=d, time_slot=ts)
        db.session.add(r)
        created.append({'date': d, 'time_slot': ts})

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500

    return jsonify({'ok': True, 'created': created})


@app.route('/api/reservations', methods=['DELETE'])
@login_required
def api_delete_reservations():
    data = request.get_json(silent=True) or {}
    slots = data.get('slots', [])
    if not slots:
        return jsonify({'ok': False, 'error': 'no slots'}), 400

    today_s = _today_str()
    for s in slots:
        d = s.get('date', '')
        if d <= today_s:
            return jsonify({'ok': False, 'error': '当日以前の予約はキャンセルできません'}), 400

    deleted = 0
    for s in slots:
        d = s.get('date', '')
        ts = s.get('time_slot', '')
        r = StudyReservation.query.filter_by(
            user_id=current_user.id, date=d, time_slot=ts
        ).first()
        if r:
            db.session.delete(r)
            deleted += 1

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500

    return jsonify({'ok': True, 'deleted': deleted})


@app.route('/api/next_reservation', methods=['GET'])
@login_required
def api_next_reservation():
    now = datetime_type.now()
    today_s = now.strftime('%Y-%m-%d')
    current_time = now.strftime('%H:%M')

    next_today = StudyReservation.query.filter(
        StudyReservation.user_id == current_user.id,
        StudyReservation.date == today_s,
        StudyReservation.time_slot >= current_time
    ).order_by(StudyReservation.time_slot).first()

    if next_today:
        return jsonify({'date': next_today.date, 'time_slot': next_today.time_slot})

    next_future = StudyReservation.query.filter(
        StudyReservation.user_id == current_user.id,
        StudyReservation.date > today_s
    ).order_by(StudyReservation.date, StudyReservation.time_slot).first()

    if next_future:
        return jsonify({'date': next_future.date, 'time_slot': next_future.time_slot})

    return jsonify(None)


# ---------- Meeting Reservation API ----------

@app.route('/api/meeting_reservations', methods=['GET'])
@login_required
def api_get_meeting_reservations():
    """ログインユーザーの面談予約一覧（scheduled のみ）"""
    rows = MeetingReservation.query.filter_by(
        user_id=current_user.id, status='scheduled'
    ).order_by(MeetingReservation.date, MeetingReservation.time_slot).all()
    return jsonify([{
        'id': r.id, 'date': r.date, 'time_slot': r.time_slot,
        'room_token': r.room_token, 'status': r.status
    } for r in rows])


@app.route('/api/meeting_reservations', methods=['POST'])
@login_required
def api_create_meeting_reservation():
    """面談を1件予約する。1ユーザーにつき scheduled は1件のみ。"""
    data = request.get_json(silent=True) or {}
    d = data.get('date', '')
    ts = data.get('time_slot', '')
    m_type = data.get('meeting_type', 'regular')
    if m_type not in ('initial', 'regular'):
        m_type = 'regular'
    if not d or not ts:
        return jsonify({'ok': False, 'error': '日付・時間は必須です'}), 400

    today_s = _today_str()
    if d < today_s:
        return jsonify({'ok': False, 'error': '過去の日付には予約できません'}), 400
    if d == today_s:
        try:
            slot_time = datetime_type.strptime(d + ' ' + ts, '%Y-%m-%d %H:%M')
            if slot_time <= datetime_type.now():
                return jsonify({'ok': False, 'error': '過去の時間は予約できません'}), 400
        except ValueError:
            return jsonify({'ok': False, 'error': '無効な時間形式です'}), 400

    # --- 面談タイプ別バリデーション ---
    if m_type == 'initial':
        if not current_user.is_within_7_days:
            return jsonify({'ok': False, 'error': '初回面談は登録から7日間限定です'}), 400
        existing_initial = MeetingReservation.query.filter(
            MeetingReservation.user_id == current_user.id,
            MeetingReservation.meeting_type == 'initial',
            MeetingReservation.status.in_(['scheduled', 'completed'])
        ).first()
        if existing_initial:
            return jsonify({'ok': False, 'error': '初回面談は1回限りです'}), 400
    else:
        # regular: 今月2回まで
        now = datetime_type.now()
        month_start = now.strftime('%Y-%m') + '-01'
        month_end_d = now.month + 1
        month_end_y = now.year
        if month_end_d > 12:
            month_end_d = 1
            month_end_y += 1
        month_end = f'{month_end_y}-{str(month_end_d).zfill(2)}-01'
        count = MeetingReservation.query.filter(
            MeetingReservation.user_id == current_user.id,
            MeetingReservation.meeting_type == 'regular',
            MeetingReservation.status.in_(['scheduled', 'completed']),
            MeetingReservation.date >= month_start,
            MeetingReservation.date < month_end
        ).count()
        if count >= 2:
            return jsonify({'ok': False, 'error': '今月の面談枠（2回）はすべて消化済みです'}), 400

    # 既に scheduled がある場合は拒否
    existing = MeetingReservation.query.filter_by(
        user_id=current_user.id, status='scheduled'
    ).first()
    if existing:
        return jsonify({'ok': False, 'error': '既に予約済みの面談があります。キャンセルしてから再予約してください。'}), 400

    # 自習室予約との衝突チェック（同日・同時間帯）
    study_conflict = StudyReservation.query.filter_by(
        user_id=current_user.id, date=d, time_slot=ts
    ).first()
    if study_conflict:
        return jsonify({'ok': False, 'error': 'この時間帯は自習室の予約があります'}), 400

    room_token = uuid.uuid4().hex
    reservation = MeetingReservation(
        user_id=current_user.id,
        date=d,
        time_slot=ts,
        room_token=room_token,
        status='scheduled',
        meeting_type=m_type
    )
    db.session.add(reservation)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500

    return jsonify({
        'ok': True,
        'reservation': {
            'id': reservation.id, 'date': d, 'time_slot': ts,
            'room_token': room_token, 'status': 'scheduled'
        }
    })


@app.route('/api/meeting_reservations', methods=['DELETE'])
@login_required
def api_cancel_meeting_reservation():
    """面談予約をキャンセル"""
    data = request.get_json(silent=True) or {}
    reservation_id = data.get('id')
    if not reservation_id:
        return jsonify({'ok': False, 'error': 'id is required'}), 400
    r = MeetingReservation.query.filter_by(
        id=reservation_id, user_id=current_user.id, status='scheduled'
    ).first()
    if not r:
        return jsonify({'ok': False, 'error': '予約が見つかりません'}), 404
    r.status = 'cancelled'
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500
    return jsonify({'ok': True})


@app.route('/api/next_meeting', methods=['GET'])
@login_required
def api_next_meeting():
    """次の面談予約を返す"""
    now = datetime_type.now()
    today_s = now.strftime('%Y-%m-%d')
    current_time = now.strftime('%H:%M')

    next_today = MeetingReservation.query.filter(
        MeetingReservation.user_id == current_user.id,
        MeetingReservation.status == 'scheduled',
        MeetingReservation.date == today_s,
        MeetingReservation.time_slot >= current_time
    ).order_by(MeetingReservation.time_slot).first()

    if not next_today:
        next_today = MeetingReservation.query.filter(
            MeetingReservation.user_id == current_user.id,
            MeetingReservation.status == 'scheduled',
            MeetingReservation.date > today_s
        ).order_by(MeetingReservation.date, MeetingReservation.time_slot).first()

    if next_today:
        return jsonify({
            'id': next_today.id, 'date': next_today.date,
            'time_slot': next_today.time_slot,
            'room_token': next_today.room_token, 'status': next_today.status
        })
    return jsonify(None)


@app.route('/api/meeting/<room_token>/no_show', methods=['POST'])
@login_required
def api_meeting_no_show(room_token):
    """面談を no_show に更新（30分すっぽかし）"""
    r = MeetingReservation.query.filter_by(room_token=room_token, status='scheduled').first()
    if not r:
        return jsonify({'ok': False, 'error': 'not found'}), 404
    if r.user_id != current_user.id and session.get('role') != 'admin':
        return jsonify({'ok': False, 'error': 'forbidden'}), 403
    r.status = 'no_show'
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500
    return jsonify({'ok': True})


# ---------- Admin: 生徒一覧 & 学習ルート更新 API ----------

@app.route('/api/admin/students', methods=['GET'])
@admin_required
def api_admin_students():
    """管理者向け: 全生徒一覧を返す"""
    users = User.query.order_by(User.id).all()
    return jsonify([{
        'id': u.id, 'name': u.name or '', 'email': u.email or '',
        'role': u.role or 'user',
        'is_subscribed': u.is_active_subscription,
        'learning_route_text': u.learning_route_text or '',
    } for u in users])


@app.route('/api/admin/update_route/<int:user_id>', methods=['POST'])
@admin_required
def api_admin_update_route(user_id):
    """管理者向け: 指定ユーザーの学習ルートを更新"""
    data = request.get_json(silent=True) or {}
    text = data.get('learning_route_text', '')
    user = User.query.get(user_id)
    if not user:
        return jsonify({'ok': False, 'error': 'not found'}), 404
    user.learning_route_text = text
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500
    return jsonify({'ok': True})


# ---------- Admin: 面談予約一覧 API ----------

@app.route('/api/admin/meeting_reservations', methods=['GET'])
@login_required
def api_admin_meeting_reservations():
    """管理者向け: scheduled な面談予約を全件返す"""
    if session.get('role') != 'admin':
        return jsonify({'ok': False, 'error': 'forbidden'}), 403
    rows = MeetingReservation.query.filter_by(status='scheduled').order_by(
        MeetingReservation.date, MeetingReservation.time_slot
    ).all()
    result = []
    for r in rows:
        u = User.query.get(r.user_id)
        result.append({
            'id': r.id, 'user_name': u.name if u else '不明',
            'date': r.date, 'time_slot': r.time_slot,
            'room_token': r.room_token, 'status': r.status
        })
    return jsonify(result)


@app.route('/admin/api/meetings', methods=['GET'])
@login_required
def admin_api_meetings_fullcalendar():
    """管理者向け: FullCalendar形式で面談＋自習室の全予約を返す"""
    if session.get('role') != 'admin':
        return jsonify({'ok': False, 'error': 'forbidden'}), 403
    events = []

    # --- 面談予約 ---
    meetings = MeetingReservation.query.order_by(
        MeetingReservation.date, MeetingReservation.time_slot
    ).all()
    for r in meetings:
        u = User.query.get(r.user_id)
        user_name = u.name if u else '不明'
        start_str = r.date + 'T' + r.time_slot + ':00'
        h, m = map(int, r.time_slot.split(':'))
        end_m = m + 30
        end_h = h + end_m // 60
        end_m = end_m % 60
        end_str = r.date + 'T{:02d}:{:02d}:00'.format(end_h, end_m)
        events.append({
            'id': 'meeting_' + str(r.id),
            'title': '面談: ' + user_name,
            'start': start_str,
            'end': end_str,
            'color': '#c5a880',
            'extendedProps': {
                'type': 'meeting',
                'room_token': r.room_token,
                'status': r.status,
                'meeting_type': r.meeting_type,
                'user_name': user_name
            }
        })

    # --- 自習室予約 ---
    studies = StudyReservation.query.order_by(
        StudyReservation.date, StudyReservation.time_slot
    ).all()
    for r in studies:
        u = User.query.get(r.user_id)
        user_name = u.name if u else '不明'
        start_str = r.date + 'T' + r.time_slot + ':00'
        h, m = map(int, r.time_slot.split(':'))
        end_m = m + 30
        end_h = h + end_m // 60
        end_m = end_m % 60
        end_str = r.date + 'T{:02d}:{:02d}:00'.format(end_h, end_m)
        events.append({
            'id': 'study_' + str(r.id),
            'title': '自習: ' + user_name,
            'start': start_str,
            'end': end_str,
            'color': '#42a5f5',
            'extendedProps': {
                'type': 'study',
                'user_name': user_name
            }
        })

    return jsonify(events)


# ---------- Monthly Report API ----------

@app.route('/api/monthly_report', methods=['GET'])
@login_required
def api_monthly_report():
    """前月の学習レポートを返す。データがなくても 200 で返す。"""
    import calendar as cal_mod
    from datetime import date, timedelta

    today = date.today()
    first_of_month = today.replace(day=1)
    last_day_prev = first_of_month - timedelta(days=1)
    first_day_prev = last_day_prev.replace(day=1)

    prev_month_label = f'{first_day_prev.year}年{first_day_prev.month}月'
    days_in_prev = cal_mod.monthrange(first_day_prev.year, first_day_prev.month)[1]

    # 基本情報は total_study_time (累計分) しかないので、
    # 「前月の study sessions」として概算を返す
    user = current_user
    total_min = user.total_study_time or 0

    if total_min == 0:
        return jsonify({
            'has_data': False,
            'month_label': prev_month_label,
            'message': '先月の学習データはまだありません。今月から学習を記録して、来月のレポート作成を楽しみにしましょう！',
        })

    # 簡易レポート: 概算値を返す
    hours = total_min // 60
    mins = total_min % 60
    return jsonify({
        'has_data': True,
        'month_label': prev_month_label,
        'report': {
            'total_minutes': total_min,
            'total_display': f'{hours}時間 {mins}分',
            'days_in_month': days_in_prev,
        }
    })


# ---------- Notification API ----------

@app.route('/api/notifications', methods=['GET'])
@login_required
def api_get_notifications():
    """ログインユーザーの全通知を新しい順で返す"""
    rows = Notification.query.filter_by(user_id=current_user.id) \
        .order_by(Notification.created_at.desc()).all()
    return jsonify([{
        'id': n.id,
        'category': n.category,
        'title': n.title,
        'message': n.message or '',
        'link_target': n.link_target or '',
        'is_read': n.is_read,
        'created_at': n.created_at.isoformat() if n.created_at else '',
    } for n in rows])


@app.route('/api/notifications/<int:notification_id>/read', methods=['POST'])
@login_required
def api_mark_notification_read(notification_id):
    """通知を既読にする"""
    n = Notification.query.get(notification_id)
    if not n or n.user_id != current_user.id:
        return jsonify({'ok': False, 'error': 'not found'}), 404
    n.is_read = True
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False}), 500
    return jsonify({'ok': True})


@app.route('/api/admin/notifications', methods=['POST'])
@login_required
def api_admin_create_notification():
    """管理者向け: 通知を送信する（個別 or 全体）"""
    if session.get('role') != 'admin':
        return jsonify({'ok': False, 'error': 'forbidden'}), 403
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    message = data.get('message', '').strip()
    category = data.get('category', 'direct')
    link_target = data.get('link_target', '')
    target_user_id = data.get('user_id')  # None = global (全体)

    if not title:
        return jsonify({'ok': False, 'error': 'title required'}), 400

    try:
        if target_user_id:
            create_notification(int(target_user_id), category, title, message, link_target)
        else:
            # 全体通知 — 全ユーザーに送信
            users = User.query.all()
            for u in users:
                n = Notification(
                    user_id=u.id, category='global', title=title,
                    message=message, link_target=link_target,
                )
                db.session.add(n)
            db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({'ok': False, 'error': 'DB error'}), 500
    return jsonify({'ok': True})


# ---------- Meeting Status API ----------

@app.route('/api/meeting_status', methods=['GET'])
@login_required
def api_meeting_status():
    """面談タイプ別のステータスを返す"""
    user = current_user
    is_within = user.is_within_7_days

    has_booked_initial = MeetingReservation.query.filter(
        MeetingReservation.user_id == user.id,
        MeetingReservation.meeting_type == 'initial',
        MeetingReservation.status.in_(['scheduled', 'completed'])
    ).first() is not None

    now = datetime_type.now()
    month_start = now.strftime('%Y-%m') + '-01'
    month_end_d = now.month + 1
    month_end_y = now.year
    if month_end_d > 12:
        month_end_d = 1
        month_end_y += 1
    month_end = f'{month_end_y}-{str(month_end_d).zfill(2)}-01'
    regular_count = MeetingReservation.query.filter(
        MeetingReservation.user_id == user.id,
        MeetingReservation.meeting_type == 'regular',
        MeetingReservation.status.in_(['scheduled', 'completed']),
        MeetingReservation.date >= month_start,
        MeetingReservation.date < month_end
    ).count()

    return jsonify({
        'is_within_7_days': is_within,
        'has_booked_initial': has_booked_initial,
        'remaining_regular_meetings': max(0, 2 - regular_count),
        'is_pro': user.is_active_subscription,
    })


# ---------- Meeting Room ----------

@app.route('/meeting/<room_token>')
@login_required
def meeting_room(room_token):
    """面談ルーム（動的URL）"""
    r = MeetingReservation.query.filter_by(room_token=room_token).first()
    if not r:
        abort(404)
    # 予約者本人 or admin のみ
    is_admin = session.get('role') == 'admin'
    if r.user_id != current_user.id and not is_admin:
        abort(403)
    return render_template(
        'meeting_room.html',
        room_token=room_token,
        meeting_date=r.date,
        meeting_time=r.time_slot,
        meeting_status=r.status,
        user_name=session.get('user_name', current_user.name or ''),
        role=session.get('role', 'student'),
        is_admin=is_admin,
    )


@app.route('/room/<room_id>')
@subscription_required
def room_by_id(room_id):
    session['room'] = room_id
    return redirect(url_for('room'))


@app.route('/logout', methods=['GET', 'POST'])
def logout():
    record_study_time_if_entered()
    logout_user()
    session.clear()

    response = make_response(redirect(url_for('index')))
    # ブラウザのCookieを「ルートパス指定」で物理的に破壊
    response.set_cookie('session', '', expires=0, path='/')
    response.set_cookie('remember_token', '', expires=0, path='/')
    # キャッシュ無効化キラー
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# ---------- Stripe 決済 ----------

@app.route('/create-checkout-session', methods=['POST'])
@login_required
def create_checkout_session():
    """未課金ユーザー向け: Stripe Checkout Session を作成しリダイレクト（旧・フォーム送信版）"""
    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            mode='subscription',
            line_items=[{
                'price': STRIPE_PRICE_ID_STANDARD,
                'quantity': 1,
            }],
            subscription_data={'trial_period_days': 7},
            client_reference_id=str(current_user.id),
            customer_email=current_user.email,
            success_url=url_for('dashboard', _external=True) + '?session_id={CHECKOUT_SESSION_ID}',
            cancel_url=url_for('dashboard', _external=True) + '?canceled=true',
        )
        return redirect(checkout_session.url, code=303)
    except Exception as e:
        app.logger.error(f'Stripe Checkout error: {e}')
        return jsonify(error=str(e)), 500


@app.route('/api/create-checkout-session', methods=['POST'])
@login_required
def api_create_checkout_session():
    """API版: price_id を受け取り Stripe Checkout Session URL を返す（7日間無料トライアル付き）"""
    data = request.get_json(silent=True) or {}
    price_id = data.get('price_id', '').strip()
    if not price_id:
        return jsonify({'ok': False, 'error': 'price_id is required'}), 400
    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            mode='subscription',
            line_items=[{'price': price_id, 'quantity': 1}],
            subscription_data={'trial_period_days': 7},
            client_reference_id=str(current_user.id),
            customer_email=current_user.email,
            success_url=url_for('dashboard', _external=True) + '?session_id={CHECKOUT_SESSION_ID}',
            cancel_url=url_for('dashboard', _external=True) + '?canceled=true',
        )
        return jsonify({'ok': True, 'url': checkout_session.url})
    except Exception as e:
        app.logger.error(f'Stripe API Checkout error: {e}')
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/create-portal-session', methods=['POST'])
@login_required
def create_portal_session():
    """課金済みユーザー向け: Stripe Customer Portal Session を作成しリダイレクト"""
    if not current_user.stripe_customer_id:
        return redirect(url_for('subscription_page'))
    try:
        portal_session = stripe.billing_portal.Session.create(
            customer=current_user.stripe_customer_id,
            return_url=url_for('dashboard', _external=True),
        )
        return redirect(portal_session.url, code=303)
    except Exception as e:
        app.logger.error(f'Stripe Portal error: {e}')
        return jsonify(error=str(e)), 500


@app.route('/subscription')
@login_required
def subscription_page():
    """サブスクリプション案内ページ"""
    return render_template(
        'subscription.html',
        user=current_user,
        stripe_publishable_key=STRIPE_PUBLISHABLE_KEY,
    )


# ---------- Stripe Webhook ----------

@app.route('/stripe/webhook', methods=['POST'])
def stripe_webhook():
    """Stripe からのイベントを受信し、DB を更新する。署名検証必須。"""
    payload = request.get_data()
    sig_header = request.headers.get('Stripe-Signature')

    # --- 署名検証 ---
    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except ValueError:
        app.logger.warning('Stripe webhook: invalid payload')
        return 'Invalid payload', 400
    except stripe.error.SignatureVerificationError:
        app.logger.warning('Stripe webhook: signature verification failed')
        return 'Invalid signature', 400

    event_type = event['type']
    data_object = event['data']['object']

    def _resolve_plan_type(sub_obj):
        """Stripe subscription の price から plan_type を判定"""
        try:
            items = sub_obj.get('items', {}).get('data', [])
            if items:
                price_id = items[0].get('price', {}).get('id', '')
                if price_id == STRIPE_PRICE_ID_PRO:
                    return 'pro'
                return 'standard'
        except Exception:
            pass
        return 'standard'

    def _update_subscription_fields(user, sub_obj):
        """subscription オブジェクトから user のプラン情報を一括更新"""
        status = sub_obj.get('status', '')
        user.subscription_status = status
        user.is_active_subscription = status in ('active', 'trialing')
        user.plan_type = _resolve_plan_type(sub_obj) if status in ('active', 'trialing') else 'free'
        trial_end = sub_obj.get('trial_end')
        if trial_end:
            user.trial_end_date = dt_datetime.utcfromtimestamp(trial_end)
        else:
            user.trial_end_date = None

    # --- checkout.session.completed: 決済完了 ---
    if event_type == 'checkout.session.completed':
        client_ref_id = data_object.get('client_reference_id')
        stripe_customer_id = data_object.get('customer')
        stripe_subscription_id = data_object.get('subscription')

        if client_ref_id:
            user = User.query.get(int(client_ref_id))
            if user:
                user.stripe_customer_id = stripe_customer_id
                user.stripe_subscription_id = stripe_subscription_id
                user.is_active_subscription = True
                # Stripe から subscription を取得して詳細を反映
                if stripe_subscription_id:
                    try:
                        sub = stripe.Subscription.retrieve(stripe_subscription_id)
                        _update_subscription_fields(user, sub)
                    except Exception as e:
                        app.logger.warning(f'Webhook: failed to retrieve subscription: {e}')
                db.session.commit()
                app.logger.info(
                    f'Subscription activated: user_id={user.id}, '
                    f'customer={stripe_customer_id}, plan={user.plan_type}'
                )
            else:
                app.logger.warning(
                    f'Webhook: user not found for client_reference_id={client_ref_id}'
                )

    # --- customer.subscription.created / updated ---
    elif event_type in ('customer.subscription.created', 'customer.subscription.updated'):
        stripe_customer_id = data_object.get('customer')
        if stripe_customer_id:
            user = User.query.filter_by(
                stripe_customer_id=stripe_customer_id
            ).first()
            if user:
                _update_subscription_fields(user, data_object)
                db.session.commit()
                app.logger.info(
                    f'Subscription {event_type.split(".")[-1]}: user_id={user.id}, '
                    f'status={user.subscription_status}, plan={user.plan_type}'
                )

    # --- customer.subscription.deleted: 解約 ---
    elif event_type == 'customer.subscription.deleted':
        stripe_customer_id = data_object.get('customer')
        if stripe_customer_id:
            user = User.query.filter_by(
                stripe_customer_id=stripe_customer_id
            ).first()
            if user:
                user.is_active_subscription = False
                user.plan_type = 'free'
                user.subscription_status = 'canceled'
                user.trial_end_date = None
                db.session.commit()
                app.logger.info(
                    f'Subscription canceled: user_id={user.id}, '
                    f'customer={stripe_customer_id}'
                )

    return 'OK', 200


# ---------- AI 目標判定＋応援 API ----------

GOAL_COACH_SYSTEM_PROMPT = (
    "あなたは厳格かつ熱血な学習コーチです。ユーザーの入力を以下の優先順位で判定してください。\n\n"
    "【判定ルール（優先順位順に必ず守ること）】\n"
    "ルール1（最優先）: 内容が「勉強・学習・作業・読書・自己研鑽」に明確に関連しているか？\n"
    "  - 無関係な内容、ふざけた内容、意味不明な文、下品・不適切な言葉、公序良俗に反する表現が"
    "少しでも含まれていたら、絶対に不合格（is_valid: false）。\n"
    '  - comment: 「勉強に関連する目標を入力してくださいね！（例：英単語を30個覚える）」\n\n'
    "ルール2: 学習に関連していても、具体的な数字（ページ数、時間、問題数、単語数など）が含まれていなければ不合格（is_valid: false）。\n"
    '  - comment: 「もっと数字を入れて具体的にしましょう！（例：数学を3ページ進める）」\n\n'
    "ルール3: ルール1とルール2の両方をクリアした場合のみ合格（is_valid: true）。\n"
    "  - comment: 1〜2文で短く熱い応援コメントを返す。\n\n"
    "【判定例】\n"
    "- 「うんこ食べる」→ 学習と無関係 → 不合格（ルール1）\n"
    "- 「ゲームする」→ 学習と無関係 → 不合格（ルール1）\n"
    "- 「あああああ」→ 意味不明 → 不合格（ルール1）\n"
    "- 「数学をやる」→ 学習だが数字なし → 不合格（ルール2）\n"
    "- 「英語を勉強する」→ 学習だが数字なし → 不合格（ルール2）\n"
    "- 「数学の問題集の10〜12ページを解く」→ 学習＋数字あり → 合格（ルール3）\n"
    "- 「英単語を50個覚える」→ 学習＋数字あり → 合格（ルール3）\n"
    "- 「TOEICの模試を1回分解く」→ 学習＋数字あり → 合格（ルール3）\n\n"
    '出力は必ずJSON形式で、{"is_valid": true/false, "comment": "メッセージ"} のみを出力すること。'
)


@app.route('/api/validate_goal', methods=['POST'])
@login_required
def validate_goal():
    data = request.get_json(silent=True) or {}
    goal_text = (data.get('goal') or '').strip()
    if not goal_text:
        return jsonify({'is_valid': False, 'comment': '目標を入力してください。'})

    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        app.logger.warning('GEMINI_API_KEY is not set')
        return jsonify({'is_valid': True, 'comment': '今日も頑張ろう！応援しています！'})

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(
            'gemini-2.0-flash-lite',
            system_instruction=GOAL_COACH_SYSTEM_PROMPT,
            generation_config=genai.types.GenerationConfig(
                temperature=0.5,
                max_output_tokens=200,
            ),
        )
        response = model.generate_content(
            f'以下の学習目標を判定してください:\n\n{goal_text}'
        )
        content = response.text.strip()
        # #region agent log
        _dl = os.path.join(os.path.dirname(__file__), 'debug-0ccf34.log')
        with open(_dl, 'a', encoding='utf-8') as _f:
            _f.write(json.dumps({'sessionId':'0ccf34','location':'app.py:raw_response','message':'Gemini raw response','data':{'raw_content':content,'goal_text':goal_text},'timestamp':__import__('time').time()*1000,'hypothesisId':'H1,H3'},ensure_ascii=False)+'\n')
        # #endregion
        if content.startswith('```'):
            content = content.split('\n', 1)[-1]
            content = content.rsplit('```', 1)[0].strip()
        # #region agent log
        with open(_dl, 'a', encoding='utf-8') as _f:
            _f.write(json.dumps({'sessionId':'0ccf34','location':'app.py:after_strip','message':'After markdown strip','data':{'stripped_content':content},'timestamp':__import__('time').time()*1000,'hypothesisId':'H1'},ensure_ascii=False)+'\n')
        # #endregion
        result = json.loads(content)
        # #region agent log
        with open(_dl, 'a', encoding='utf-8') as _f:
            _f.write(json.dumps({'sessionId':'0ccf34','location':'app.py:parsed_result','message':'Parsed JSON result','data':{'is_valid':result.get('is_valid'),'comment':result.get('comment',''),'has_is_valid_key':'is_valid' in result},'timestamp':__import__('time').time()*1000,'hypothesisId':'H3,H5'},ensure_ascii=False)+'\n')
        # #endregion
        return jsonify({
            'is_valid': bool(result.get('is_valid', True)),
            'comment': result.get('comment', '頑張りましょう！'),
        })
    except Exception as e:
        # #region agent log
        _dl = os.path.join(os.path.dirname(__file__), 'debug-0ccf34.log')
        with open(_dl, 'a', encoding='utf-8') as _f:
            _f.write(json.dumps({'sessionId':'0ccf34','location':'app.py:exception','message':'Exception in validate_goal','data':{'error':str(e),'error_type':type(e).__name__},'timestamp':__import__('time').time()*1000,'hypothesisId':'H2'},ensure_ascii=False)+'\n')
        # #endregion
        app.logger.error(f'Goal coach error: {e}')
        return jsonify({'is_valid': True, 'comment': '今日も一歩ずつ前進しよう！応援しています！'})


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
    # safe column migration for existing tables
    with db.engine.connect() as conn:
        import sqlalchemy
        insp = sqlalchemy.inspect(db.engine)
        existing = [c['name'] for c in insp.get_columns('users')]
        if 'grade' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN grade VARCHAR(32)"))
            conn.commit()
        if 'target_school' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN target_school VARCHAR(256)"))
            conn.commit()
        if 'has_used_free_meeting' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN has_used_free_meeting BOOLEAN DEFAULT FALSE"))
            conn.commit()
        if 'has_used_pro_meeting' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN has_used_pro_meeting BOOLEAN DEFAULT FALSE"))
            conn.commit()
        if 'learning_route_text' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN learning_route_text TEXT"))
            conn.commit()
        if 'role' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user'"))
            conn.commit()
        if 'created_at' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN created_at TIMESTAMP"))
            conn.commit()
        # --- Stripe subscription columns ---
        if 'stripe_customer_id' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255)"))
            conn.commit()
        if 'stripe_subscription_id' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN stripe_subscription_id VARCHAR(255)"))
            conn.commit()
        if 'is_active_subscription' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN is_active_subscription BOOLEAN DEFAULT FALSE"))
            conn.commit()
        if 'plan_type' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN plan_type VARCHAR(20) DEFAULT 'free'"))
            conn.commit()
        if 'subscription_status' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN subscription_status VARCHAR(30) DEFAULT 'none'"))
            conn.commit()
        if 'trial_end_date' not in existing:
            conn.execute(sqlalchemy.text("ALTER TABLE users ADD COLUMN trial_end_date TIMESTAMP"))
            conn.commit()
        # meeting_reservations table
        mr_cols = [c['name'] for c in insp.get_columns('meeting_reservations')]
        if 'meeting_type' not in mr_cols:
            conn.execute(sqlalchemy.text("ALTER TABLE meeting_reservations ADD COLUMN meeting_type VARCHAR(10) DEFAULT 'regular'"))
            conn.commit()

if __name__ == '__main__':
    # ローカル開発時のみ（Render では gunicorn で起動する）
    port = int(os.environ.get("PORT", 10000))
    print("--- 他端末でカメラを使う場合: README.md の「他端末からアクセスする場合（HTTPS）」を参照 ---")
    socketio.run(app, debug=True, port=port, host='0.0.0.0', allow_unsafe_werkzeug=True)
