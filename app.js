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
/* 세로 화면(스마트폰·아이패드 세로)에서는 과목별 퀴즈 세 화면만 세로 배치, 나머지는 가로 4:3 유지 */
const PORT=new Set(['s-qsel','s-quiz','s-qres']);
let curScreen='s-login';
function fit(){
  const w=innerWidth,h=innerHeight, st=$('stage'), por=h>w, pv=por&&PORT.has(curScreen);
  st.classList.toggle('portrait',pv);
  if(pv){ st.style.width=w+'px'; st.style.height=h+'px'; st.style.setProperty('--u',Math.min(w/45,h/75,12)+'px'); }
  else { let sw=w, sh=w*3/4; if(sh>h){sh=h;sw=h*4/3;} st.style.width=sw+'px'; st.style.height=sh+'px'; st.style.setProperty('--u',(sw/100)+'px'); }
}
addEventListener('resize',fit); addEventListener('orientationchange',()=>setTimeout(fit,200)); fit();

/* ---------- 기기 저장 / 유틸 ---------- */
function lsGet(k){try{const r=localStorage.getItem(k); return r?JSON.parse(r):null;}catch(e){return null;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v)); return true;}catch(e){return false;}}
const clean=o=>JSON.parse(JSON.stringify(o));
const nowIso=()=>new Date().toISOString();
function T(p,ms){ return Promise.race([Promise.resolve(p),new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms||8000))]); }
function fresh(){return {nextNo:1,records:[],exam:null,examAt:''};}
let viewing=null, adminU=null;
function saveLocal(){ if(viewing) return; if(sid&&U){ if(E) U.exam=E; lsSet('ptq2:u:'+sid,U); } }
function show(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('on')); $(id).classList.add('on'); curScreen=id; fit(); }
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function stemTable(s){
  const i=s.indexOf(' | '); if(i<0||!/\|\s*:?-{1,}:?\s*\|/.test(s)) return null;
  const cells=s.slice(i).split('|').map(t=>t.trim()).filter(t=>t!==''), isSep=t=>/^:?-+:?$/.test(t);
  const k=cells.findIndex(isSep); if(k<1) return null; let n=0; while(isSep(cells[k+n]||'')) n++;
  if(n!==k) return null; const body=cells.slice(2*k); if(!body.length||body.length%k) return null;
  let h='<table class="stbl"><tr>'+cells.slice(0,k).map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr>';
  for(let r=0;r<body.length;r+=k) h+='<tr>'+body.slice(r,r+k).map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>';
  return {pre:s.slice(0,i).trim(),html:h+'</table>'};
}
function stemHtml(s){ const t=stemTable(s); if(t) return esc(t.pre)+t.html; const p=s.split(' • '); if(p.length===1) return esc(s); return esc(p[0])+'<div class="box"><ul>'+p.slice(1).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></div>'; }
function stemLead(s){ const t=stemTable(s); return t?t.pre:s.split(' • ')[0]; }
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
const ORD={"기초|해부생리":0,"기초|운동학":1,"기초|물리적 인자치료":2,"기초|공중보건":3,"진단평가|진단평가 원리":0,"진단평가|검사와 평가":1,"진단평가|임상의사결정":2,"진단평가|물리치료 문제해결(진단평가)":3,"중재|근골격계 중재":0,"중재|신경계 중재":1,"중재|심폐혈관계 중재":2,"중재|피부계 중재":3,"중재|물리치료 문제해결(중재)":4,"법규|의료법":0,"법규|의료기사 등에 관한 법률":1,"법규|장애인복지법":2,"법규|노인복지법":3,"법규|국민건강보험법":4,"기초|해부생리|인체의 구분과 조직":0,"기초|해부생리|뼈대계통":1,"기초|해부생리|관절계통":2,"기초|해부생리|근육계통":3,"기초|해부생리|호흡계통":4,"기초|해부생리|순환계통":5,"기초|해부생리|피부계통 및 특수감각계통":6,"기초|해부생리|소화계통":7,"기초|해부생리|비뇨계통 및 내분비계통":8,"기초|해부생리|신경계통":9,"기초|운동학|운동학 원리":0,"기초|운동학|어깨, 팔":1,"기초|운동학|골반, 다리":2,"기초|운동학|머리, 척주, 가슴우리":3,"기초|운동학|걷기, 달리기":4,"기초|물리적 인자치료|전기치료의 기초":0,"기초|물리적 인자치료|전기진단의 원리":1,"기초|물리적 인자치료|전기치료의 적용 원리":2,"기초|물리적 인자치료|기계적 자극 치료의 적용 원리":3,"기초|물리적 인자치료|광선치료의 기초":4,"기초|물리적 인자치료|광선치료의 적용 원리":5,"기초|물리적 인자치료|수치료와 수중운동의 기초":6,"기초|물리적 인자치료|온열과 한랭치료의 기초":7,"기초|물리적 인자치료|수치료와 수중운동의 적용 원리":8,"기초|물리적 인자치료|보조기":9,"기초|물리적 인자치료|의지":10,"기초|물리적 인자치료|보조도구와 로봇을 이용한 기립, 보행, 이동":11,"기초|공중보건|역학과 감염병":0,"기초|공중보건|공중보건 총론":1,"기초|공중보건|환경보건":2,"기초|공중보건|보건관리 및 보건사업":3,"진단평가|진단평가 원리|진단평가 검사원리":0,"진단평가|진단평가 원리|측정 및 평가":1,"진단평가|검사와 평가|근골격계 검사 및 평가":0,"진단평가|검사와 평가|신경계 검사 및 평가":1,"진단평가|검사와 평가|심폐혈관계 검사 및 평가":2,"진단평가|검사와 평가|피부계 검사 및 평가":3,"진단평가|검사와 평가|난치성·대사성 질환 검사 및 평가":4,"진단평가|임상의사결정|물리치료 기록":0,"진단평가|임상의사결정|근거중심 물리치료":1,"진단평가|임상의사결정|물리치료 의사결정":2,"진단평가|임상의사결정|물리치료 윤리":3,"진단평가|물리치료 문제해결(진단평가)|근골격계 및 신경계 진단평가 문제해결":0,"중재|근골격계 중재|근골격계 질환":0,"중재|근골격계 중재|근골격계 운동치료":1,"중재|근골격계 중재|근골격계 물리적 인자치료":2,"중재|근골격계 중재|근골격계 예방관리":3,"중재|신경계 중재|신경계 질환 및 관리":0,"중재|신경계 중재|신경계 운동치료":1,"중재|신경계 중재|신경계 물리적 인자치료":2,"중재|심폐혈관계 중재|호흡기계 질환":0,"중재|심폐혈관계 중재|심혈관계 질환":1,"중재|심폐혈관계 중재|심폐혈관계 물리치료":2,"중재|피부계 중재|피부계 물리치료":0,"중재|피부계 중재|피부계 손상 및 질환":1,"중재|물리치료 문제해결(중재)|근골격계 및 신경계 문제해결":0,"법규|의료법|총칙":0,"법규|의료법|의료기관":1,"법규|의료법|의료인":2,"법규|의료기사 등에 관한 법률|목적, 정의, 의료기사의 종류 및 업무, 업무 범위와 한계":0,"법규|의료기사 등에 관한 법률|자격과 면허":1,"법규|의료기사 등에 관한 법률|벌칙":2,"법규|장애인복지법|총칙":0,"법규|장애인복지법|복지 조치":1,"법규|장애인복지법|복지시설과 단체":2,"법규|노인복지법|총칙":0,"법규|노인복지법|보건·복지조치":1,"법규|노인복지법|노인복지시설의 설치·운영":2,"법규|국민건강보험법|총칙":0};
function ordF(s,f){const v=ORD[s+'|'+f]; return v===undefined?99:v;}
function ordA(s,f,x){const v=ORD[s+'|'+f+'|'+x]; return v===undefined?99:v;}
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
    ar.forEach((r,j)=>{ out.push({fo:ordF(subj,f),ao:ordA(subj,f,r.area),ids:shuffle(poolOf(subj,f,r.area)).slice(0,ac[j]).map(q=>q.id)}); });
  });
  out.sort((x,y)=>x.fo-y.fo||x.ao-y.ao);
  return out.reduce((acc,p)=>acc.concat(p.ids),[]);
}
function lab(r){ return r.real?'국가고시 '+r.real+'회':r.no+'회차'; }
let recTab='mock';
function RS(){ return U.records.filter(r=>recTab==='real'?!!r.real:!r.real); }
function realQids(round,period){
  const pre=round+'회 '+period+'교시 ';
  return Q.filter(q=>q.id.indexOf(pre)===0).sort((a,b)=>parseInt(a.id.slice(pre.length))-parseInt(b.id.slice(pre.length))).map(q=>q.id);
}
function buildReal(round,period){
  const P=PERIODS[period];
  return {period:period,real:round,qids:realQids(round,period),ans:{},flag:{},idx:0,remaining:P.min*60000,total:P.min*60000,alerts:{a5:false,a1:false},startedAt:nowIso(),paused:false};
}
function buildExam(period){
  const P=PERIODS[period]; let ids=[];
  P.subs.forEach(s=>{ ids=ids.concat(pickSubject(s,P.counts[s])); });
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
let qErr='';
async function ensureQuestions(){
  let meta=null, offline=false; qErr='';
  try{ meta=await T(DB.getMeta(),20000); }catch(e){ offline=true; qErr='문제 정보 읽기 실패: '+((e&&(e.code||e.message))||e); }
  const cache=lsGet('ptq2:q');
  if(cache&&(offline||(meta&&cache.version===meta.version))){ setQ(cache); return true; }
  if(!meta&&!offline) qErr='서버에 문제 데이터가 아직 없습니다(관리자 화면에서 올려 주세요).';
  if(meta){ try{ const data=await T(DB.getQuestions(),40000); if(data&&data.items&&data.items.length){ lsSet('ptq2:q',data); setQ(data); qErr=''; return true; } qErr='문제 데이터가 비어 있습니다.'; }catch(e){ qErr='문제 읽기 실패: '+((e&&(e.code||e.message))||e); } }
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
  $('qtitle').innerHTML=(E.real?'국가고시 '+E.real+'회 ':'')+E.period+'교시 · '+q.subj+' · <b>'+n+'번</b> / '+E.qids.length+'<span class="src">기출 '+esc(q.id)+'</span>'+(q.subj==='법규'?'<span class="tag">기출 당시 기준</span>':'');
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
  const fl=E.qids.filter(id=>E.flag[id]).length;
  modal(fl?'다시 확인 문제가 '+fl+'문제 있습니다.\n제출하시겠습니까?':'제출하시겠습니까?',[['아니오','sec'],['예','ok',()=>submitExam(false)]]);
}
async function submitExam(auto){
  if(!E) return; const ex=E; E=null; $('ov-sel').classList.remove('on'); $('ov-pause').classList.remove('on'); $('modal').classList.remove('on');
  const subj={}, wrong=[]; let c=0;
  ex.qids.forEach(id=>{ const q=byId[id]; subj[q.subj]=subj[q.subj]||{c:0,t:0}; subj[q.subj].t++;
    const m=ex.ans[id]; if(m===q.ans){subj[q.subj].c++; c++;} else wrong.push({q:id,m:m===undefined?-1:m}); });
  let next=U.nextNo;
  try{ const r=await T(DB.getUser(sid),4000); next=Math.max(next,(r&&r.nextNo)||1); }catch(e){}
  const rec={no:next,period:ex.period,at:nowIso(),auto:!!auto,used:ex.total-Math.max(0,ex.remaining),subj,correct:c,total:ex.qids.length,wrong,qs:ex.qids.slice(),fl:ex.qids.filter(id=>ex.flag&&ex.flag[id]),pending:true};
  if(ex.real) rec.real=ex.real;
  U.nextNo=next+1; U.records.push(rec); U.exam=null; U.examAt=nowIso(); saveLocal();
  showResult(rec,true);
  T(DB.putRecord(sid,clean(Object.assign({},rec,{pending:undefined}))))
    .then(()=>T(DB.saveUser(sid,{nextNo:U.nextNo,exam:null,examAt:U.examAt,deviceId:deviceId})))
    .then(()=>{ delete rec.pending; saveLocal(); syncOK=true; }).catch(()=>{ syncOK=false; });
}

/* ---------- 틀린 문제 표시 ---------- */
function wrongCounts(){ const m={}; RS().forEach(r=>r.wrong.forEach(w=>{(m[w.q]=m[w.q]||[]).push(r.no);})); return m; }
function qCard(q,es,opts){
  opts=opts||{}; const cnt=opts.count||0, rep=cnt>=2, one=es.length===1?es[0]:null;
  let h='<div class="wq'+(rep?' rep':'')+'"><div class="meta">';
  if(opts.num) h+='<b>'+opts.num+'번</b>';
  if(one) h+=one.ok?'<span class="badge ok">정답</span>':'<span class="badge bad">'+(one.m<0?'선택 없음':'오답')+'</span>';
  if(rep) h+='<span class="badge">'+cnt+'번 틀림</span>';
  const nf=es.filter(e=>e.fl).length; if(nf) h+='<span class="badge fl">다시 확인'+(es.length>1&&nf>1?' '+nf+'번':'')+'</span>';
  h+='<span class="src">기출 '+esc(q.id)+'</span><span>'+q.subj+' · '+esc(q.field)+' · '+esc(q.area)+'</span><span class="pg">개념정리본 '+pgLabel(q)+'</span>'+(q.subj==='법규'?'<span>기출 당시 기준</span>':'')+'</div>';
  h+='<div class="st">'+stemHtml(q.stem)+'</div>';
  const mine=new Set(es.filter(e=>!e.ok&&e.m>=0).map(e=>e.m));
  q.opts.forEach((o,i)=>{ h+='<div class="wo'+(i===q.ans?' right':'')+(mine.has(i)?' mine':'')+'">'+'①②③④⑤'[i]+' '+esc(o)+(i===q.ans?'  ← 정답':'')+(mine.has(i)&&i!==q.ans?'  ← 내 답':'')+'</div>'; });
  if(one&&!one.ok&&one.m<0) h+='<div class="small nosel">선택한 선지 없음</div>';
  if(opts.showWhich) h+='<div class="small" style="margin-top:calc(var(--u)*.8)">'+es.map(x=>x.lab+': '+(x.ok?'정답':(x.m<0?'선택한 선지 없음':'①②③④⑤'[x.m]+' 오답'))+(x.fl?' · 다시 확인':'')).join(' · ')+'</div>';
  return h+xpBlock(q)+'</div>';
}

/* ---------- 결과 ---------- */
function subjTable(rows){
  let h='<table><tr><th style="text-align:left">과목</th><th>맞힌 수</th><th>비율</th><th>판정</th></tr>';
  rows.forEach(([s,v])=>{ h+='<tr><td class="sn">'+s+(s==='법규'?'<div class="note">기출 당시 기준</div>':'')+'</td><td>'+(v.t?v.c+' / '+v.t:'-')+'</td><td>'+(v.t?pct(v.c,v.t)+'%':'-')+'</td><td>'+chip(v.c,v.t)+'</td></tr>'; });
  return h+'</table>';
}
let resRec=null, resMode='all';
function showResult(rec,justDone){
  resRec=rec; resMode='all'; recTab=rec.real?'real':'mock'; show('s-result'); preloadExpl();
  $('res-title').textContent=lab(rec)+' · '+rec.period+'교시 결과'+(rec.auto?' (시간 종료로 자동 제출)':'');
  const b=$('res-btns'); b.innerHTML='';
  const add=(t,cls,fn)=>{const x=document.createElement('button'); x.textContent=t; if(cls) x.className=cls; x.onclick=fn; b.appendChild(x);};
  if(justDone&&rec.period===1) add('2교시 시작','ok',()=>startNew(2,rec.real));
  if(justDone) { add('기록','sec',()=>showRecords()); add('홈','sec',()=>showHome()); }
  else add('기록으로','sec',()=>showRecords());
  renderResultBody(); $('res-body').scrollTop=0;
}
const FM=[['all','전체'],['right','정답'],['fok','정답-확인'],['fbad','오답-확인'],['fnone','오답-확인X'],['many','많이 틀린 문제']];
function fm(k,es){ if(k==='all') return true; if(k==='right') return es.some(e=>e.ok); if(k==='wrong') return es.some(e=>!e.ok); if(k==='fok') return es.some(e=>e.fl&&e.ok); if(k==='fbad') return es.some(e=>e.fl&&!e.ok); if(k==='fnone') return es.some(e=>!e.ok&&!e.fl); if(k==='many') return es.filter(e=>!e.ok).length>=2; return true; }
function fchips(attr,cur,groups,many){ return '<div class="chips">'+FM.filter(p=>p[0]!=='many'||many).map(p=>'<button data-'+attr+'="'+p[0]+'" class="'+(cur===p[0]?'on':'')+'">'+p[1]+' '+groups.filter(g=>fm(p[0],g)).length+'</button>').join('')+xAllBtn()+'</div>'; }
function renderResultBody(){
  const rec=resRec, rows=PERIODS[rec.period].subs.map(s=>[s,rec.subj[s]||{c:0,t:0}]);
  const es=recMap(rec), hasAll=!!(rec.qs&&rec.qs.length), cnts=wrongCounts();
  let h='<div class="card" style="margin-bottom:calc(var(--u)*1.6)"><div style="font-size:calc(var(--u)*2.4);font-weight:800;margin-bottom:calc(var(--u)*1)">점수 '+rec.correct+' / '+rec.total+' ('+pct(rec.correct,rec.total)+'%)</div>'+subjTable(rows)+'<div class="note" style="margin-top:calc(var(--u)*.8)">판정: 40% 미만 과락 · 60% 이하 주의 · 80% 이하 안정권 · 80% 초과 짱이야 (과목별)</div></div>';
  const nW=es.filter(e=>!e.ok).length, nF=es.filter(e=>e.fl).length;
  if(hasAll){
    h+='<div class="sechd">문제별 결과 · 틀린 문제 '+nW+'개 · 다시 확인 '+nF+'개</div>';
    h+='<div class="rgrid">'+es.map((e,i)=>'<button class="nb '+(e.ok?'a':'u')+(e.fl?' f':'')+'" data-j="'+i+'">'+(i+1)+'</button>').join('')+'</div>';
    h+=fchips('rm',resMode,es.map(e=>[e]));
    const list=es.filter(e=>fm(resMode,[e]));
    if(!list.length) h+='<div class="card">해당하는 문제가 없습니다.</div>';
    list.forEach(e=>{ h+='<div id="rc-'+e.i+'">'+qCard(byId[e.id],[e],{count:(cnts[e.id]||[]).length,num:e.i+1})+'</div>'; });
  } else {
    h+='<div class="sechd">틀린 문제 · 선택 없음 포함 '+rec.wrong.length+'개</div>';
    h+='<div class="note" style="margin-bottom:calc(var(--u)*1)">이 회차는 출제 목록이 저장되기 전 기록이라 틀린 문제만 볼 수 있습니다.</div><div class="chips">'+xAllBtn()+'</div>';
    if(!rec.wrong.length) h+='<div class="card">틀린 문제가 없습니다.</div>';
    es.forEach(e=>{ h+=qCard(byId[e.id],[e],{count:(cnts[e.id]||[]).length}); });
  }
  $('res-body').innerHTML=h;
}
$('res-body').addEventListener('click',ev=>{
  const body=$('res-body'), rm=ev.target.closest('[data-rm]'), nb=ev.target.closest('.rgrid .nb');
  if(rm){ resMode=rm.dataset.rm; const st=body.scrollTop; renderResultBody(); body.scrollTop=st; return; }
  if(nb){ const j=nb.dataset.j; let el=document.getElementById('rc-'+j); if(!el){ resMode='all'; renderResultBody(); el=document.getElementById('rc-'+j); } if(el) el.scrollIntoView({block:'start'}); }
});

/* ---------- 기록 ---------- */
let recView='main', wSel=null; /* wSel: null=모든 회차 선택, Set=고른 회차 번호 */
function selRecs(){ return RS().filter(r=>wSel===null||wSel.has(r.no)); }
function allSel(){ const R=RS(); return wSel===null||(R.length>0&&R.every(r=>wSel.has(r.no))); }
function avgName(){ return allSel()?'전체 평균':'선택 평균'; }
function showRecords(){
  show('s-rec'); recView='main'; preloadExpl();
  $('rec-title').textContent=viewing?('학생 '+viewing+' 기록 · 읽기 전용'):('기록 · '+sid);
  const b=$('rec-btns'); b.innerHTML='';
  const add=(t,cls,fn)=>{const x=document.createElement('button'); x.textContent=t; if(cls) x.className=cls; x.onclick=fn; b.appendChild(x);};
  add('문제 확인','warn',()=>{recView='wrong';wSel=null;wrongMode='all';cellState=null;renderRecords();}); add(viewing?'관리자 화면으로':'홈','sec',viewing?exitView:showHome);
  renderRecords();
}
function tabsHtml(){ return '<div class="chips"><button data-rt="mock" class="'+(recTab==='mock'?'on':'')+'">모의시험</button><button data-rt="real" class="'+(recTab==='real'?'on':'')+'">국가고시</button></div>'; }
function renderRecords(){
  const body=$('rec-body'); const R=RS();
  if(recView==='wrong') return renderWrong();
  const agg={}; ['기초','진단평가','중재','법규'].forEach(s=>agg[s]={c:0,t:0});
  R.forEach(r=>Object.keys(r.subj).forEach(s=>{agg[s].c+=r.subj[s].c; agg[s].t+=r.subj[s].t;}));
  let h=tabsHtml()+'<div class="card" style="margin-bottom:calc(var(--u)*1.6)"><div style="font-weight:800;font-size:calc(var(--u)*2.3);margin-bottom:calc(var(--u)*.8)">전체 회차 통합 (과목별)</div>'+(R.length?subjTable(Object.entries(agg)):'<div class="sub">아직 기록이 없습니다.</div>')+'<div class="note" style="margin-top:calc(var(--u)*.8)">판정: 40% 미만 과락 · 60% 이하 주의 · 80% 이하 안정권 · 80% 초과 짱이야</div></div>';
  h+='<div class="sechd">회차별 기록</div>';
  if(!R.length) h+='<div class="card">'+(recTab==='real'?'국가 고시를 풀면':'모의 시험을 보면')+' 여기에 기록됩니다.</div>';
  R.slice().reverse().forEach(r=>{
    const parts=PERIODS[r.period].subs.map(s=>{const v=r.subj[s]||{c:0,t:0}; return s+' '+pct(v.c,v.t)+'% '+chip(v.c,v.t);}).join(' · ');
    h+='<div class="card rec"><div><div class="t">'+lab(r)+' · '+r.period+'교시 &nbsp; '+r.correct+' / '+r.total+' ('+pct(r.correct,r.total)+'%)</div><div class="d">'+fmtDate(r.at)+(r.auto?' · 시간 종료':'')+(r.pending?' · 서버 저장 대기':'')+'</div><div class="d">'+parts+'</div></div><div class="row"><button class="sec" data-v="'+r.no+'">상세</button>'+(viewing?'':'<button class="warn" data-d="'+r.no+'">삭제</button>')+'</div></div>';
  });
  h+='<div class="note" style="margin-top:calc(var(--u)*1.2)">기록은 학번·비밀번호로 서버에 저장되어 다른 기기에서도 볼 수 있습니다.'+(syncOK?'':' (현재 서버에 연결되지 않아 이 기기에만 저장 중입니다.)')+'</div>';
  body.innerHTML=h; body.scrollTop=0;
}
$('rec-body').addEventListener('click',ev=>{
  const rt=ev.target.closest('[data-rt]'); if(rt){ recTab=rt.dataset.rt; wSel=null; wrongMode='all'; cellState=null; renderRecords(); return; }
  const v=ev.target.closest('[data-v]'), d=ev.target.closest('[data-d]'), f=ev.target.closest('[data-f]');
  if(v){ const r=U.records.find(x=>x.no==v.dataset.v); showResult(r,false); }
  if(d){ const no=+d.dataset.d; modal(lab(U.records.find(x=>x.no===no)||{no:no})+' 기록을 삭제할까요?\n삭제하면 되돌릴 수 없습니다.',[['취소','sec'],['삭제','warn',()=>deleteRecord(no)]]); }
  if(f){ const v=f.dataset.f;
    if(v==='on') wSel=null; else if(v==='off') wSel=new Set();
    else { const no=+v; if(wSel===null) wSel=new Set(RS().map(r=>r.no)); wSel.has(no)?wSel.delete(no):wSel.add(no); if(allSel()) wSel=null; }
    cellState=null; renderWrong(); }
});
async function deleteRecord(no){
  if(viewing) return;
  const r=U.records.find(x=>x.no===no); if(!r) return;
  if(!r.pending){ try{ await T(DB.delRecord(sid,no)); }catch(e){ modal('서버에 연결할 수 없어 삭제하지 못했습니다.\n인터넷에 연결한 뒤 다시 시도해 주세요.',[['확인','']]); return; } }
  U.records=U.records.filter(x=>x.no!==no); saveLocal(); if(wSel) wSel.delete(no); renderRecords();
}

/* ---------- 분야·영역 정답률 ---------- */
let accOpen={}, cellState=null, accScroll=0, wrongMode='all';
function recMap(r){
  const wr={}; r.wrong.forEach(w=>{wr[w.q]=w.m;}); const fl=new Set(r.fl||[]);
  const ids=(r.qs&&r.qs.length)?r.qs:r.wrong.map(w=>w.q);
  return ids.filter(id=>byId[id]).map((id,i)=>{ const bad=Object.prototype.hasOwnProperty.call(wr,id); return {id:id,i:i,no:r.no,lab:lab(r),m:bad?wr[id]:byId[id].ans,ok:!bad,fl:fl.has(id)}; });
}
function recStats(r){
  const m={}, wr={}; r.wrong.forEach(w=>{wr[w.q]=1;});
  (r.qs||[]).forEach(id=>{ const q=byId[id]; if(!q) return; const ok=!wr[id];
    [q.subj, q.subj+'|'+q.field, q.subj+'|'+q.field+'|'+q.area].forEach(k=>{ const v=m[k]=m[k]||{c:0,t:0}; v.t++; if(ok) v.c++; }); });
  return m;
}
function accCell(v){ return v&&v.t? '<b>'+pct(v.c,v.t)+'%</b><div class="note">'+v.c+'/'+v.t+'</div>' : '-'; }
function vcell(c,k){ const v=c.st[k], av=c.id==='all'?' av':''; return v&&v.t? '<td class="v'+av+'" data-c="'+c.id+'" data-k="'+esc(k)+'">'+accCell(v)+'</td>' : '<td'+(av?' class="av"':'')+'>-</td>'; }
function setupAccSlider(){
  const w=document.querySelector('#rec-body .accwrap'), r=document.getElementById('acc-slider'); if(!w||!r) return;
  const upd=()=>{ const max=w.scrollWidth-w.clientWidth; r.parentNode.style.display=max>8?'flex':'none'; r.max=Math.max(0,max); r.value=w.scrollLeft; };
  w.addEventListener('scroll',()=>{ r.value=w.scrollLeft; });
  r.addEventListener('input',()=>{ w.scrollLeft=+r.value; });
  upd(); setTimeout(upd,60);
}
function accPanel(cols,hasOld){
  const keys={}; cols.forEach(c=>Object.keys(c.st).forEach(k=>{keys[k]=1;}));
  const subs=['기초','진단평가','중재','법규'].filter(s=>keys[s]);
  let h='<div class="card" style="margin-bottom:calc(var(--u)*1.6)"><div style="font-weight:800;font-size:calc(var(--u)*2.3);margin-bottom:calc(var(--u)*.6)">분야·영역별 정답률</div>';
  if(hasOld) h+='<div class="note" style="margin-bottom:calc(var(--u)*.8)">출제 목록이 저장되기 전의 옛 기록은 이 표에 포함되지 않습니다.</div>';
  if(!subs.length) return h+'<div class="sub">집계할 수 있는 회차가 아직 없습니다. 새로 푼 회차부터 표시됩니다.</div></div>';
  h+='<div class="note" style="margin-bottom:calc(var(--u)*.8)">분야 이름을 누르면 영역이 펼쳐지고, %를 누르면 그 문제들이 나옵니다.</div>';
  h+='<div class="accwrap"><table class="acc"><tr><th class="sn">분야 · 영역 <button class="sec acc-all" id="acc-all">모두 펼치기/접기</button></th>'+cols.map(c=>'<th'+(c.id==='all'?' class="av"':'')+'>'+c.name+'</th>').join('')+'</tr>';
  const fieldsOf=s=>[...new Set(Object.keys(keys).filter(k=>k.startsWith(s+'|')&&k.split('|').length===2).map(k=>k.split('|')[1]))].sort((x,y)=>ordF(s,x)-ordF(s,y));
  const areasOf=(s,f)=>[...new Set(Object.keys(keys).filter(k=>k.startsWith(s+'|'+f+'|')).map(k=>k.split('|')[2]))].sort((x,y)=>ordA(s,f,x)-ordA(s,f,y));
  subs.forEach(s=>{
    h+='<tr class="rs"><td class="sn">'+s+'</td>'+cols.map(c=>'<td'+(c.id==='all'?' class="av"':'')+'>'+accCell(c.st[s])+'</td>').join('')+'</tr>';
    fieldsOf(s).forEach(f=>{ const fk=s+'|'+f, open=!!accOpen[fk];
      h+='<tr class="rf" data-k="'+esc(fk)+'"><td class="sn nm">'+(open?'▾ ':'▸ ')+esc(f)+'</td>'+cols.map(c=>vcell(c,fk)).join('')+'</tr>';
      if(open) areasOf(s,f).forEach(x=>{ const ak=fk+'|'+x; h+='<tr class="ra"><td class="sn">'+esc(x)+'</td>'+cols.map(c=>vcell(c,ak)).join('')+'</tr>'; });
    });
  });
  return h+'</table></div><div class="accsl"><span>◀</span><input type="range" id="acc-slider" min="0" max="0" value="0"><span>▶</span></div><div class="note" style="margin-top:calc(var(--u)*.8)">%는 맞힌 수 ÷ 출제된 문항 수입니다(안 푼 문제는 오답). 전체 평균은 모든 회차의 맞힌 수를 합쳐 계산합니다.</div></div>';
}
function accFor(){
  const sel=selRecs(), all=sel.filter(r=>r.qs&&r.qs.length), hasOld=sel.some(r=>!(r.qs&&r.qs.length));
  const tot={}; all.forEach(r=>{ const s=recStats(r); Object.keys(s).forEach(k=>{ const v=tot[k]=tot[k]||{c:0,t:0}; v.c+=s[k].c; v.t+=s[k].t; }); });
  const mk=r=>({id:r.no,name:(r.real?'국시 '+r.real+'회':r.no+'회차')+'<div class="note">'+r.period+'교시</div>',st:recStats(r)});
  const cols=[{id:'all',name:avgName(),st:tot}].concat(all.map(mk));
  if(sel.length===1&&hasOld) return '<div class="card" style="margin-bottom:calc(var(--u)*1.6)"><div style="font-weight:800;font-size:calc(var(--u)*2.3);margin-bottom:calc(var(--u)*.6)">분야·영역별 정답률</div><div class="note">이 회차는 출제 목록이 저장되기 전 기록이라 이 회차의 분야·영역별 정답률은 알 수 없습니다.</div></div>';
  return accPanel(cols,hasOld);
}
function keyMatch(q,key){ const qk=q.subj+'|'+q.field+'|'+q.area; return qk===key||qk.startsWith(key+'|'); }
function cellEntries(col,key){
  const m={}, order=[];
  selRecs().filter(r=>r.qs&&r.qs.length&&(col==='all'||r.no===+col)).forEach(r=>recMap(r).forEach(e=>{ if(keyMatch(byId[e.id],key)){ if(!m[e.id]){m[e.id]=[];order.push(e.id);} m[e.id].push(e);} }));
  return order.map(id=>({q:byId[id],es:m[id]}));
}
function renderCell(){
  const body=$('rec-body'), cs=cellState, cnts=wrongCounts();
  let items=cellEntries(cs.col,cs.key);
  const tot=items.reduce((a,x)=>a+x.es.length,0), okc=items.reduce((a,x)=>a+x.es.filter(e=>e.ok).length,0);
  if(cs.col==='all') items.sort((a,b)=>Q.indexOf(a.q)-Q.indexOf(b.q)); else items.sort((a,b)=>a.es[0].i-b.es[0].i);
  const nWrong=items.filter(x=>x.es.some(e=>!e.ok)).length;
  const list=items.filter(x=>fm(cs.mode,x.es));
  const title=(cs.col==='all'?avgName():lab(U.records.find(r=>r.no===+cs.col)||{no:cs.col}))+' · '+cs.key.split('|').slice(1).join(' › ')+' · '+pct(okc,tot)+'% ('+okc+'/'+tot+')';
  let h='<div class="chips"><button class="sec" id="cell-back">← 표로 돌아가기</button></div>'+fchips('cm',cs.mode,items.map(x=>x.es),cs.col==='all')+'<div class="sechd">'+esc(title)+'</div>';
  if(!list.length) h+='<div class="card">해당하는 문제가 없습니다.</div>';
  list.forEach(x=>{ h+=qCard(x.q,x.es,{count:(cnts[x.q.id]||[]).length,showWhich:cs.col==='all'}); });
  body.innerHTML=h; body.scrollTop=0;
}
function renderWrong(){
  if(cellState) return renderCell();
  const R=RS(), cnts=wrongCounts(), body=$('rec-body');
  const S=selRecs(), isSel=r=>wSel===null||wSel.has(r.no);
  let h=tabsHtml()+'<div class="chips"><button class="act" data-f="on">전체 선택</button><button class="act" data-f="off">선택 해제</button>'+R.map(r=>'<button data-f="'+r.no+'" class="'+(isSel(r)?'on':'')+'">'+(r.real?'국시 '+r.real+'회':r.no+'회차')+'·'+r.period+'교시</button>').join('')+'<button class="sec" id="wb-back" style="margin-left:auto">기록으로</button></div>';
  if(R.length&&!S.length){
    h+='<div class="card" style="text-align:center;padding:calc(var(--u)*4)"><div style="font-weight:800;font-size:calc(var(--u)*2.2)">회차를 하나 이상 골라 주세요</div><div class="note" style="margin-top:calc(var(--u)*.6)">위의 회차 버튼을 누르면 선택됩니다. "전체 선택"을 누르면 모든 회차를 봅니다.</div></div>';
    body.innerHTML=h; body.scrollTop=0; $('wb-back').onclick=()=>{recView='main'; cellState=null; renderRecords();}; return;
  }
  h+=accFor();
  if(S.length!==1){
    const m={}; S.forEach(r=>recMap(r).forEach(e=>{(m[e.id]=m[e.id]||[]).push(e);}));
    const cand=Object.keys(m).map(id=>({id:id,es:m[id],w:m[id].filter(e=>!e.ok).length,f:m[id].filter(e=>e.fl).length}));
    const nW=cand.filter(x=>x.w).length, nRep=cand.filter(x=>x.w>=2).length, nF=cand.filter(x=>x.f).length;
    const list=cand.filter(x=>fm(wrongMode,x.es)).sort((a,b)=>b.w-a.w||b.f-a.f||Q.indexOf(byId[a.id])-Q.indexOf(byId[b.id]));
    h+=fchips('wm',wrongMode,cand.map(x=>x.es),true);
    h+='<div class="sechd">'+(allSel()?'전체 회차':'선택한 회차 '+S.length+'개')+' · 틀린 문제 '+nW+'개 · 2번 이상 틀린 문제 '+nRep+'개 · 다시 확인 '+nF+'개</div>';
    if(!list.length) h+='<div class="card">해당하는 문제가 없습니다.</div>';
    list.forEach(x=>{ h+=qCard(byId[x.id],x.es,{count:x.w,showWhich:true}); });
  } else {
    const r=S[0];
    const cand=recMap(r), nW=cand.filter(e=>!e.ok).length, nF=cand.filter(e=>e.fl).length;
    if(wrongMode==='many') wrongMode='all';
    const list=cand.filter(e=>fm(wrongMode,[e]));
    h+=fchips('wm',wrongMode,cand.map(e=>[e]));
    h+='<div class="sechd">'+lab(r)+' · '+r.period+'교시 틀린 문제 '+nW+'개 · 다시 확인 '+nF+'개</div>';
    if(!list.length) h+='<div class="card">해당하는 문제가 없습니다.</div>';
    list.forEach(e=>{ h+=qCard(byId[e.id],[e],{count:(cnts[e.id]||[]).length}); });
  }
  body.innerHTML=h; body.scrollTop=0; setupAccSlider();
  $('wb-back').onclick=()=>{recView='main'; cellState=null; renderRecords();};
}
$('rec-body').addEventListener('click',ev=>{
  const body=$('rec-body'), keep=fn=>{ const st=body.scrollTop, w=body.querySelector('.accwrap'), sl=w?w.scrollLeft:0; fn(); body.scrollTop=st; const w2=body.querySelector('.accwrap'); if(w2){ w2.scrollLeft=sl; const r=document.getElementById('acc-slider'); if(r) r.value=sl; } };
  const nm=ev.target.closest('td.nm'); if(nm){ const k=nm.parentNode.dataset.k; keep(()=>{ accOpen[k]=!accOpen[k]; renderWrong(); }); return; }
  const vc=ev.target.closest('td.v'); if(vc){ accScroll=body.scrollTop; cellState={col:vc.dataset.c,key:vc.dataset.k,mode:'all'}; renderWrong(); return; }
  if(ev.target.closest('#acc-all')){ const ks=[...body.querySelectorAll('tr.rf')].map(t=>t.dataset.k); const anyClosed=ks.some(k=>!accOpen[k]); ks.forEach(k=>accOpen[k]=anyClosed); keep(renderWrong); return; }
  const wm=ev.target.closest('[data-wm]'); if(wm){ wrongMode=wm.dataset.wm; keep(renderWrong); return; }
  const cm=ev.target.closest('[data-cm]'); if(cm&&cellState){ cellState.mode=cm.dataset.cm; keep(renderCell); return; }
  if(ev.target.closest('#cell-back')){ cellState=null; renderWrong(); body.scrollTop=accScroll; }
});

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
function showAdmin(){ show('s-admin'); renderStu(); adminLog('현재 이 기기에 불러온 문제: '+Q.length+'문항'); $('adm-out').value=''; }
$('adm-back').onclick=()=>showHome();
const STU_DEF=['2426048','2426047','2426040','2426004','2426067','2426039','2426066','2426023','2426033'];
function stuList(){ const l=lsGet('ptq2:adm:list'); return Array.isArray(l)&&l.length?l:STU_DEF.slice(); }
let stuData={};
function exitView(){ viewing=null; if(adminU){ U=adminU; adminU=null; } recTab='mock'; show('s-admin'); renderStu(); }
async function loadStu(){
  const list=stuList(); $('stu-out').innerHTML='<div class="small">불러오는 중…</div>'; stuData={};
  await Promise.all(list.map(async id=>{
    try{ const u=await T(DB.getUser(id),10000); const r=await T(DB.getRecords(id),10000); stuData[id]={u:u||{},r:r||[],ok:true,had:!!u||(r&&r.length>0)}; }
    catch(e){ stuData[id]={ok:false,err:(e&&(e.code||e.message))||String(e)}; }
  }));
  renderStu();
}
function renderStu(){
  const list=stuList(); $('stu-ids').value=list.join(' ');
  let h='<table><tr><th style="text-align:left">학번</th><th>마지막 활동</th><th>모의시험</th><th>국가고시</th><th style="text-align:left">진행 중인 시험</th><th></th></tr>';
  list.forEach(id=>{ const d=stuData[id];
    if(!d){ h+='<tr><td class="sn">'+esc(id)+'</td><td colspan="5">아직 불러오지 않았습니다.</td></tr>'; return; }
    if(!d.ok){ h+='<tr><td class="sn">'+esc(id)+'</td><td colspan="5">불러오지 못했습니다 ('+esc(d.err)+')</td></tr>'; return; }
    const rs=d.r, mock=rs.filter(r=>!r.real).length, real=rs.filter(r=>r.real).length;
    const last=Math.max(d.u.examAt?Date.parse(d.u.examAt)||0:0,...rs.map(r=>Date.parse(r.at)||0));
    const ex=d.u.exam; let exs='-';
    if(ex) exs=(ex.real?'국가고시 '+ex.real+'회 ':'')+ex.period+'교시 · 푼 '+Object.keys(ex.ans||{}).length+'/'+(ex.qids||[]).length+' · 남은 '+fmtTime(ex.remaining||0)+(ex.paused?' (멈춤)':'')+' · 저장 '+fmtDate(d.u.examAt||ex.startedAt);
    h+='<tr><td class="sn">'+esc(id)+'</td><td>'+(last?fmtDate(new Date(last).toISOString()):(d.had?'-':'기록 없음'))+'</td><td>'+mock+'회</td><td>'+real+'회</td><td style="text-align:left">'+esc(exs)+'</td><td><button class="sec" data-sv="'+esc(id)+'">기록 보기</button></td></tr>';
  });
  $('stu-out').innerHTML=h+'</table>';
}
$('stu-load').onclick=loadStu;
$('stu-save').onclick=()=>{ const l=[...new Set($('stu-ids').value.split(/[\s,]+/).filter(x=>/^[0-9]{7}$/.test(x)))]; lsSet('ptq2:adm:list',l.length?l:STU_DEF); renderStu(); };
$('stu-out').addEventListener('click',ev=>{
  const b=ev.target.closest('[data-sv]'); if(!b) return; const id=b.dataset.sv, d=stuData[id]; if(!d||!d.ok) return;
  adminU=U; viewing=id;
  U=Object.assign(fresh(),{records:d.r.map(r=>Object.assign({wrong:[]},r)).sort((a,b)=>a.no-b.no),nextNo:1,exam:null});
  recTab='mock'; wSel=null; wrongMode='all'; cellState=null; showRecords();
});
$('adm-up').onclick=()=>{ const f=$('adm-file').files[0]; if(!f){ adminLog('문제 데이터 파일(questions_upload.json)을 먼저 선택해 주세요.'); return; }
  const rd=new FileReader(); rd.onload=async()=>{
    try{
      const data=JSON.parse(rd.result);
      if(!data.items||!data.quota||!data.version||data.items.length<1) throw new Error('파일 형식이 올바르지 않습니다.');
      adminLog('올리는 중… ('+data.items.length+'문항)');
      await T(DB.adminWriteQuestions(data),60000);
      lsSet('ptq2:q',null); adminLog('올리기 완료: '+data.items.length+'문항. 서버에서 다시 불러오는 중…');
      const ok=await ensureQuestions();
      adminLog(ok?('올리기 완료: '+data.items.length+'문항, 버전 '+data.version+'\n서버에서 읽기 확인까지 성공했습니다. 홈으로 가면 모의 시험을 쓸 수 있습니다.'):('올리기는 끝났지만 다시 읽지 못했습니다.\n'+qErr));
    }catch(e){ adminLog('올리지 못했습니다: '+(e&&(e.code||e.message)||e)); }
  }; rd.readAsText(f,'utf-8'); };
$('adm-chk').onclick=async()=>{
  adminLog('서버 확인 중…'); let m='';
  try{ const meta=await T(DB.getMeta(),20000); m='문제 정보: '+(meta?JSON.stringify(meta):'없음'); }catch(e){ m='문제 정보 읽기 오류: '+((e&&(e.code||e.message))||e); }
  adminLog(m+'\n이 기기에 불러온 문제: '+Q.length+'문항'+(qErr?'\n마지막 오류: '+qErr:''));
};
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
  const noQ=!Q.length; $('h-exam').disabled=noQ; $('h-real').disabled=noQ; $('h-quiz').disabled=noQ; $('h-rec').disabled=noQ;
  $('home-note').textContent=noQ?('문제 데이터를 불러오지 못했습니다. '+(qErr?'['+qErr+']':'')):(syncOK?'':'서버에 연결되지 않아 이 기기에만 저장 중입니다. 연결되면 자동으로 올라갑니다.');
  const ex=U&&U.exam; $('home-resume').style.display=ex?'block':'none';
  if(ex) $('home-resume-t').textContent='진행 중인 시험: '+(ex.real?'국가고시 '+ex.real+'회 ':'')+ex.period+'교시 · 남은 시간 '+fmtTime(ex.remaining)+' · 푼 문제 '+Object.keys(ex.ans).length+'/'+ex.qids.length;
  retryPending();
}
function startNew(period,real){
  const go=()=>{ U.exam=null; startExam(real?buildReal(real,period):buildExam(period)); };
  if(U.exam){ modal('진행 중인 시험이 있습니다.\n새로 시작하면 진행 중인 시험은 사라집니다.',[['취소','sec'],['새로 시작','warn',go]]); }
  else go();
}
$('h-exam').onclick=()=>show('s-pick');
function renderReal(){
  const rounds=[...new Set(Q.map(q=>parseInt(q.id)))].sort((a,b)=>a-b);
  const best=(rd,p)=>{ const rs=U.records.filter(r=>r.real===rd&&r.period===p); if(!rs.length) return '아직 안 풂'; const l=rs[rs.length-1]; return '최근 '+l.correct+'/'+l.total+' ('+pct(l.correct,l.total)+'%) · '+rs.length+'회 응시'; };
  let h='';
  rounds.forEach(rd=>{ h+='<div class="card rcard"><h2>'+rd+'회</h2>';
    [1,2].forEach(p=>{ const n=realQids(rd,p).length; h+='<div class="rp"><button class="bigbtn" data-real="'+rd+'" data-rp="'+p+'">'+p+'교시</button><div class="note">'+n+'문항 · '+PERIODS[p].min+'분<br>'+best(rd,p)+'</div></div>'; });
    h+='</div>'; });
  $('real-list').innerHTML=h;
}
$('h-real').onclick=()=>{ renderReal(); show('s-real'); };
$('real-back').onclick=showHome;
$('real-list').addEventListener('click',ev=>{ const b=ev.target.closest('[data-real]'); if(b) startNew(+b.dataset.rp,+b.dataset.real); });
$('h-rec').onclick=()=>{ recTab='mock'; showRecords(); };
$('h-logout').onclick=logout;
$('h-pw').onclick=()=>{ $('pw-msg').textContent=''; show('s-pw'); };
$('h-admin').onclick=showAdmin;
document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>startNew(+b.dataset.p));
document.querySelector('[data-back]').onclick=showHome;
$('resume-go').onclick=()=>{ const ex=U.exam; ex.paused=true; startExam(ex); };
$('resume-drop').onclick=()=>modal('진행 중인 시험을 포기할까요?\n기록에는 남지 않습니다.',[['취소','sec'],['포기','warn',()=>{U.exam=null; U.examAt=nowIso(); E=null; saveLocal(); lastPush=0; pushExam(); showHome();}]]);

