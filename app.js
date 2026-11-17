'use strict';
/* 물리치료사 국가시험 모의고사 — Firebase 버전 (학번+비밀번호 로그인, 서버 저장) */
const ADMIN = window.ADMIN_SID || '';
const DOMAIN = window.EMAIL_DOMAIN || 'ptquiz.example.com';
const PERIODS = {1:{subs:['기초','진단평가'],counts:{'기초':60,'진단평가':45},min:85},2:{subs:['중재','법규'],counts:{'중재':65,'법규':20},min:70}};
const $ = id=>document.getElementById(id);
let DB=null, sid=null, U=null, E=null, Q=[], byId={}, QUOTA=[], deadline=0, lastSave=0, lastPush=0, pushTimer=null, syncOK=false, choice=null;
const poolCache={};
const deviceId=(()=>{try{let d=localStorage.getItem('ptq2:dev'); if(!d){d=Math.random().toString(36).slice(2,10); localStorage.setItem('ptq2:dev',d);} return d;}catch(e){return 'nodev';}})();

/* ---------- 화면 크기 4:3 ---------- */
function fit(){
  const w=innerWidth,h=innerHeight; let sw=w, sh=w*3/4; if(sh>h){sh=h;sw=h*4/3;}
  const st=$('stage'); st.style.width=sw+'px'; st.style.height=sh+'px'; st.style.setProperty('--u',(sw/100)+'px');
}
addEventListener('resize',fit); fit();

