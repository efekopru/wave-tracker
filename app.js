// DNX3 Wave Tracker — Client JS (Part 1: Auth, State, Socket, Sidebar)
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const API = '';  // same origin
let TOKEN = localStorage.getItem('dnx3_token') || '';
let ROLE  = localStorage.getItem('dnx3_role')  || '';

// ── App state ─────────────────────────────────────────────────────────────────
let state       = {};   // waveIdx -> { route -> { time } }
let notes       = {};   // route -> {text, otd}
let scanlog     = [];   // array of route strings
let waveOpen    = {};
let missingOpen = {};
let searchQ     = '';
let themeMode   = (['light','dark'].includes(localStorage.getItem('dnx3_theme')) ? localStorage.getItem('dnx3_theme') : 'light');
let dark        = themeMode === 'dark';
let socket      = null;
let notePanel   = {open:false, route:''};

// Slack late alert tracking — avoid duplicate alerts per route
const slackAlerted = new Set();
let slackEnabled = false; // loaded from settings, off by default

// Editable report state
let rptEdits = { late: '', otd: '', reportNotes: '' };
let rptEditMode = { late: false, otd: false };

// Theme applied after applyTheme is defined below

// ── Helpers ───────────────────────────────────────────────────────────────────
function isIn(wi, r)      { return !!(state[wi] && state[wi][r]); }
function inTime(wi, r)    { return state[wi]?.[r]?.time || ''; }
function inCount(wi)      { return Object.keys(state[String(wi)] || {}).length; }
function allR(w)          { return [...(w.green||[]), ...(w.red||[])]; }
function sortByDsp(arr)   { return [...arr].sort((a,b)=>a.dsp.localeCompare(b.dsp)||a.route.localeCompare(b.route,undefined,{numeric:true})); }

// Notes helper: get text/otd from notes object with backward compat
function getNoteText(route){ const n=notes[route]; if(!n)return ''; if(typeof n==='string')return n; return n.text||''; }
function getNoteOtd(route){ const n=notes[route]; if(!n)return false; if(typeof n==='string')return false; return !!n.otd; }
function hasNote(route){ return !!getNoteText(route); }

// Auto-detect route prefix from data (e.g. "CA_A" from "CA_A248")
function getPrefix(){
  try{
    const first=WAVES[0].green[0]||WAVES[0].red[0];
    if(!first)return '';
    const m=first.route.match(/^([A-Z]{2}_[A-Z])/i);
    return m?m[1]:'';
  }catch(e){return '';}
}
function expandSearch(q){
  q=q.trim();
  if(!q)return '';
  if(/^\d+$/.test(q)) return (getPrefix()+q).toLowerCase();
  return q.toLowerCase();
}

// ScanLog helper: get effective green/red arrays for a wave considering scanlog overrides
function effGreen(w){ return w.green.filter(r=>!scanlog.includes(r.route)); }
function effRed(w){ return [...w.red, ...w.green.filter(r=>scanlog.includes(r.route))]; }

function wMin(s) {
  const m=String(s).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if(!m)return 9999;
  let h=+m[1],mn=+m[2],ap=m[3].toUpperCase();
  if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
  return h*60+mn;
}
// Change #1: Remove 5-min grace — lateness = exact wave time
function isLate(wi){ const n=new Date(); return(n.getHours()*60+n.getMinutes())>wMin(WAVES[wi].time); }


// ── Theme helpers ─────────────────────────────────────────────────────────
const THEME_ICONS = {
  light: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/><line x1="8" y1="1" x2="8" y2="3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="1" y1="8" x2="3" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="2.93" y1="2.93" x2="4.34" y2="4.34" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="11.66" y1="11.66" x2="13.07" y2="13.07" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="13.07" y1="2.93" x2="11.66" y2="4.34" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="4.34" y1="11.66" x2="2.93" y2="13.07" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  dark:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 10A6 6 0 0 1 6 2.5a6 6 0 1 0 7.5 7.5z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  auto:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".4"/><path d="M8 2a6 6 0 0 1 0 12V2z" fill="currentColor" opacity=".25"/></svg>`
};
function applyTheme(mode){
  themeMode = mode;
  dark = mode === 'dark';
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('theme-auto', mode === 'auto');
  const btn = document.getElementById('dark-btn');
  if(btn) btn.innerHTML = THEME_ICONS[mode] || THEME_ICONS.light;
  const lbl = document.getElementById('dark-btn-label');
  if(lbl) lbl.textContent = '';
  localStorage.setItem('dnx3_theme', mode);
}
function toggleDark(){
  const modes = ['light','dark'];
  const next = modes[(modes.indexOf(themeMode)+1) % modes.length];
  applyTheme(next);
}
// Apply theme on page load (now safe — applyTheme is defined)
applyTheme(themeMode);

// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock(){ document.getElementById('clock').textContent=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
setInterval(updateClock,1000); updateClock();

// ── Dark mode ─────────────────────────────────────────────────────────────────




// ── Sidebar toggle ───────────────────────────────────────────────────────────
let sidebarOpen=true;
function toggleSidebar(){
  const aside=document.getElementById('main-aside');
  const layout=document.getElementById('main-layout');
  if(!aside||!layout)return;
  sidebarOpen=!sidebarOpen;
  aside.classList.toggle('collapsed',!sidebarOpen);
  layout.classList.toggle('sb-collapsed',!sidebarOpen);
}
// applyTheme handles dark-btn init above

// ── Toast ─────────────────────────────────────────────────────────────────────
let _tt;
function showToast(m){
  const t=document.getElementById('toast');
  t.textContent=m; t.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>t.classList.remove('show'),2800);
}
// inject .show style
const ts=document.createElement('style');
ts.textContent='#toast.show{transform:translateX(-50%) translateY(0)!important;}';
document.head.appendChild(ts);

// Webhook settings styles
const whStyles=document.createElement('style');
whStyles.textContent=`

.slack-toggle-wrap{display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--surface2);border-radius:10px;border:1.5px solid var(--border);margin-bottom:18px;}
.slack-toggle-label{flex:1;}
.slack-toggle-title{font-size:.88rem;font-weight:600;color:var(--text);}
.slack-toggle-sub{font-size:.72rem;color:var(--subtext);margin-top:2px;}
.slack-toggle-btn{position:relative;width:44px;height:26px;border-radius:13px;border:none;cursor:pointer;transition:background .2s;padding:0;background:var(--border);flex-shrink:0;}
.slack-toggle-btn[data-on="1"]{background:var(--green);}
.slack-toggle-ind{position:absolute;top:3px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .2s;}
.slack-toggle-btn[data-on="1"] .slack-toggle-ind{transform:translateX(20px);}
.slack-toggle-status{font-size:.72rem;font-weight:600;min-width:80px;color:var(--subtext);}
.slack-toggle-btn[data-on="1"] ~ .slack-toggle-status{color:var(--green);}
.wh-label{font-size:.75rem;font-weight:600;color:var(--subtext);display:block;margin-bottom:6px;}
.wh-hint{font-size:.68rem;color:var(--subtext);}
.wh-main-input{width:100%;max-width:600px;padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:.82rem;background:var(--surface2);color:var(--text);outline:none;font-family:monospace;margin-bottom:6px;}
.wh-main-input:focus{border-color:#3b82f6;}
.wh-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;padding:6px 10px;background:var(--surface2);border-radius:7px;border:1px solid var(--border);}
.wh-dsp{font-size:.75rem;font-weight:700;color:var(--text);min-width:50px;}
.wh-input{flex:1;max-width:500px;padding:6px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:.78rem;background:var(--surface2);color:var(--text);outline:none;font-family:monospace;}
.wh-input:focus{border-color:#3b82f6;}
.wh-rm{background:none;border:none;color:var(--red);font-size:1.1rem;cursor:pointer;padding:2px 6px;border-radius:4px;}
.wh-rm:hover{background:var(--red-bg);}
.wh-add-row{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);flex-wrap:wrap;}
.wh-select{padding:6px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:.78rem;background:var(--surface2);color:var(--text);outline:none;min-width:100px;}
.wh-empty{font-size:.75rem;color:var(--subtext);font-style:italic;padding:8px 0;}
`;
document.head.appendChild(whStyles);


// ── Login ─────────────────────────────────────────────────────────────────────
// Password field — always type=text, masked with bullet chars
let _pwReal='';
function _pwSetup(){
  const inp=document.getElementById('pw-input');
  if(!inp||inp._pwReady)return;
  inp._pwReady=true;
  inp.addEventListener('input',function(e){
    const sel=inp.selectionStart;
    const old=_pwReal;
    const val=inp.value;
    // count bullets already there
    const bullets=old.split('').map(()=>'\u2022').join('');
    if(val.length>bullets.length){
      // chars added
      const added=val.slice(bullets.length-val.length+val.length-(val.length-bullets.length));
      // simpler: new chars are non-bullet chars
      let real='';
      for(let i=0;i<val.length;i++){
        if(val[i]==='\u2022')real+=old[i]||'';
        else real+=val[i];
      }
      _pwReal=real;
    } else {
      _pwReal=old.slice(0,val.length);
    }
    if(inp.dataset.masked==='1'){
      const masked=_pwReal.split('').map(()=>'\u2022').join('');
      inp.value=masked;
      inp.setSelectionRange(sel,sel);
    }
  });
  inp.addEventListener('keydown',function(e){
    if(e.key==='Backspace'&&inp.dataset.masked==='1'){
      e.preventDefault();
      const s=inp.selectionStart,en=inp.selectionEnd;
      if(s!==en){_pwReal=_pwReal.slice(0,s)+_pwReal.slice(en);}
      else if(s>0){_pwReal=_pwReal.slice(0,s-1)+_pwReal.slice(s);}
      inp.value=_pwReal.split('').map(()=>'\u2022').join('');
      const ns=Math.max(0,s-(s===en?1:0));
      inp.setSelectionRange(ns,ns);
    }
  });
}
function showPw(){
  _pwSetup();
  const inp=document.getElementById('pw-input');
  inp.dataset.masked='0';
  inp.value=_pwReal;
}
function hidePw(){
  _pwSetup();
  const inp=document.getElementById('pw-input');
  inp.dataset.masked='1';
  inp.value=_pwReal.split('').map(()=>'•').join('');
}
// Init masking on load
document.addEventListener('DOMContentLoaded',function(){_pwSetup();});
async function doLogin(){
  const pw=_pwReal.trim();
  const errEl=document.getElementById('login-err');
  errEl.textContent='';
  if(!pw){errEl.textContent='Please enter a password.';return;}
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
    const d=await r.json();
    if(!r.ok){errEl.textContent=d.error||'Incorrect password';return;}
    TOKEN=d.token; ROLE=d.role;
    localStorage.setItem('dnx3_token',TOKEN);
    localStorage.setItem('dnx3_role',ROLE);
    document.getElementById('login-screen').style.display='none';
    bootApp();
  }catch(e){errEl.textContent='Cannot reach server. Is it running?';}
}