/* ---------- 과목별 퀴즈 (해설은 여기서만 보임 · 기록 저장 안 함) ---------- */
const SUBJS=['기초','진단평가','중재','법규'];
let X=null, QZ=null, qsSel=new Set();
async function ensureExpl(){
  if(X) return true;
  const cache=lsGet('ptq2:x'); let meta=null, off=false;
  if(!DB.getExplMeta) { if(cache){X=cache.items; return true;} return false; }
  try{ meta=await T(DB.getExplMeta(),15000); }catch(e){ off=true; }
  if(cache&&(off||(meta&&cache.version===meta.version))){ X=cache.items; return true; }
  if(meta){ try{ const d=await T(DB.getExpl(),30000); if(d&&d.items&&Object.keys(d.items).length){ lsSet('ptq2:x',d); X=d.items; return true; } }catch(e){} }
  if(cache){ X=cache.items; return true; }
  return false;
}
const akey=q=>q.subj+'|'+q.field+'|'+q.area;
function quizTree(){
  const t={};
  Q.forEach(q=>{ ((t[q.subj]=t[q.subj]||{})[q.field]=t[q.subj][q.field]||{})[q.area]=(t[q.subj][q.field][q.area]||0)+1; });
  return SUBJS.filter(s=>t[s]).map(s=>({s,fields:Object.keys(t[s]).sort((a,b)=>ordF(s,a)-ordF(s,b)).map(f=>({f,areas:Object.keys(t[s][f]).sort((a,b)=>ordA(s,f,a)-ordA(s,f,b)).map(a=>({a,n:t[s][f][a],k:s+'|'+f+'|'+a}))}))}));
}
function renderQsel(){
  let h='';
  quizTree().forEach(S=>{
    const all=S.fields.flatMap(F=>F.areas), on=all.every(A=>qsSel.has(A.k));
    h+='<div class="card qs-subj"><h2>'+esc(S.s)+' <button class="qs-all'+(on?' on':'')+'" data-ks="'+esc(all.map(A=>A.k).join('\n'))+'">과목 전체</button><span class="note">'+all.reduce((x,A)=>x+A.n,0)+'문항</span></h2>';
    S.fields.forEach(F=>{ const fon=F.areas.every(A=>qsSel.has(A.k));
      h+='<div class="qs-fld"><div class="sechd">'+esc(F.f)+' <button class="qs-all'+(fon?' on':'')+'" data-ks="'+esc(F.areas.map(A=>A.k).join('\n'))+'">분야 전체</button></div><div class="chips">';
      F.areas.forEach(A=>{ h+='<button class="'+(qsSel.has(A.k)?'on':'')+'" data-k="'+esc(A.k)+'">'+esc(A.a)+'<span class="c">'+A.n+'</span></button>'; });
      h+='</div></div>'; });
    h+='</div>';
  });
  const st=$('qs-body').scrollTop; $('qs-body').innerHTML=h; $('qs-body').scrollTop=st;
  const n=Q.filter(q=>qsSel.has(akey(q))).length;
  $('qs-cnt').textContent=qsSel.size?('영역 '+qsSel.size+'개 · '+n+'문항 (무작위 순서)'):'풀고 싶은 분야나 영역을 고르세요 (여러 개 가능)';
  $('qs-go').disabled=!n;
}
$('qs-body').addEventListener('click',ev=>{
  const g=ev.target.closest('[data-ks]'), b=ev.target.closest('[data-k]');
  if(g){ const ks=g.dataset.ks.split('\n'), on=ks.every(k=>qsSel.has(k)); ks.forEach(k=>on?qsSel.delete(k):qsSel.add(k)); renderQsel(); }
  else if(b){ const k=b.dataset.k; qsSel.has(k)?qsSel.delete(k):qsSel.add(k); renderQsel(); }
});
$('qs-clear').onclick=()=>{ qsSel.clear(); renderQsel(); };
$('qs-back').onclick=showHome;
$('qs-go').onclick=()=>startQuiz(Q.filter(q=>qsSel.has(akey(q))).map(q=>q.id),'선택한 영역');
async function openQuiz(){
  if(!X){ loading('해설을 불러오는 중…'); const ok=await ensureExpl(); if(!ok) modal('해설 데이터를 불러오지 못했습니다.\n문제와 정답은 풀 수 있지만 해설은 보이지 않습니다.',[['확인','ok']]); }
  show('s-qsel'); renderQsel(); $('qs-body').scrollTop=0;
}
$('h-quiz').onclick=openQuiz;
function startQuiz(ids,name){
  QZ={ids:shuffle(ids),i:0,sel:null,checked:false,log:[],name};
  show('s-quiz'); renderQuiz();
}
function xpInner(q){
  const x=X&&X[q.id];
  if(!x) return '<p class="note">'+(X?'이 문제의 해설이 없습니다.':'해설을 불러오지 못했습니다. 인터넷에 연결한 뒤 다시 눌러 주세요.')+'</p>';
  let h='<div>'+x.kw.map(k=>'<span class="kw">'+esc(k)+'</span>').join('')+'</div>';
  h+='<p><span class="xl">해설</span>'+esc(x.why)+'</p>';
  if(x.trap) h+='<p><span class="xl">함정</span>'+esc(x.trap)+'</p>';
  if(x.ref) h+='<p class="ref">'+esc(x.ref)+'</p>';
  return h;
}
/* 결과·기록 카드의 해설 (제출 후에만 · 시험 도중에는 없음) */
let xAll=false, xLoading=null; const xOpen=new Set();
function preloadExpl(){ if(!X&&!xLoading) xLoading=ensureExpl().catch(()=>false).finally(()=>{xLoading=null;}); return xLoading||Promise.resolve(!!X); }
function xAllBtn(){ return '<button class="sec xall" style="margin-left:auto">'+(xAll?'해설 모두 접기':'해설 모두 펼치기')+'</button>'; }
function xpBlock(q){ const open=xAll||xOpen.has(q.id); return '<div class="xpw" data-x="'+esc(q.id)+'"><button class="sec xbtn">'+(open?'해설 접기':'해설 보기')+'</button><div class="xp2"'+(open?'':' hidden')+'>'+(open?xpInner(q):'')+'</div></div>'; }
function setXp(w,open){ const c=w.querySelector('.xp2'), id=w.dataset.x; if(open){ c.innerHTML=xpInner(byId[id]); c.hidden=false; xOpen.add(id); } else { c.hidden=true; xOpen.delete(id); } w.querySelector('.xbtn').textContent=open?'해설 접기':'해설 보기'; }
document.addEventListener('click',async ev=>{
  const b=ev.target.closest('.xbtn'), a=ev.target.closest('.xall'); if(!b&&!a) return;
  const root=(b||a).closest('.scroll'), w=b&&b.closest('.xpw'), wasOpen=w&&!w.querySelector('.xp2').hidden;
  if(!X){ (b||a).disabled=true; await preloadExpl(); (b||a).disabled=false; if(w&&wasOpen&&X){ setXp(w,true); return; } }
  if(w){ setXp(w,!wasOpen); return; }
  xAll=!xAll; xOpen.clear(); root.querySelectorAll('.xpw').forEach(w=>setXp(w,xAll)); root.querySelectorAll('.xall').forEach(x=>x.textContent=xAll?'해설 모두 접기':'해설 모두 펼치기');
});
function xpHtml(q,ok){
  let h='<div class="xp '+(ok?'ok':'bad')+'"><div class="xv">'+(ok?'정답입니다':'오답입니다 · 정답 '+'①②③④⑤'[q.ans])+'</div>'+xpInner(q);
  h+='<div class="note">개념정리본 '+pgLabel(q)+(q.subj==='법규'?' · 문제와 정답은 기출 당시 기준':'')+'</div></div>';
  return h;
}
function renderQuiz(){
  const q=byId[QZ.ids[QZ.i]], n=QZ.i+1, done=QZ.checked;
  $('qz-title').innerHTML='과목별 퀴즈 · <b>'+n+'</b> / '+QZ.ids.length+'<span class="src">기출 '+esc(q.id)+'</span>';
  const c=QZ.log.filter(e=>e.ok).length; $('qz-score').textContent='맞힘 '+c+' / '+QZ.log.length;
  let h='<div class="qmeta">'+esc(q.subj)+' · '+esc(q.field)+' · '+esc(q.area)+'</div><div class="stem">'+stemHtml(q.stem)+'</div>';
  q.opts.forEach((o,i)=>{ let cl='opt';
    if(done){ cl+=' done'; if(i===q.ans) cl+=' r'; else if(i===QZ.sel) cl+=' w'; }
    else if(QZ.sel===i) cl+=' sel';
    h+='<div class="'+cl+'" data-i="'+i+'"><span class="n">'+'①②③④⑤'[i]+'</span><span>'+esc(o)+'</span></div>'; });
  if(done) h+=xpHtml(q,QZ.sel===q.ans);
  const qb=$('qz-body'); qb.innerHTML=h; qb.scrollTop=0;
  const last=QZ.i===QZ.ids.length-1, b=$('qz-go');
  if(!done){ b.textContent='정답 확인'; b.className=''; b.disabled=QZ.sel===null; }
  else { b.textContent=last?'결과 보기':'다음'; b.className='ok'; b.disabled=false; }
  $('qz-cnt').textContent=done?'':'답을 고른 뒤 "정답 확인"을 누르세요';
}
$('qz-body').addEventListener('click',ev=>{
  const o=ev.target.closest('.opt'); if(!o||!QZ||QZ.checked) return; const i=+o.dataset.i;
  QZ.sel=(QZ.sel===i)?null:i; renderQuiz();
});
$('qz-go').onclick=()=>{
  if(!QZ) return; const q=byId[QZ.ids[QZ.i]];
  if(!QZ.checked){ if(QZ.sel===null) return; QZ.checked=true; QZ.log.push({id:q.id,ok:QZ.sel===q.ans}); renderQuiz(); const xp=$('qz-body').querySelector('.xp'); if(xp) xp.scrollIntoView({block:'nearest'}); return; }
  if(QZ.i<QZ.ids.length-1){ QZ.i++; QZ.sel=null; QZ.checked=false; renderQuiz(); } else showQres();
};
$('qz-stop').onclick=()=>modal('여기까지 풀고 결과를 볼까요?\n'+(QZ.checked?'':'지금 문제는 정답 확인 전이라 결과에 들어가지 않습니다.\n')+'결과는 저장되지 않습니다.',[['계속 풀기','sec'],['결과 보기','ok',showQres]]);
function showQres(){
  const L=QZ.log, c=L.filter(e=>e.ok).length, t=L.length;
  let h='<div class="card" style="margin-bottom:calc(var(--u)*1.6)"><div style="font-size:calc(var(--u)*2.6);font-weight:800">점수 '+c+' / '+t+' · 정답률 '+pct(c,t)+'%</div>'
    +'<div class="note" style="margin-top:calc(var(--u)*.6)">'+esc(QZ.name)+' · 전체 '+QZ.ids.length+'문항 중 '+t+'문항 풂 · 이 결과는 저장되지 않습니다.</div></div>';
  if(!t) h+='<div class="card">푼 문제가 없습니다.</div>';
  else{
    const W=L.filter(e=>!e.ok).map(e=>byId[e.id]), G={};
    W.forEach(q=>{ (G[akey(q)]=G[akey(q)]||[]).push(q); });
    const per={}; L.forEach(e=>{ const k=akey(byId[e.id]); per[k]=per[k]||[0,0]; per[k][1]++; if(e.ok) per[k][0]++; });
    const keys=Object.keys(G).sort((a,b)=>{ const [s1,f1,a1]=a.split('|'), [s2,f2,a2]=b.split('|'); return SUBJS.indexOf(s1)-SUBJS.indexOf(s2)||ordF(s1,f1)-ordF(s2,f2)||ordA(s1,f1,a1)-ordA(s2,f2,a2); });
    h+='<div class="sechd">틀린 문제 '+W.length+'개 · 영역별</div>';
    if(!keys.length) h+='<div class="card">틀린 문제가 없습니다.</div>';
    keys.forEach(k=>{ const [s,f,a]=k.split('|'), n=Q.filter(q=>akey(q)===k).length;
      h+='<div class="qa"><div class="hd"><div><b>'+esc(a)+'</b> <span class="note">'+esc(s)+' · '+esc(f)+' · 이번에 '+per[k][0]+'/'+per[k][1]+' 맞힘</span></div><button data-ra="'+esc(k)+'">이 영역 전체 다시 풀기 ('+n+'문항)</button></div>';
      G[k].forEach(q=>{ const x=X&&X[q.id], st=stemLead(q.stem);
        h+='<div class="wi"><div class="s"><span class="src" style="margin-left:0">기출 '+esc(q.id)+'</span> '+esc(st.length>60?st.slice(0,60)+'…':st)+'</div>'+(x?x.kw.map(w=>'<span class="kw">'+esc(w)+'</span>').join(''):'')+'</div>'; });
      h+='</div>'; });
  }
  $('qr-body').innerHTML=h; show('s-qres'); $('qr-body').scrollTop=0;
}
$('qr-body').addEventListener('click',ev=>{ const b=ev.target.closest('[data-ra]'); if(!b) return; const k=b.dataset.ra; startQuiz(Q.filter(q=>akey(q)===k).map(q=>q.id),k.split('|')[2]+' 전체 다시 풀기'); });
$('qr-again').onclick=()=>{ QZ=null; show('s-qsel'); renderQsel(); };
$('qr-home').onclick=()=>{ QZ=null; showHome(); };