/* ---------- 기기 저장 / 유틸 ---------- */
function lsGet(k){try{const r=localStorage.getItem(k); return r?JSON.parse(r):null;}catch(e){return null;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v)); return true;}catch(e){return false;}}
const clean=o=>JSON.parse(JSON.stringify(o));
const nowIso=()=>new Date().toISOString();
function T(p,ms){ return Promise.race([Promise.resolve(p),new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms||8000))]); }
function fresh(){return {nextNo:1,records:[],exam:null,examAt:''};}
function saveLocal(){ if(sid&&U){ if(E) U.exam=E; lsSet('ptq2:u:'+sid,U); } }
function show(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('on')); $(id).classList.add('on'); }
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function stemHtml(s){ const p=s.split(' • '); if(p.length===1) return esc(s); return esc(p[0])+'<div class="box"><ul>'+p.slice(1).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></div>'; }
function pgLabel(q){ return q.ps===q.pe ? 'p.'+q.ps : 'p.'+q.ps+'–'+q.pe; }
function pct(c,t){return t? Math.round(c*1000/t)/10 : 0;}
function label(c,t){ if(!t) return null; if(c*100<40*t) return ['과락','c-fail']; if(c*100<=60*t) return ['주의','c-warn']; if(c*100<=80*t) return ['안정권','c-safe']; return ['짱이야','c-top']; }
function chip(c,t){const l=label(c,t); return l?'<span class="chip '+l[1]+'">'+l[0]+'</span>':'-';}
function fmtTime(ms){ ms=Math.max(0,ms); const s=Math.ceil(ms/1000); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function fmtDate(iso){const d=new Date(iso);return d.getFullYear()+'.'+(d.getMonth()+1)+'.'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function modal(text,buttons){
  $('modal-t').textContent=text; const b=$('modal-b'); b.innerHTML='';
  buttons.forEach(([t,cls,fn])=>{const x=document.createElement('button'); x.textContent=t; if(cls) x.className=cls; x.onclick=()=>{$('modal').classList.remove('on'); fn&&fn();}; b.appendChild(x);});
  $('modal').classList.add('on');
}
function ask(text,buttons){ return new Promise(res=>modal(text,buttons.map(([t,c,v])=>[t,c,()=>res(v)]))); }
function loading(msg){ $('loading-t').textContent=msg; show('s-loading'); }

/* ---------- 출제 ---------- */
function randRound(means,total){
  const s=means.reduce((a,b)=>a+b,0); if(s<=0||total<=0) return means.map(()=>0);
  const sc=means.map(m=>m*total/s), fl=sc.map(Math.floor); let rem=total-fl.reduce((a,b)=>a+b,0);
  const fr=sc.map((v,i)=>v-fl[i]+1e-9), open=fr.map((_,i)=>i);
  while(rem>0&&open.length){
    const W=open.reduce((a,i)=>a+fr[i],0); let r=Math.random()*W, k=0;
    for(k=0;k<open.length;k++){ r-=fr[open[k]]; if(r<=0) break; }
    k=Math.min(k,open.length-1); fl[open[k]]++; open.splice(k,1); rem--;
  }
  return fl;
}
function shuffle(a){a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function poolOf(subj,field,area){const k=subj+'|'+field+'|'+area; if(!poolCache[k]) poolCache[k]=Q.filter(q=>q.subj===subj&&q.field===field&&q.area===area); return poolCache[k];}
function pickSubject(subj,total){
  const rows=QUOTA.filter(r=>r.subj===subj);
  const fields=[...new Set(rows.map(r=>r.field))];
  const fm=fields.map(f=>rows.filter(r=>r.field===f).reduce((a,r)=>a+r.mean,0));
  const fc=randRound(fm,total), out=[];
  fields.forEach((f,i)=>{
    const ar=rows.filter(r=>r.field===f);
    let ac=randRound(ar.map(r=>r.mean),fc[i]);
    let over=0; ac=ac.map((c,j)=>{const p=poolOf(subj,f,ar[j].area).length; if(c>p){over+=c-p;return p;}return c;});
    while(over>0){ const j=ac.findIndex((c,jj)=>c<poolOf(subj,f,ar[jj].area).length); if(j<0) break; ac[j]++; over--; }
    ar.forEach((r,j)=>{ out.push(...shuffle(poolOf(subj,f,r.area)).slice(0,ac[j]).map(q=>q.id)); });
  });
  return out;
}
function buildExam(period){
  const P=PERIODS[period]; let ids=[];
  P.subs.forEach(s=>{ ids=ids.concat(shuffle(pickSubject(s,P.counts[s]))); });
  return {period:period,qids:ids,ans:{},flag:{},idx:0,remaining:P.min*60000,total:P.min*60000,alerts:{a5:false,a1:false},startedAt:nowIso(),paused:false};
}

/* ---------- 서버 동기화 ---------- */
function touch(){ if(!E) return; U.examAt=nowIso(); U.exam=E; saveLocal(); schedulePush(); }
function schedulePush(now){ clearTimeout(pushTimer); pushTimer=setTimeout(pushExam, now?0:1500); }
function pushExam(){
  if(!DB||!sid) return; lastPush=Date.now();
  const payload={exam:E?clean(E):(U.exam?clean(U.exam):null),examAt:U.examAt||'',deviceId:deviceId};
  T(DB.saveUser(sid,payload)).then(()=>{syncOK=true;}).catch(()=>{syncOK=false;});
}
async function mergeRemote(remote,recs){
  remote=remote||{}; const byNo={}; recs.forEach(r=>byNo[r.no]=r);
  let next=Math.max(remote.nextNo||1,U.nextNo||1,...recs.map(r=>r.no+1));
  const up=[];
  U.records.filter(r=>r.pending).forEach(r=>{
    const ex=byNo[r.no]; delete r.pending;
    if(ex&&ex.at===r.at) return;
    if(ex) r.no=next++;
    byNo[r.no]=r; up.push(r);
  });
  U.records=Object.values(byNo).sort((a,b)=>a.no-b.no);
  U.nextNo=Math.max(next,...U.records.map(r=>r.no+1));
  for(const r of up) await T(DB.putRecord(sid,clean(r)));
  await T(DB.saveUser(sid,{nextNo:U.nextNo}));
  const rx=remote.exam||null, rat=remote.examAt||'', lx=U.exam, lat=U.examAt||'';
  if(rx&&lx&&remote.deviceId!==deviceId&&rat!==lat){ choice={rx:rx,rat:rat,lx:lx,lat:lat}; }
  else if(rat>lat){ U.exam=rx; U.examAt=rat; }
  else if(lat>rat){ lastPush=0; setTimeout(pushExam,0); }
}
async function retryPending(){
  if(!sid||!U) return; const pend=U.records.filter(r=>r.pending); if(!pend.length) return;
  for(const r of pend){ try{ await T(DB.putRecord(sid,clean(Object.assign({},r,{pending:undefined})))); delete r.pending; }catch(e){ return; } }
  try{ await T(DB.saveUser(sid,{nextNo:U.nextNo})); }catch(e){}
  saveLocal();
}
addEventListener('online',()=>{ if(sid) retryPending(); });

/* ---------- 문제 데이터 ---------- */
function setQ(data){ Q=data.items; QUOTA=data.quota; byId={}; Q.forEach(q=>byId[q.id]=q); Object.keys(poolCache).forEach(k=>delete poolCache[k]); }
async function ensureQuestions(){
  let meta=null, offline=false;
  try{ meta=await T(DB.getMeta()); }catch(e){ offline=true; }
  const cache=lsGet('ptq2:q');
  if(cache&&(offline||(meta&&cache.version===meta.version))){ setQ(cache); return true; }
  if(meta){ try{ const data=await T(DB.getQuestions(),20000); if(data&&data.items&&data.items.length){ lsSet('ptq2:q',data); setQ(data); return true; } }catch(e){} }
  if(cache){ setQ(cache); return true; }
  return false;
}

/* ---------- 로그인 ---------- */
async function enter(s){
  sid=s; E=null; choice=null; loading('문제와 기록을 불러오는 중…');
  const ok=await ensureQuestions();
  if(!ok&&sid!==ADMIN){ await DB.signOut().catch(()=>{}); sid=null; U=null; show('s-login'); $('login-err').textContent='문제 데이터를 불러오지 못했습니다. 인터넷 연결을 확인하거나 관리자에게 문의해 주세요.'; return; }
  U=Object.assign(fresh(),lsGet('ptq2:u:'+sid)||{});
  try{ const remote=await T(DB.getUser(sid)); const recs=await T(DB.getRecords(sid)); await mergeRemote(remote,recs); syncOK=true; }
  catch(e){ syncOK=false; }
  if(choice){
    const c=choice; choice=null;
    const useRemote=await ask('진행 중인 시험이 두 기기에 모두 있습니다.\n어느 쪽을 이어서 풀까요?\n\n이 기기: '+c.lx.period+'교시 · '+fmtDate(c.lat)+'\n다른 기기: '+c.rx.period+'교시 · '+fmtDate(c.rat),[['이 기기 시험','sec',false],['다른 기기 시험','ok',true]]);
    if(useRemote){ U.exam=c.rx; U.examAt=c.rat; } else { U.examAt=nowIso(); lastPush=0; setTimeout(pushExam,0); }
  }
  saveLocal(); showHome();
}
function authError(e){
  const c=(e&&e.code)||'';
  if(c.includes('invalid-credential')||c.includes('wrong-password')||c.includes('user-not-found')||c.includes('invalid-email')) return '학번 또는 비밀번호가 올바르지 않습니다.';
  if(c.includes('too-many-requests')) return '시도가 너무 많습니다. 잠시 후 다시 해 주세요.';
  if(c.includes('network')||(e&&e.message==='timeout')) return '인터넷 연결을 확인해 주세요.';
  if(c.includes('user-disabled')) return '사용할 수 없는 계정입니다. 관리자에게 문의해 주세요.';
  return '로그인에 실패했습니다. ('+(c||'알 수 없는 오류')+')';
}
async function login(){
  const v=$('sid').value.trim(), pw=$('pw').value;
  if(!/^[0-9]{7}$/.test(v)){ $('login-err').textContent='학번은 숫자 7자리로 입력해 주세요. 예) 2426013'; return; }
  if(!pw){ $('login-err').textContent='비밀번호를 입력해 주세요.'; return; }
  $('login-go').disabled=true; $('login-err').textContent='로그인 중…';
  try{ await T(DB.signIn(v,pw),15000); }
  catch(e){ $('login-err').textContent=authError(e); $('login-go').disabled=false; return; }
  $('login-go').disabled=false; $('pw').value=''; $('login-err').textContent='';
  await enter(v);
}
$('login-go').onclick=login;
$('sid').addEventListener('input',e=>{ e.target.value=e.target.value.replace(/[^0-9]/g,'').slice(0,7); $('login-err').textContent=''; });
$('sid').addEventListener('keydown',e=>{ if(e.key==='Enter') $('pw').focus(); });
$('pw').addEventListener('keydown',e=>{ if(e.key==='Enter') login(); });
async function logout(){ try{ await DB.signOut(); }catch(e){} sid=null; U=null; E=null; $('sid').value=''; $('pw').value=''; $('login-err').textContent=''; show('s-login'); }

/* ---------- 시험 화면 ---------- */
function curQ(){return byId[E.qids[E.idx]];}
function renderQ(){
  const q=curQ(), n=E.idx+1;
  $('qtitle').innerHTML=E.period+'교시 · '+q.subj+' · <b>'+n+'번</b> / '+E.qids.length+(q.subj==='법규'?'<span class="tag">기출 당시 기준</span>':'');
  const sel=E.ans[q.id];
  let h='<div class="stem">'+stemHtml(q.stem)+'</div>';
  q.opts.forEach((o,i)=>{ h+='<div class="opt'+(sel===i?' sel':'')+'" data-i="'+i+'"><span class="n">'+'①②③④⑤'[i]+'</span><span>'+esc(o)+'</span></div>'; });
  const qb=$('qbody'); qb.innerHTML=h; qb.scrollTop=0; const base=parseFloat($('stage').style.getPropertyValue('--u'));
  let k=1; qb.style.setProperty('--u',base+'px'); while(qb.scrollHeight>qb.clientHeight+1&&k>0.78){k-=0.04; qb.style.setProperty('--u',(base*k)+'px');}
  $('recheck').classList.toggle('on',!!E.flag[q.id]);
  $('prev').disabled=E.idx===0;
  const last=E.idx===E.qids.length-1; $('next').textContent=last?'제출':'다음'; $('next').className=last?'ok':'';
  const answered=Object.keys(E.ans).length; $('cnt').textContent='푼 문제 '+answered+' / '+E.qids.length;
}
function updTimer(){ const t=$('timer'); t.textContent=fmtTime(E.remaining); t.className=E.remaining<=60000?'w1':(E.remaining<=300000?'w5':''); }
function startExam(E0){
  E=E0; touch(); schedulePush(true); show('s-exam'); $('ov-sel').classList.remove('on'); renderQ(); updTimer();
  if(E.paused){ $('ov-pause').classList.add('on'); }
  else { $('ov-pause').classList.remove('on'); deadline=Date.now()+E.remaining; }
}
function pauseExam(){
  if(!E||E.paused) return;
  E.remaining=Math.max(0,deadline-Date.now()); E.paused=true; updTimer(); touch(); schedulePush(true);
  $('ov-sel').classList.remove('on'); $('ov-pause').classList.add('on');
}
function resumeExam(){
  if(!E||!E.paused) return; E.paused=false; deadline=Date.now()+E.remaining; touch();
  $('ov-pause').classList.remove('on');
}
function toast(msg){const t=$('toast'); t.textContent=msg; t.classList.add('on'); clearTimeout(toast.h); toast.h=setTimeout(()=>t.classList.remove('on'),5000);
  try{const A=window.AudioContext||window.webkitAudioContext; const c=new A(); [0,.3].forEach(d=>{const o=c.createOscillator(),g=c.createGain(); o.frequency.value=880; g.gain.value=.15; o.connect(g); g.connect(c.destination); o.start(c.currentTime+d); o.stop(c.currentTime+d+.2);});}catch(e){}}
function tick(){
  if(!E||E.paused||!$('s-exam').classList.contains('on')) return;
  E.remaining=Math.max(0,deadline-Date.now()); updTimer();
  if(E.remaining<=300000&&!E.alerts.a5){E.alerts.a5=true; if(E.remaining>60000) toast('5분 남았습니다'); }
  if(E.remaining<=60000&&!E.alerts.a1){E.alerts.a1=true; E.alerts.a5=true; toast('1분 남았습니다');}
  if(Date.now()-lastSave>1000){lastSave=Date.now(); saveLocal();}
  if(Date.now()-lastPush>20000){ touch(); lastPush=Date.now(); pushExam(); }
  if(E.remaining<=0){ submitExam(true); }
}
setInterval(tick,250);
document.addEventListener('visibilitychange',()=>{ if(document.hidden&&E&&!E.paused&&$('s-exam').classList.contains('on')) pauseExam(); });
addEventListener('pagehide',()=>{ if(E&&!E.paused&&$('s-exam').classList.contains('on')){ E.remaining=Math.max(0,deadline-Date.now()); E.paused=true; touch(); pushExam(); } });

$('qbody').addEventListener('click',ev=>{
  const o=ev.target.closest('.opt'); if(!o||E.paused) return; const q=curQ(), i=+o.dataset.i;
  if(E.ans[q.id]===i) delete E.ans[q.id]; else E.ans[q.id]=i;
  touch(); renderQ();
});
$('recheck').onclick=()=>{ if(E.paused) return; const q=curQ(); if(E.flag[q.id]) delete E.flag[q.id]; else E.flag[q.id]=1; touch(); $('recheck').classList.toggle('on',!!E.flag[q.id]); };
$('prev').onclick=()=>{ if(E.idx>0){E.idx--; touch(); renderQ();} };
$('next').onclick=()=>{ if(E.idx<E.qids.length-1){E.idx++; touch(); renderQ();} else confirmSubmit(); };
$('pause-btn').onclick=pauseExam;
$('resume').onclick=resumeExam;
$('sel-btn').onclick=()=>{ if(E.paused) return; renderSel(); $('ov-sel').classList.add('on'); };
$('sel-close').onclick=()=>$('ov-sel').classList.remove('on');
$('sel-submit').onclick=confirmSubmit;
function renderSel(){
  const P=PERIODS[E.period]; let h='';
  P.subs.forEach(s=>{
    h+='<div class="sechd">'+s+(s==='법규'?' <span class="note">(기출 당시 기준)</span>':'')+'</div><div class="grid">';
    E.qids.forEach((id,i)=>{ if(byId[id].subj!==s) return;
      h+='<button class="nb '+(E.ans[id]!==undefined?'a':'u')+(E.flag[id]?' f':'')+(i===E.idx?' cur':'')+'" data-i="'+i+'">'+(i+1)+'</button>'; });
    h+='</div>';
  });
  $('sel-grid').innerHTML=h;
}
$('sel-grid').addEventListener('click',ev=>{ const b=ev.target.closest('.nb'); if(!b) return; E.idx=+b.dataset.i; touch(); $('ov-sel').classList.remove('on'); renderQ(); });

function confirmSubmit(){
  if(E.paused) return;
  const un=E.qids.filter(id=>E.ans[id]===undefined).length, fl=E.qids.filter(id=>E.flag[id]).length;
  modal('제출할까요?\n안 푼 문제 '+un+'개'+(fl?' · 다시 확인 표시 '+fl+'개':''),[['돌아가기','sec'],['제출','ok',()=>submitExam(false)]]);
}
async function submitExam(auto){
  if(!E) return; const ex=E; E=null; $('ov-sel').classList.remove('on'); $('ov-pause').classList.remove('on'); $('modal').classList.remove('on');
  const subj={}, wrong=[]; let c=0;
  ex.qids.forEach(id=>{ const q=byId[id]; subj[q.subj]=subj[q.subj]||{c:0,t:0}; subj[q.subj].t++;
    const m=ex.ans[id]; if(m===q.ans){subj[q.subj].c++; c++;} else wrong.push({q:id,m:m===undefined?-1:m}); });
  let next=U.nextNo;
  try{ const r=await T(DB.getUser(sid),4000); next=Math.max(next,(r&&r.nextNo)||1); }catch(e){}
  const rec={no:next,period:ex.period,at:nowIso(),auto:!!auto,used:ex.total-Math.max(0,ex.remaining),subj,correct:c,total:ex.qids.length,wrong,pending:true};
  U.nextNo=next+1; U.records.push(rec); U.exam=null; U.examAt=nowIso(); saveLocal();
  showResult(rec,true);
  T(DB.putRecord(sid,clean(Object.assign({},rec,{pending:undefined}))))
    .then(()=>T(DB.saveUser(sid,{nextNo:U.nextNo,exam:null,examAt:U.examAt,deviceId:deviceId})))
    .then(()=>{ delete rec.pending; saveLocal(); syncOK=true; }).catch(()=>{ syncOK=false; });
}

/* ---------- 틀린 문제 표시 ---------- */
function wrongCounts(){ const m={}; U.records.forEach(r=>r.wrong.forEach(w=>{(m[w.q]=m[w.q]||[]).push(r.no);})); return m; }
function qCard(q,mines,opts){
  const cnt=opts.count||0, rep=cnt>=2;
  let h='<div class="wq'+(rep?' rep':'')+'"><div class="meta">';
  if(rep) h+='<span class="badge">'+cnt+'번 틀림</span>';
  h+='<span>'+esc(q.id)+'</span><span>'+q.subj+' · '+esc(q.field)+' · '+esc(q.area)+'</span><span class="pg">개념정리본 '+pgLabel(q)+'</span>'+(q.subj==='법규'?'<span>기출 당시 기준</span>':'')+'</div>';
  h+='<div class="st">'+stemHtml(q.stem)+'</div>';
  const mineSet=new Set(mines.filter(x=>x.m>=0).map(x=>x.m));
  q.opts.forEach((o,i)=>{ h+='<div class="wo'+(i===q.ans?' right':'')+(mineSet.has(i)?' mine':'')+'">'+'①②③④⑤'[i]+' '+esc(o)+(i===q.ans?'  ← 정답':'')+(mineSet.has(i)&&i!==q.ans?'  ← 내 답':'')+'</div>'; });
  if(opts.showWhich) h+='<div class="small" style="margin-top:calc(var(--u)*.8)">'+mines.map(x=>x.no+'회차: '+(x.m<0?'미응답':'①②③④⑤'[x.m])).join(' · ')+'</div>';
  return h+'</div>';
}

/* ---------- 결과 ---------- */
function subjTable(rows){
  let h='<table><tr><th style="text-align:left">과목</th><th>맞힌 수</th><th>비율</th><th>판정</th></tr>';
  rows.forEach(([s,v])=>{ h+='<tr><td class="sn">'+s+(s==='법규'?'<div class="note">기출 당시 기준</div>':'')+'</td><td>'+(v.t?v.c+' / '+v.t:'-')+'</td><td>'+(v.t?pct(v.c,v.t)+'%':'-')+'</td><td>'+chip(v.c,v.t)+'</td></tr>'; });
  return h+'</table>';
}
function showResult(rec,justDone){
  show('s-result');
  $('res-title').textContent=rec.no+'회차 · '+rec.period+'교시 결과'+(rec.auto?' (시간 종료로 자동 제출)':'');
  const b=$('res-btns'); b.innerHTML='';
  const add=(t,cls,fn)=>{const x=document.createElement('button'); x.textContent=t; if(cls) x.className=cls; x.onclick=fn; b.appendChild(x);};
  if(justDone&&rec.period===1) add('2교시 시작','ok',()=>startNew(2));
  if(justDone) { add('기록','sec',()=>showRecords()); add('홈','sec',()=>showHome()); }
  else add('기록으로','sec',()=>showRecords());
  const rows=PERIODS[rec.period].subs.map(s=>[s,rec.subj[s]||{c:0,t:0}]);
  const cnts=wrongCounts();
  let h='<div class="card" style="margin-bottom:calc(var(--u)*1.6)"><div style="font-size:calc(var(--u)*2.4);font-weight:800;margin-bottom:calc(var(--u)*1)">점수 '+rec.correct+' / '+rec.total+' ('+pct(rec.correct,rec.total)+'%)</div>'+subjTable(rows)+'<div class="note" style="margin-top:calc(var(--u)*.8)">판정: 40% 미만 과락 · 60% 이하 주의 · 80% 이하 안정권 · 80% 초과 짱이야 (과목별)</div></div>';
  h+='<div class="sechd">틀린 문제 · 미응답 '+rec.wrong.length+'개</div>';
  if(!rec.wrong.length) h+='<div class="card">틀린 문제가 없습니다.</div>';
  rec.wrong.forEach(w=>{ if(byId[w.q]) h+=qCard(byId[w.q],[{no:rec.no,m:w.m}],{count:(cnts[w.q]||[]).length}); });
  $('res-body').innerHTML=h; $('res-body').scrollTop=0;
}

/* ---------- 기록 ---------- */
let recView='main', wrongFilter='all';
function showRecords(){
  show('s-rec'); recView='main';
  $('rec-title').textContent='기록 · '+sid;
  const b=$('rec-btns'); b.innerHTML='';
  const add=(t,cls,fn)=>{const x=document.createElement('button'); x.textContent=t; if(cls) x.className=cls; x.onclick=fn; b.appendChild(x);};
  add('틀린 문제 확인','warn',()=>{recView='wrong';wrongFilter='all';renderRecords();}); add('홈','sec',showHome);
  renderRecords();
}
function renderRecords(){
  const body=$('rec-body'); const R=U.records;
  if(recView==='wrong') return renderWrong();
  const agg={}; ['기초','진단평가','중재','법규'].forEach(s=>agg[s]={c:0,t:0});
  R.forEach(r=>Object.keys(r.subj).forEach(s=>{agg[s].c+=r.subj[s].c; agg[s].t+=r.subj[s].t;}));
  let h='<div class="card" style="margin-bottom:calc(var(--u)*1.6)"><div style="font-weight:800;font-size:calc(var(--u)*2.3);margin-bottom:calc(var(--u)*.8)">전체 회차 통합 (과목별)</div>'+(R.length?subjTable(Object.entries(agg)):'<div class="sub">아직 기록이 없습니다.</div>')+'<div class="note" style="margin-top:calc(var(--u)*.8)">판정: 40% 미만 과락 · 60% 이하 주의 · 80% 이하 안정권 · 80% 초과 짱이야</div></div>';
  h+='<div class="sechd">회차별 기록</div>';
  if(!R.length) h+='<div class="card">모의 시험을 보면 여기에 기록됩니다.</div>';
  R.slice().reverse().forEach(r=>{
    const parts=PERIODS[r.period].subs.map(s=>{const v=r.subj[s]||{c:0,t:0}; return s+' '+pct(v.c,v.t)+'% '+chip(v.c,v.t);}).join(' · ');
    h+='<div class="card rec"><div><div class="t">'+r.no+'회차 · '+r.period+'교시 &nbsp; '+r.correct+' / '+r.total+' ('+pct(r.correct,r.total)+'%)</div><div class="d">'+fmtDate(r.at)+(r.auto?' · 시간 종료':'')+(r.pending?' · 서버 저장 대기':'')+'</div><div class="d">'+parts+'</div></div><div class="row"><button class="sec" data-v="'+r.no+'">상세</button><button class="warn" data-d="'+r.no+'">삭제</button></div></div>';
  });
  h+='<div class="note" style="margin-top:calc(var(--u)*1.2)">기록은 학번·비밀번호로 서버에 저장되어 다른 기기에서도 볼 수 있습니다.'+(syncOK?'':' (현재 서버에 연결되지 않아 이 기기에만 저장 중입니다.)')+'</div>';
  body.innerHTML=h; body.scrollTop=0;
}
$('rec-body').addEventListener('click',ev=>{
  const v=ev.target.closest('[data-v]'), d=ev.target.closest('[data-d]'), f=ev.target.closest('[data-f]');
  if(v){ const r=U.records.find(x=>x.no==v.dataset.v); showResult(r,false); }
  if(d){ const no=+d.dataset.d; modal(no+'회차 기록을 삭제할까요?\n삭제하면 되돌릴 수 없습니다.',[['취소','sec'],['삭제','warn',()=>deleteRecord(no)]]); }
  if(f){ wrongFilter=f.dataset.f==='all'?'all':+f.dataset.f; renderWrong(); }
});
async function deleteRecord(no){
  const r=U.records.find(x=>x.no===no); if(!r) return;
  if(!r.pending){ try{ await T(DB.delRecord(sid,no)); }catch(e){ modal('서버에 연결할 수 없어 삭제하지 못했습니다.\n인터넷에 연결한 뒤 다시 시도해 주세요.',[['확인','']]); return; } }
  U.records=U.records.filter(x=>x.no!==no); saveLocal(); if(wrongFilter===no) wrongFilter='all'; renderRecords();
}
function renderWrong(){
  const R=U.records, cnts=wrongCounts(), body=$('rec-body');
  let h='<div class="chips"><button data-f="all" class="'+(wrongFilter==='all'?'on':'')+'">전체 회차</button>'+R.map(r=>'<button data-f="'+r.no+'" class="'+(wrongFilter===r.no?'on':'')+'">'+r.no+'회차·'+r.period+'교시</button>').join('')+'<button class="sec" id="wb-back" style="margin-left:auto">기록으로</button></div>';
  if(wrongFilter==='all'){
    const ids=Object.keys(cnts).filter(i=>byId[i]).sort((a,b)=>cnts[b].length-cnts[a].length||Q.indexOf(byId[a])-Q.indexOf(byId[b]));
    const rep=ids.filter(i=>cnts[i].length>=2).length;
    h+='<div class="sechd">전체 회차 틀린 문제 '+ids.length+'개 · 2번 이상 틀린 문제 '+rep+'개</div>';
    if(!ids.length) h+='<div class="card">틀린 문제가 없습니다.</div>';
    ids.forEach(id=>{ const mines=[]; R.forEach(r=>{const w=r.wrong.find(x=>x.q===id); if(w) mines.push({no:r.no,m:w.m});}); h+=qCard(byId[id],mines,{count:cnts[id].length,showWhich:true}); });
  } else {
    const r=R.find(x=>x.no===wrongFilter);
    if(!r){wrongFilter='all'; return renderWrong();}
    h+='<div class="sechd">'+r.no+'회차 · '+r.period+'교시 틀린 문제 '+r.wrong.length+'개</div>';
    if(!r.wrong.length) h+='<div class="card">틀린 문제가 없습니다.</div>';
    r.wrong.forEach(w=>{ if(byId[w.q]) h+=qCard(byId[w.q],[{no:r.no,m:w.m}],{count:cnts[w.q].length}); });
  }
  body.innerHTML=h; body.scrollTop=0;
  $('wb-back').onclick=()=>{recView='main'; renderRecords();};
}

/* ---------- 비밀번호 변경 ---------- */
$('pw-save').onclick=async()=>{
  const a=$('pw-new').value, b=$('pw-new2').value, m=$('pw-msg');
  if(a.length<8){ m.textContent='비밀번호는 8자 이상으로 입력해 주세요.'; return; }
  if(a!==b){ m.textContent='두 비밀번호가 서로 다릅니다.'; return; }
  m.textContent='변경 중…';
  try{ await T(DB.changePassword(a),15000); $('pw-new').value=''; $('pw-new2').value=''; m.textContent=''; modal('비밀번호를 변경했습니다.',[['확인','',showHome]]); }
  catch(e){ const c=(e&&e.code)||''; m.textContent=c.includes('requires-recent-login')?'보안을 위해 다시 로그인한 뒤 변경해 주세요. (로그아웃 후 다시 로그인)':(c.includes('weak-password')?'더 긴 비밀번호를 사용해 주세요.':'변경하지 못했습니다. 인터넷 연결을 확인해 주세요.'); }
};
$('pw-back').onclick=()=>showHome();

/* ---------- 관리자 ---------- */
function adminLog(t){ $('adm-log').textContent=t; }
function showAdmin(){ show('s-admin'); adminLog('현재 이 기기에 불러온 문제: '+Q.length+'문항'); $('adm-out').value=''; }
$('adm-back').onclick=()=>showHome();
$('adm-up').onclick=()=>{ const f=$('adm-file').files[0]; if(!f){ adminLog('문제 데이터 파일(questions_upload.json)을 먼저 선택해 주세요.'); return; }
  const rd=new FileReader(); rd.onload=async()=>{
    try{
      const data=JSON.parse(rd.result);
      if(!data.items||!data.quota||!data.version||data.items.length<1) throw new Error('파일 형식이 올바르지 않습니다.');
      adminLog('올리는 중… ('+data.items.length+'문항)');
      await T(DB.adminWriteQuestions(data),60000);
      lsSet('ptq2:q',null); adminLog('올리기 완료: '+data.items.length+'문항, 버전 '+data.version+'\n사이트를 새로고침하면 새 문제가 적용됩니다.');
    }catch(e){ adminLog('올리지 못했습니다: '+(e&&(e.code||e.message)||e)); }
  }; rd.readAsText(f,'utf-8'); };
$('adm-exp').onclick=async()=>{
  adminLog('모든 학생 기록을 불러오는 중…');
  try{ const all=await T(DB.adminExportAll(),60000); const txt=JSON.stringify(all,null,1); $('adm-out').value=txt;
    const n=Object.keys(all.users||{}).length; adminLog('불러오기 완료: 학생 '+n+'명. 아래 칸의 내용을 "복사"하거나 "파일로 저장"하세요.');
    window.__exportText=txt; }
  catch(e){ adminLog('불러오지 못했습니다: '+(e&&(e.code||e.message)||e)); }
};
$('adm-copy').onclick=async()=>{ try{ await navigator.clipboard.writeText($('adm-out').value); adminLog('복사했습니다.'); }catch(e){ $('adm-out').select(); adminLog('길게 눌러 직접 복사해 주세요.'); } };
$('adm-dl').onclick=()=>{ const t=$('adm-out').value; if(!t){ adminLog('먼저 "전체 기록 불러오기"를 눌러 주세요.'); return; }
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([t],{type:'application/json'})); a.download='ptquiz_backup_'+nowIso().slice(0,10)+'.json'; document.body.appendChild(a); a.click(); a.remove(); };

/* ---------- 흐름 ---------- */
function showHome(){
  E=null; show('s-home'); $('home-id').textContent='학번 '+sid;
  $('h-admin').style.display=(sid===ADMIN)?'inline-block':'none';
  const noQ=!Q.length; $('h-exam').disabled=noQ; $('h-rec').disabled=noQ;
  $('home-note').textContent=noQ?'문제 데이터가 아직 없습니다. 관리자 화면에서 올려 주세요.':(syncOK?'':'서버에 연결되지 않아 이 기기에만 저장 중입니다. 연결되면 자동으로 올라갑니다.');
  const ex=U&&U.exam; $('home-resume').style.display=ex?'block':'none';
  if(ex) $('home-resume-t').textContent='진행 중인 시험: '+ex.period+'교시 · 남은 시간 '+fmtTime(ex.remaining)+' · 푼 문제 '+Object.keys(ex.ans).length+'/'+ex.qids.length;
  retryPending();
}
function startNew(period){
  const go=()=>{ U.exam=null; startExam(buildExam(period)); };
  if(U.exam){ modal('진행 중인 시험이 있습니다.\n새로 시작하면 진행 중인 시험은 사라집니다.',[['취소','sec'],['새로 시작','warn',go]]); }
  else go();
}
$('h-exam').onclick=()=>show('s-pick');
$('h-rec').onclick=showRecords;
$('h-logout').onclick=logout;
$('h-pw').onclick=()=>{ $('pw-msg').textContent=''; show('s-pw'); };
$('h-admin').onclick=showAdmin;
document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>startNew(+b.dataset.p));
document.querySelector('[data-back]').onclick=showHome;
$('resume-go').onclick=()=>{ const ex=U.exam; ex.paused=true; startExam(ex); };
$('resume-drop').onclick=()=>modal('진행 중인 시험을 포기할까요?\n기록에는 남지 않습니다.',[['취소','sec'],['포기','warn',()=>{U.exam=null; U.examAt=nowIso(); E=null; saveLocal(); lastPush=0; pushExam(); showHome();}]]);

/* ---------- Firebase 연결 ---------- */
async function makeFirebaseDB(cfg){
  const base='https://www.gstatic.com/firebasejs/10.14.1/';
  const [A,Au,F]=await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js'),import(base+'firebase-firestore.js')]);
  const app=A.initializeApp(cfg), auth=Au.getAuth(app), fs=F.getFirestore(app);
  const email=s=>s+'@'+DOMAIN;
  const SUBJ=['기초','진단평가','중재','법규'];
  const firstUser=new Promise(res=>{ const un=Au.onAuthStateChanged(auth,u=>{un(); res(u);}); });
  return {
    ready:firstUser,
    currentSid(){ const u=auth.currentUser; return u&&u.email?u.email.split('@')[0]:null; },
    signIn:(s,pw)=>Au.signInWithEmailAndPassword(auth,email(s),pw),
    signOut:()=>Au.signOut(auth),
    changePassword:pw=>Au.updatePassword(auth.currentUser,pw),
    async getMeta(){ const d=await F.getDoc(F.doc(fs,'questions','meta')); return d.exists()?d.data():null; },
    async getQuestions(){
      const meta=(await F.getDoc(F.doc(fs,'questions','meta'))).data(); let items=[];
      for(const s of SUBJ){ const d=await F.getDoc(F.doc(fs,'questions',s)); if(d.exists()) items=items.concat(d.data().items); }
      const q=await F.getDoc(F.doc(fs,'questions','quota'));
      return {version:meta.version,items:items,quota:q.data().rows};
    },
    async getUser(s){ const d=await F.getDoc(F.doc(fs,'users',s)); return d.exists()?d.data():null; },
    async getRecords(s){ const r=await F.getDocs(F.collection(fs,'users',s,'records')); return r.docs.map(d=>d.data()); },
    saveUser:(s,p)=>F.setDoc(F.doc(fs,'users',s),clean(p),{merge:true}),
    putRecord:(s,r)=>F.setDoc(F.doc(fs,'users',s,'records',String(r.no)),clean(r)),
    delRecord:(s,no)=>F.deleteDoc(F.doc(fs,'users',s,'records',String(no))),
    async adminWriteQuestions(data){
      const by={}; data.items.forEach(q=>{(by[q.subj]=by[q.subj]||[]).push(q);});
      for(const s of Object.keys(by)) await F.setDoc(F.doc(fs,'questions',s),{items:by[s]});
      await F.setDoc(F.doc(fs,'questions','quota'),{rows:data.quota});
      await F.setDoc(F.doc(fs,'questions','meta'),{version:data.version,count:data.items.length});
    },
    async adminExportAll(){
      const out={exportedAt:nowIso(),users:{}}; const us=await F.getDocs(F.collection(fs,'users'));
      for(const u of us.docs){ const r=await F.getDocs(F.collection(fs,'users',u.id,'records')); out.users[u.id]={user:u.data(),records:r.docs.map(d=>d.data())}; }
      return out;
    }
  };
}

(async function init(){
  fitRetry();
  try{
    if(window.__DBIMPL){ DB=window.__DBIMPL; }
    else{
      const cfg=window.FIREBASE_CONFIG;
      if(!cfg||!cfg.apiKey||String(cfg.apiKey).startsWith('여기에')){ $('login-err').textContent='firebase-config.js 설정이 아직 되어 있지 않습니다. 안내서(SETUP.md)를 따라 설정해 주세요.'; $('login-go').disabled=true; return; }
      loading('연결하는 중…'); DB=await makeFirebaseDB(cfg);
    }
    await T(DB.ready,10000).catch(()=>{});
    const cur=DB.currentSid&&DB.currentSid();
    if(cur&&/^[0-9]{7}$/.test(cur)){ await enter(cur); } else show('s-login');
  }catch(e){ show('s-login'); $('login-err').textContent='서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.'; }
})();
function fitRetry(){ fit(); }