async function doLogout(){
  await fetch('/api/logout',{method:'POST',headers:{'X-Token':TOKEN}}).catch(()=>{});
  localStorage.removeItem('dnx3_token'); localStorage.removeItem('dnx3_role');
  TOKEN=''; ROLE=''; location.reload();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function bootApp(){
  // Verify token still valid
  try{
    const r=await fetch('/api/me',{headers:{'X-Token':TOKEN}});
    if(!r.ok){
      localStorage.removeItem('dnx3_token');
      localStorage.removeItem('dnx3_role');
      TOKEN=''; ROLE='';
      showLoginScreen();
      return;
    }
    const d=await r.json(); ROLE=d.role;
    localStorage.setItem('dnx3_role',ROLE);
  }catch(e){showLoginScreen();return;}

  // Show UI
  document.getElementById('main-header').style.display='flex';
  if(window.initTabIndicator) setTimeout(window.initTabIndicator, 50);
  document.getElementById('tv').style.display='flex';

  // Role badge
  const rb=document.getElementById('role-badge');
  rb.textContent=ROLE==='manager'?'👔 Manager':'👷 Associate';
  rb.className='role-badge '+(ROLE==='manager'?'rb-manager':'rb-associate');

  // Manager-only tabs
  if(ROLE==='manager'){
    document.getElementById('tb-r').style.display='';
    document.getElementById('tb-i').style.display='';
    document.getElementById('tb-s').style.display='';
  }

  // All waves start closed — autoOpenWave opens the right one
  WAVES.forEach((_,i)=>{ waveOpen[i]=false; missingOpen[i]=false; });

  // Load state from server
  await fetchState();
  await fetchNotes();
  await fetchScanlog();

  // Connect WebSocket
  connectSocket();

  // Inject note panel container
  if(!document.getElementById('note-panel')){
    const np=document.createElement('div');
    np.id='note-panel';np.className='note-panel';
    document.body.appendChild(np);
  }

  render();

  // Change #2: Start Slack late alert interval (manager only)
  // Re-check wave open state every 30s (catches wave time crossings)
  setInterval(()=>{ autoOpenWave(); }, 30000);

  if(ROLE==='manager'){
    setInterval(checkSlackLateAlerts, 30000);
    // Run once immediately after boot
    setTimeout(checkSlackLateAlerts, 5000);
  }
}

function showLoginScreen(){
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('main-header').style.display='none';
  document.getElementById('tv').style.display='none';
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function fetchState(){
  try{
    const r=await fetch('/api/state',{headers:{'X-Token':TOKEN}});
    if(r.ok){ state=await r.json(); }
  }catch(e){}
}

async function fetchNotes(){
  try{
    const r=await fetch('/api/notes',{headers:{'X-Token':TOKEN}});
    if(r.ok){ notes=await r.json(); }
  }catch(e){}
}

async function fetchScanlog(){
  try{
    const r=await fetch('/api/scanlog',{headers:{'X-Token':TOKEN}});
    if(r.ok){ scanlog=await r.json(); }
  }catch(e){}
}

async function apiCheckin(wi,route,checked,time){
  try{
    await fetch('/api/checkin',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({waveIdx:wi,route,checked,time})});
  }catch(e){showToast('⚠️ Sync error — check connection');}
}


async function apiResetWave(wi){
  try{
    await fetch('/api/reset_wave',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({waveIdx:wi})});
  }catch(e){showToast('⚠️ Sync error');}
}

async function apiSaveNote(route,text,otd){
  try{
    await fetch('/api/notes',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({route,text,otd})});
  }catch(e){showToast('⚠️ Sync error');}
}

async function apiAddScanlog(route){
  try{
    await fetch('/api/scanlog',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({route})});
  }catch(e){showToast('⚠️ Sync error');}
}

async function apiRemoveScanlog(route){
  try{
    await fetch('/api/scanlog',{method:'DELETE',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({route})});
  }catch(e){showToast('⚠️ Sync error');}
}

