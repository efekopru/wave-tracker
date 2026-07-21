"""WSGI entry point for Render / gunicorn."""
from gevent import monkey
monkey.patch_all()

from server import app, socketio
