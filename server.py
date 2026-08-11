"""
DNX3 Wave Tracker — Local Network Server
=========================================
Flask + SocketIO server for real-time multi-device sync.

Roles:
  Associate (set via ASSOCIATE_PASSWORD env var)
  Manager   (set via MANAGER_PASSWORD env var)

Run:  python server.py
      Then open http://<this-pc-ip>:8080 on any device
"""

import os
import json
import secrets
import hashlib
import re
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory, abort
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import requests

# — Config ————————————————————————————————————————————————————————
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
STATE_FILE   = os.path.join(BASE_DIR, 'state.json')
NOTES_FILE   = os.path.join(BASE_DIR, 'notes.json')
SCANLOG_FILE = os.path.join(BASE_DIR, 'scanlog.json')
DATA_JS_FILE = os.path.join(BASE_DIR, 'data.js')
PORT         = int(os.environ.get('PORT', 8080))

# Slack webhook URL — read from env var, fallback for local dev
SETTINGS_FILE = os.path.join(BASE_DIR, 'settings.json')

def load_settings():
    if os.path.isfile(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {
        'slack_webhook_url': 'https://hooks.slack.com/triggers/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',
        'slack_enabled': False,
        'dsp_webhooks': {
            'ADGH': 'https://hooks.slack.com/triggers/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',
            'ALGK': 'https://hooks.slack.com/triggers/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',
            'CAEX': 'https://hooks.slack.com/triggers/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',
            'DERD': 'https://hooks.slack.com/triggers/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',
            'INFG': 'https://hooks.slack.com/triggers/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',
            'KLBZ': 'https://hooks.slack.com/triggers/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',
            'LMDD': 'https://hooks.slack.com/triggers/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',
            'PHDI': 'https://hooks.slack.com/triggers/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',
            'TORS': 'https://hooks.slack.com/triggers/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'
        }
    }

def save_settings(s):
    with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
        json.dump(s, f, indent=2)
def get_slack_webhook(dsp=None):
    """Get webhook URL. If dsp given, only return DSP-specific webhook — no fallback."""
    settings = load_settings()
    if dsp:
        dsp_hooks = settings.get('dsp_webhooks', {})
        if dsp in dsp_hooks and dsp_hooks[dsp]:
            return dsp_hooks[dsp]
        return ''  # DSP specified but no webhook configured — send nothing
    return settings.get('slack_webhook_url') or os.environ.get('SLACK_WEBHOOK_URL', '')

# Passwords — read from environment variables (set in Render dashboard)
# Fallbacks are for local development only
ASSOCIATE_PW = os.environ.get('ASSOCIATE_PASSWORD', 'containersa')
MANAGER_PW   = os.environ.get('MANAGER_PASSWORD', 'containermanager')

PASSWORDS = {
    hashlib.sha256(ASSOCIATE_PW.encode()).hexdigest(): 'associate',
    hashlib.sha256(MANAGER_PW.encode()).hexdigest():   'manager',
}

# In-memory session store: token -> { role, created_at }
sessions = {}
SESSION_TTL_HOURS = 12

# Server-side dedup for late alerts — resets daily
# key: "YYYY-MM-DD_waveIndex_route"
_late_alerted: set = set()
_late_alerted_date: str = ''

def already_alerted(wave_time: str, route: str) -> bool:
    """Return True if this route+wave was already alerted today. Records it if not."""
    global _late_alerted, _late_alerted_date
    today = datetime.utcnow().strftime('%Y-%m-%d')
    if today != _late_alerted_date:
        _late_alerted = set()
        _late_alerted_date = today
    key = f"{today}_{wave_time}_{route}"
    if key in _late_alerted:
        return True
    _late_alerted.add(key)
    return False

app = Flask(__name__, static_folder=BASE_DIR, static_url_path='')
CORS(app)
try:
    import gevent
    async_mode = 'gevent'
except ImportError:
    async_mode = 'threading'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode=async_mode)

# — State helpers ———————————————————————————————————————————————

def load_state():
    if os.path.isfile(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_state(state):
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=2)