// ── Slack Late Alert Check (Change #2) ────────────────────────────────────────
async function checkSlackLateAlerts(){
  if(ROLE!=='manager')return;
  const now=new Date();
  const nowMin=now.getHours()*60+now.getMinutes();
  WAVES.forEach((w,i)=>{
    const waveMinutes=wMin(w.time);
    if(waveMinutes===9999)return;
    // Only trigger if current time has passed the wave time
    if(nowMin<waveMinutes+1)return; // alert 1 min after wave time (1-min buffer)
    const allRoutes=[...effGreen(w),...effRed(w)];
    allRoutes.forEach(r=>{
      if(isIn(i,r.route))return; // already checked in
      const key=`${i}_${r.route}`;
      if(slackAlerted.has(key))return; // already alerted
      slackAlerted.add(key);
      // Fire and forget — send alert to server
      if(!slackEnabled){return;} // Slack disabled
      fetch('/api/slack_late',{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Token':TOKEN},
        body:JSON.stringify({route:r.route,waveTime:w.time,dsp:r.dsp,staging:r.staging})
      }).catch(()=>{});
    });
  });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectSocket(){
  socket=io({auth:{token:TOKEN}});
  const dot=document.getElementById('sync-dot');
  const lbl=document.getElementById('sync-lbl');

  socket.on('connect',()=>{
    dot.className='sync-dot'; lbl.textContent='Live';
  });
  socket.on('disconnect',()=>{
    dot.className='sync-dot off'; lbl.textContent='Offline';
  });

  socket.on('state_update',d=>{
    const wi=String(d.waveIdx);
    if(!state[wi])state[wi]={};
    if(d.checked) state[wi][d.route]={time:d.time};
    else delete state[wi][d.route];
    render();
  });


  socket.on('wave_reset',d=>{
    delete state[String(d.waveIdx)]; render();
  });

  socket.on('full_reset',()=>{ state={}; render(); });

  socket.on('data_reloaded',()=>{
    showToast('📥 New sequencing data loaded — reloading...');
    setTimeout(()=>location.reload(),1500);
  });

  socket.on('notes_update',d=>{
    if(d.text || d.otd) {
      notes[d.route]={text:d.text||'', otd:!!d.otd};
    } else {
      delete notes[d.route];
    }
    // If note panel is open for this route, update textarea and checkbox
    if(notePanel.open && notePanel.route===d.route){
      const ta=document.getElementById('note-ta');
      if(ta) ta.value=d.text||'';
      const cb=document.getElementById('note-otd-btn');
      if(cb){if(d.otd)cb.classList.add('otd-on');else cb.classList.remove('otd-on');}
    }
    render();
  });

  socket.on('scanlog_update',d=>{
    scanlog=d.scanlog||[];
    render();
  });
}

// ── Search (Change #5: clear on blur) ─────────────────────────────────────────
function onSearch(){ searchQ=expandSearch(document.getElementById('si').value); renderMain(); }
document.addEventListener('keydown',e=>{
  if(e.key==='/'&&document.activeElement!==document.getElementById('si')){
    e.preventDefault();
    document.getElementById('si').focus();
  }
  if(e.key==='Escape'){
    clearSearch();
    document.getElementById('si').blur();
  }
});

// ── clearSearch helper (replaces old blur-to-clear) ──────────────────────────
function clearSearch(){
  const si=document.getElementById('si');
  if(si) si.value='';
  searchQ='';
  render();
}

// ── Tab switch ────────────────────────────────────────────────────────────────
function switchTab(t){
  document.getElementById('tv').style.display=t==='t'?'flex':'none';
  const rv=document.getElementById('rv'); rv.style.display=t==='r'?'block':'none';
  const iv=document.getElementById('iv'); iv.style.display=t==='i'?'block':'none';
  const sv=document.getElementById('sv'); if(sv) sv.style.display=t==='s'?'block':'none';
  ['t','r','i','s'].forEach(id=>document.getElementById('tb-'+id)?.classList.toggle('active',id===t));
  if(t==='r')renderReport();
  if(t==='i')renderImport();
  if(t==='s')renderSettings();
}
// ── Quick OTD toggle (card button) ────────────────────────────────────────────
async function quickToggleOtd(e, route){
  e.stopPropagation();
  const currentOtd=getNoteOtd(route);
  const currentText=getNoteText(route);
  const newOtd=!currentOtd;
  if(currentText||newOtd){
    notes[route]={text:currentText,otd:newOtd};
  } else {
    delete notes[route];
  }
  await apiSaveNote(route,currentText,newOtd);
  showToast(newOtd?`🚨 ${route} marked as OTD`:`✅ OTD removed for ${route}`);
  render();
}

// ── Note Panel ────────────────────────────────────────────────────────────────
function openNotePanel(route){
  notePanel={open:true,route};
  const panel=document.getElementById('note-panel');
  const currentText=getNoteText(route);
  const currentOtd=getNoteOtd(route);
  // Change #6: OTD checkbox only for managers, but OTD badge visible to all
  const otdRow = ROLE==='manager' ? `<div class="np-otd-row${currentOtd?' otd-on':''}" id="note-otd-btn"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2.5L14.5 13.5H1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="8" y1="6.5" x2="8" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.7" fill="currentColor"/></svg><span class="np-otd-text">Mark as OTD Hit</span><span class="np-otd-ind" onclick="npToggleOtd(this.parentElement)" style="cursor:pointer;"></span></div>` : '';
  panel.innerHTML=`<div class="np-header"><span class="np-title"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 2.5a1.5 1.5 0 0 1 2.121 2.121l-8.5 8.5-2.828.707.707-2.828 8.5-8.5z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> ${route}</span><button class="np-close" onclick="closeNotePanel()" title="Close"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>
    <textarea id="note-ta" class="np-textarea" placeholder="Add notes for ${route}...">${currentText}</textarea>
    ${otdRow}
    <div class="np-actions"><button class="rabtn pri" onclick="saveNote()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 8.5l4 4 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> Save</button><button class="rabtn" onclick="closeNotePanel()">Cancel</button></div>`;
  panel.classList.add('open'); setTimeout(()=>{const ta=document.getElementById('note-ta');if(ta)ta.blur();},50);
}
function npToggleOtd(btn){
  btn.classList.toggle('otd-on');
}
function closeNotePanel(){
  notePanel={open:false,route:''};
  const panel=document.getElementById('note-panel');
  if(panel){panel.classList.remove('open');panel.innerHTML='';}
}
async function saveNote(){
  const ta=document.getElementById('note-ta');
  const cb=document.getElementById('note-otd-btn');
  if(!ta)return;
  const text=ta.value.trim();
  const otd=cb?cb.classList.contains('otd-on'):(notes[notePanel.route]?.otd||false);
  if(text||otd){
    notes[notePanel.route]={text,otd};
  } else {
    delete notes[notePanel.route];
  }
  await apiSaveNote(notePanel.route,text,otd);
  showToast(`📝 Note saved for ${notePanel.route}`);
  closeNotePanel();
  clearSearch();
  render();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar(){
  const ml=document.getElementById('ml');
  ml.innerHTML=''; let any=false;
  WAVES.forEach((w,i)=>{
    const green=effGreen(w),red=effRed(w);
    const miss=sortByDsp([...green,...red].filter(r=>!isIn(i,r.route)));
    if(!miss.length)return; any=true;
    const open=!!missingOpen[i];
    const d=document.createElement('div');
    d.innerHTML=`<button class="mwhdr${open?' open':''}" onclick="toggleM(${i})">
      <span class="mwlabel">Wave ${w.time}</span><span class="mwcount">${miss.length}</span><span class="chevron">▶</span>
    </button>
    <div class="mwbody${open?' open':''}" id="mb${i}">
      ${miss.map(r=>`<div class="mr"><span class="mrdot"></span><span>${r.route}</span><span class="mrdsp">${r.dsp}</span></div>`).join('')}
    </div>`;
    ml.appendChild(d);
  });
  if(!any)ml.innerHTML='<div class="nomiss">✅ All routes checked in!</div>';
}
function toggleM(i){ missingOpen[i]=!missingOpen[i]; renderSidebar(); }

// ── Styles injected ───────────────────────────────────────────────────────────
const appStyles=document.createElement('style');
appStyles.textContent=`
main{flex:1;overflow-y:auto;padding:16px;}
.wave-accordion{margin-bottom:10px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface);}
.wave-acc-hdr{display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer;background:var(--surface);border:none;width:100%;text-align:left;color:var(--text);user-select:none;}
.wave-acc-hdr:hover{background:var(--surface2);}
.wah-chev{font-size:.65rem;color:var(--subtext);transition:transform .2s;flex-shrink:0;}
.wave-acc-hdr.open .wah-chev{transform:rotate(90deg);}
.wah-time{font-weight:700;font-size:.95rem;min-width:90px;}
.wah-prog{flex:1;}
.wah-bar-w{background:var(--border);border-radius:999px;height:5px;overflow:hidden;width:100%;max-width:200px;}
.wah-bar{height:100%;background:#3b82f6;border-radius:999px;transition:width .4s;}
.wah-plbl{font-size:.65rem;color:var(--subtext);margin-top:2px;}
.wah-badges{display:flex;gap:5px;flex-wrap:wrap;margin-left:auto;}
.bm{border-radius:999px;padding:2px 8px;font-size:.63rem;font-weight:700;white-space:nowrap;}
.bm-miss{background:#fee2e2;color:#b91c1c;}.dark .bm-miss{background:#450a0a;color:#fca5a5;}
.bm-done{background:#dcfce7;color:#166534;}.dark .bm-done{background:#052e16;color:#86efac;}
.bm-late{background:#fef9c3;color:#b45309;}
.wave-acc-body{display:none;padding:12px 14px 14px;border-top:1px solid var(--border);}
.wave-acc-body.open{display:block;}
.pills{display:flex;gap:5px;margin-bottom:14px;flex-wrap:wrap;}
.pill{padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:600;border:1.5px solid;}
.pg{background:var(--green-bg);color:var(--green);border-color:var(--green-border);}
.pr{background:var(--red-bg);color:var(--red);border-color:var(--red-border);}
.pt{background:var(--blue-bg);color:var(--blue);border-color:var(--blue-border);}
.pd{background:#f0fdf4;color:#166534;border-color:#bbf7d0;}.dark .pd{background:#052e16;color:#86efac;border-color:#166534;}
.py{background:var(--yellow-bg);color:var(--yellow);border-color:var(--yellow-border);}
.ghdr{display:flex;align-items:center;gap:7px;margin-bottom:8px;margin-top:2px;}
.ghdr h3{font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.7px;}
.gcnt{font-size:.66rem;background:var(--surface2);border-radius:999px;padding:1px 7px;color:var(--subtext);border:1px solid var(--border);}
.divider{border:none;border-top:1px dashed var(--border);margin:6px 0 14px;}
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(138px,1fr));gap:7px;margin-bottom:14px;}
.rcard{border-radius:8px;padding:9px 10px 7px;border:1.5px solid;cursor:pointer;transition:transform .1s,box-shadow .15s;user-select:none;position:relative;}
.rcard:hover{transform:translateY(-1px);box-shadow:0 3px 8px rgba(0,0,0,.12);}
.rcard:active{transform:scale(.97);}
.rcard.green{background:var(--green-bg);border-color:var(--green-border);}
.rcard.red{background:var(--red-bg);border-color:var(--red-border);}
.rcard.late{background:var(--yellow-bg);border-color:var(--yellow-border);}
.rcard.checked{opacity:.5;}


.rcard.dimmed{opacity:.15;pointer-events:none;}
.cr{font-weight:700;font-size:.82rem;}.cs{font-size:.65rem;color:var(--subtext);margin-top:1px;}
.cd{font-size:.63rem;color:var(--subtext);margin-top:1px;}.ct{font-size:.63rem;color:#3b82f6;margin-top:2px;font-weight:600;}
.dark .ct{color:#60a5fa;}
.pen-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;border:1px solid rgba(0,0,0,.15);background:rgba(255,255,255,.5);cursor:pointer;font-size:.7rem;transition:background .15s;margin-left:auto;}
.dark .pen-btn{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.1);}
.pen-btn:hover{background:rgba(255,255,255,.8);}
.pen-btn.has-note{background:#fef3c7;border-color:#f59e0b;}
.dark .pen-btn.has-note{background:#451a03;border-color:#f59e0b;}
.otd-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;border:1.5px solid var(--border);background:var(--surface2);cursor:pointer;font-size:.65rem;opacity:.45;transition:opacity .15s,background .15s;}
.otd-btn:hover{opacity:1;}
.otd-btn.otd-active{background:#fef2f2;border-color:#dc2626;opacity:1;}
.otd-badge{position:absolute;top:0;right:0;background:#dc2626;color:#fff;font-size:.58rem;font-weight:700;letter-spacing:.4px;padding:2px 6px 2px 7px;border-radius:0 7px 0 7px;text-transform:uppercase;line-height:1.4;pointer-events:none;z-index:2;}.late-tag{position:absolute;bottom:0;left:0;background:#d97706;color:#fff;font-size:.58rem;font-weight:700;letter-spacing:.4px;padding:2px 7px 2px 6px;border-radius:0 7px 0 7px;text-transform:uppercase;line-height:1.4;pointer-events:none;z-index:2;}
.sw-lbl{font-size:.7rem;font-weight:700;color:var(--subtext);text-transform:uppercase;letter-spacing:.6px;padding:6px 0 4px;border-top:1px solid var(--border);margin-top:4px;}
.sw-lbl:first-child{border-top:none;margin-top:0;}
.srwrap{padding:14px;}.srwrap .rgrid{margin-bottom:6px;}
.no-results{text-align:center;color:var(--subtext);padding:30px;font-size:.85rem;}
/* Note Panel */
.note-panel{position:fixed;top:0;right:-360px;width:340px;height:100vh;background:var(--bg);border-left:1px solid var(--border);box-shadow:-4px 0 20px rgba(0,0,0,.15);z-index:1000;display:flex;flex-direction:column;transition:right .25s ease;overflow:hidden;}
.note-panel.open{right:0;}
.np-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border);}
.np-title{font-weight:700;font-size:.9rem;}
.np-close{border:none;background:none;font-size:1.1rem;cursor:pointer;color:var(--text);padding:4px 8px;border-radius:4px;}
.np-close:hover{background:var(--surface2);}
.np-textarea{flex:1;margin:12px 16px 0;padding:12px;border:1px solid var(--border);border-radius:8px;resize:none;font-size:.82rem;font-family:inherit;background:var(--surface-solid);color:var(--text);outline:none;box-sizing:border-box;width:calc(100% - 32px);}
.np-textarea:focus{border-color:var(--border);}
.dark .np-otd-toggle.otd-on .np-otd-toggle.otd-on 
.np-otd-row{padding:0 16px 8px;}.np-otd-row{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:.82rem;font-weight:600;color:var(--text);}.np-otd-row.otd-on{color:var(--text);}.np-otd-text{flex:1;text-align:left;user-select:none;}.np-otd-ind{flex-shrink:0;width:30px;height:18px;border-radius:9px;background:rgba(120,120,128,0.3);position:relative;transition:background .2s;}.np-otd-ind::after{content:'';position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s;}.np-otd-row.otd-on .np-otd-ind{background:#dc2626;}.np-otd-row.otd-on .np-otd-ind::after{transform:translateX(12px);}.np-actions{display:flex;gap:8px;padding:8px 16px 14px;}
/* ScanLog */
.scanlog-sec{margin-top:24px;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
.scanlog-title{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--subtext);padding:10px 14px 8px;border-bottom:1px solid var(--border);}
.scanlog-body{padding:12px 14px;}
.scanlog-input-row{display:flex;gap:8px;margin-bottom:10px;}
.scanlog-input{flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:7px;font-size:.8rem;background:var(--bg);color:var(--text);outline:none;}
.scanlog-input:focus{border-color:#3b82f6;}
.scanlog-add{padding:7px 14px;border-radius:7px;border:1.5px solid #3b82f6;background:#3b82f6;color:#fff;font-size:.76rem;font-weight:600;cursor:pointer;}
.scanlog-add:hover{background:#2563eb;}
.scanlog-list{list-style:none;padding:0;margin:0;}
.scanlog-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--border);font-size:.78rem;font-weight:600;}
.scanlog-item:last-child{border-bottom:none;}
.scanlog-rm{border:none;background:none;color:#dc2626;cursor:pointer;font-size:1rem;padding:0 4px;font-weight:700;}
.scanlog-rm:hover{color:#991b1b;}
.scanlog-empty{color:var(--subtext);font-size:.78rem;padding:4px 0;}
/* Report */
.rpt-title{font-size:1.25rem;font-weight:700;margin-bottom:2px;}
.rpt-sub{font-size:.76rem;color:var(--subtext);margin-bottom:16px;}
.rsec{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:13px;overflow:hidden;}
.rsec-title{font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--subtext);padding:10px 14px 8px;border-bottom:1px solid var(--border);}
.rsec-title.collapsible{cursor:pointer;display:flex;align-items:center;gap:8px;user-select:none;}
.rsec-title.collapsible:hover{background:var(--surface2);}
.rsec-title .coll-chev{font-size:.55rem;transition:transform .2s;}
.rsec-title.collapsible.open .coll-chev{transform:rotate(90deg);}
.rsec-body{display:none;}
.rsec-body.open{display:block;}
.sgrid{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:88px;margin-bottom:0!important;}
.sstat{height:88px!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;text-align:center!important;padding:0 10px!important;border-right:1px solid var(--border)!important;}.sstat:last-child{border-right:none!important;}

.sval{font-size:1.35rem;font-weight:700;}.slbl{font-size:.65rem;color:var(--subtext);margin-top:2px;}
.sv-blue{color:#3b82f6;}.sv-green{color:var(--green);}.sv-red{color:var(--red);}.sv-amber{color:#d97706;}
.rtbl{width:100%;border-collapse:collapse;font-size:.76rem;table-layout:fixed;}
.rtbl th{padding:7px 11px;text-align:left;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--subtext);border-bottom:1px solid var(--border);}
.rtbl td{padding:7px 11px;border-bottom:1px solid var(--border);}
.rtbl tr:last-child td{border-bottom:none;}
.rtbl tr:hover td{background:var(--surface2);}
.pbar-w{background:var(--border);border-radius:999px;height:5px;width:60px;display:inline-block;vertical-align:middle;margin-left:5px;}
.pbar{height:100%;border-radius:999px;}
.pb-g{background:#16a34a;}.pb-y{background:#f59e0b;}.pb-r{background:#dc2626;}
.t100{color:#166534;font-weight:700;}.dark .t100{color:#86efac;}.twarn{color:#b45309;}.tbad{color:#b91c1c;}
.mrl{padding:10px 14px;}
.mri{display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:.74rem;}
.mri:last-child{border-bottom:none;}
.mri-w{font-size:.63rem;color:var(--subtext);min-width:58px;}.mri-r{font-weight:700;}
.mri-s{color:var(--subtext);font-size:.68rem;}
.mri-d{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:.65rem;font-weight:600;}
.ractions{display:flex;gap:9px;padding:11px 14px;border-top:1px solid var(--border);}
.rabtn{padding:6px 13px;border-radius:7px;border:1.5px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;font-size:.76rem;font-weight:600;}
.rabtn:hover{background:var(--border);}
.rabtn.pri{background:#1e2d3d;color:#fff;border-color:#1e2d3d;}.rabtn.pri:hover{background:#2d3f54;}
.dark .rabtn.pri{background:#3b82f6;border-color:#3b82f6;}
.empty-sec{padding:13px 14px;color:var(--subtext);font-size:.8rem;}
/* Report edit areas (Change #4) */
.rpt-edit-toggle{display:inline-flex;align-items:center;gap:4px;margin-left:auto;padding:3px 9px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--subtext);cursor:pointer;font-size:.65rem;font-weight:600;transition:background .15s;}
.rpt-edit-toggle:hover{background:var(--border);}
.rpt-edit-toggle.active{background:#dbeafe;border-color:#3b82f6;color:#1d4ed8;}
.dark .rpt-edit-toggle.active{background:#1e3a5f;border-color:#3b82f6;color:#93c5fd;}
.rpt-edit-area{margin:10px 14px;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:.78rem;font-family:inherit;background:var(--bg);color:var(--text);resize:vertical;min-height:60px;outline:none;width:calc(100% - 28px);}
.rpt-edit-area:focus{border-color:#3b82f6;}
.rpt-notes-sec{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:13px;overflow:hidden;}
.rpt-notes-title{font-size:.71rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--subtext);padding:10px 14px 8px;border-bottom:1px solid var(--border);}
.rpt-notes-area{margin:10px 14px 14px;padding:12px;border:1px solid var(--border);border-radius:8px;font-size:.8rem;font-family:inherit;background:var(--bg);color:var(--text);resize:vertical;min-height:80px;outline:none;width:calc(100% - 28px);}
.rpt-notes-area:focus{border-color:#3b82f6;}
/* Import */
.import-wrap{max-width:640px;}
.import-title{font-size:1.1rem;font-weight:700;margin-bottom:4px;}
.import-sub{font-size:.78rem;color:var(--subtext);margin-bottom:20px;}
.drop-zone{border:2.5px dashed var(--border);border-radius:12px;padding:48px 24px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s;background:var(--surface);}
.drop-zone:hover,.drop-zone.over{border-color:#3b82f6;background:var(--blue-bg);}
.dz-icon{font-size:2.5rem;margin-bottom:10px;}
.dz-main{font-size:.9rem;font-weight:600;color:var(--text);margin-bottom:4px;}
.dz-sub{font-size:.75rem;color:var(--subtext);}
.preview-box{margin-top:18px;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
.preview-title{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--subtext);padding:10px 14px 8px;border-bottom:1px solid var(--border);}
.preview-warn{font-size:.75rem;color:#b45309;background:var(--yellow-bg);border:1px solid var(--yellow-border);border-radius:7px;padding:8px 12px;margin:12px 14px 0;}
.preview-actions{display:flex;gap:9px;padding:12px 14px;border-top:1px solid var(--border);}
@media print{header,aside{display:none!important;}#tv{display:none!important;}#rv{display:block!important;padding:0;}body{background:#fff;color:#000;height:auto;overflow:auto;}}
.snap-banner{display:flex;align-items:center;background:var(--yellow-bg);border:1px solid var(--yellow-border);border-radius:8px;padding:9px 14px;margin-bottom:12px;font-size:.8rem;color:var(--text);}
.rpt-time-input{padding:3px 6px;border:1px solid var(--border);border-radius:5px;font-size:.75rem;background:var(--bg);color:var(--text);width:90px;}
.rpt-x-btn{border:none;background:none;color:var(--red);font-size:1rem;cursor:pointer;padding:0 4px;font-weight:700;}
.rpt-x-btn:hover{color:#991b1b;}@media(prefers-color-scheme:dark){body.theme-auto{--bg:#000000;--surface:rgba(28,28,30,.9);--surface2:rgba(44,44,46,.85);--surface3:rgba(58,58,60,.6);--surface-solid:#1c1c1e;--glass-bg:rgba(28,28,30,.78);--glass-border:rgba(255,255,255,.1);--text:#ffffff;--text2:#ebebf5;--subtext:rgba(235,235,245,.6);--subtext2:rgba(235,235,245,.25);--border:rgba(255,255,255,.1);--border2:rgba(255,255,255,.16);--separator:rgba(84,84,88,.65);--header-bg:rgba(22,22,24,.88);--header-border:rgba(255,255,255,.1);--green:#30d158;--green-bg:rgba(48,209,88,.15);--green-border:rgba(48,209,88,.4);--green-text:#a8f5bc;--red:#ff453a;--red-bg:rgba(255,69,58,.15);--red-border:rgba(255,69,58,.4);--red-text:#ffd0cd;--yellow-bg:rgba(255,159,10,.14);--yellow-border:rgba(255,159,10,.35);--blue:#0a84ff;--blue-bg:rgba(10,132,255,.15);--blue-border:rgba(10,132,255,.35);--accent:#0a84ff;--accent-glow:rgba(10,132,255,.25);}}button svg{display:inline-block;vertical-align:middle;flex-shrink:0;}.rabtn{display:inline-flex;align-items:center;gap:6px;}
.rpt-reason-input{padding:4px 7px;border:1px solid var(--border);border-radius:5px;font-size:.75rem;background:var(--bg);color:var(--text);width:100%;}
`;
document.head.appendChild(appStyles);

function cardHtml(wi,r,color){
  const chk=isIn(wi,r.route),t=inTime(wi,r.route);
  const late=isLate(wi)&&!chk, eff=late?'late':color;
  const q=searchQ;
  const match=!q||r.route.toLowerCase()===q||r.dsp.toLowerCase()===q||r.staging.toLowerCase()===q;
  const hasN=hasNote(r.route);
  const isOtd=getNoteOtd(r.route); const otdTitle=isOtd?'Remove OTD':'Mark as OTD';
  return`<div class="rcard ${eff}${chk?' checked':''}${q&&!match?' dimmed':''}" data-wi="${wi}" data-r="${r.route}">
    
    ${isOtd?'<span class="otd-badge">OTD</span>':''}${late?'<span class="late-tag">Late</span>':''}
    <div class="cr">${r.route}</div><div class="cs">${r.staging}</div><div class="cd">${r.dsp}</div>
    ${t?`<div class="ct">${t}</div>`:''}
    <div class="urow">
      <button class="pen-btn${hasN?' has-note':''}" data-r="${r.route}" data-action="note" onclick="event.stopPropagation()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 2.5a1.5 1.5 0 0 1 2.121 2.121l-8.5 8.5-2.828.707.707-2.828 8.5-8.5z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="otd-btn${isOtd?' otd-active':''}" data-r="${r.route}" data-action="otd" onclick="quickToggleOtd(event,this.dataset.r)" title="${otdTitle}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2.5 L14.5 13.5 H1.5 Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="8" y1="6.5" x2="8" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.7" fill="currentColor"/></svg></button>
    </div>
  </div>`;
}

// ── Bind card events ──────────────────────────────────────────────────────────
function bindCards(c){
  c.querySelectorAll('.rcard:not(.dimmed)').forEach(card=>{
    card.addEventListener('click',async e=>{
      if(e.target.closest('[data-action="u"]'))return;
      if(e.target.closest('[data-action="note"]'))return;
      const wi=+card.dataset.wi, ro=card.dataset.r;
      if(isIn(wi,ro)){
        delete state[String(wi)][ro];
        showToast(`${ro} unmarked`);
        await apiCheckin(wi,ro,false,'');
      } else {
        const t=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
        if(!state[String(wi)])state[String(wi)]={};
        state[String(wi)][ro]={time:t};
        showToast(`✅ ${ro} checked in at ${t}`);
        await apiCheckin(wi,ro,true,t);
        if(inCount(wi)===WAVES[wi].total){setTimeout(()=>{playDing();showToast(`🎉 Wave ${WAVES[wi].time} — all in!`);},350);}
      }
      clearSearch();
    });
  });
  c.querySelectorAll('[data-action="note"]').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      openNotePanel(btn.dataset.r);
    });
  });
}

