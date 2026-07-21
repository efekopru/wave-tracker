#!/usr/bin/env python3
"""Deploy script — run on the DevSpace to write all wave-tracker files."""
import os, base64, json

BASE = os.path.expanduser('~/wave-tracker')
os.makedirs(BASE, exist_ok=True)

# ── server.py ─────────────────────────────────────────────────────────────────
SERVER = """import os, json, secrets, hashlib
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
STATE_FILE   = os.path.join(BASE_DIR, 'state.json')
DATA_JS_FILE = os.path.join(BASE_DIR, 'data.js')
PORT         = 8080

PASSWORDS = {
    hashlib.sha256(b'containersa').hexdigest():      'associate',
    hashlib.sha256(b'containermanager').hexdigest(): 'manager',
}
sessions = {}
SESSION_TTL_HOURS = 12

app = Flask(__name__, static_folder=BASE_DIR)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

def load_state():
    if os.path.isfile(STATE_FILE):
        try:
            with open(STATE_FILE) as f: return json.load(f)
        except: pass
    return {}

def save_state(s):
    with open(STATE_FILE, 'w') as f: json.dump(s, f, indent=2)

def make_token(): return secrets.token_hex(32)

def get_role(token):
    if not token or token not in sessions: return None
    s = sessions[token]
    if datetime.utcnow() - datetime.fromisoformat(s['created_at']) > timedelta(hours=SESSION_TTL_HOURS):
        del sessions[token]; return None
    return s['role']

def require_role(min_role='associate'):
    token = request.headers.get('X-Token') or request.args.get('token')
    role  = get_role(token)
    if not role: return None, (jsonify({'error': 'Unauthorised'}), 401)
    if min_role == 'manager' and role != 'manager':
        return None, (jsonify({'error': 'Manager access required'}), 403)
    return role, None

@app.route('/')
def index(): return send_from_directory(BASE_DIR, 'app.html')
@app.route('/app.js')
def appjs(): return send_from_directory(BASE_DIR, 'app.js')
@app.route('/data.js')
def datajs(): return send_from_directory(BASE_DIR, 'data.js')
@app.route('/ping')
def ping(): return jsonify({'ok': True, 'time': datetime.utcnow().isoformat()})

@app.route('/api/login', methods=['POST'])
def login():
    body = request.get_json(silent=True) or {}
    hashed = hashlib.sha256(body.get('password','').encode()).hexdigest()
    role = PASSWORDS.get(hashed)
    if not role: return jsonify({'error': 'Incorrect password'}), 401
    token = make_token()
    sessions[token] = {'role': role, 'created_at': datetime.utcnow().isoformat()}
    return jsonify({'token': token, 'role': role})

@app.route('/api/logout', methods=['POST'])
def logout():
    sessions.pop(request.headers.get('X-Token'), None)
    return jsonify({'ok': True})

@app.route('/api/me')
def me():
    token = request.headers.get('X-Token') or request.args.get('token')
    role = get_role(token)
    if not role: return jsonify({'error': 'Unauthorised'}), 401
    return jsonify({'role': role})

@app.route('/api/state')
def get_state():
    _, err = require_role('associate')
    if err: return err
    return jsonify(load_state())

@app.route('/api/checkin', methods=['POST'])
def checkin():
    _, err = require_role('associate')
    if err: return err
    body = request.get_json(silent=True) or {}
    wi, route, checked, ts = str(body.get('waveIdx')), body.get('route'), body.get('checked', True), body.get('time', '')
    if not route: return jsonify({'error': 'Missing route'}), 400
    state = load_state()
    if wi not in state: state[wi] = {}
    if checked: state[wi][route] = {'time': ts, 'uniform': False}
    else: state[wi].pop(route, None)
    save_state(state)
    socketio.emit('state_update', {'waveIdx': wi, 'route': route, 'checked': checked,
                                   'time': ts, 'uniform': state[wi].get(route, {}).get('uniform', False)})
    return jsonify({'ok': True})

@app.route('/api/uniform', methods=['POST'])
def uniform():
    _, err = require_role('associate')
    if err: return err
    body = request.get_json(silent=True) or {}
    wi, route, value = str(body.get('waveIdx')), body.get('route'), body.get('uniform', True)
    if not route: return jsonify({'error': 'Missing route'}), 400
    state = load_state()
    if wi not in state: state[wi] = {}
    if route not in state[wi]: state[wi][route] = {'time': datetime.now().strftime('%H:%M'), 'uniform': False}
    state[wi][route]['uniform'] = value
    save_state(state)
    socketio.emit('uniform_update', {'waveIdx': wi, 'route': route, 'uniform': value})
    return jsonify({'ok': True})

@app.route('/api/reset_wave', methods=['POST'])
def reset_wave():
    _, err = require_role('manager')
    if err: return err
    wi = str((request.get_json(silent=True) or {}).get('waveIdx'))
    s = load_state(); s.pop(wi, None); save_state(s)
    socketio.emit('wave_reset', {'waveIdx': wi})
    return jsonify({'ok': True})

@app.route('/api/reset_all', methods=['POST'])
def reset_all():
    _, err = require_role('manager')
    if err: return err
    save_state({}); socketio.emit('full_reset', {})
    return jsonify({'ok': True})

@app.route('/api/import_data', methods=['POST'])
def import_data():
    _, err = require_role('manager')
    if err: return err
    body = request.get_json(silent=True) or {}
    content = body.get('content')
    if not content or 'const WAVES' not in content:
        return jsonify({'error': 'Invalid data.js'}), 400
    if os.path.isfile(DATA_JS_FILE):
        with open(DATA_JS_FILE) as f: old = f.read()
        with open(DATA_JS_FILE + '.bak', 'w') as f: f.write(old)
    with open(DATA_JS_FILE, 'w') as f: f.write(content)
    save_state({}); socketio.emit('data_reloaded', {})
    return jsonify({'ok': True})

@socketio.on('connect')
def on_connect(): pass

if __name__ == '__main__':
    import socket as _s
    try:
        s2 = _s.socket(_s.AF_INET, _s.SOCK_DGRAM); s2.connect(('8.8.8.8', 80))
        ip = s2.getsockname()[0]; s2.close()
    except: ip = '127.0.0.1'
    print('=' * 50)
    print('  DNX3 Wave Tracker')
    print(f'  Local:   http://localhost:{PORT}')
    print(f'  Network: http://{ip}:{PORT}')
    print('=' * 50)
    socketio.run(app, host='0.0.0.0', port=PORT, debug=False)
"""

