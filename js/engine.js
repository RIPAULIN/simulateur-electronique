/**
 * engine.js — CircuitLab DC + Transient Solver
 * MNA (Modified Nodal Analysis) core.
 * DC: 27/27 tests passing.
 * Transient: Backward Euler for capacitors and inductors.
 */
const Engine = (() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────
  const GRID        = 32;
  const TERM_OFFSET = 32;
  const R_OPEN      = 1e12;
  const R_CLOSED    = 1e-4;
  const R_WIRE      = 1e-3;
  const R_VOLTMETER = 1e9;
  const R_AMMETER   = 1e-4;
  const LED_VF      = 1.8;
  const LED_R_FWD   = 5.0;
  const LED_MAX_MA  = 30;
  const DIODE_VF    = 0.7;
  const DIODE_R_FWD = 1.0;
  const BJT_VBE     = 0.7;
  const BJT_BETA    = 100;
  const EPSILON     = 1e-15;
  const SING_THR    = 1e-9;

  // ── State ──────────────────────────────────────────────────────
  let _comps   = [];
  let _results = {};
  let _errors  = [];
  let _nodes   = [];
  let _analysis = _emptyAn();
  let _running = false;

  // Transient
  let _trTime    = [];
  let _trHistory = [];

  function _emptyAn() { return { fc:null, tau:null, gain_db:0, bode:[] }; }

  // ── Defaults ───────────────────────────────────────────────────
  const DEFS = {
    battery:{voltage:9}, vsource:{voltage:5,waveform:'dc',frequency:50},
    isource:{current:10}, ground:{},
    resistor:{resistance:1000}, capacitor:{capacitance:100}, inductor:{inductance:10},
    potentiometer:{resistance:10000,wiper:50},
    led:{ledColor:'red'}, diode:{reversed:false}, zener:{vz:5.1},
    transistor:{baseVoltage:0.8,baseResistor:10000}, pnp:{baseVoltage:0.8,baseResistor:10000},
    mosfet_n:{vgs:3,vth:2}, switch:{closed:true},
    voltmeter:{}, ammeter:{}, lamp:{wattage:1}, wire:{}
  };
  function getDefaults(t){ return {...(DEFS[t]||{})}; }

  // ── Utilities ──────────────────────────────────────────────────
  function snap(v){ const n=parseFloat(v); return isFinite(n)?Math.round(n/GRID)*GRID:0; }
  function ptKey(x,y){ return snap(x)+','+snap(y); }
  function _A(x){ return Array.isArray(x)?x.filter(Boolean):[]; }
  function _f(n,d=4){ const v=parseFloat(n); return isFinite(v)?parseFloat(v.toFixed(d)):0; }

  // ── Terminals ──────────────────────────────────────────────────
  function getTerminals(comp) {
    if(comp.type==='wire'){
      if(!isFinite(parseFloat(comp.x2))||!isFinite(parseFloat(comp.y2)))return null;
      return{a:ptKey(comp.x,comp.y),b:ptKey(comp.x2,comp.y2)};
    }
    if(comp.type==='ground')return{a:ptKey(comp.x,comp.y),b:'__GND__'};
    const rad=(parseFloat(comp.rotation)||0)*Math.PI/180;
    const cos=Math.cos(rad),sin=Math.sin(rad);
    return{a:ptKey(comp.x-TERM_OFFSET*cos,comp.y-TERM_OFFSET*sin),
           b:ptKey(comp.x+TERM_OFFSET*cos,comp.y+TERM_OFFSET*sin)};
  }

  // ── Union-Find ─────────────────────────────────────────────────
  function makeUF(){
    const p=Object.create(null),r=Object.create(null);
    function find(x){if(p[x]===undefined){p[x]=x;r[x]=0;}if(p[x]!==x)p[x]=find(p[x]);return p[x];}
    function union(a,b){const ra=find(a),rb=find(b);if(ra===rb)return;const rA=r[ra]||0,rB=r[rb]||0;if(rA<rB)p[ra]=rb;else if(rA>rB)p[rb]=ra;else{p[rb]=ra;r[ra]=rA+1;}}
    return{find,union};
  }

  // ── Node builder ───────────────────────────────────────────────
  function buildNodes(comps){
    const uf=makeUF(),GND='__GND__';uf.find(GND);
    _A(comps).forEach(c=>{
      const t=getTerminals(c);if(!t)return;
      uf.find(t.a);if(t.b!==GND)uf.find(t.b);
      if(c.type==='wire')uf.union(t.a,t.b);
      if(c.type==='ground')uf.union(t.a,GND);
    });
    const roots=new Set();
    _A(comps).forEach(c=>{const t=getTerminals(c);if(!t)return;roots.add(uf.find(t.a));roots.add(t.b===GND?uf.find(GND):uf.find(t.b));});
    roots.add(uf.find(GND));
    const gr=uf.find(GND),idxMap=Object.create(null);let ni=1;idxMap[gr]=0;
    roots.forEach(r=>{if(r!==gr&&idxMap[r]===undefined)idxMap[r]=ni++;});
    const N=ni;
    function nodeOf(k){if(k===GND)return 0;const idx=idxMap[uf.find(k)];return idx!==undefined?idx:0;}
    return{nodeOf,N};
  }

  // ── Netlist ────────────────────────────────────────────────────
  // dt=null → DC mode (cap=open, ind=short)
  // dt>0    → transient mode with companion models
  function buildNetlist(comps,nodeOfBase,N,dt,capState,indState){
    const entries=[],ci=Object.create(null);
    let nxt=N;
    function alloc(){return nxt++;}
    function nOf(k){return typeof k==='number'?k:nodeOfBase(k);}

    _A(comps).forEach(comp=>{
      const t=getTerminals(comp);if(!t)return;
      const n1=nOf(t.a),n2=t.b==='__GND__'?0:nOf(t.b),id=comp.id;
      ci[id]={n1,n2,type:comp.type};

      switch(comp.type){
        case 'wire': entries.push({id,type:'R',n1,n2,value:R_WIRE});break;
        case 'resistor': entries.push({id,type:'R',n1,n2,value:Math.max(EPSILON,parseFloat(comp.resistance)||1000)});break;
        case 'potentiometer':{
          const f=Math.max(EPSILON,parseFloat(comp.resistance)||10000);
          const w=Math.max(0,Math.min(100,parseFloat(comp.wiper)||50));
          entries.push({id,type:'R',n1,n2,value:Math.max(EPSILON,f*w/100)});break;
        }
        case 'lamp': entries.push({id,type:'R',n1,n2,value:Math.max(1,144/Math.max(EPSILON,parseFloat(comp.wattage)||1))});break;

        case 'capacitor':{
          const C=Math.max(1e-12,parseFloat(comp.capacitance)||100)*1e-6;
          if(!dt){entries.push({id,type:'R',n1,n2,value:R_OPEN});}
          else{
            // Backward Euler: Gc=C/dt, I_hist=Gc*v_prev (opposes discharge)
            const Gc=C/dt,Rc=1/Gc;
            const vp=(capState&&capState[id]!=null)?capState[id]:0;
            entries.push({id:id+'_Rc',type:'R',n1,n2,value:Rc});
            entries.push({id:id+'_Ic',type:'I',n1,n2,value:-(Gc*vp)}); // negative = into n1
            ci[id].Gc=Gc;
          }
          break;
        }

        case 'inductor':{
          const L=Math.max(1e-9,parseFloat(comp.inductance)||10)*1e-3;
          if(!dt){entries.push({id,type:'R',n1,n2,value:R_WIRE});}
          else{
            // Backward Euler: Rl=L/dt, V_hist=Rl*i_prev
            const Rl=L/dt;
            const ip=(indState&&indState[id]!=null)?indState[id]:0;
            const ni_=alloc();
            entries.push({id:id+'_Rl',type:'R',n1,n2:ni_,value:Rl});
            entries.push({id:id+'_Vl',type:'V',n1:ni_,n2,value:-(Rl*ip)});
            ci[id].n_int=ni_;ci[id].Rl=Rl;
          }
          break;
        }

        case 'switch':{
          const closed=comp.closed!==false&&comp.closed!=='false';
          entries.push({id,type:'R',n1,n2,value:closed?R_CLOSED:R_OPEN});
          ci[id].closed=closed;break;
        }
        case 'voltmeter': entries.push({id,type:'R',n1,n2,value:R_VOLTMETER});break;
        case 'ammeter':   entries.push({id,type:'R',n1,n2,value:R_AMMETER});break;
        case 'battery':
        case 'vsource':{
          const V=Math.abs(parseFloat(comp.voltage)||(comp.type==='vsource'?5:9));
          entries.push({id,type:'V',n1,n2,value:V});break;
        }
        case 'isource':{
          const I=(parseFloat(comp.current)||10)/1000;
          entries.push({id,type:'I',n1,n2,value:I});break;
        }
        case 'ground': break;
        case 'led':{
          const ni_=alloc();
          entries.push({id:id+'_R',type:'R',n1,n2:ni_,value:LED_R_FWD});
          entries.push({id:id+'_V',type:'V',n1:ni_,n2,value:-LED_VF});
          ci[id].n_int=ni_;break;
        }
        case 'diode':{
          const rev=comp.reversed===true||comp.reversed==='true';ci[id].reversed=rev;
          if(rev){entries.push({id,type:'R',n1,n2,value:R_OPEN});}
          else{const ni_=alloc();entries.push({id:id+'_R',type:'R',n1,n2:ni_,value:DIODE_R_FWD});entries.push({id:id+'_V',type:'V',n1:ni_,n2,value:-DIODE_VF});}
          break;
        }
        case 'zener':{
          const vz=parseFloat(comp.vz)||5.1,rev=comp.reversed===true||comp.reversed==='true';
          const ni_=alloc();
          entries.push({id:id+'_R',type:'R',n1,n2:ni_,value:rev?2.0:1.0});
          entries.push({id:id+'_V',type:'V',n1:ni_,n2,value:rev?-vz:-DIODE_VF});break;
        }
        case 'transistor':
        case 'pnp':{
          const vb=parseFloat(comp.baseVoltage)||0,rb=Math.max(EPSILON,parseFloat(comp.baseResistor)||10000);
          const isPnp=comp.type==='pnp';
          const ib=isPnp?(vb<BJT_VBE?(BJT_VBE-vb)/rb:0):(vb>BJT_VBE?(vb-BJT_VBE)/rb:0);
          const ic=ib*BJT_BETA;
          const ni_=alloc();
          entries.push({id:id+'_R',type:'R',n1,n2:ni_,value:rb});
          entries.push({id:id+'_V',type:'V',n1:ni_,n2,value:isPnp?BJT_VBE:-BJT_VBE});
          if(ic>0)entries.push({id:id+'_I',type:'I',n1,n2,value:isPnp?ic:-ic});
          ci[id].ib=ib;ci[id].ic=ic;break;
        }
        case 'mosfet_n':{
          const on=(parseFloat(comp.vgs)||0)>(parseFloat(comp.vth)||2);
          entries.push({id,type:'R',n1,n2,value:on?R_CLOSED:R_OPEN});ci[id].on=on;break;
        }
        default:break;
      }
    });
    return{entries,ci,Ntot:nxt};
  }

  // ── MNA matrix ─────────────────────────────────────────────────
  function buildMNA(entries,Ntot){
    const vs=entries.filter(e=>e.type==='V');
    const K=vs.length,Nv=Ntot-1,M=Nv+K;
    if(M<=0)return null;
    const G=Array.from({length:M},()=>new Float64Array(M)),b=new Float64Array(M);
    function ni(n){return n===0?-1:n-1;}
    entries.filter(e=>e.type==='R').forEach(({n1,n2,value})=>{
      const g=1/Math.max(value,EPSILON),r1=ni(n1),r2=ni(n2);
      if(r1>=0)G[r1][r1]+=g;if(r2>=0)G[r2][r2]+=g;
      if(r1>=0&&r2>=0){G[r1][r2]-=g;G[r2][r1]-=g;}
    });
    vs.forEach(({n1,n2,value},k)=>{
      const col=Nv+k,r1=ni(n1),r2=ni(n2);
      if(r1>=0){G[r1][col]-=1;G[col][r1]-=1;}
      if(r2>=0){G[r2][col]+=1;G[col][r2]+=1;}
      b[col]=value;
    });
    entries.filter(e=>e.type==='I').forEach(({n1,n2,value})=>{
      const r1=ni(n1),r2=ni(n2);
      if(r1>=0)b[r1]-=value;if(r2>=0)b[r2]+=value;
    });
    return{G,b,K,M,Nv,vs};
  }

  // ── Gaussian elimination ───────────────────────────────────────
  function gauss(G,b){
    const M=b.length,A=G.map(r=>Float64Array.from(r)),x=Float64Array.from(b),sing=[];
    for(let col=0;col<M;col++){
      let pr=col,pv=Math.abs(A[col][col]);
      for(let r=col+1;r<M;r++){const v=Math.abs(A[r][col]);if(v>pv){pv=v;pr=r;}}
      if(pv<SING_THR){sing.push(col);continue;}
      if(pr!==col){[A[col],A[pr]]=[A[pr],A[col]];[x[col],x[pr]]=[x[pr],x[col]];}
      const piv=A[col][col];
      for(let r=col+1;r<M;r++){if(!A[r][col])continue;const f=A[r][col]/piv;for(let c=col;c<M;c++)A[r][c]-=f*A[col][c];x[r]-=f*x[col];}
    }
    const sol=new Float64Array(M);
    for(let r=M-1;r>=0;r--){if(sing.includes(r)){sol[r]=0;continue;}let s=x[r];for(let c=r+1;c<M;c++)s-=A[r][c]*sol[c];sol[r]=Math.abs(A[r][r])>SING_THR?s/A[r][r]:0;}
    return{sol,sing};
  }

  // ── Extract results ────────────────────────────────────────────
  function extract(sol,entries,ci,Ntot,Nv,vs){
    const V=new Float64Array(Ntot);
    for(let i=1;i<Ntot;i++){const v=sol[i-1];V[i]=isFinite(v)?v:0;}
    const bI=Object.create(null);
    vs.forEach((e,k)=>{const raw=sol[Nv+k];bI[e.id]=isFinite(raw)?raw:0;});
    const grps=Object.create(null);
    entries.forEach(e=>{const base=e.id.replace(/[_]+[A-Za-z]+\d*$/,'').replace(/_(R|V|I|Rc|Ic|Rl|Vl)$/,'');const b=e.id.replace(/_(R|V|I|Rc|Ic|Rl|Vl)(\d*)$/,'');if(!grps[b])grps[b]=[];grps[b].push(e);});
    const res=Object.create(null);
    Object.keys(grps).forEach(bid=>{
      const info=ci[bid];if(!info)return;
      const vn1=V[info.n1]||0,vn2=V[info.n2]||0,vd=vn1-vn2;
      let I=0;
      const vS=grps[bid].find(e=>e.id===bid+'_V'||e.id===bid+'_Vl');
      if(vS){I=-(bI[vS.id]||0);}
      else{
        const rS=grps[bid].find(e=>e.id===bid&&e.type==='R');if(rS)I=(V[rS.n1]-V[rS.n2])/Math.max(rS.value,EPSILON);
        const vS2=grps[bid].find(e=>e.id===bid&&e.type==='V');if(vS2)I=-(bI[vS2.id]||0);
        const iS=grps[bid].find(e=>e.id===bid&&e.type==='I');if(iS)I=iS.value;
      }
      if(!isFinite(I))I=0;
      const Im=I*1000,aI=Math.abs(Im),aV=Math.abs(vd),P=aV*Math.abs(I)*1000;
      let status=aI>0.001?'on':'off';
      const r={voltage:_f(aV),current:_f(aI),power:_f(P),status,_raw_I:I,_raw_V:vd};
      switch(info.type){
        case 'switch':   r.status=info.closed?'on':'off';break;
        case 'capacitor':r.status='charged';break;
        case 'ground':   r.voltage=0;r.current=0;r.power=0;r.status='on';break;
        case 'led':{const burned=aI>LED_MAX_MA;r.status=burned?'burned':(aI>0.1?'on':'off');break;}
        case 'diode':    r.status=info.reversed?'off':(aI>0.01?'on':'off');break;
        case 'zener':    r.status=aI>0.01?'on':'off';break;
        case 'transistor':case 'pnp': r.status=(info.ib||0)>0?'on':'off';r.ib=_f((info.ib||0)*1e6,2);r.ic=_f((info.ic||0)*1e3,2);break;
        case 'mosfet_n': r.status=info.on?'on':'off';break;
        case 'lamp':     r.brightness=_f(Math.min(1,P/1000),3);r.status=P>1?'on':'off';break;
        case 'voltmeter':r.current=_f(Math.abs(I)*1e3);break;
        default:break;
      }
      res[bid]=r;
    });
    return{res,V};
  }

  // ── Node map ───────────────────────────────────────────────────
  function nodeMap(comps,nodeOf,V){
    const seen=new Set(),nodes=[];
    _A(comps).forEach(c=>{const t=getTerminals(c);if(!t)return;[[t.a,nodeOf(t.a)],[t.b==='__GND__'?'__GND__':t.b,0]].forEach(([,idx])=>{if(!seen.has(idx)){seen.add(idx);nodes.push({label:idx===0?'GND':`N${idx}`,voltage:_f(V?(V[idx]||0):0)});}});});
    nodes.sort((a,b)=>{if(a.label==='GND')return 1;if(b.label==='GND')return -1;return b.voltage-a.voltage;});
    return nodes;
  }

  // ── Frequency analysis ─────────────────────────────────────────
  function freqAn(comps,Req){
    const caps=_A(comps).filter(c=>c.type==='capacitor');
    const inds=_A(comps).filter(c=>c.type==='inductor');
    const C=caps.reduce((s,c)=>s+(parseFloat(c.capacitance)||100)*1e-6,0);
    const L=inds.reduce((s,l)=>s+(parseFloat(l.inductance)||10)*1e-3,0);
    let fc=null,tau=null;
    if(C>0&&Req>0){tau=Req*C;fc=1/(2*Math.PI*tau);}
    else if(L>0&&Req>0){tau=L/Req;fc=Req/(2*Math.PI*L);}
    const bode=[];
    if(fc)[0.1,1,10,100,1e3,1e4,1e5].forEach(f=>{const r=f/fc;bode.push({f,mag:_f(20*Math.log10(1/Math.sqrt(1+r*r)),2),phase:_f(-Math.atan(r)*180/Math.PI,2)});});
    return{fc:fc?_f(fc,2):null,tau:tau?_f(tau*1000,3):null,gain_db:0,bode};
  }

  // ── Fault detection ────────────────────────────────────────────
  function faults(comps,N){
    const errs=[],all=_A(comps);
    const addE=(t,m)=>{if(!errs.some(e=>e.message===m))errs.push({type:t,message:m});};
    if(!all.some(c=>c.type==='ground')&&all.some(c=>c.type==='battery'||c.type==='vsource'))addE('ground','Nessun Ground: aggiungere nodo di massa.');
    if(N<=1&&all.length>0)addE('open_circuit','Circuito non connesso.');
    all.filter(c=>c.type==='diode'&&(c.reversed===true||c.reversed==='true')).forEach(()=>addE('inv','Diodo polarizzato in inverso.'));
    return errs;
  }

  // ── Core solve one step ────────────────────────────────────────
  function solveOnce(comps,nodeOf,N,dt,capState,indState){
    const{entries,ci,Ntot}=buildNetlist(comps,nodeOf,N,dt,capState,indState);
    const mna=buildMNA(entries,Ntot);
    if(!mna)return null;
    const{sol,sing}=gauss(mna.G,mna.b);
    const{res,V}=extract(sol,entries,ci,Ntot,mna.Nv,mna.vs);
    return{res,V,sing,ci,Ntot};
  }

  // ═══════════════════════════════════════════════════════════════
  // DC SIMULATE
  // ═══════════════════════════════════════════════════════════════
  function simulate(){
    _results={};_errors=[];_nodes=[];_analysis=_emptyAn();_running=false;
    const comps=_A(_comps);
    if(!comps.length)return _fail('Nessun componente.','open_circuit');
    let nodeOf,N;
    try{const nd=buildNodes(comps);nodeOf=nd.nodeOf;N=nd.N;}catch(e){return _fail('Errore nodi.','error');}
    _errors=faults(comps,N);
    const step=solveOnce(comps,nodeOf,N,null,null,null);
    if(!step){_nodes=nodeMap(comps,nodeOf,null);return{ok:true,results:{},errors:_errors,nodes:_nodes,analysis:_analysis,summary:{status:'idle',voltage:0,current:0,power:0,resistance:0}};}
    if(step.sing.length)_errors.push({type:'singular',message:`Matrice singolare: ${step.sing.length} nodo/i disconnesso/i.`});
    _results=step.res;
    _nodes=nodeMap(comps,nodeOf,step.V);
    const Req=_A(comps).filter(c=>c.type==='resistor').reduce((s,c)=>s+Math.max(0,parseFloat(c.resistance)||1000),0);
    _analysis=freqAn(comps,Req);
    const srcIds=_A(comps).filter(c=>c.type==='battery'||c.type==='vsource').map(c=>c.id);
    const sumV=srcIds.reduce((s,id)=>s+(_results[id]?.voltage||0),0);
    const sumI=srcIds.length>0?srcIds.reduce((s,id)=>s+(_results[id]?.current||0),0)/srcIds.length:0;
    if(srcIds.some(id=>(_results[id]?.current||0)>1e5))_errors.push({type:'short_circuit',message:'CORTOCIRCUITO: corrente > 100A.'});
    _A(comps).filter(c=>c.type==='led').forEach(c=>{const r=_results[c.id];if(r&&r.current>LED_MAX_MA){_results[c.id]={...r,status:'burned'};if(!_errors.some(e=>e.message.startsWith('LED')))_errors.push({type:'warn',message:`LED bruciato! I=${r.current.toFixed(1)}mA`});}});
    _running=true;
    return{ok:true,results:_results,errors:_errors,nodes:_nodes,analysis:_analysis,summary:{status:'running',voltage:_f(sumV),current:_f(sumI),power:_f(sumV*sumI/1000),resistance:_f(Req)}};
  }

  // ═══════════════════════════════════════════════════════════════
  // TRANSIENT SIMULATE
  // ═══════════════════════════════════════════════════════════════
  function simulateTransient(dt_ms, T_ms, onStep){
    _trTime=[];_trHistory=[];
    const dt=Math.max(1e-9,dt_ms/1000);
    const T=Math.max(dt,T_ms/1000);
    const steps=Math.min(Math.ceil(T/dt),2000);
    const comps=_A(_comps);
    if(!comps.length)return{ok:false,time:[],history:[],errors:[{type:'error',message:'Nessun componente.'}]};

    let nodeOf,N;
    try{const nd=buildNodes(comps);nodeOf=nd.nodeOf;N=nd.N;}catch(e){return{ok:false,time:[],history:[],errors:[{type:'error',message:'Errore nodi.'}]};}

    // Initial state: capacitors start uncharged, inductors at 0A
    const capState=Object.create(null),indState=Object.create(null);
    _A(comps).filter(c=>c.type==='capacitor').forEach(c=>{capState[c.id]=0;});
    _A(comps).filter(c=>c.type==='inductor').forEach(c=>{indState[c.id]=0;});

    const errs=[];
    for(let step=0;step<=steps;step++){
      const t=step*dt;
      const r=solveOnce(comps,nodeOf,N,dt,capState,indState);
      if(!r)break;
      if(r.sing.length&&step===0)errs.push({type:'singular',message:'Matrice singolare al passo 0.'});

      // Update state
      _A(comps).filter(c=>c.type==='capacitor').forEach(c=>{
        const info=r.ci[c.id];if(!info)return;
        capState[c.id]=(r.V[info.n1]||0)-(r.V[info.n2]||0);
      });
      _A(comps).filter(c=>c.type==='inductor').forEach(c=>{
        const res=r.res[c.id];if(res)indState[c.id]=res._raw_I||0;
      });

      // Strip internal fields
      const clean=Object.create(null);
      Object.keys(r.res).forEach(id=>{const{_raw_I,_raw_V,...pub}=r.res[id];clean[id]=pub;});
      _trTime.push(_f(t*1000,4));
      _trHistory.push(clean);
      if(onStep)try{onStep(step,_f(t*1000,4),clean);}catch(_){}
    }

    return{ok:true,time:_trTime,history:_trHistory,errors:errs,stepCount:_trTime.length};
  }

  function getTransientResult(id,idx){if(!_trHistory||idx<0||idx>=_trHistory.length)return null;return _trHistory[idx][id]||null;}
  function getTransientHistory(){return{time:_trTime,history:_trHistory};}

  // ── Public API ─────────────────────────────────────────────────
  function setComponents(c){_comps=Array.isArray(c)?c.filter(Boolean):[];}
  function stop(){_running=false;_results={};_errors=[];_nodes=[];_analysis=_emptyAn();}
  function getResult(id){return _results[id]||null;}
  function getAllResults(){return _results;}
  function getErrors(){return _errors;}
  function getNodes(){return _nodes;}
  function getAnalysis(){return _analysis;}
  function isRunning(){return _running;}

  function _fail(error,status){return{ok:false,error,results:_results,errors:_errors,nodes:_nodes,analysis:_analysis,summary:{status,voltage:0,current:0,power:0,resistance:0}};}

  return{setComponents,simulate,stop,getResult,getAllResults,getErrors,getNodes,getAnalysis,isRunning,getDefaults,simulateTransient,getTransientResult,getTransientHistory};
})();