// ── Main render ───────────────────────────────────────────────────────────────
// ── Auto-open active wave by time ─────────────────────────────────────────────
let lastAutoWave = -2; // -2 = uninitialised, -1 = before first wave
function autoOpenWave(){
  const nowMin = new Date().getHours()*60 + new Date().getMinutes();
  // Active wave = wave whose time has passed but next wave hasn't started yet
  // -1 means no wave has started yet → all closed
  let active = -1;
  WAVES.forEach((w,i)=>{
    const start = wMin(w.time);
    const end   = (i+1 < WAVES.length) ? wMin(WAVES[i+1].time) : 9999;
    if(nowMin >= start && nowMin < end) active = i;
  });
  // Only animate when active wave actually changes
  if(active === lastAutoWave) return;
  lastAutoWave = active;
  WAVES.forEach((_,i)=>{ waveOpen[i] = (i === active); });
  // Animate accordion panels if DOM is already rendered
}



function renderMain(){
  autoOpenWave(); // recalculate which wave should be open
  const mc=document.getElementById('mc');
  if(searchQ){
    let html='<div class="srwrap">'; let found=0;
    WAVES.forEach((w,i)=>{
      const green=effGreen(w),red=effRed(w);
      const matched=[...green,...red].filter(r=>r.route.toLowerCase()===searchQ||r.dsp.toLowerCase()===searchQ||r.staging.toLowerCase()===searchQ);
      if(!matched.length)return; found+=matched.length;
      html+=`<div class="sw-lbl">Wave ${w.time} — ${matched.length} result${matched.length!==1?'s':''}</div>
        <div class="rgrid">${matched.map(r=>cardHtml(i,r,green.find(g=>g.route===r.route)?'green':'red')).join('')}</div>`;
    });
    if(!found)html+=`<div class="no-results">No routes found for "<strong>${searchQ}</strong>"</div>`;
    mc.innerHTML=html+'</div>'; bindCards(mc); return;
  }
  let html='';
  WAVES.forEach((w,i)=>{
    const green=effGreen(w),red=effRed(w);
    const done=inCount(i),miss=w.total-done,late=isLate(i)&&miss>0,allDone=miss===0,pct=Math.round(done/w.total*100),open=!!waveOpen[i];
    const badge=allDone?`<span class="bm bm-done">✅ Complete</span>`:late?`<span class="bm bm-late">🟡 ${miss} late</span>`:`<span class="bm bm-miss">● ${miss} missing</span>`;
    html+=`<div class="wave-accordion"><button class="wave-acc-hdr${open?' open':''}" onclick="toggleWave(${i})">
      <span class="wah-chev">▶</span><span class="wah-time">Wave ${w.time}</span>
      <div class="wah-prog"><div class="wah-bar-w"><div class="wah-bar" style="width:${pct}%"></div></div><div class="wah-plbl">${done}/${w.total} checked in</div></div>
      <div class="wah-badges">${badge}</div>
    </button>
    <div class="wave-acc-body${open?' open':''}">
      <div class="pills">
        <span class="pill pt">Total: ${w.total}</span><span class="pill pg">🟢 B/D: ${green.length}</span>
        <span class="pill pr">🔴 A/C: ${red.length}</span><span class="pill pd">✅ In: ${done}</span>
        ${late?`<span class="pill py">🟡 Late: ${miss}</span>`:''}
      </div>
      ${green.length?`<div class="ghdr"><h3 style="color:var(--green)">🟢 Staging B &amp; D</h3><span class="gcnt">${green.length}</span></div><div class="rgrid">${green.map(r=>cardHtml(i,r,'green')).join('')}</div>`:''}
      ${green.length&&red.length?'<hr class="divider"/>'  :''}
      ${red.length?`<div class="ghdr"><h3 style="color:var(--red)">🔴 Staging A &amp; C</h3><span class="gcnt">${red.length}</span></div><div class="rgrid">${red.map(r=>cardHtml(i,r,'red')).join('')}</div>`:''}
    </div></div>`;
  });
  mc.innerHTML=html; bindCards(mc);
  // re-apply open classes after DOM rebuild
  document.querySelectorAll('.wave-acc-hdr').forEach((h,i)=>{ h.classList.toggle('open',!!waveOpen[i]); });
  document.querySelectorAll('.wave-acc-body').forEach((b,i)=>{ b.classList.toggle('open',!!waveOpen[i]); });
}
function toggleWave(i){
  waveOpen[i]=!waveOpen[i];
  const hdr  =document.querySelectorAll('.wave-acc-hdr')[i];
  const body =document.querySelectorAll('.wave-acc-body')[i];
  if(hdr&&body){
    hdr.classList.toggle('open',waveOpen[i]);
    body.classList.toggle('open',waveOpen[i]);
  }
}

