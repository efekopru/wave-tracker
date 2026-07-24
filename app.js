// DNX3 Wave Tracker — Client JS (Part 1: Auth, State, Socket, Sidebar)
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const API = '';  // same origin
let TOKEN = localStorage.getItem('dnx3_token') || '';
let ROLE  = localStorage.getItem('dnx3_role')  || '';

// ── App state ─────────────────────────────────────────────────────────────────
let state       = {};   // waveIdx -> { route -> { time, uniform } }
let notes       = {};   // route -> text
let scanlog     = [];   // array of route strings
let waveOpen    = {};
let missingOpen = {};
let searchQ     = '';
let dark        = localStorage.getItem('dnx3_dk') === '1';
let socket      = null;
let notePanel   = {open:false, route:''};

if (dark) document.body.classList.add('dark');

// ── Helpers ───────────────────────────────────────────────────────────────────
function isIn(wi, r)      { return !!(state[wi] && state[wi][r]); }
function hasUniform(wi,r) { return !!(state[wi] && state[wi][r] && state[wi][r].uniform); }
function inTime(wi, r)    { return state[wi]?.[r]?.time || ''; }
function inCount(wi)      { return Object.keys(state[String(wi)] || {}).length; }
function uniCount(wi)     { return Object.values(state[String(wi)] || {}).filter(v=>v.uniform).length; }
function allR(w)          { return [...(w.green||[]), ...(w.red||[])]; }
function sortByDsp(arr)   { return [...arr].sort((a,b)=>a.dsp.localeCompare(b.dsp)||a.route.localeCompare(b.route,undefined,{numeric:true})); }

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
function isLate(wi){ const n=new Date(); return(n.getHours()*60+n.getMinutes())>wMin(WAVES[wi].time)+5; }

// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock(){ document.getElementById('clock').textContent=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
setInterval(updateClock,1000); updateClock();

// ── Dark mode ─────────────────────────────────────────────────────────────────
function toggleDark(){
  dark=!dark; document.body.classList.toggle('dark',dark);
  localStorage.setItem('dnx3_dk',dark?'1':'0');
  document.getElementById('dark-btn').textContent=dark?'☀️':'🌙';
}
if(dark)document.getElementById('dark-btn').textContent='☀️';

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

// ── Login ─────────────────────────────────────────────────────────────────────
async function doLogin(){
  const pw=document.getElementById('pw-input').value.trim();
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
    if(!r.ok){showLoginScreen();return;}
    const d=await r.json(); ROLE=d.role;
    localStorage.setItem('dnx3_role',ROLE);
  }catch(e){showLoginScreen();return;}

  // Show UI
  document.getElementById('main-header').style.display='flex';
  document.getElementById('tv').style.display='flex';

  // Role badge
  const rb=document.getElementById('role-badge');
  rb.textContent=ROLE==='manager'?'👔 Manager':'👷 Associate';
  rb.className='role-badge '+(ROLE==='manager'?'rb-manager':'rb-associate');

  // Manager-only tabs
  if(ROLE==='manager'){
    document.getElementById('tb-r').style.display='';
    document.getElementById('tb-i').style.display='';
  }

  // Wave open state: first open, rest closed
  WAVES.forEach((_,i)=>{ waveOpen[i]=i===0; missingOpen[i]=false; });

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

async function apiUniform(wi,route,value){
  try{
    await fetch('/api/uniform',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({waveIdx:wi,route,uniform:value})});
  }catch(e){showToast('⚠️ Sync error — check connection');}
}

async function apiResetWave(wi){
  try{
    await fetch('/api/reset_wave',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({waveIdx:wi})});
  }catch(e){showToast('⚠️ Sync error');}
}