def load_notes():
    """Load notes with backward compatibility.
    Old format: { "route": "text string" }
    New format: { "route": {"text": "...", "otd": false} }
    On read, migrate old string values to new format."""
    if os.path.isfile(NOTES_FILE):
        try:
            with open(NOTES_FILE, 'r', encoding='utf-8') as f:
                raw = json.load(f)
            # Migrate old format
            migrated = False
            for route, val in raw.items():
                if isinstance(val, str):
                    raw[route] = {"text": val, "otd": False}
                    migrated = True
                elif isinstance(val, dict):
                    # Ensure both keys exist
                    if "text" not in val:
                        val["text"] = ""
                    if "otd" not in val:
                        val["otd"] = False
            if migrated:
                save_notes(raw)
            return raw
        except Exception:
            pass
    return {}

def save_notes(notes):
    with open(NOTES_FILE, 'w', encoding='utf-8') as f:
        json.dump(notes, f, indent=2)

def load_scanlog():
    if os.path.isfile(SCANLOG_FILE):
        try:
            with open(SCANLOG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return []

def save_scanlog(scanlog):
    with open(SCANLOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(scanlog, f, indent=2)

# — Auth helpers ————————————————————————————————————————————————

def make_token():
    return secrets.token_hex(32)

def get_role(token):
    """Return role string or None if invalid/expired."""
    if not token or token not in sessions:
        return None
    s = sessions[token]
    created = datetime.fromisoformat(s['created_at'])
    if datetime.utcnow() - created > timedelta(hours=SESSION_TTL_HOURS):
        del sessions[token]
        return None
    return s['role']

def require_role(min_role='associate'):
    """Return (role, error_response). error_response is None if OK."""
    token = request.headers.get('X-Token') or request.args.get('token')
    role  = get_role(token)
    if not role:
        return None, (jsonify({'error': 'Unauthorised'}), 401)
    if min_role == 'manager' and role != 'manager':
        return None, (jsonify({'error': 'Manager access required'}), 403)
    return role, None

# — Slack helpers ——————————————————————————————————————————————

def send_slack_message(text, dsp=None):
    """Send a fully formatted message to the Slack webhook."""
    webhook = get_slack_webhook(dsp=dsp)
    if not webhook:
        return False
    try:
        resp = requests.post(webhook, json={"text": text}, timeout=10)
        return resp.status_code == 200
    except Exception:
        return False

# — Static files ————————————————————————————————————————————————

@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'app.html')

@app.route('/data.js')
def datajs():
    return send_from_directory(BASE_DIR, 'data.js')

@app.route('/app.js')
def appjs():
    return send_from_directory(BASE_DIR, 'app.js', max_age=0)

@app.route('/ping')
def ping():
    return jsonify({'ok': True, 'time': datetime.utcnow().isoformat()})

# — Auth endpoints ——————————————————————————————————————————————

@app.route('/api/login', methods=['POST'])
def login():
    body     = request.get_json(silent=True) or {}
    password = body.get('password', '')
    hashed   = hashlib.sha256(password.encode()).hexdigest()
    role     = PASSWORDS.get(hashed)
    if not role:
        return jsonify({'error': 'Incorrect password'}), 401
    token = make_token()
    sessions[token] = {'role': role, 'created_at': datetime.utcnow().isoformat()}
    return jsonify({'token': token, 'role': role})

@app.route('/api/logout', methods=['POST'])
def logout():
    token = request.headers.get('X-Token')
    sessions.pop(token, None)
    return jsonify({'ok': True})

@app.route('/api/me')
def me():
    token = request.headers.get('X-Token') or request.args.get('token')
    role  = get_role(token)
    if not role:
        return jsonify({'error': 'Unauthorised'}), 401
    return jsonify({'role': role})

# — State endpoints —————————————————————————————————————————————

@app.route('/api/state')
def get_state():
    _, err = require_role('associate')
    if err: return err
    return jsonify(load_state())

@app.route('/api/checkin', methods=['POST'])
def checkin():
    role, err = require_role('associate')
    if err: return err
    body      = request.get_json(silent=True) or {}
    wave_idx  = str(body.get('waveIdx'))
    route     = body.get('route')
    checked   = body.get('checked', True)
    time_str  = body.get('time', '')
    if wave_idx is None or not route:
        return jsonify({'error': 'Missing waveIdx or route'}), 400
    state = load_state()
    if wave_idx not in state:
        state[wave_idx] = {}
    if checked:
        state[wave_idx][route] = {'time': time_str, 'uniform': False}
    else:
        state[wave_idx].pop(route, None)
    save_state(state)
    socketio.emit('state_update', {'waveIdx': wave_idx, 'route': route,
                                   'checked': checked, 'time': time_str,
                                   'uniform': state[wave_idx].get(route, {}).get('uniform', False)})
    return jsonify({'ok': True})

@app.route('/api/uniform', methods=['POST'])
def uniform():
    role, err = require_role('associate')
    if err: return err
    body     = request.get_json(silent=True) or {}
    wave_idx = str(body.get('waveIdx'))
    route    = body.get('route')
    value    = body.get('uniform', True)
    if wave_idx is None or not route:
        return jsonify({'error': 'Missing waveIdx or route'}), 400
    state = load_state()
    if wave_idx not in state:
        state[wave_idx] = {}
    if route not in state[wave_idx]:
        # auto check-in
        now = datetime.now().strftime('%H:%M')
        state[wave_idx][route] = {'time': now, 'uniform': False}
    state[wave_idx][route]['uniform'] = value
    save_state(state)
    socketio.emit('uniform_update', {'waveIdx': wave_idx, 'route': route, 'uniform': value})
    return jsonify({'ok': True})

@app.route('/api/reset_wave', methods=['POST'])
def reset_wave():
    role, err = require_role('manager')
    if err: return err
    body     = request.get_json(silent=True) or {}
    wave_idx = str(body.get('waveIdx'))
    state    = load_state()
    state.pop(wave_idx, None)
    save_state(state)
    socketio.emit('wave_reset', {'waveIdx': wave_idx})
    return jsonify({'ok': True})

@app.route('/api/reset_all', methods=['POST'])
def reset_all():
    role, err = require_role('manager')
    if err: return err
    save_state({})
    socketio.emit('full_reset', {})
    return jsonify({'ok': True})

# — Notes endpoints ——————————————————————————————————————————————

@app.route('/api/notes', methods=['GET'])
def get_notes():
    _, err = require_role('associate')
    if err: return err
    return jsonify(load_notes())

@app.route('/api/notes', methods=['POST'])
def save_note():
    _, err = require_role('associate')
    if err: return err
    body  = request.get_json(silent=True) or {}
    route = body.get('route', '')
    text  = body.get('text', '')
    otd   = body.get('otd', False)
    if not route:
        return jsonify({'error': 'Missing route'}), 400
    notes = load_notes()
    if text or otd:
        notes[route] = {"text": text, "otd": bool(otd)}
    else:
        notes.pop(route, None)
    save_notes(notes)
    socketio.emit('notes_update', {'route': route, 'text': text, 'otd': bool(otd)})
    return jsonify({'ok': True})

# — ScanLog endpoints (manager only) —————————————————————————————

@app.route('/api/scanlog', methods=['GET'])
def get_scanlog():
    _, err = require_role('associate')
    if err: return err
    return jsonify(load_scanlog())

@app.route('/api/scanlog', methods=['POST'])
def add_scanlog():
    role, err = require_role('manager')
    if err: return err
    body  = request.get_json(silent=True) or {}
    route = body.get('route', '').strip()
    if not route:
        return jsonify({'error': 'Missing route'}), 400
    scanlog = load_scanlog()
    if route not in scanlog:
        scanlog.append(route)
    save_scanlog(scanlog)
    socketio.emit('scanlog_update', {'scanlog': scanlog})
    return jsonify({'ok': True})

@app.route('/api/scanlog', methods=['DELETE'])
def remove_scanlog():
    role, err = require_role('manager')
    if err: return err
    body  = request.get_json(silent=True) or {}
    route = body.get('route', '').strip()
    if not route:
        return jsonify({'error': 'Missing route'}), 400
    scanlog = load_scanlog()
    if route in scanlog:
        scanlog.remove(route)
    save_scanlog(scanlog)
    socketio.emit('scanlog_update', {'scanlog': scanlog})
    return jsonify({'ok': True})

# — Import endpoint (manager only) ————————————————————————————————

@app.route('/api/import_data', methods=['POST'])
def import_data():
    role, err = require_role('manager')
    if err: return err
    body    = request.get_json(silent=True) or {}
    content = body.get('content')   # full data.js file content as string
    if not content or 'const WAVES' not in content:
        return jsonify({'error': 'Invalid data.js content'}), 400
    # Backup old data.js
    if os.path.isfile(DATA_JS_FILE):
        bak = DATA_JS_FILE + '.bak'
        with open(DATA_JS_FILE, 'r', encoding='utf-8') as f:
            old = f.read()
        with open(bak, 'w', encoding='utf-8') as f:
            f.write(old)
    with open(DATA_JS_FILE, 'w', encoding='utf-8') as f:
        f.write(content)
    # Reset state on new import
    save_state({})
    socketio.emit('data_reloaded', {})
    return jsonify({'ok': True})

# — Slack endpoints ————————————————————————————————————————————

@app.route('/api/slack_late', methods=['POST'])
def slack_late():
    """Send a late tour alert to Slack."""
    role, err = require_role('manager')
    if err: return err
    body = request.get_json(silent=True) or {}
    route = body.get('route', '')
    wave_time = body.get('waveTime', '')
    dsp = body.get('dsp', '')
    staging = body.get('staging', '')
    if not route:
        return jsonify({'error': 'Missing route'}), 400
    if already_alerted(wave_time, route):
        return jsonify({'ok': True, 'skipped': 'already alerted today'})
    msg = (
        f"\u26a0\ufe0f Late Tour Alert \u2014 DNX3\n\n"
        f"Lieber DSP,\n\n"
        f"wir m\u00f6chten dich darauf hinweisen, dass deine Tour nicht rechtzeitig zur geplanten Welle eingetroffen ist. "
        f"Gem\u00e4\u00df unseren Vereinbarungen werden wir die Tour an einen alternativen DSP vergeben, "
        f"sollte die Abholung nicht innerhalb von 30 Minuten nach der geplanten Ankunftszeit erfolgen.\n\n"
        f"Bitte stelle sicher, dass deine Fahrer zuk\u00fcnftig p\u00fcnktlich zum vereinbarten Zeitpunkt eintreffen.\n"
        f"Bei Fragen oder Problemen kontaktiere uns bitte umgehend.\n\n"
        f"Viele Gr\u00fc\u00dfe\n\n"
        f"DSP: {dsp}\n"
        f"Route: {route}\n"
        f"Wave: {wave_time}"
    )
    success = send_slack_message(msg, dsp=dsp)
    if success:
        return jsonify({'ok': True})
    else:
        return jsonify({'error': 'Slack webhook failed or disabled'}), 500

@app.route('/api/slack_report', methods=['POST'])
def slack_report():
    """Send the full report text to Slack."""
    role, err = require_role('manager')
    if err: return err
    body = request.get_json(silent=True) or {}
    report_text = body.get('text', '')
    title = body.get('title', '')
    if not report_text:
        return jsonify({'error': 'Missing report text'}), 400
    msg = f"{title}\n{report_text}"
    success = send_slack_message(msg)
    if success:
        return jsonify({'ok': True})
    else:
        return jsonify({'error': 'Slack webhook failed or disabled'}), 500

@app.route('/api/test_dsp_alert', methods=['POST'])
def test_dsp_alert():
    """Send a full test late alert message to a specific DSP webhook."""
    role, err = require_role('manager')
    if err: return err
    body = request.get_json(silent=True) or {}
    dsp = body.get('dsp', '').strip()
    if not dsp:
        return jsonify({'error': 'Missing DSP name'}), 400
    webhook = get_slack_webhook(dsp=dsp)
    if not webhook:
        return jsonify({'error': f'No webhook configured for DSP: {dsp}'}), 400
    msg = (
        f"\u26a0\ufe0f Late Tour Alert \u2014 DNX3 [TEST]\n\n"
        f"Lieber DSP,\n\n"
        f"wir m\u00f6chten dich darauf hinweisen, dass deine Tour nicht rechtzeitig zur geplanten Welle eingetroffen ist. "
        f"Gem\u00e4\u00df unseren Vereinbarungen werden wir die Tour an einen alternativen DSP vergeben, "
        f"sollte die Abholung nicht innerhalb von 30 Minuten nach der geplanten Ankunftszeit erfolgen.\n\n"
        f"Bitte stelle sicher, dass deine Fahrer zuk\u00fcnftig p\u00fcnktlich zum vereinbarten Zeitpunkt eintreffen.\n"
        f"Bei Fragen oder Problemen kontaktiere uns bitte umgehend.\n\n"
        f"Viele Gr\u00fc\u00dfe\n\n"
        f"DSP: {dsp}\n"
        f"Route: TEST-ROUTE\n"
        f"Wave: 07:30 AM"
    )
    try:
        resp = requests.post(webhook, json={"text": msg}, timeout=10)
        if resp.status_code == 200:
            return jsonify({'ok': True})
        else:
            return jsonify({'error': f'Slack returned status {resp.status_code}'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# — SocketIO —————————————————————————————————————————————————————

# —— Clear data endpoint (manager only) ————————————————————————————————

@app.route('/api/clear_data', methods=['POST'])
def clear_data():
    """Clear all sequencing data — resets waves, state, notes, scanlog."""
    role, err = require_role('manager')
    if err: return err
    # Write empty WAVES to data.js
    empty_data = "// Cleared — no sequencing data\nconst WAVES = [];\n"
    with open(DATA_JS_FILE, 'w', encoding='utf-8') as f:
        f.write(empty_data)
    # Reset state
    save_state({})
    # Clear notes and scanlog
    notes_file = os.path.join(BASE_DIR, 'notes.json')
    scanlog_file = os.path.join(BASE_DIR, 'scanlog.json')
    if os.path.isfile(notes_file):
        with open(notes_file, 'w', encoding='utf-8') as f:
            json.dump({}, f)
    if os.path.isfile(scanlog_file):
        with open(scanlog_file, 'w', encoding='utf-8') as f:
            json.dump([], f)
    socketio.emit('data_reloaded', {})
    return jsonify({'ok': True})

# —— Settings endpoints (manager only) ————————————————————————————————

@app.route('/api/settings', methods=['GET', 'POST'])
def handle_settings():
    role, err = require_role('manager')
    if err: return err
    if request.method == 'GET':
        return jsonify(load_settings())
    body = request.get_json(silent=True) or {}
    settings = load_settings()
    if 'slack_webhook_url' in body:
        settings['slack_webhook_url'] = body['slack_webhook_url'].strip()
    if 'dsp_webhooks' in body:
        settings['dsp_webhooks'] = body['dsp_webhooks']
    save_settings(settings)
    return jsonify({'ok': True})

@app.route('/api/test_slack', methods=['POST'])
def test_slack():
    """Send a test message to verify the webhook works."""
    role, err = require_role('manager')
    if err: return err
    body = request.get_json(silent=True) or {}
    target = body.get('target', 'default')
    if target == 'default':
        webhook = get_slack_webhook()
    else:
        webhook = get_slack_webhook(dsp=target)
    if not webhook:
        return jsonify({'error': 'No Slack webhook URL configured'}), 400
    try:
        label = f'DSP: {target}' if target != 'default' else 'Default channel'
        r = requests.post(webhook, json={'text': f'✅ DNX3 Wave Tracker — Test successful! ({label})'}, timeout=5)
        if r.status_code == 200:
            return jsonify({'ok': True})
        else:
            return jsonify({'error': f'Slack returned status {r.status_code}'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@socketio.on('connect')
def on_connect():
    pass

# — Main ——————————————————————————————————————————————————————————

if __name__ == '__main__':
    import socket as _s
    try:
        s2 = _s.socket(_s.AF_INET, _s.SOCK_DGRAM)
        s2.connect(('8.8.8.8', 80))
        ip = s2.getsockname()[0]
        s2.close()
    except Exception:
        ip = '127.0.0.1'
    print('=' * 50)
    print('  DNX3 Wave Tracker')
    print(f'  Local:   http://localhost:{PORT}')
    print(f'  Network: http://{ip}:{PORT}')
    print('=' * 50)
    socketio.run(app, host='0.0.0.0', port=PORT, debug=False)