// ── Sound ─────────────────────────────────────────────────────────────────────
function playDing(){try{const c=new(window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.setValueAtTime(880,c.currentTime);o.frequency.exponentialRampToValueAtTime(1320,c.currentTime+.15);g.gain.setValueAtTime(.28,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.7);o.start();o.stop(c.currentTime+.7);}catch(e){}}

// Report collapsible state
let rptCollapse={late:false,otd:false};

// Past snapshot — null = live view, object = viewing exported day data
let pastSnapshot=null;

function loadPastReport(evt){
  const file=evt.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=function(e){
    try{
      const data=JSON.parse(e.target.result);
      if(!data.waves||!data.state||!data.date){showToast('\u26a0\ufe0f Invalid day data file');return;}
      pastSnapshot=data;
      rptEdits={late:'',otd:'',reportNotes:''};
      rptEditMode={late:false,otd:false};
      renderReport();
      showToast('Loaded: '+data.date);
    }catch(err){showToast('\u26a0\ufe0f Could not read file');}
  };
  reader.readAsText(file);
  evt.target.value='';
}

function clearPastReport(){
  pastSnapshot=null;
  rptEdits={late:'',otd:'',reportNotes:''};
  rptEditMode={late:false,otd:false};
  renderReport();
}

function pb(p){const cls=p===100?'pb-g':p>=80?'pb-y':'pb-r';const tag=p===100?`<span class="t100">100%</span>`:p>=80?`<span class="twarn">${p}%</span>`:`<span class="tbad">${p}%</span>`;return`${tag}<span class="pbar-w"><span class="pbar ${cls}" style="width:${p}%"></span></span>`;}

function getReportData(snap){
  // Use snapshot data if provided, otherwise live globals
  const snapWaves = snap ? snap.waves : WAVES;
  const snapState = snap ? snap.state : state;
  const snapNotes = snap ? snap.notes : notes;

  // Helper functions scoped to snapshot or live data
  const _isIn=(wi,r)=>!!(snapState[String(wi)]&&snapState[String(wi)][r]);
  const _inTime=(wi,r)=>snapState[String(wi)]?.[r]?.time||'';
  const _inCount=(wi)=>Object.keys(snapState[String(wi)]||{}).length;
  const _allR=(w)=>[...(w.green||[]),...(w.red||[])];
  const _getNoteText=(route)=>{ const n=snapNotes[route]; if(!n)return ''; if(typeof n==='string')return n; return n.text||''; };
  const _getNoteOtd=(route)=>{ const n=snapNotes[route]; if(!n)return false; if(typeof n==='string')return false; return !!n.otd; };

  let tot=0,tin=0;
  snapWaves.forEach((w,i)=>{tot+=w.total;tin+=_inCount(i);});

  const lateArrivals=[];
  snapWaves.forEach((w,i)=>{
    const waveMinutes=wMin(w.time);
    if(waveMinutes===9999)return;
    _allR(w).forEach(r=>{
      if(!_isIn(i,r.route))return;
      const checkinStr=_inTime(i,r.route);
      if(!checkinStr)return;
      const parts=checkinStr.match(/^(\d{1,2}):(\d{2})$/);
      if(!parts)return;
      const checkinMin=parseInt(parts[1])*60+parseInt(parts[2]);
      if(checkinMin>waveMinutes){
        lateArrivals.push({waveIdx:i,waveTime:w.time,route:r.route,dsp:r.dsp,staging:r.staging,checkinTime:checkinStr,delay:checkinMin-waveMinutes});
      }
    });
  });
  lateArrivals.sort((a,b)=>b.delay-a.delay);

  const otdHits=[];
  snapWaves.forEach((w,i)=>{
    _allR(w).forEach(r=>{
      if(_getNoteOtd(r.route)){
        otdHits.push({waveIdx:i,waveTime:w.time,route:r.route,dsp:r.dsp,checkinTime:_inTime(i,r.route)||'\u2014',noteText:_getNoteText(r.route)});
      }
    });
  });

  const otdPct=tot>0?Math.round(((tot-otdHits.length)/tot*100)*100)/100:100;

  const waveBreakdown=snapWaves.map((w,i)=>{
    const waveMinutes=wMin(w.time);
    let wLate=0;
    if(waveMinutes!==9999){
      _allR(w).forEach(r=>{
        if(!_isIn(i,r.route))return;
        const ct=_inTime(i,r.route);
        if(!ct)return;
        const p=ct.match(/^(\d{1,2}):(\d{2})$/);
        if(!p)return;
        if(parseInt(p[1])*60+parseInt(p[2])>waveMinutes)wLate++;
      });
    }
    let wOtd=0;
    _allR(w).forEach(r=>{ if(_getNoteOtd(r.route))wOtd++; });
    return {time:w.time,total:w.total,late:wLate,otd:wOtd};
  });

  const dspMap={};
  snapWaves.forEach((w,i)=>{
    const waveMinutes=wMin(w.time);
    _allR(w).forEach(r=>{
      if(!dspMap[r.dsp])dspMap[r.dsp]={total:0,late:0,otd:0};
      dspMap[r.dsp].total++;
      if(_isIn(i,r.route)){
        const ct=_inTime(i,r.route);
        if(ct&&waveMinutes!==9999){
          const p=ct.match(/^(\d{1,2}):(\d{2})$/);
          if(p&&parseInt(p[1])*60+parseInt(p[2])>waveMinutes)dspMap[r.dsp].late++;
        }
      }
      if(_getNoteOtd(r.route))dspMap[r.dsp].otd++;
    });
  });

  return {tot,tin,otdPct,lateArrivals,otdHits,waveBreakdown,dspMap};
}

function renderReport(){
  const rv=document.getElementById('rv');
  const snap=pastSnapshot;
  const now=new Date();
  const d=getReportData(snap);
  const isSnap=!!snap;
  const snapDate=isSnap?snap.date:'';

  // In snapshot mode: read-only, no edit buttons, no Slack/export actions
  const editBtnHtml=(key)=>(!isSnap&&ROLE==='manager')?`<button class="rpt-edit-toggle${rptEditMode[key]?' active':''}" data-key="${key}" onclick="event.stopPropagation();toggleRptEdit(this.dataset.key)">${rptEditMode[key]?`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 8.5l4 4 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> Done`:`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 2.5a1.5 1.5 0 0 1 2.121 2.121l-8.5 8.5-2.828.707.707-2.828 8.5-8.5z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Edit`}</button>`:'';

  // Snapshot banner
  const snapBanner=isSnap?`<div class="snap-banner"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 4.5A1 1 0 0 1 2.5 3.5H6l1.5 2H13.5A1 1 0 0 1 14.5 6.5V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5V4.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span style="margin-left:5px">Viewing past report:</span> <strong>${snapDate}</strong> <button class="rabtn" style="margin-left:12px;padding:3px 10px;font-size:.72rem;" onclick="clearPastReport()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Back to Live</span></button></div>`:'';

  // Load past report button (always shown at top)
  const loadBtn=`<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
    ${!isSnap?`<span class="rpt-title"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 10.5H2.5A1 1 0 0 1 1.5 9.5V2.5A1 1 0 0 1 2.5 1.5H9.5A1 1 0 0 1 10.5 2.5V3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span style="margin-left:5px">End of Day Yard Breakdown</span></span>`:`<span class="rpt-title" style="color:var(--subtext);">\ud83d\udcc2 Past Report</span>`}
    <button class="rabtn" style="margin-left:auto;font-size:.72rem;padding:4px 11px;" onclick="document.getElementById('past-report-file').click()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 4.5A1 1 0 0 1 2.5 3.5H6l1.5 2H13.5A1 1 0 0 1 14.5 6.5V12.5A1 1 0 0 1 13.5 13.5H2.5A1 1 0 0 1 1.5 12.5V4.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span style="margin-left:5px">Load Past Report</span></button>
    <input type="file" id="past-report-file" accept=".json" style="display:none;" onchange="loadPastReport(event)"/>
  </div>`;

  const dateLabel=isSnap
    ? snap.date
    : now.toLocaleDateString('en-GB',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});

  rv.innerHTML=`${loadBtn}
  ${snapBanner}
  <div class="rpt-sub">DNX3 \u00b7 ${dateLabel}</div>

  <!-- Overview Summary -->
  <div class="rsec"><div class="rsec-title">Overview Summary</div><div class="sgrid">
    <div class="sstat"><div class="sval sv-blue">${d.tot}</div><div class="slbl">Total Routes</div></div>
    <div class="sstat"><div class="sval sv-red">${d.lateArrivals.length}</div><div class="slbl">Late Entries</div></div>
    <div class="sstat"><div class="sval sv-amber">${d.otdHits.length}</div><div class="slbl">OTD Hits</div></div>
    <div class="sstat"><div class="sval ${d.otdPct>=98?'sv-green':d.otdPct>=95?'sv-amber':'sv-red'}">${d.otdPct}%</div><div class="slbl">Expected OTD</div></div>
  </div></div>

  <!-- Wave Breakdown -->
  <div class="rsec"><div class="rsec-title">Wave Breakdown</div><table class="rtbl">
    <thead><tr><th>Wave Time</th><th>Total Routes</th><th>Late Entries</th><th>OTD Hits</th></tr></thead>
    <tbody>${d.waveBreakdown.map(w=>`<tr><td><strong>${w.time}</strong></td><td>${w.total}</td><td>${w.late>0?`<span style="color:var(--red)">${w.late}</span>`:'<span style="color:var(--green)">0</span>'}</td><td>${w.otd>0?`<span style="color:#d97706;font-weight:700">${w.otd} \ud83c\udfaf</span>`:'<span style="color:var(--subtext)">0</span>'}</td></tr>`).join('')}</tbody>
  </table></div>

  <!-- DSP Performance -->
  <div class="rsec"><div class="rsec-title">DSP Performance</div><table class="rtbl">
    <thead><tr><th>DSP</th><th>Total Routes</th><th>Late Entries</th><th>OTD Hits</th></tr></thead>
    <tbody>${Object.entries(d.dspMap).sort((a,b)=>a[0].localeCompare(b[0])).map(([name,v])=>{
      return`<tr><td><strong>${name}</strong></td><td>${v.total}</td><td>${v.late>0?`<span style="color:var(--red)">${v.late}</span>`:'<span style="color:var(--green)">0</span>'}</td><td>${v.otd>0?`<span style="color:#d97706;font-weight:700">${v.otd} \ud83c\udfaf</span>`:'<span style="color:var(--subtext)">0</span>'}</td></tr>`;
    }).join('')}</tbody>
  </table></div>

  <!-- Late Arrivals (collapsible, editable only in live mode) -->
  <div class="rsec"><div class="rsec-title collapsible${rptCollapse.late?' open':''}" onclick="toggleRptSec('late')"><span class="coll-chev">\u25b6</span> <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.5l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Late Arrivals (${d.lateArrivals.length}) ${editBtnHtml('late')}</div>
  <div class="rsec-body${rptCollapse.late?' open':''}" id="rpt-late">${d.lateArrivals.length===0?'<div class="empty-sec">\u2705 No late arrivals!</div>':`<table class="rtbl">
    <thead><tr><th>Wave Time</th><th>Route</th><th>DSP</th><th>Check-in Time</th>${!isSnap?'<th>Edit Time</th><th></th>':''}</tr></thead>
    <tbody>${d.lateArrivals.map(l=>`<tr><td>${l.waveTime}</td><td><strong>${l.route}</strong></td><td>${l.dsp}</td><td><span style="color:#dc2626;font-weight:600">${l.checkinTime}</span> <span style="color:var(--subtext);font-size:.65rem">(+${l.delay}min)</span></td>${!isSnap?`<td><input type="time" class="rpt-time-input" value="${l.checkinTime}" data-wi2="${l.waveIdx}" data-r2="${l.route}" onchange="rptEditLateTime(+this.dataset.wi2,this.dataset.r2,this.value)"></td><td><button class="rpt-x-btn" data-wi="${l.waveIdx}" data-r="${l.route}" data-wt="${l.waveTime}" onclick="rptUncheckLate(+this.dataset.wi,this.dataset.r,this.dataset.wt)" title="Remove (set on-time)">\u2715</button></td>`:''}</tr>`).join('')}</tbody>
  </table>`}${(!isSnap&&rptEditMode.late)?`<textarea class="rpt-edit-area" id="rpt-edit-late" placeholder="Add annotations for late arrivals..." oninput="rptEdits.late=this.value">${rptEdits.late}</textarea>`:''}</div></div>

  <!-- OTD Hits (collapsible, editable only in live mode) -->
  <div class="rsec"><div class="rsec-title collapsible${rptCollapse.otd?' open':''}" onclick="toggleRptSec('otd')"><span class="coll-chev">\u25b6</span> <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2.5L14.5 13.5H1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="8" y1="6.5" x2="8" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.7" fill="currentColor"/></svg> OTD Hits (${d.otdHits.length}) ${editBtnHtml('otd')}</div>
  <div class="rsec-body${rptCollapse.otd?' open':''}" id="rpt-otd">${d.otdHits.length===0?'<div class="empty-sec">No OTD hits marked yet.</div>':`<table class="rtbl">
    <thead><tr><th>Wave Time</th><th>Route</th><th>DSP</th><th>Check-in Time</th><th>Reason</th>${!isSnap?'<th></th>':''}</tr></thead>
    <tbody>${d.otdHits.map(o=>`<tr><td>${o.waveTime}</td><td><strong>${o.route}</strong></td><td>${o.dsp}</td><td>${o.checkinTime}</td><td>${!isSnap?`<input type="text" class="rpt-reason-input" value="${(o.noteText||'').replace(/"/g,'&quot;')}" placeholder="Add reason..." data-r3="${o.route}" onchange="rptEditOtdReason(this.dataset.r3,this.value)">`:(o.noteText||'\u2014')}</td>${!isSnap?`<td><button class="rpt-x-btn" data-r="${o.route}" onclick="rptUncheckOtd(this.dataset.r)" title="Remove OTD">\u2715</button></td>`:''}</tr>`).join('')}</tbody>
  </table>`}${(!isSnap&&rptEditMode.otd)?`<textarea class="rpt-edit-area" id="rpt-edit-otd" placeholder="Add annotations for OTD hits..." oninput="rptEdits.otd=this.value">${rptEdits.otd}</textarea>`:''}</div></div>

  <!-- Report Notes (live mode only) -->
  ${(!isSnap&&ROLE==='manager')?`<div class="rpt-notes-sec">
    <div class="rpt-notes-title"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 2.5a1.5 1.5 0 0 1 2.121 2.121l-8.5 8.5-2.828.707.707-2.828 8.5-8.5z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Report Notes</span></div>
    <textarea class="rpt-notes-area" id="rpt-notes-area" placeholder="Add general report notes, comments, or context..." oninput="rptEdits.reportNotes=this.value">${rptEdits.reportNotes}</textarea>
  </div>`:''}

  <!-- Actions -->
  <div class="rsec"><div class="ractions">
    <button class="rabtn pri" onclick="downloadRpt()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v8m0 0-3-3m3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span style="margin-left:5px">Download .txt</span></button>
    <button class="rabtn" onclick="copyRpt()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 10.5H2.5A1 1 0 0 1 1.5 9.5V2.5A1 1 0 0 1 2.5 1.5H9.5A1 1 0 0 1 10.5 2.5V3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span style="margin-left:5px">Copy</span></button>
    ${(!isSnap&&ROLE==='manager')?'<button class="rabtn" onclick="submitRptToSlack()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2 2 7l4.5 1.5L14 2zm0 0-5.5 9L8.5 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Submit to Slack</span></button>':''}
    ${(!isSnap&&ROLE==='manager')?'<button class="rabtn" onclick="exportDayData()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="9.5" width="13" height="5" rx="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="12.5" cy="12" r="1" fill="currentColor"/><path d="M5 7.5V2m0 0L3 4m2-2 2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Export Day Data</span></button>':''}
  </div></div>`;
}

