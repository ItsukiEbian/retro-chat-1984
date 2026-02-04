from flask import Flask, render_template
from flask_socketio import SocketIO, emit
from pyngrok import ngrok
import os
import sys

# Initialize Flask
app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'

# Initialize SocketIO
# Initialize SocketIO
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Store connected users (simple implementation)
connected_users = []

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('connect')
def on_connect():
    # request.sid needs request imported? No, flask_socketio provides request context implicitly usually,
    # but strictly speaking `from flask import request` is needed if we use it explicitly.
    # However, existing code used `request` in `user_joined` without import shown in the view?
    # Wait, the view showed `from flask import Flask, render_template`. missing `request`.
    # I should add `request` to imports if I touch them, but here I am replacing lines 12-70.
    # I will stick to what was there or make it safe.
    from flask import request
    print(f'User connected: {request.sid}')

@socketio.on('join_room')
def on_join(data):
    from flask import request
    room = data['room']
    print(f'User joined room: {room}')
    emit('user_joined', {'sid': request.sid}, broadcast=True, include_self=False)

@socketio.on('offer')
def on_offer(data):
    print(f"Relaying offer to {data.get('target')}")
    emit('offer', data, room=data['target'])

@socketio.on('answer')
def on_answer(data):
    print(f"Relaying answer to {data.get('target')}")
    emit('answer', data, room=data['target'])

@socketio.on('ice_candidate')
def on_candidate(data):
    print(f"Relaying ICE candidate to {data.get('target')}")
    emit('ice_candidate', data, room=data['target'])

@socketio.on('disconnect')
def on_disconnect():
    from flask import request
    print(f'User disconnected: {request.sid}')
    emit('user_left', {'sid': request.sid}, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    socketio.run(app, debug=True, port=port, host='0.0.0.0', allow_unsafe_werkzeug=True)