/* ---------- 관리자: 해설 업로드 ---------- */
$('adm-eup').onclick=async()=>{
  const f=$('adm-efile').files[0]; if(!f){ adminLog('explanations_upload.json 파일을 먼저 골라 주세요.'); return; }
  if(!Q.length){ adminLog('문제 데이터가 없습니다. 문제 데이터를 먼저 올려 주세요.'); return; }
  let d; try{ d=JSON.parse(await f.text()); }catch(e){ adminLog('파일을 읽지 못했습니다: '+e.message); return; }
  if(!d||!d.version||!d.items||typeof d.items!=='object'){ adminLog('해설 파일 형식이 아닙니다 (version, items 필요).'); return; }
  const by={}, unknown=[];
  Object.keys(d.items).forEach(id=>{ const q=byId[id], x=d.items[id]; if(!q){ unknown.push(id); return; }
    const o={id,kw:x.kw||[],why:x.why||'',trap:x.trap||''}; if(x.ref) o.ref=x.ref; (by[q.subj]=by[q.subj]||[]).push(o); });
  const n=Object.values(by).reduce((s,a)=>s+a.length,0), miss=Q.filter(q=>!d.items[q.id]).length;
  adminLog('해설 올리는 중… ('+n+'개)');
  try{ await DB.adminWriteExpl({version:d.version,by,count:n}); X=null; lsSet('ptq2:x',null);
    adminLog('해설 올리기 완료: '+n+'개 · 버전 '+d.version+(miss?'\n해설 없는 문제: '+miss+'개':'')+(unknown.length?'\n문제 데이터에 없는 번호(건너뜀): '+unknown.length+'개 '+unknown.slice(0,5).join(', '):''));
  }catch(e){ adminLog('해설 올리기 실패: '+((e&&(e.code||e.message))||e)); }
};
$('adm-echk').onclick=async()=>{ try{ const m=await T(DB.getExplMeta(),15000); adminLog(m?('서버 해설: '+m.count+'개 · 버전 '+m.version):'서버에 해설 데이터가 아직 없습니다.'); }catch(e){ adminLog('확인 실패: '+((e&&(e.code||e.message))||e)); } };

/* ---------- Firebase 연결 ---------- */
async function makeFirebaseDB(cfg){
  const base='https://www.gstatic.com/firebasejs/10.14.1/';
  const [A,Au,F]=await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js'),import(base+'firebase-firestore.js')]);
  const app=A.initializeApp(cfg), auth=Au.getAuth(app), fs=F.initializeFirestore(app,{experimentalAutoDetectLongPolling:true});
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
    async getExplMeta(){ const d=await F.getDoc(F.doc(fs,'questions','expl_meta')); return d.exists()?d.data():null; },
    async getExpl(){
      const meta=(await F.getDoc(F.doc(fs,'questions','expl_meta'))).data(); const items={};
      for(const s of SUBJ){ const d=await F.getDoc(F.doc(fs,'questions','expl_'+s)); if(d.exists()) d.data().items.forEach(o=>{ const {id,...r}=o; items[id]=r; }); }
      return {version:meta.version,items};
    },
    async adminWriteExpl(d){
      for(const s of Object.keys(d.by)) await F.setDoc(F.doc(fs,'questions','expl_'+s),{items:clean(d.by[s])});
      await F.setDoc(F.doc(fs,'questions','expl_meta'),{version:d.version,count:d.count});
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