// ── Report: collapsible toggle ────────────────────────────────────────────────
function toggleRptSec(key){
  rptCollapse[key]=!rptCollapse[key];
  renderReport();
}

// ── Report: edit toggle ───────────────────────────────────────────────────────
function toggleRptEdit(key){
  rptEditMode[key]=!rptEditMode[key];
  renderReport();
}

// ── Report: Edit late time ───────────────────────────────────────────────────
async function rptEditLateTime(waveIdx,route,newTime){
  if(!newTime)return;
  const wi=String(waveIdx);
  if(!state[wi])state[wi]={};
  if(!state[wi][route])state[wi][route]={time:newTime};
  else state[wi][route].time=newTime;
  await apiCheckin(waveIdx,route,true,newTime);
  renderReport();
}

// ── Report: Uncheck late (set time = wave time to make on-time) ──────────────
async function rptUncheckLate(waveIdx,route,waveTime){
  // Convert wave time (e.g. "7:30 AM") to 24h "HH:MM"
  const m=waveTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if(!m)return;
  let h=+m[1],mn=+m[2],ap=m[3].toUpperCase();
  if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
  const onTime=String(h).padStart(2,'0')+':'+String(mn).padStart(2,'0');
  const wi=String(waveIdx);
  if(!state[wi])state[wi]={};
  if(!state[wi][route])state[wi][route]={time:onTime};
  else state[wi][route].time=onTime;
  await apiCheckin(waveIdx,route,true,onTime);
  showToast(`⏰ ${route} set on-time (${onTime})`);
  renderReport();
}

// ── Report: Edit OTD reason ──────────────────────────────────────────────────
async function rptEditOtdReason(route,reason){
  const currentOtd=getNoteOtd(route);
  notes[route]={text:reason,otd:currentOtd};
  await apiSaveNote(route,reason,currentOtd);
  renderReport();
}

async function rptUncheckOtd(route){
  const currentText=getNoteText(route);
  if(currentText){
    notes[route]={text:currentText,otd:false};
  } else {
    delete notes[route];
  }
  await apiSaveNote(route,currentText,false);
  showToast(`🎯 OTD removed for ${route}`);
  renderReport();
}

function buildReportText(){
  const snap=pastSnapshot;
  const d=getReportData(snap);
  const now=new Date();
  const dateStr=snap
    ? snap.date
    : now.toLocaleDateString('en-GB',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  const timeStr=now.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  const SEP='\u2501'.repeat(42);
  let t='';
  t+=`DNX3 \u2014 End of Day Yard Breakdown\n`;
  t+=`${dateStr} \u00b7 Generated: ${timeStr}\n`;
  t+=`${SEP}\n\n`;

  t+=`\ud83d\udcca OVERVIEW\n`;
  t+=`  Routes: ${d.tot}  |  Late: ${d.lateArrivals.length}  |  OTD Hits: ${d.otdHits.length}  |  Expected OTD: ${d.otdPct}%\n\n`;

  t+=`${SEP}\n`;
  t+=`\ud83c\udf0a WAVES\n`;
  d.waveBreakdown.forEach(w=>{
    t+=`  ${w.time}  \u2192  ${w.total} routes  |  ${w.late} late  |  ${w.otd} OTD\n`;
  });

  t+=`\n${SEP}\n`;
  t+=`\ud83c\udfe2 DSP PERFORMANCE\n`;
  Object.entries(d.dspMap).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([name,v])=>{
    t+=`  ${name}  \u2192  ${v.total} routes  |  ${v.late} late  |  ${v.otd} OTD\n`;
  });

  t+=`\n${SEP}\n`;
  t+=`\u23f0 LATE ARRIVALS (${d.lateArrivals.length})\n`;
  if(d.lateArrivals.length===0){
    t+=`  \u2705 None\n`;
  } else {
    d.lateArrivals.forEach(l=>{
      t+=`  ${l.route}  \u00b7  ${l.dsp}  \u00b7  Wave ${l.waveTime}  \u00b7  ${l.checkinTime} (+${l.delay} min)\n`;
    });
  }
  if(rptEdits.late){ t+=`\n  Notes: ${rptEdits.late}\n`; }

  t+=`\n${SEP}\n`;
  t+=`\ud83c\udfaf OTD HITS (${d.otdHits.length})\n`;
  if(d.otdHits.length===0){
    t+=`  None marked\n`;
  } else {
    d.otdHits.forEach(o=>{
      t+=`  ${o.route}  \u00b7  ${o.dsp}  \u00b7  Wave ${o.waveTime}  \u00b7  Reason: ${o.noteText||'\u2014'}\n`;
    });
  }
  if(rptEdits.otd){ t+=`\n  Notes: ${rptEdits.otd}\n`; }

  if(rptEdits.reportNotes){
    t+=`\n${SEP}\n`;
    t+=`\ud83d\udcdd REPORT NOTES\n`;
    t+=`  ${rptEdits.reportNotes}\n`;
  }

  t+=`\n${SEP}\n`;
  return t;
}


function copyRpt(){
  const snap=pastSnapshot;
  const d=getReportData(snap);
  const now=new Date();
  const dateStr=snap
    ? snap.date
    : now.toLocaleDateString('en-GB',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  const timeStr=now.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  const SEP='\u2501'.repeat(42);
  let t=`DNX3 \u2014 End of Day Yard Breakdown\n`;
  t+=`${dateStr} \u00b7 Generated: ${timeStr}\n`;
  t+=`${SEP}\n\n`;

  t+=`\ud83d\udcca OVERVIEW\n`;
  t+=`  Routes: ${d.tot}  |  Late: ${d.lateArrivals.length}  |  OTD Hits: ${d.otdHits.length}  |  Expected OTD: ${d.otdPct}%\n\n`;

  t+=`${SEP}\n`;
  t+=`\ud83c\udf0a WAVES\n`;
  d.waveBreakdown.forEach(w=>{
    t+=`  ${w.time}  \u2192  ${w.total} routes  |  ${w.late} late  |  ${w.otd} OTD\n`;
  });

  t+=`\n${SEP}\n`;
  t+=`\ud83c\udfe2 DSP PERFORMANCE\n`;
  Object.entries(d.dspMap).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([name,v])=>{
    t+=`  ${name}  \u2192  ${v.total} routes  |  ${v.late} late  |  ${v.otd} OTD\n`;
  });

  t+=`\n${SEP}\n`;
  t+=`\u23f0 LATE ARRIVALS (${d.lateArrivals.length})\n`;
  if(d.lateArrivals.length===0){
    t+=`  \u2705 None\n`;
  } else {
    d.lateArrivals.forEach(l=>{
      t+=`  ${l.route}  \u00b7  ${l.dsp}  \u00b7  Wave ${l.waveTime}  \u00b7  ${l.checkinTime} (+${l.delay} min)\n`;
    });
  }
  if(rptEdits.late){ t+=`\n  Notes: ${rptEdits.late}\n`; }

  t+=`\n${SEP}\n`;
  t+=`\ud83c\udfaf OTD HITS (${d.otdHits.length})\n`;
  if(d.otdHits.length===0){
    t+=`  None marked\n`;
  } else {
    d.otdHits.forEach(o=>{
      t+=`  ${o.route}  \u00b7  ${o.dsp}  \u00b7  Wave ${o.waveTime}  \u00b7  Reason: ${o.noteText||'\u2014'}\n`;
    });
  }
  if(rptEdits.otd){ t+=`\n  Notes: ${rptEdits.otd}\n`; }

  if(rptEdits.reportNotes){
    t+=`\n${SEP}\n`;
    t+=`\ud83d\udcdd REPORT NOTES\n`;
    t+=`  ${rptEdits.reportNotes}\n`;
  }

  t+=`\n${SEP}\n`;
  navigator.clipboard.writeText(t).then(()=>showToast('Copied!'));
}

