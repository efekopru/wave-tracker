# DNX3 Wave Tracker — Deploy to Render (Free Tier)

## Quick Steps

### 1. Create a GitHub repo
```bash
cd wave-tracker
git init
git add .
git commit -m "Initial commit — wave tracker"
```

Push to GitHub:
```bash
git remote add origin https://github.com/YOUR_USERNAME/wave-tracker.git
git branch -M main
git push -u origin main
```

### 2. Deploy on Render
1. Go to [render.com](https://render.com) and sign up (free)
2. Click **New** → **Web Service**
3. Connect your GitHub account and select the `wave-tracker` repo
4. Render will auto-detect the `render.yaml` — settings are pre-configured:
   - **Build command**: `pip install -r requirements.txt`
   - **Start command**: `gunicorn --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker --bind 0.0.0.0:$PORT server:app`
5. Before clicking Create, go to **Environment** and add these variables:
   - `ASSOCIATE_PASSWORD` = your chosen associate password (e.g. `containersa`)
   - `MANAGER_PASSWORD` = your chosen manager password (e.g. `containermanager`)
6. Click **Create Web Service**
7. Wait ~2 minutes for the first deploy

### 3. Access your dashboard
Your app will be live at:
```
https://dnx3-wave-tracker.onrender.com
```
(Render gives you a free `.onrender.com` subdomain, or you can add a custom domain.)

Share this URL with all stakeholders — they can access it simultaneously from any device, anywhere.

## Passwords
Passwords are set via environment variables on Render (not in the code).
For local development, defaults are: Associate = `containersa`, Manager = `containermanager`.

## Updating wave data
Managers can still import new Excel data directly through the app's Import tab — no redeployment needed.

## Notes
- **Free tier**: The server sleeps after 15 min of inactivity. First request after sleep takes ~30s to wake up. Upgrade to the Starter plan ($7/month) for always-on.
- **State persistence**: `state.json` resets on each deploy. For durable state, consider adding a free PostgreSQL or Redis add-on (let me know if you want this).
- **WebSocket**: Full real-time sync works on Render (via gevent-websocket).
- **HTTPS**: Automatically included — all traffic is encrypted.

## Optional: Custom domain
In Render dashboard → Settings → Custom Domains → add e.g. `wave.yourcompany.com`
