"""
Video Desk — 自習室アプリ

他端末（スマホ等）からローカルIPでアクセスする場合、カメラは HTTPS でないと利用できません。
ngrok / cloudflared で HTTPS 公開する手順は README.md の「他端末からアクセスする場合」を参照してください。
"""
import os
import secrets
import eventlet
from flask import Flask, render_template, request, redirect, url_for, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from dotenv import load_dotenv

# ローカル .env を読む（Render 等で設定した環境変数は上書きしない＝Render の値を優先）
load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'secret!')
# Render では gunicorn + eventlet で起動するため、async_mode を eventlet に統一
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

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


def build_room_state(room_id):
    """メインルーム用: 最大4スロットの参加者リストとホストsidを返す。"""
    if not is_main_room(room_id) or room_id not in room_participants:
        return {'participants': [], 'host_sid': None}
    plist = room_participants[room_id]
    host_sid = plist[0]['sid'] if plist else None
    # 各スロットを { sid, user_name, role, connected, is_host } で送る（空きは送らないのでクライアントで4枠にパディング）
    participants = []
    for i, p in enumerate(plist):
        participants.append({
            'sid': p['sid'],
            'user_name': p.get('user_name', ''),
            'role': p.get('role', 'student'),
            'connected': p.get('connected', True),
            'is_host': (i == 0),
        })
    return {'participants': participants, 'host_sid': host_sid}


# ---------- Routes ----------

@app.route('/')
def index():
    if session.get('role'):
        return redirect(url_for('room'))
    room_from_url = request.args.get('room') or request.args.get('room_id')
    show_admin_form = request.args.get('form') == 'admin'
    return render_template('landing.html', room_from_url=room_from_url, show_admin_form=show_admin_form, error=None)


@app.route('/enter', methods=['POST'])
def enter():
    name = (request.form.get('name') or '').strip()
    if not name:
        return render_template('landing.html', error='名前を入力してください', room_from_url=request.form.get('room'), show_admin_form=False), 400
    session['role'] = 'student'
    session['user_name'] = name[:50]
    room = (request.form.get('room') or '').strip()
    if room:
        session['room'] = room
    return redirect(url_for('room'))


@app.route('/admin_login', methods=['GET', 'POST'])
def admin_login():
    if session.get('role') == 'admin':
        return redirect(url_for('room'))
    room_from_url = request.args.get('room') or (request.form.get('room') if request.method == 'POST' else None)
    if request.method == 'GET':
        kwargs = {'form': 'admin'}
        if request.args.get('room'):
            kwargs['room'] = request.args.get('room')
        return redirect(url_for('index', **kwargs))
    if request.method == 'POST':
        password = request.form.get('password', '')
        admin_password = os.environ.get('ADMIN_PASSWORD', '')
        if admin_password and password == admin_password:
            session['role'] = 'admin'
            session['user_name'] = '管理者'
            if request.form.get('room'):
                session['room'] = request.form.get('room')
            return redirect(url_for('room'))
        return render_template('landing.html', error='パスワードが正しくありません', room_from_url=room_from_url, show_admin_form=True), 401


@app.route('/room')
def room():
    if not session.get('role'):
        room_arg = request.args.get('room')
        if room_arg:
            return redirect(url_for('index', room=room_arg))
        return redirect(url_for('index'))
    room_arg = request.args.get('room')
    if room_arg and not session.get('room'):
        session['room'] = room_arg
    if not session.get('room'):
        session['room'] = secrets.token_hex(4)
    return render_template(
        'room.html',
        role=session.get('role'),
        user_name=session.get('user_name', ''),
        room_id=session.get('room'),
    )


@app.route('/room/<room_id>')
def room_by_id(room_id):
    """招待URL /room/<room_id> 用。未ログインならランディングへ、ログイン済みならそのルームへ。"""
    if not session.get('role'):
        return redirect(url_for('index', room=room_id))
    session['room'] = room_id
    return redirect(url_for('room'))


@app.route('/logout')
def logout():
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
    user_id = (data.get('user_id') or '').strip()
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

    # 1) 招待URLで指定ルームへ（空きがあれば）。満室なら新規ルームへ強制
    if req_room and is_main_room(req_room):
        if req_room in room_participants and len(room_participants[req_room]) >= 4:
            req_room = None  # 5人目は別室へ
        elif req_room in room_participants and len(room_participants[req_room]) < 4:
            room = req_room

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
    if old_room and old_room != room and is_main_room(old_room):
        leave_room(old_room)
    join_room(room)
    sid_to_room[sid] = room

    plist.append({
        'sid': sid,
        'user_name': user_name,
        'role': role,
        'user_id': user_id or None,
        'connected': True,
    })
    room_users.setdefault(room, {})[sid] = {"user_name": user_name, "role": role}
    hand_raise_states.setdefault(room, {})[sid] = False

    is_host = (len(plist) == 1)
    emit('room_assigned', {'room_id': room, 'is_host': is_host}, room=sid)
    emit('room_state', build_room_state(room), room=room)
    emit('hand_states', {"states": get_hand_states(room)}, room=room)
    emit('request_offer_to', {'new_sid': sid}, room=room, include_self=False)


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
    """同一メインルームにいるか（ICE/offer/answer の送信先チェック）"""
    if not target_sid or not sid:
        return False
    r1 = sid_to_room.get(sid)
    r2 = sid_to_room.get(target_sid)
    return r1 and r2 and r1 == r2 and is_main_room(r1)


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
                            emit('room_state', build_room_state(room), room=room)
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


if __name__ == '__main__':
    # ローカル開発時のみ（Render では gunicorn で起動する）
    port = int(os.environ.get("PORT", 10000))
    print("--- 他端末でカメラを使う場合: README.md の「他端末からアクセスする場合（HTTPS）」を参照 ---")
    socketio.run(app, debug=True, port=port, host='0.0.0.0', allow_unsafe_werkzeug=True)