# ── keepalive.sh ──────────────────────────────────────────────────────────────
KEEPALIVE = """#!/bin/bash
# Keep-alive ping — runs every 9 hours via cron
curl -s http://localhost:8080/ping >> ~/wave-tracker/keepalive.log 2>&1
echo " pinged at $(date)" >> ~/wave-tracker/keepalive.log
"""

# ── start.sh ──────────────────────────────────────────────────────────────────
START = """#!/bin/bash
cd ~/wave-tracker
pkill -f "python.*server.py" 2>/dev/null || true
sleep 1
nohup python3 server.py > ~/wave-tracker/tracker.log 2>&1 &
echo "Started PID $!"
sleep 2
curl -s http://localhost:8080/ping && echo " Server is up" || echo " Server failed to start"
"""

# Write all files
files = {
    'server.py':    SERVER,
    'keepalive.sh': KEEPALIVE,
    'start.sh':     START,
}

for name, content in files.items():
    path = os.path.join(BASE, name)
    with open(path, 'w', newline='\n') as f:
        f.write(content.lstrip('\n'))
    print(f'wrote {name}')

os.chmod(os.path.join(BASE, 'keepalive.sh'), 0o755)
os.chmod(os.path.join(BASE, 'start.sh'), 0o755)
print('All files written OK')