function downloadRpt(){
  const t=buildReportText();
  const now=new Date();
  // Create and trigger download
  const blob=new Blob([t],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`DNX3_Yard_Breakdown_${now.toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Report downloaded!');
}

async function submitRptToSlack(){
  if(!slackEnabled){showToast("Slack is disabled — enable it in Settings first.");return;}
  const t=buildReportText();
  const now=new Date();
  const dateStr=now.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'numeric'});
  // Auto-detect cycle from route prefix (e.g. SA_A → Same Day-A, CA_A → Cycle_1)
  const prefix=getPrefix().toUpperCase();
  let cycleLabel='Cycle_1';
  if(prefix.startsWith('SA_A')) cycleLabel='Same Day-A';
  else if(prefix.startsWith('SA_B')) cycleLabel='Same Day-B';
  else if(prefix.startsWith('SA_C')) cycleLabel='Same Day-C';
  else if(prefix.startsWith('CA_')) cycleLabel='Cycle_1';
  const title=`\ud83d\udcca Yard Report ${cycleLabel} \u2014 DNX3 \u2014 ${dateStr}`;
  try{
    const r=await fetch('/api/slack_report',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({text:t,title})
    });
    if(r.ok){
      showToast('📤 Report sent to Slack!');
    } else {
      const d=await r.json();
      showToast('⚠️ '+(d.error||'Failed to send to Slack'));
    }
  }catch(e){
    showToast('⚠️ Cannot reach server.');
  }
}

// Change #8: Export Day Data as JSON
function exportDayData(){
  const now=new Date();
  const data={
    date:now.toISOString().slice(0,10),
    waves:WAVES,
    state:state,
    notes:notes,
    scanlog:scanlog
  };
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`DNX3_DayData_${now.toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('💾 Day data exported!');
}


// ── Settings tab (manager only) ───────────────────────────────────────────────
async function fetchSettings(){
  try{
    const r=await fetch('/api/settings',{headers:{'X-Token':TOKEN}});
    if(r.ok) return await r.json();
  }catch(e){}
  return {};
}

async function toggleSlack(){
  slackEnabled = !slackEnabled;
  const btn = document.getElementById('slack-toggle-btn');
  const ind = document.getElementById('slack-toggle-ind');
  if(btn){
    btn.setAttribute('data-on', slackEnabled ? '1' : '0');
    if(ind) ind.style.transform = slackEnabled ? 'translateX(20px)' : 'translateX(2px)';
  }
  const statusEl = document.getElementById('slack-toggle-status');
  if(statusEl) statusEl.textContent = slackEnabled ? 'Enabled' : 'Disabled (safe mode)';
  // persist to settings.json via server
  try{
    const r = await fetch('/api/settings',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body: JSON.stringify({slack_enabled: slackEnabled})
    });
    if(!r.ok) showToast('Failed to save Slack toggle');
  }catch(e){ showToast('Network error saving toggle'); }
}

function renderSettings(){
  const sv=document.getElementById('sv');
  if(!sv)return;
  fetchSettings().then(settings=>{
    slackEnabled = !!(settings.slack_enabled);
    const defaultWH=settings.slack_webhook_url||'';
    const dspWebhooks=settings.dsp_webhooks||{};
    
    // Get all unique DSPs from WAVES data
    const allDsps=new Set();
    WAVES.forEach(w=>{[...(w.green||[]),...(w.red||[])].forEach(r=>allDsps.add(r.dsp));});
    const dspList=[...allDsps].sort();
    
    // Build DSP webhook rows
    let dspRows='';
    Object.entries(dspWebhooks).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([dsp,url])=>{
      dspRows+=`<div class="wh-row" data-dsp="${dsp}">
        <span class="wh-dsp">${dsp}</span>
        <input type="text" class="wh-input" value="${url}" placeholder="https://hooks.slack.com/services/..." data-dsp="${dsp}"/>
        <button class="rabtn" data-dsp="${dsp}" onclick="testDspAlert(this.dataset.dsp)" title="Send test late alert to this DSP" style="white-space:nowrap;font-size:.7rem;padding:4px 10px;"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 1.5h4M6.5 1.5v5.2L2.5 13a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5L9.5 6.7V1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Test Alert</span></button>
        <button class="wh-rm" data-dsp="${dsp}" onclick="removeDspWebhook(this.dataset.dsp)" title="Remove">&times;</button>
      </div>`;
    });

    // DSP options for the dropdown (exclude already-added ones)


    sv.innerHTML=`
      <div class="slack-toggle-wrap">
        <div class="slack-toggle-label">
          <div class="slack-toggle-title">Slack Notifications</div>
          <div class="slack-toggle-sub">Enable before going live. Off by default to prevent accidental sends during testing.</div>
        </div>
        <button class="slack-toggle-btn" id="slack-toggle-btn" data-on="${slackEnabled?'1':'0'}" onclick="toggleSlack()" title="Toggle Slack notifications">
          <span class="slack-toggle-ind" id="slack-toggle-ind" style="transform:${slackEnabled?'translateX(20px)':'translateX(2px)'}"></span>
        </button>
        <span class="slack-toggle-status" id="slack-toggle-status">${slackEnabled?'Enabled':'Disabled (safe mode)'}</span>
      </div>
      <div class="rpt-title" style="padding:14px 16px 4px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Settings</span></div>

      <div class="rsec">
        <div class="rsec-title">Slack Integration</div>
        <div style="padding:14px 16px;">
          <label class="wh-label">Default Webhook (Reports & General Alerts)</label>
          <input type="text" id="settings-webhook" value="${defaultWH}" placeholder="https://hooks.slack.com/services/T.../B.../xxx" class="wh-main-input"/>
          
          <div style="margin-top:20px;">
            <label class="wh-label">DSP-Specific Webhooks (Late Tour Alerts)</label>
            <div class="wh-hint" style="margin-bottom:8px;">Late departure alerts are sent only to the DSP\u2019s own webhook. If no webhook is set for a DSP, no alert is sent.</div>
            <div id="dsp-webhook-list">${dspRows||'<div class="wh-empty">No DSP webhooks configured yet.</div>'}</div>
            <div class="wh-add-row">
              <input type="text" id="add-dsp-name" class="wh-select" placeholder="DSP name..." style="min-width:80px;"/>
              <input type="text" id="add-dsp-url" class="wh-input" placeholder="Webhook URL for this DSP..."/>
              <button class="rabtn" onclick="addDspWebhook()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span style="margin-left:5px">Add</span></button>
            </div>
          </div>

          <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="rabtn pri" onclick="saveAllWebhooks()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.4"/><rect x="4.5" y="1.5" width="7" height="4" rx="0.5" stroke="currentColor" stroke-width="1.2"/><rect x="3.5" y="8.5" width="9" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/></svg><span style="margin-left:5px">Save All</span></button>
            <button class="rabtn" onclick="testWebhook('default')"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 1.5h4M6.5 1.5v5.2L2.5 13a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5L9.5 6.7V1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Test Default</span></button>
            <button class="rabtn" onclick="exportSettings()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 10V2m0 0L5 5m3-3 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span style="margin-left:5px">Export Settings</span></button>
            <button class="rabtn" onclick="document.getElementById('import-settings-file').click()"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1M8 2v8m0 0-3-3m3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="margin-left:5px">Import Settings</span></button>
            <input type="file" id="import-settings-file" accept=".json" style="display:none;" onchange="importSettings(event)"/>
          </div>
          <div id="webhook-status" style="margin-top:10px;font-size:.75rem;min-height:20px;"></div>
        </div>
      </div>

      <div class="rsec" style="margin-top:16px;">
        <div class="rsec-title">About</div>
        <div style="padding:12px 14px;font-size:.78rem;color:var(--subtext);line-height:1.7;">
          DNX3 Container Wave Tracker<br/>
          Developed by <strong>@koeabdur</strong><br/>
          Version 2.1
        </div>
      </div>
      </div>
    `;
  });
}

function addDspWebhook(){
  const sel=document.getElementById('add-dsp-name');
  const inp=document.getElementById('add-dsp-url');
  if(!sel||!inp)return;
  const dsp=sel.value.trim().toUpperCase();
  const url=inp.value.trim();
  if(!dsp){showToast('\u26a0\ufe0f Enter a DSP name');return;}
  if(!url){showToast('\u26a0\ufe0f Enter a webhook URL');return;}
  // Save immediately
  fetchSettings().then(settings=>{
    if(!settings.dsp_webhooks) settings.dsp_webhooks={};
    settings.dsp_webhooks[dsp]=url;
    fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},body:JSON.stringify(settings)}).then(r=>{
      if(r.ok){showToast(`\u2705 Webhook added for ${dsp}`);renderSettings();}
      else showToast('\u274c Failed to save');
    });
  });
}

function removeDspWebhook(dsp){
  fetchSettings().then(settings=>{
    if(settings.dsp_webhooks) delete settings.dsp_webhooks[dsp];
    fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},body:JSON.stringify(settings)}).then(r=>{
      if(r.ok){showToast(`Removed webhook for ${dsp}`);renderSettings();}
    });
  });
}

async function saveAllWebhooks(){
  const mainInp=document.getElementById('settings-webhook');
  const defaultUrl=mainInp?mainInp.value.trim():'';
  const status=document.getElementById('webhook-status');
  
  // Collect DSP webhook values from inputs
  const dspInputs=document.querySelectorAll('#dsp-webhook-list .wh-input');
  const dspWebhooks={};
  dspInputs.forEach(inp=>{
    const dsp=inp.dataset.dsp;
    const url=inp.value.trim();
    if(dsp&&url) dspWebhooks[dsp]=url;
  });

  try{
    const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({slack_webhook_url:defaultUrl, dsp_webhooks:dspWebhooks})});
    if(r.ok){
      status.innerHTML='<span style="color:var(--green);">\u2705 All webhooks saved!</span>';
      showToast('<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M3.4 12.6l.85-.85M11.75 4.25l.85-.85" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span style="margin-left:5px">Settings</span> saved');
    } else {
      status.innerHTML='<span style="color:var(--red);">\u274c Failed to save</span>';
    }
  }catch(e){ status.innerHTML='<span style="color:var(--red);">\u274c Network error</span>'; }
}

async function testWebhook(target){
  const status=document.getElementById('webhook-status');
  status.innerHTML='<span style="color:var(--subtext);">Testing...</span>';
  try{
    const r=await fetch('/api/test_slack',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},body:JSON.stringify({target})});
    const d=await r.json();
    if(r.ok){
      status.innerHTML='<span style="color:var(--green);">\u2705 Test message sent! Check Slack.</span>';
    } else {
      status.innerHTML=`<span style="color:var(--red);">\u274c ${d.error||'Failed'}</span>`;
    }
  }catch(e){ status.innerHTML='<span style="color:var(--red);">\u274c Network error</span>'; }
}



async function testDspAlert(dsp){
  const status=document.getElementById('webhook-status');
  status.innerHTML='<span style="color:var(--subtext);">Sending test alert to '+dsp+'...</span>';
  try{
    const r=await fetch('/api/test_dsp_alert',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},body:JSON.stringify({dsp})});
    const d=await r.json();
    if(r.ok){
      status.innerHTML='<span style="color:var(--green);">\u2705 Test alert sent to '+dsp+'! Check Slack.</span>';
    } else {
      status.innerHTML='<span style="color:var(--red);">\u274c '+(d.error||'Failed')+'</span>';
    }
  }catch(e){ status.innerHTML='<span style="color:var(--red);">\u274c Network error</span>'; }
}