async function apiSaveNote(route,text){
  try{
    await fetch('/api/notes',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TOKEN},
      body:JSON.stringify({route,text})});
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
    if(d.checked) state[wi][d.route]={time:d.time,uniform:d.uniform||false};
    else delete state[wi][d.route];
    render();
  });

  socket.on('uniform_update',d=>{
    const wi=String(d.waveIdx);
    if(!state[wi])state[wi]={};
    if(!state[wi][d.route])state[wi][d.route]={time:'',uniform:false};
    state[wi][d.route].uniform=d.uniform;
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
    if(d.text) notes[d.route]=d.text;
    else delete notes[d.route];
    // If note panel is open for this route, update textarea
    if(notePanel.open && notePanel.route===d.route){
      const ta=document.getElementById('note-ta');
      if(ta) ta.value=d.text||'';
    }
  });

  socket.on('scanlog_update',d=>{
    scanlog=d.scanlog||[];
    render();
  });
}

// ── Search ────────────────────────────────────────────────────────────────────
function onSearch(){ searchQ=expandSearch(document.getElementById('si').value); renderMain(); }
document.addEventListener('keydown',e=>{
  if(e.key==='/'&&document.activeElement!==document.getElementById('si')){e.preventDefault();document.getElementById('si').focus();}
  if(e.key==='Escape'){document.getElementById('si').value='';searchQ='';renderMain();closeNotePanel();}
});

// ── Tab switch ────────────────────────────────────────────────────────────────
function switchTab(t){
  document.getElementById('tv').style.display=t==='t'?'flex':'none';
  const rv=document.getElementById('rv'); rv.style.display=t==='r'?'block':'none';
  const iv=document.getElementById('iv'); iv.style.display=t==='i'?'block':'none';
  ['t','r','i'].forEach(id=>document.getElementById('tb-'+id)?.classList.toggle('active',id===t));
  if(t==='r')renderReport();
  if(t==='i')renderImport();
}