async function exportSettings(){
  const settings=await fetchSettings();
  const blob=new Blob([JSON.stringify(settings,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`DNX3_Settings_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Settings exported!');
}

function importSettings(evt){
  const file=evt.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=async function(e){
    try{
      const settings=JSON.parse(e.target.result);
      const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},body:JSON.stringify(settings)});
      if(r.ok){
        showToast('Settings imported!');
        renderSettings();
      } else {
        showToast('\u274c Failed to import settings');
      }
    }catch(err){
      showToast('\u274c Invalid settings file');
    }
  };
  reader.readAsText(file);
  evt.target.value='';
}


// ── Import tab ────────────────────────────────────────────────────────────────
let parsedWaves=null;

function renderImport(){
  const iv=document.getElementById('iv');
  const last=localStorage.getItem('dnx3_last_import')||'No import yet';
  let scanlogHtml='';
  if(ROLE==='manager'){
    scanlogHtml=`<div class="scanlog-sec">
      <div class="scanlog-title">📋 ScanLog — Override Staging</div>
      <div class="scanlog-body">
        <div class="scanlog-input-row">
          <input type="text" id="scanlog-input" class="scanlog-input" placeholder="Tour numbers (e.g. 249, 259, 5)..." onkeydown="if(event.key==='Enter')addScanlogEntry()"/>
          <button class="scanlog-add" onclick="addScanlogEntry()">Add</button>
        </div>
        ${scanlog.length?`<ul class="scanlog-list">${scanlog.map(r=>`<li class="scanlog-item"><span>${r}</span><button class="scanlog-rm" data-r="${r}" onclick="removeScanlogEntry(this.dataset.r)">×</button></li>`).join('')}</ul>`:'<div class="scanlog-empty">No entries yet. Scanned tours will be moved to A/C staging group.</div>'}
      </div>
    </div>`;
  }
  iv.innerHTML=`<div class="import-wrap">
    <div class="import-title">📥 Import Today's Sequencing</div>
    <div class="import-sub">Drag and drop the Excel file below — the tracker will update for all devices automatically.</div>
    <div class="drop-zone" id="dz" onclick="document.getElementById('fi').click()">
      <div class="dz-icon">📂</div>
      <div class="dz-main">Drop your Excel file here</div>
      <div class="dz-sub">or click to browse &nbsp;·&nbsp; .xlsx · .xls · .csv</div>
    </div>
    <input type="file" id="fi" accept=".xlsx,.xls,.csv" style="display:none" onchange="handleFile(this.files[0])"/>
    <div id="preview-area"></div>
    <div class="import-last">Last import: ${last}</div>
    <div style="margin-top:14px;"><button class="rabtn" style="background:#dc2626;color:#fff;border-color:#dc2626;" onclick="clearSequencing()">🗑️ Clear Sequencing Data</button><span style="font-size:.68rem;color:var(--subtext);margin-left:10px;">Removes all wave data and resets the tracker</span></div>
    ${scanlogHtml}
  </div>`;
  const dz=document.getElementById('dz');
  dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
  dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
  dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('over');const f=e.dataTransfer.files[0];if(f)handleFile(f);});
}

async function addScanlogEntry(){
  const inp=document.getElementById('scanlog-input');
  if(!inp)return;
  const raw=inp.value.trim();
  if(!raw){showToast('\u26a0\ufe0f Enter a tour number');return;}
  const prefix=getPrefix();
  const parts=raw.split(/[,;\s]+/).filter(Boolean);
  const added=[];
  for(const part of parts){
    const route=/^\d+$/.test(part)?(prefix+part):part.toUpperCase();
    if(scanlog.includes(route))continue;
    scanlog.push(route);
    await apiAddScanlog(route);
    added.push(route);
  }
  inp.value='';
  if(added.length===0){showToast('\u26a0\ufe0f All entries already in ScanLog');return;}
  showToast(`${added.length} tour${added.length>1?'s':''} added to ScanLog`);
  render();
  renderImport();
}

async function clearSequencing(){
  if(!confirm('Are you sure? This will remove ALL wave/sequencing data and reset the tracker.'))return;
  try{
    const r=await fetch('/api/clear_data',{method:'POST',headers:{'X-Token':TOKEN}});
    if(r.ok){
      showToast('Sequencing data cleared');
      location.reload();
    } else {
      showToast('\u274c Failed to clear data');
    }
  }catch(e){showToast('\u274c Network error');}
}


async function removeScanlogEntry(route){
  scanlog=scanlog.filter(r=>r!==route);
  await apiRemoveScanlog(route);
  showToast(`📋 ${route} removed from ScanLog`);
  render();
  renderImport();
}

function handleFile(file){
  if(!file)return;
  const ext=file.name.split('.').pop().toLowerCase();
  if(!['xlsx','xls','csv'].includes(ext)){showToast('⚠️ Only .xlsx, .xls or .csv accepted');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const data=new Uint8Array(e.target.result);
      const wb=XLSX.read(data,{type:'array'});
      const sheetName=wb.SheetNames.find(s=>s.toLowerCase().includes('sequenc'))||wb.SheetNames[0];
      const ws=wb.Sheets[sheetName];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      parsedWaves=parseRows(rows,file.name);
      if(parsedWaves)showPreview(parsedWaves,file.name);
    }catch(err){showToast('⚠️ Could not read file: '+err.message);}
  };
  reader.readAsArrayBuffer(file);
}

const COL_ALIASES={
  wave:   ['wave time','wave','departure','wave_time'],
  route:  ['route code','route','route_code','routecode','tour','tour code'],
  staging:['staging','staging location','stage','position'],
  dsp:    ['dsp','dsp code','dsp_code','provider','carrier'],
  group:  ['staging group','group','color','zone'],
};

function findCols(headers){
  const hl=headers.map(h=>String(h||'').trim().toLowerCase());
  const res={};
  for(const[k,aliases]of Object.entries(COL_ALIASES)){
    for(let i=0;i<hl.length;i++){if(aliases.includes(hl[i])){res[k]=i;break;}}
  }
  return res;
}

function detectGroup(staging){
  const m=String(staging).toUpperCase().match(/STG-([ABCD])/);
  return m?(['B','D'].includes(m[1])?'green':'red'):'red';
}

function parseRows(rows,filename){
  const pa=document.getElementById('preview-area');
  if(!rows||rows.length<2){pa.innerHTML=`<div class="preview-warn">⚠️ File appears empty.</div>`;return null;}
  let headerIdx=0;
  for(let i=0;i<Math.min(5,rows.length);i++){if(rows[i].some(c=>c!=='')){{headerIdx=i;break;}}}
  const col=findCols(rows[headerIdx]);
  const req=['wave','route','staging','dsp'];
  const missing=req.filter(k=>!(k in col));
  if(missing.length){
    pa.innerHTML=`<div class="preview-warn">⚠️ Required columns not found: <strong>${missing.join(', ')}</strong><br>Headers seen: ${rows[headerIdx].filter(h=>h).join(', ')}</div>`;
    return null;
  }
  const wavesMap={},order=[];
  for(let i=headerIdx+1;i<rows.length;i++){
    const row=rows[i];
    const wRaw=row[col.wave],rRaw=row[col.route],sRaw=row[col.staging],dRaw=row[col.dsp];
    if(!wRaw&&!rRaw)continue;
    const wt=normTime(wRaw),route=String(rRaw||'').trim(),staging=String(sRaw||'').trim(),dsp=String(dRaw||'').trim().toUpperCase();
    if(!wt||!route||!staging||!dsp)continue;
    const color=('group' in col)?detectGroup(row[col.group])||detectGroup(staging):detectGroup(staging);
    if(!wavesMap[wt]){wavesMap[wt]={green:[],red:[]};order.push(wt);}
    wavesMap[wt][color].push({route,staging,dsp});
  }
  order.sort((a,b)=>wMin(a)-wMin(b));
  if(!order.length){pa.innerHTML=`<div class="preview-warn">⚠️ No valid routes found. Check column headers and data.</div>`;return null;}
  return order.map(t=>({time:t,total:wavesMap[t].green.length+wavesMap[t].red.length,green:wavesMap[t].green,red:wavesMap[t].red}));
}

function normTime(v){
  if(!v)return null;
  if(typeof v==='number'){const tm=Math.round(v*24*60);const h=Math.floor(tm/60),m=tm%60;const ap=h<12?'AM':'PM';const h12=h%12||12;return`${h12}:${String(m).padStart(2,'0')} ${ap}`;}
  const s=String(v).trim();
  const m1=s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);if(m1)return`${m1[1]}:${m1[2]} ${m1[3].toUpperCase()}`;
  const m2=s.match(/^(\d{1,2}):(\d{2})$/);if(m2){const h=+m2[1];return`${h%12||12}:${m2[2]} ${h<12?'AM':'PM'}`;}
  return s;
}

function showPreview(waves,filename){
  const tot=waves.reduce((s,w)=>s+w.total,0);
  const pa=document.getElementById('preview-area');
  pa.innerHTML=`<div class="preview-box">
    <div class="preview-title">✅ Preview — ${filename}</div>
    <table class="rtbl"><thead><tr><th>Wave</th><th>Total</th><th>🟢 B/D</th><th>🔴 A/C</th></tr></thead>
    <tbody>${waves.map(w=>`<tr><td><strong>${w.time}</strong></td><td>${w.total}</td><td>${w.green.length}</td><td>${w.red.length}</td></tr>`).join('')}
    <tr style="font-weight:700"><td>TOTAL</td><td>${tot}</td><td>${waves.reduce((s,w)=>s+w.green.length,0)}</td><td>${waves.reduce((s,w)=>s+w.red.length,0)}</td></tr>
    </tbody></table>
    <div class="preview-warn">⚠️ Confirming will reset all current check-ins for all devices.</div>
    <div class="preview-actions">
      <button class="rabtn pri" onclick="confirmImport()">✅ Confirm &amp; Load for All Devices</button>
      <button class="rabtn" onclick="cancelImport()">✗ Cancel</button>
    </div>
  </div>`;
}

async function confirmImport(){
  if(!parsedWaves)return;
  // Generate data.js content
  const lines=['// Generated by Wave Tracker Import — '+new Date().toLocaleString(),'const WAVES = ['];
  parsedWaves.forEach((w,i)=>{
    const g=w.green.map(r=>`{route:"${r.route}",staging:"${r.staging}",dsp:"${r.dsp}"}`).join(',');
    const r=w.red.map(r=>`{route:"${r.route}",staging:"${r.staging}",dsp:"${r.dsp}"}`).join(',');
    lines.push(`  {time:"${w.time}",total:${w.total},green:[${g}],red:[${r}]}${i<parsedWaves.length-1?',':''}`);
  });
  lines.push('];');
  const content=lines.join('\n');
  try{
    const res=await fetch('/api/import_data',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},body:JSON.stringify({content})});
    if(!res.ok){const d=await res.json();showToast('⚠️ Import failed: '+(d.error||'unknown error'));return;}
    const now=new Date().toLocaleString('en-GB');
    localStorage.setItem('dnx3_last_import',`${now} · ${parsedWaves.reduce((s,w)=>s+w.total,0)} routes · ${parsedWaves.length} waves`);
    showToast('✅ Import successful — reloading all devices...');
    setTimeout(()=>location.reload(),1800);
  }catch(e){showToast('⚠️ Cannot reach server.');}
}

function cancelImport(){ parsedWaves=null; document.getElementById('preview-area').innerHTML=''; }

// ── Master render ─────────────────────────────────────────────────────────────
function render(){ renderSidebar(); renderMain(); }

// ── Auto-boot if token exists ─────────────────────────────────────────────────
if(TOKEN){ bootApp(); } else { document.getElementById('login-screen').style.display='flex'; }