// ── Note Panel ────────────────────────────────────────────────────────────────
function openNotePanel(route){
  notePanel={open:true,route};
  const panel=document.getElementById('note-panel');
  panel.innerHTML=`<div class="np-header"><span class="np-title">📝 ${route}</span><button class="np-close" onclick="closeNotePanel()">✕</button></div>
    <textarea id="note-ta" class="np-textarea" placeholder="Add notes for ${route}...">${notes[route]||''}</textarea>
    <div class="np-actions"><button class="rabtn pri" onclick="saveNote()">💾 Save</button><button class="rabtn" onclick="closeNotePanel()">Close</button></div>`;
  panel.classList.add('open');
}
function closeNotePanel(){
  notePanel={open:false,route:''};
  const panel=document.getElementById('note-panel');
  if(panel){panel.classList.remove('open');panel.innerHTML='';}
}
async function saveNote(){
  const ta=document.getElementById('note-ta');
  if(!ta)return;
  const text=ta.value.trim();
  notes[notePanel.route]=text;
  await apiSaveNote(notePanel.route,text);
  showToast(`📝 Note saved for ${notePanel.route}`);
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
.rcard.checked .ck{display:block;}
.ck{display:none;position:absolute;top:4px;right:7px;font-size:.8rem;color:#166534;font-weight:700;}
.rcard.dimmed{opacity:.15;pointer-events:none;}
.cr{font-weight:700;font-size:.82rem;}.cs{font-size:.65rem;color:var(--subtext);margin-top:1px;}
.cd{font-size:.63rem;color:var(--subtext);margin-top:1px;}.ct{font-size:.63rem;color:#3b82f6;margin-top:2px;font-weight:600;}
.dark .ct{color:#60a5fa;}
.urow{margin-top:6px;border-top:1px solid rgba(0,0,0,.08);padding-top:5px;display:flex;align-items:center;gap:4px;}
.dark .urow{border-top-color:rgba(255,255,255,.08);}
.ubtn{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:5px;border:1px solid rgba(0,0,0,.15);background:rgba(255,255,255,.5);cursor:pointer;font-size:.63rem;font-weight:600;color:#374151;transition:background .15s;white-space:nowrap;}
.dark .ubtn{background:rgba(255,255,255,.08);color:#cbd5e1;border-color:rgba(255,255,255,.1);}
.ubtn:hover{background:rgba(255,255,255,.8);}
.ubtn.on{background:#dcfce7;border-color:#86efac;color:#166534;}
.dark .ubtn.on{background:#052e16;border-color:#166534;color:#86efac;}
.pen-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;border:1px solid rgba(0,0,0,.15);background:rgba(255,255,255,.5);cursor:pointer;font-size:.7rem;transition:background .15s;margin-left:auto;}
.dark .pen-btn{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.1);}
.pen-btn:hover{background:rgba(255,255,255,.8);}
.pen-btn.has-note{background:#fef3c7;border-color:#f59e0b;}
.dark .pen-btn.has-note{background:#451a03;border-color:#f59e0b;}
.sw-lbl{font-size:.7rem;font-weight:700;color:var(--subtext);text-transform:uppercase;letter-spacing:.6px;padding:6px 0 4px;border-top:1px solid var(--border);margin-top:4px;}
.sw-lbl:first-child{border-top:none;margin-top:0;}
.srwrap{padding:14px;}.srwrap .rgrid{margin-bottom:6px;}
.no-results{text-align:center;color:var(--subtext);padding:30px;font-size:.85rem;}
/* Note Panel */
.note-panel{position:fixed;top:0;right:-360px;width:340px;height:100vh;background:var(--surface);border-left:1px solid var(--border);box-shadow:-4px 0 20px rgba(0,0,0,.15);z-index:1000;display:flex;flex-direction:column;transition:right .25s ease;}
.note-panel.open{right:0;}
.np-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border);}
.np-title{font-weight:700;font-size:.9rem;}
.np-close{border:none;background:none;font-size:1.1rem;cursor:pointer;color:var(--text);padding:4px 8px;border-radius:4px;}
.np-close:hover{background:var(--surface2);}
.np-textarea{flex:1;margin:14px 16px;padding:12px;border:1px solid var(--border);border-radius:8px;resize:none;font-size:.82rem;font-family:inherit;background:var(--bg);color:var(--text);outline:none;}
.np-textarea:focus{border-color:#3b82f6;}
.np-actions{display:flex;gap:9px;padding:12px 16px;border-top:1px solid var(--border);}
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
.sgrid{display:grid;grid-template-columns:repeat(5,1fr);}
.sstat{padding:13px 10px;text-align:center;border-right:1px solid var(--border);}
.sstat:last-child{border-right:none;}
.sval{font-size:1.35rem;font-weight:700;}.slbl{font-size:.65rem;color:var(--subtext);margin-top:2px;}
.sv-blue{color:#3b82f6;}.sv-green{color:var(--green);}.sv-red{color:var(--red);}.sv-amber{color:#d97706;}
.rtbl{width:100%;border-collapse:collapse;font-size:.76rem;}
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
.import-last{font-size:.72rem;color:var(--subtext);margin-top:14px;}
@media print{header,aside{display:none!important;}#tv{display:none!important;}#rv{display:block!important;padding:0;}body{background:#fff;color:#000;height:auto;overflow:auto;}}
`;
document.head.appendChild(appStyles);

// ── Card HTML ─────────────────────────────────────────────────────────────────
function cardHtml(wi,r,color){
  const chk=isIn(wi,r.route),uni=hasUniform(wi,r.route),t=inTime(wi,r.route);
  const late=isLate(wi)&&!chk, eff=late?'late':color;
  const q=searchQ;
  const match=!q||r.route.toLowerCase()===q||r.dsp.toLowerCase()===q||r.staging.toLowerCase()===q;
  const hasNote=!!notes[r.route];
  return`<div class="rcard ${eff}${chk?' checked':''}${q&&!match?' dimmed':''}" data-wi="${wi}" data-r="${r.route}">
    <div class="ck">✓</div>
    <div class="cr">${r.route}</div><div class="cs">${r.staging}</div><div class="cd">${r.dsp}</div>
    ${t?`<div class="ct">${t}</div>`:''}
    <div class="urow"><button class="ubtn${uni?' on':''}" data-wi="${wi}" data-r="${r.route}" data-action="u" onclick="event.stopPropagation()"><span>👕</span>${uni?' Uniform ✓':' Uniform'}</button><button class="pen-btn${hasNote?' has-note':''}" data-r="${r.route}" data-action="note" onclick="event.stopPropagation()">✏️</button></div>
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
        state[String(wi)][ro]={time:t,uniform:false};
        showToast(`✅ ${ro} checked in at ${t}`);
        await apiCheckin(wi,ro,true,t);
        if(inCount(wi)===WAVES[wi].total){setTimeout(()=>{playDing();showToast(`🎉 Wave ${WAVES[wi].time} — all in!`);},350);}
      }
      render();
    });
  });
  c.querySelectorAll('[data-action="u"]').forEach(btn=>{
    btn.addEventListener('click',async e=>{
      e.stopPropagation();
      const wi=+btn.dataset.wi, ro=btn.dataset.r;
      if(!state[String(wi)])state[String(wi)]={};
      if(!state[String(wi)][ro]){
        const t=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
        state[String(wi)][ro]={time:t,uniform:false};
        await apiCheckin(wi,ro,true,t);
      }
      const newVal=!state[String(wi)][ro].uniform;
      state[String(wi)][ro].uniform=newVal;
      showToast(newVal?`👕 Uniform ✓ — ${ro}`:`👕 Uniform removed — ${ro}`);
      await apiUniform(wi,ro,newVal);
      render();
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
function renderMain(){
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
}
function toggleWave(i){ waveOpen[i]=!waveOpen[i]; renderMain(); }

// ── Sound ─────────────────────────────────────────────────────────────────────
function playDing(){try{const c=new(window.AudioContext||window.webkitAudioContext)(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.setValueAtTime(880,c.currentTime);o.frequency.exponentialRampToValueAtTime(1320,c.currentTime+.15);g.gain.setValueAtTime(.28,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.7);o.start();o.stop(c.currentTime+.7);}catch(e){}}

// ── Report ────────────────────────────────────────────────────────────────────
function pb(p){const cls=p===100?'pb-g':p>=80?'pb-y':'pb-r';const tag=p===100?`<span class="t100">100%</span>`:p>=80?`<span class="twarn">${p}%</span>`:`<span class="tbad">${p}%</span>`;return`${tag}<span class="pbar-w"><span class="pbar ${cls}" style="width:${p}%"></span></span>`;}
function mriRow(r){return`<div class="mri"><span class="mri-w">${r.wave}</span><span class="mri-r">${r.route}</span><span class="mri-s">${r.staging}</span><span class="mri-d">${r.dsp}</span></div>`;}

function renderReport(){
  const rv=document.getElementById('rv');
  const now=new Date();
  let tot=0,tin=0,tuni=0;
  WAVES.forEach((w,i)=>{tot+=w.total;tin+=inCount(i);tuni+=uniCount(i);});
  const tmiss=tot-tin,pctIn=Math.round(tin/tot*100);
  const dspMap={};
  WAVES.forEach((w,i)=>allR(w).forEach(r=>{
    if(!dspMap[r.dsp])dspMap[r.dsp]={t:0,i:0,u:0};
    dspMap[r.dsp].t++;
    if(isIn(i,r.route)){dspMap[r.dsp].i++;if(hasUniform(i,r.route))dspMap[r.dsp].u++;}
  }));
  const missAll=[]; WAVES.forEach((w,i)=>sortByDsp(allR(w).filter(r=>!isIn(i,r.route))).forEach(r=>missAll.push({wave:w.time,...r})));
  const missUni=[]; WAVES.forEach((w,i)=>sortByDsp(allR(w).filter(r=>isIn(i,r.route)&&!hasUniform(i,r.route))).forEach(r=>missUni.push({wave:w.time,...r})));

  // Late arrivals calculation
  const lateArrivals=[];
  WAVES.forEach((w,i)=>{
    const waveMinutes=wMin(w.time);
    if(waveMinutes===9999)return;
    const grace=waveMinutes+5;
    allR(w).forEach(r=>{
      if(!isIn(i,r.route))return;
      const checkinStr=inTime(i,r.route);
      if(!checkinStr)return;
      // checkinStr is "HH:MM" in 24h format
      const parts=checkinStr.match(/^(\d{1,2}):(\d{2})$/);
      if(!parts)return;
      const checkinMin=parseInt(parts[1])*60+parseInt(parts[2]);
      if(checkinMin>grace){
        const delay=checkinMin-waveMinutes;
        lateArrivals.push({waveTime:w.time,route:r.route,dsp:r.dsp,staging:r.staging,checkinTime:checkinStr,delay});
      }
    });
  });
  lateArrivals.sort((a,b)=>b.delay-a.delay);

  rv.innerHTML=`<div class="rpt-title">📋 End of Day Yard Report</div>
  <div class="rpt-sub">DNX3 · CYCLE 1 · ${now.toLocaleDateString('en-GB',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}</div>
  <div class="rsec"><div class="rsec-title">Overall Summary</div><div class="sgrid">
    <div class="sstat"><div class="sval sv-blue">${tot}</div><div class="slbl">Total Routes</div></div>
    <div class="sstat"><div class="sval sv-green">${tin}</div><div class="slbl">Checked In</div></div>
    <div class="sstat"><div class="sval sv-red">${tmiss}</div><div class="slbl">Never Arrived</div></div>
    <div class="sstat"><div class="sval sv-amber">${tuni}</div><div class="slbl">Uniform ✓</div></div>
    <div class="sstat"><div class="sval ${pctIn===100?'sv-green':pctIn>=80?'sv-amber':'sv-red'}">${pctIn}%</div><div class="slbl">Completion</div></div>
  </div></div>
  <div class="rsec"><div class="rsec-title">Wave Breakdown</div><table class="rtbl">
    <thead><tr><th>Wave</th><th>Total</th><th>Checked In</th><th>Uniform ✓</th><th>Missing</th><th>Completion</th></tr></thead>
    <tbody>${WAVES.map((w,i)=>{const d=inCount(i),u=uniCount(i),m=w.total-d,p=Math.round(d/w.total*100);return`<tr><td><strong>${w.time}</strong></td><td>${w.total}</td><td>${d}</td><td>${u>0?`<span style="color:var(--green)">${u} 👕</span>`:'<span style="color:var(--subtext)">—</span>'}</td><td>${m===0?'<span style="color:var(--green)">0 ✅</span>':`<span style="color:var(--red)">${m}</span>`}</td><td>${pb(p)}</td></tr>`;}).join('')}</tbody>
  </table></div>
  <div class="rsec"><div class="rsec-title">DSP Performance</div><table class="rtbl">
    <thead><tr><th>DSP</th><th>Total</th><th>Checked In</th><th>Uniform ✓</th><th>Uniform %</th><th>Missing</th><th>Completion</th></tr></thead>
    <tbody>${Object.entries(dspMap).sort((a,b)=>a[0].localeCompare(b[0])).map(([d,v])=>{const p=Math.round(v.i/v.t*100),m=v.t-v.i,up=v.i>0?Math.round(v.u/v.i*100):0;return`<tr><td><strong>${d}</strong></td><td>${v.t}</td><td>${v.i}</td><td>${v.u>0?`<span style="color:var(--green)">${v.u} 👕</span>`:'<span style="color:var(--subtext)">—</span>'}</td><td>${v.i>0?pb(up):'<span style="color:var(--subtext)">—</span>'}</td><td>${m===0?'<span style="color:var(--green)">0 ✅</span>':`<span style="color:var(--red)">${m}</span>`}</td><td>${pb(p)}</td></tr>`;}).join('')}</tbody>
  </table></div>
  <div class="rsec"><div class="rsec-title">⏰ Late Arrivals (${lateArrivals.length})</div>${lateArrivals.length===0?'<div class="empty-sec">✅ No late arrivals!</div>':`<table class="rtbl">
    <thead><tr><th>Wave Time</th><th>Route</th><th>DSP</th><th>Staging</th><th>Check-in Time</th><th>Delay (min)</th></tr></thead>
    <tbody>${lateArrivals.map(l=>`<tr><td>${l.waveTime}</td><td><strong>${l.route}</strong></td><td>${l.dsp}</td><td>${l.staging}</td><td>${l.checkinTime}</td><td><span style="color:#dc2626;font-weight:700">+${l.delay}</span></td></tr>`).join('')}</tbody>
  </table>`}</div>
  <div class="rsec"><div class="rsec-title">❌ Missing Routes — Never Arrived (${missAll.length})</div>${missAll.length===0?'<div class="empty-sec">✅ All routes checked in!</div>':`<div class="mrl">${missAll.map(mriRow).join('')}</div>`}</div>
  <div class="rsec"><div class="rsec-title">👕 Missing Uniform — Not Confirmed (${missUni.length})</div>${missUni.length===0?'<div class="empty-sec">✅ All checked-in drivers had uniform confirmed!</div>':`<div class="mrl">${missUni.map(mriRow).join('')}</div>`}</div>
  <div class="rsec"><div class="ractions"><button class="rabtn pri" onclick="window.print()">🖨️ Print</button><button class="rabtn" onclick="copyRpt()">📋 Copy</button></div></div>`;
}

function copyRpt(){
  let t=`DNX3 End of Day Report\n${'─'.repeat(40)}\n`;
  let tot=0,tin=0,tuni=0; WAVES.forEach((w,i)=>{tot+=w.total;tin+=inCount(i);tuni+=uniCount(i);});
  t+=`Total: ${tot} | In: ${tin} | Missing: ${tot-tin} | Uniform: ${tuni} | ${Math.round(tin/tot*100)}%\n\nWAVES\n`;
  WAVES.forEach((w,i)=>{const d=inCount(i);t+=`  ${w.time}: ${d}/${w.total} (${Math.round(d/w.total*100)}%) Uniform:${uniCount(i)}\n`;});
  t+=`\nMISSING ROUTES\n`; WAVES.forEach((w,i)=>sortByDsp(allR(w).filter(r=>!isIn(i,r.route))).forEach(r=>{t+=`  ${w.time}|${r.dsp}|${r.route}|${r.staging}\n`;}));
  t+=`\nMISSING UNIFORM\n`; WAVES.forEach((w,i)=>sortByDsp(allR(w).filter(r=>isIn(i,r.route)&&!hasUniform(i,r.route))).forEach(r=>{t+=`  ${w.time}|${r.dsp}|${r.route}|${r.staging}\n`;}));
  t+=`\nLATE ARRIVALS\n`; WAVES.forEach((w,i)=>{const wm=wMin(w.time);if(wm===9999)return;const grace=wm+5;allR(w).forEach(r=>{if(!isIn(i,r.route))return;const ct=inTime(i,r.route);const p=ct.match(/^(\d{1,2}):(\d{2})$/);if(!p)return;const cm=parseInt(p[1])*60+parseInt(p[2]);if(cm>grace)t+=`  ${w.time}|${r.dsp}|${r.route}|${ct}|+${cm-wm}min\n`;});});
  navigator.clipboard.writeText(t).then(()=>showToast('📋 Copied!'));
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
        ${scanlog.length?`<ul class="scanlog-list">${scanlog.map(r=>`<li class="scanlog-item"><span>${r}</span><button class="scanlog-rm" onclick="removeScanlogEntry('${r}')">×</button></li>`).join('')}</ul>`:'<div class="scanlog-empty">No entries yet. Scanned tours will be moved to A/C staging group.</div>'}
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
  showToast(`\ud83d\udccb ${added.length} tour${added.length>1?'s':''} added to ScanLog`);
  render();
  renderImport();
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
