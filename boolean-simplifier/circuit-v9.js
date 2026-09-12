(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const circuitBtn = $("circuitBtn");
  const imageInput = $("imageInput");
  const cameraInput = $("cameraInput");
  const preview = $("preview");
  const ocrStatus = $("ocrStatus");
  const ocrProgress = $("ocrProgress");
  const ocrBtn = $("ocrBtn");
  const simplifyBtn = $("simplifyBtn");
  const clearBtn = $("clearBtn");
  const resultBox = $("resultBox");
  const batchResults = $("batchResults");
  const emptyState = $("emptyState");
  const errorBox = $("errorBox");

  if (!circuitBtn || !imageInput) return;

  const TYPE_LABEL = { NOT:"NOT", AND:"AND", NAND:"NAND", OR:"OR", NOR:"NOR", XOR:"XOR", XNOR:"XNOR" };

  function setError(message) { if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; } }
  function clearError() { if (errorBox) errorBox.hidden = true; }
  function escapeHtml(v) { return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;"); }

  async function fileToBitmap(file) {
    if ("createImageBitmap" in window) return await createImageBitmap(file);
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function rasterize(bitmap) {
    const naturalW = bitmap.width || bitmap.naturalWidth;
    const naturalH = bitmap.height || bitmap.naturalHeight;
    const scale = Math.min(1, 1400 / naturalW, 1000 / naturalH);
    const W = Math.max(1, Math.round(naturalW * scale));
    const H = Math.max(1, Math.round(naturalH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently:true });
    ctx.drawImage(bitmap, 0, 0, W, H);
    const data = ctx.getImageData(0,0,W,H).data;
    const black = new Uint8Array(W*H);
    for (let i=0,j=0;i<data.length;i+=4,j++) {
      const r=data[i], g=data[i+1], b=data[i+2];
      const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
      if (mx < 178 && (mx-mn < 70 || mx < 95)) black[j]=1;
    }
    return { canvas,ctx,black,W,H,naturalW,naturalH };
  }

  function lineMasks(black,W,H) {
    const horizontal=new Uint8Array(W*H), vertical=new Uint8Array(W*H);
    const minH=Math.max(24,Math.round(W*.025)), minV=Math.max(24,Math.round(H*.04));
    for (let y=0;y<H;y++) {
      let x=0, base=y*W;
      while (x<W) {
        while (x<W && !black[base+x]) x++;
        const start=x;
        while (x<W && black[base+x]) x++;
        if (x-start>=minH) horizontal.fill(1,base+start,base+x);
      }
    }
    for (let x=0;x<W;x++) {
      let y=0;
      while (y<H) {
        while (y<H && !black[y*W+x]) y++;
        const start=y;
        while (y<H && black[y*W+x]) y++;
        if (y-start>=minV) for (let yy=start;yy<y;yy++) vertical[yy*W+x]=1;
      }
    }
    return {horizontal,vertical,minH,minV};
  }

  function components(bin,W,H,minArea=1) {
    const N=W*H, seen=new Uint8Array(N), queue=new Int32Array(N), out=[];
    const dirs=[-W-1,-W,-W+1,-1,1,W-1,W,W+1];
    for (let start=0;start<N;start++) {
      if (!bin[start] || seen[start]) continue;
      let qh=0,qt=0; queue[qt++]=start; seen[start]=1;
      let area=0,minX=W,minY=H,maxX=0,maxY=0,sumX=0,sumY=0;
      while(qh<qt) {
        const idx=queue[qh++], y=Math.floor(idx/W), x=idx-y*W;
        area++; minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); sumX+=x; sumY+=y;
        for (let d=0;d<8;d++) {
          if ((x===0&&(d===0||d===3||d===5))||(x===W-1&&(d===2||d===4||d===7))||(y===0&&d<=2)||(y===H-1&&d>=5)) continue;
          const ni=idx+dirs[d];
          if (ni>=0&&ni<N&&bin[ni]&&!seen[ni]) { seen[ni]=1; queue[qt++]=ni; }
        }
      }
      if (area>=minArea) out.push({x0:minX,y0:minY,x1:maxX,y1:maxY,w:maxX-minX+1,h:maxY-minY+1,area,cx:sumX/area,cy:sumY/area});
    }
    return out;
  }

  function mergeBoxes(boxes,gapX,gapY) {
    let cur=boxes.map(b=>({...b})), changed=true;
    while(changed) {
      changed=false; const used=new Array(cur.length).fill(false), next=[];
      for (let i=0;i<cur.length;i++) {
        if (used[i]) continue;
        let a={...cur[i]}; used[i]=true; let grown=true;
        while(grown) {
          grown=false;
          for (let j=0;j<cur.length;j++) {
            if (used[j]) continue; const b=cur[j];
            const separate=a.x1+gapX<b.x0||b.x1+gapX<a.x0||a.y1+gapY<b.y0||b.y1+gapY<a.y0;
            if (!separate) {
              const total=a.area+b.area;
              a={x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1),area:total,
                 cx:(a.cx*a.area+b.cx*b.area)/total,cy:(a.cy*a.area+b.cy*b.area)/total};
              a.w=a.x1-a.x0+1; a.h=a.y1-a.y0+1;
              used[j]=true; grown=true; changed=true;
            }
          }
        }
        next.push(a);
      }
      cur=next;
    }
    return cur;
  }

  function bubbleScore(box,black,W,H) {
    let best=0;
    const sx=Math.max(box.x0+Math.floor(box.w*.5),0), ex=Math.min(box.x1+15,W-1), sy=Math.max(box.y0+5,0), ey=Math.min(box.y1-5,H-1);
    for (let cy=sy;cy<=ey;cy+=3) for (let cx=sx;cx<=ex;cx+=3) for (const r of [5,7,9]) {
      let ring=0,n=0;
      for (let k=0;k<16;k++) { const a=Math.PI*2*k/16, x=Math.round(cx+r*Math.cos(a)), y=Math.round(cy+r*Math.sin(a)); if(x>=0&&x<W&&y>=0&&y<H){ring+=black[y*W+x];n++;} }
      let inner=0,ni=0;
      for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){if(dx*dx+dy*dy>4)continue;const x=cx+dx,y=cy+dy;if(x>=0&&x<W&&y>=0&&y<H){inner+=black[y*W+x];ni++;}}
      best=Math.max(best,(n?ring/n:0)-.7*(ni?inner/ni:0));
    }
    return best;
  }

  function detectGateBoxes(black,horizontal,vertical,W,H) {
    const symbol=new Uint8Array(W*H);
    for(let i=0;i<symbol.length;i++) symbol[i]=black[i]&&!horizontal[i]&&!vertical[i]?1:0;
    const raw=components(symbol,W,H,8);
    const merged=mergeBoxes(raw,Math.max(14,W*.016),Math.max(6,H*.011));
    const boxes=merged.filter(b=>b.h>H*.06&&b.w>W*.03&&b.w<W*.23&&b.h<H*.20&&b.area>Math.max(150,W*H*.0002)&&b.x0>W*.12);
    const gates=boxes.map((b,i)=>{
      const bubble=bubbleScore(b,black,W,H), leftW=Math.max(1,Math.floor(b.w/3));
      let leftPixels=0; for(let y=b.y0;y<=b.y1;y++) for(let x=b.x0;x<b.x0+leftW;x++) leftPixels+=symbol[y*W+x];
      const leftDensity=leftPixels/(leftW*b.h);
      let baseType=b.w/W<.055?"AND":(leftDensity>.13?"XOR":"OR");
      let bodyX0=b.x0-5; if(baseType==="AND") bodyX0=b.x0-b.h*1.02;
      const body={x0:Math.max(0,Math.round(bodyX0)),y0:Math.max(0,b.y0-5),x1:Math.min(W-1,b.x1+5),y1:Math.min(H-1,b.y1+5)};
      return {id:`G${i+1}`,type:baseType,baseType,bubble,leftDensity,box:b,body,inputs:[],output:null};
    });
    gates.sort((a,b)=>a.body.x0-b.body.x0||a.body.y0-b.body.y0); gates.forEach((g,i)=>g.id=`G${i+1}`);
    return gates;
  }

  function lineSegments(mask,W,H,o,minLength) {
    const comps=components(mask,W,H,1), out=[];
    for(const c of comps) {
      if(o==="H"&&c.w>=minLength) out.push({id:`H${out.length}`,o:"H",x1:c.x0,x2:c.x1,y:Math.round(c.cy),th:c.h});
      if(o==="V"&&c.h>=minLength) out.push({id:`V${out.length}`,o:"V",y1:c.y0,y2:c.y1,x:Math.round(c.cx),th:c.w});
    }
    return out;
  }

  function detectPorts(g,hs,W,H) {
    const b=g.box, yLo=b.y0+.15*b.h, yHi=b.y0+.85*b.h;
    let inputs=hs.filter(s=>s.y>=yLo&&s.y<=yHi&&s.x2>=b.x0-1.3*b.h&&s.x2<=b.x0+.45*b.w&&s.x2-s.x1>=Math.max(18,W*.014)&&s.x1<b.x0).sort((a,b)=>a.y-b.y);
    const ded=[];
    for(const s of inputs){const last=ded[ded.length-1];if(last&&Math.abs(last.y-s.y)<Math.max(6,H*.01)){if(s.x1<last.x1)ded[ded.length-1]=s;}else ded.push(s);} inputs=ded;
    if(inputs.length>2){const targets=[b.y0+b.h*.32,b.y0+b.h*.68],remain=inputs.slice(),chosen=[];for(const t of targets){let bi=0;for(let i=1;i<remain.length;i++)if(Math.abs(remain[i].y-t)<Math.abs(remain[bi].y-t))bi=i;chosen.push(remain.splice(bi,1)[0]);}inputs=chosen.sort((a,b)=>a.y-b.y);}
    const outs=hs.filter(s=>s.y>=yLo&&s.y<=yHi&&s.x1>=b.x0+.55*b.w&&s.x1<=b.x1+30&&s.x2-s.x1>=Math.max(18,W*.014)&&s.x2>b.x1);
    let output=null;if(outs.length){const t=b.y0+b.h/2;output=outs.reduce((a,s)=>Math.abs(s.y-t)<Math.abs(a.y-t)?s:a,outs[0]);}
    const hasBubble=g.bubble>.82;
    if(hasBubble&&inputs.length<=1) g.type="NOT";
    else { g.type=g.baseType; if(hasBubble) g.type=g.baseType==="AND"?"NAND":g.baseType==="XOR"?"XNOR":"NOR"; }
    const need=g.type==="NOT"?1:2; if(inputs.length>need)inputs=inputs.slice(0,need);
    if(g.type==="AND"||g.type==="NAND") g.body.x0=Math.max(0,Math.round(b.x0-b.h*1.02));
    g.inputs=inputs; g.output=output;
  }

  function localDensity(black,W,H,x,y,rad){x=Math.round(x);y=Math.round(y);let sum=0,n=0;for(let yy=Math.max(0,y-rad);yy<=Math.min(H-1,y+rad);yy++){const base=yy*W;for(let xx=Math.max(0,x-rad);xx<=Math.min(W-1,x+rad);xx++){sum+=black[base+xx];n++;}}return n?sum/n:0;}
  function midpoint(s){return s.o==="H"?[(s.x1+s.x2)/2,s.y]:[s.x,(s.y1+s.y2)/2];}

  function buildNets(gates,hs,vs,black,W,H) {
    const portIds=new Set(); for(const g of gates){g.inputs.forEach(s=>portIds.add(s.id));if(g.output)portIds.add(g.output.id);}
    const active=[...hs,...vs].filter(s=>{const [mx,my]=midpoint(s);const inside=gates.some(g=>mx>=g.body.x0&&mx<=g.body.x1&&my>=g.body.y0&&my<=g.body.y1);return !inside||portIds.has(s.id);});
    const map=new Map(active.map(s=>[s.id,s])), ids=[...map.keys()], adj=new Map(ids.map(id=>[id,new Set()]));
    const tol=Math.max(5,Math.round(W*.0055)), rad=Math.max(4,Math.round(W*.0047));
    const connect=(a,b)=>{adj.get(a.id).add(b.id);adj.get(b.id).add(a.id);};
    for(let i=0;i<ids.length;i++){const a=map.get(ids[i]);for(let j=i+1;j<ids.length;j++){const b=map.get(ids[j]);let yes=false;
      if(a.o==="H"&&b.o==="H")yes=Math.abs(a.y-b.y)<=tol&&!(a.x2+tol<b.x1||b.x2+tol<a.x1);
      else if(a.o==="V"&&b.o==="V")yes=Math.abs(a.x-b.x)<=tol&&!(a.y2+tol<b.y1||b.y2+tol<a.y1);
      else{const h=a.o==="H"?a:b,v=a.o==="V"?a:b,x=v.x,y=h.y;if(x>=h.x1-tol&&x<=h.x2+tol&&y>=v.y1-tol&&y<=v.y2+tol){const endpoint=Math.min(Math.abs(x-h.x1),Math.abs(x-h.x2))<=tol||Math.min(Math.abs(y-v.y1),Math.abs(y-v.y2))<=tol;const dot=localDensity(black,W,H,x,y,rad)>=.74;yes=endpoint||dot;}}
      if(yes)connect(a,b);
    }}
    const netOf=new Map(),nets=[],visited=new Set();
    for(const id of ids){if(visited.has(id))continue;const stack=[id];visited.add(id);const members=[];while(stack.length){const u=stack.pop();members.push(u);netOf.set(u,nets.length);for(const v of adj.get(u))if(!visited.has(v)){visited.add(v);stack.push(v);}}nets.push(members);}
    return {netOf,nets,segmentMap:map};
  }

  function sourceRecords(sourceNets,nets,segmentMap){return sourceNets.map(net=>{const segs=nets[net].map(id=>segmentMap.get(id)).filter(Boolean),h=segs.filter(s=>s.o==="H"),left=h.length?h.reduce((a,b)=>a.x1<b.x1?a:b):null;return{net,y:left?left.y:0,x:left?left.x1:0};}).sort((a,b)=>a.y-b.y);}

  function makeLabelCrop(canvas,rec,W,H){
    const padX=Math.max(55,Math.round(W*.08)), padY=Math.max(24,Math.round(H*.045));
    const x0=Math.max(0,Math.round(rec.x-padX)), x1=Math.max(x0+12,Math.round(rec.x-4));
    const y0=Math.max(0,Math.round(rec.y-padY)), y1=Math.min(H,Math.round(rec.y+padY));
    const scale=6, out=document.createElement("canvas"); out.width=Math.max(1,(x1-x0)*scale);out.height=Math.max(1,(y1-y0)*scale);
    const c=out.getContext("2d");c.fillStyle="#fff";c.fillRect(0,0,out.width,out.height);c.imageSmoothingEnabled=false;c.drawImage(canvas,x0,y0,x1-x0,y1-y0,0,0,out.width,out.height);
    const id=c.getImageData(0,0,out.width,out.height),p=id.data;for(let i=0;i<p.length;i+=4){const g=.299*p[i]+.587*p[i+1]+.114*p[i+2];const v=g<175?0:255;p[i]=p[i+1]=p[i+2]=v;p[i+3]=255;}c.putImageData(id,0,0);return out;
  }

  function cleanLabel(text){
    const toks=String(text||"").match(/[A-Za-z][A-Za-z0-9_]*/g)||[];if(!toks.length)return null;
    let t=toks.sort((a,b)=>a.length-b.length)[0];
    if(t.length>1&&[...t.toLowerCase()].every(ch=>ch===t[0].toLowerCase()))t=t[0];
    return t.length<=10?t:null;
  }

  async function recognizeSourceNames(records,ras,fullOcr){
    const names=new Array(records.length).fill(null), used=new Set();
    const words=Array.isArray(fullOcr?.data?.words)?fullOcr.data.words:[], sx=ras.W/ras.naturalW, sy=ras.H/ras.naturalH;
    for(let i=0;i<records.length;i++){
      const rec=records[i];let best=null,dist=Infinity;
      for(const w of words){const t=cleanLabel(w.text);if(!t||/^T\d*$/i.test(t)||/^F\d*$/i.test(t))continue;const b=w.bbox||{},cx=((b.x0||0)+(b.x1||0))*.5*sx,cy=((b.y0||0)+(b.y1||0))*.5*sy;if(cx>rec.x+ras.W*.025)continue;const d=Math.abs(cy-rec.y)+Math.max(0,cx-rec.x)*.2;if(d<dist&&Math.abs(cy-rec.y)<ras.H*.055&&!used.has(t)){best=t;dist=d;}}
      if(best){names[i]=best;used.add(best);}
    }
    if(window.Tesseract){
      for(let i=0;i<records.length;i++){
        if(names[i])continue;
        try{ocrStatus.textContent=`อ่านตัวแปร ${i+1}/${records.length}…`;const crop=makeLabelCrop(ras.canvas,records[i],ras.W,ras.H);const r=await Tesseract.recognize(crop,"eng",{tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_",tessedit_pageseg_mode:"10"});const t=cleanLabel(r?.data?.text);if(t&&!/^T\d*$/i.test(t)&&!/^F\d*$/i.test(t)&&!used.has(t)){names[i]=t;used.add(t);}}catch(_){ }
      }
    }
    const bases=[];for(let i=0;i<names.length;i++)if(names[i]&&names[i].length===1&&/[A-Za-z]/.test(names[i]))bases.push(names[i].toLowerCase().charCodeAt(0)-i);
    if(bases.length>=2&&bases.every(v=>v===bases[0])){const first=names.find(Boolean);const upper=first&&first===first.toUpperCase();for(let i=0;i<names.length;i++)if(!names[i]){let c=String.fromCharCode(bases[0]+i);names[i]=upper?c.toUpperCase():c;}}
    for(let i=0;i<names.length;i++)if(!names[i])names[i]=`I${i+1}`;
    return new Map(records.map((r,i)=>[r.net,names[i]]));
  }

  function opText(type,vals,pretty=false){
    const a=vals[0]??"?",b=vals[1]??"?",mul=pretty?"·":"*";
    if(type==="NOT")return /^[A-Za-z][A-Za-z0-9_]*$/.test(a)?`${a}'`:`(${a})'`;
    if(type==="AND")return `${a}${mul}${b}`;
    if(type==="NAND")return `BAR(${a}${mul}${b})`;
    if(type==="OR")return `${a} + ${b}`;
    if(type==="NOR")return `BAR(${a} + ${b})`;
    if(type==="XOR")return `${a} ⊕ ${b}`;
    if(type==="XNOR")return `${a} ⊙ ${b}`;
    return `${a} ? ${b}`;
  }

  function buildCircuitModel(gates,netOf,sourceNames){
    const producer=new Map(),consumed=new Set();
    for(const g of gates){if(g.output&&netOf.has(g.output.id))producer.set(netOf.get(g.output.id),g);for(const s of g.inputs)if(netOf.has(s.id))consumed.add(netOf.get(s.id));}
    let roots=gates.filter(g=>!g.output||!netOf.has(g.output.id)||!consumed.has(netOf.get(g.output.id))).sort((a,b)=>(a.body.y0+a.body.y1)-(b.body.y0+b.body.y1));
    if(!roots.length)throw new Error("หา Gate เอาต์พุตไม่เจอ");
    const rootIds=new Set(roots.map(g=>g.id)), depthMemo=new Map();
    function depth(g){if(depthMemo.has(g.id))return depthMemo.get(g.id);let d=1;for(const s of g.inputs){const n=netOf.get(s.id),p=producer.get(n);if(p)d=Math.max(d,depth(p)+1);}depthMemo.set(g.id,d);return d;}
    const labels=new Map();
    const mids=gates.filter(g=>!rootIds.has(g.id)&&g.type!=="NOT").sort((a,b)=>depth(a)-depth(b)||((a.body.y0+a.body.y1)-(b.body.y0+b.body.y1))||a.body.x0-b.body.x0);
    mids.forEach((g,i)=>labels.set(g.id,`T${i+1}`)); roots.forEach((g,i)=>labels.set(g.id,`F${i+1}`));

    const expandedMemo=new Map(),visiting=new Set();
    function expandedNet(n){if(sourceNames.has(n))return sourceNames.get(n);const p=producer.get(n);return p?expandedGate(p):`I${n+1}`;}
    function expandedGate(g){if(expandedMemo.has(g.id))return expandedMemo.get(g.id);if(visiting.has(g.id))throw new Error("พบ feedback loop ซึ่งยังไม่รองรับ");visiting.add(g.id);const vals=g.inputs.map(s=>expandedNet(netOf.get(s.id)));const t=opText(g.type,vals);visiting.delete(g.id);expandedMemo.set(g.id,t);return t;}
    function namedNet(n){if(sourceNames.has(n))return sourceNames.get(n);const p=producer.get(n);if(!p)return`I${n+1}`;if(p.type==="NOT"&&!labels.has(p.id)){const base=namedNet(netOf.get(p.inputs[0].id));return /^[A-Za-z][A-Za-z0-9_]*$/.test(base)?`${base}'`:`(${base})'`;}return labels.get(p.id)||expandedGate(p);}
    function localGate(g){return opText(g.type,g.inputs.map(s=>namedNet(netOf.get(s.id))),true);}
    const stageGates=[...mids,...roots];
    const stages=stageGates.map(g=>({name:labels.get(g.id),gate:g,type:g.type,equation:localGate(g),depth:depth(g)}));
    const outputs=roots.map(g=>({name:labels.get(g.id),gate:g,expression:expandedGate(g),local:localGate(g)}));
    return {producer,labels,stages,outputs,roots,depth};
  }

  function annotate(ras,gates,model,records,sourceNames){
    const {canvas,ctx,W}=ras;ctx.save();ctx.lineWidth=Math.max(2,W*.002);ctx.font=`700 ${Math.max(13,Math.round(W*.014))}px system-ui`;
    for(const g of gates){ctx.strokeStyle="#7357ff";ctx.fillStyle="#7357ff";const b=g.body;ctx.strokeRect(b.x0,b.y0,b.x1-b.x0,b.y1-b.y0);ctx.fillText(TYPE_LABEL[g.type]||g.type,b.x0,Math.max(14,b.y0-6));const lab=model.labels.get(g.id);if(lab){ctx.fillStyle="#e84a3c";ctx.font=`800 ${Math.max(15,Math.round(W*.016))}px system-ui`;const ox=g.output?g.output.x2:b.x1+10, oy=g.output?g.output.y:(b.y0+b.y1)/2;ctx.fillText(lab,Math.min(W-45,ox+8),Math.max(18,oy-8));ctx.font=`700 ${Math.max(13,Math.round(W*.014))}px system-ui`;}}
    ctx.fillStyle="#118a4e";ctx.font=`800 ${Math.max(14,Math.round(W*.015))}px system-ui`;for(const r of records){const n=sourceNames.get(r.net);ctx.fillText(n,Math.max(3,r.x-48),r.y-8);}
    ctx.restore();return canvas.toDataURL("image/png");
  }

  function renderCircuit(model,gates,sourceNames){
    if(resultBox)resultBox.hidden=true;if(emptyState)emptyState.hidden=true;if(!batchResults)return;
    const sourceList=[...new Set(sourceNames.values())].join(", "), counts=gates.reduce((m,g)=>(m[g.type]=(m[g.type]||0)+1,m),{}), gateText=Object.entries(counts).map(([k,v])=>`${k} ${v}`).join(" • ");
    const stageHtml=model.stages.map(s=>`<div class="circuit-step"><span class="step-var">${escapeHtml(s.name)}</span><span class="step-eq">${escapeHtml(s.name)} = ${escapeHtml(s.equation)}</span><small>${escapeHtml(s.type)}</small></div>`).join("");
    const outHtml=model.outputs.map(out=>{let simplified=out.expression;try{simplified=window.BooleanSimplifier?.simplifyBoolean(out.expression)?.result||out.expression;}catch(_){}return `<div class="batch-item circuit-result-item"><div class="batch-item-head"><strong>${escapeHtml(out.name)}</strong><span>Final output</span></div><div class="batch-answer">${escapeHtml(out.name)} = ${escapeHtml(simplified)}</div><code class="circuit-raw">${escapeHtml(out.name)} = ${escapeHtml(out.local)}</code><code class="circuit-expanded">Expanded: ${escapeHtml(out.expression)}</code></div>`;}).join("");
    batchResults.innerHTML=`<div class="circuit-summary"><span>Inputs <strong>${escapeHtml(sourceList||"-")}</strong></span><span>Gates <strong>${escapeHtml(gateText)}</strong></span></div><div class="circuit-walk"><div class="circuit-walk-title">เดินวงจรทีละจุด</div>${stageHtml}</div>${outHtml}`;batchResults.hidden=false;
  }

  async function analyzeCircuit(file){
    const bitmap=await fileToBitmap(file), ras=rasterize(bitmap), lm=lineMasks(ras.black,ras.W,ras.H), gates=detectGateBoxes(ras.black,lm.horizontal,lm.vertical,ras.W,ras.H), hs=lineSegments(lm.horizontal,ras.W,ras.H,"H",lm.minH), vs=lineSegments(lm.vertical,ras.W,ras.H,"V",lm.minV);
    if(gates.length<2)throw new Error("ยังหา Logic Gate ไม่ได้ ลองครอปให้เหลือเฉพาะวงจรและใช้ภาพคมชัด");
    for(const g of gates)detectPorts(g,hs,ras.W,ras.H);
    const usable=gates.filter(g=>g.inputs.length>=(g.type==="NOT"?1:2));if(usable.length<2)throw new Error("เจอ Gate แต่ขาเข้าไม่ครบ");
    const {netOf,nets,segmentMap}=buildNets(usable,hs,vs,ras.black,ras.W,ras.H);
    const outputNets=new Set(usable.filter(g=>g.output&&netOf.has(g.output.id)).map(g=>netOf.get(g.output.id)));
    const sourceNets=[...new Set(usable.flatMap(g=>g.inputs.map(s=>netOf.get(s.id)).filter(n=>n!==undefined&&!outputNets.has(n))))];
    const records=sourceRecords(sourceNets,nets,segmentMap);
    let fullOcr=null;if(window.Tesseract){ocrStatus.textContent="อ่านตัวแปรจากรูป…";try{fullOcr=await Tesseract.recognize(file,"eng",{logger:m=>{if(m.status==="recognizing text"&&typeof m.progress==="number"&&ocrProgress)ocrProgress.style.width=`${Math.round(m.progress*45)}%`;}});}catch(_){}}
    const sourceNames=await recognizeSourceNames(records,ras,fullOcr);
    const model=buildCircuitModel(usable,netOf,sourceNames);
    preview.src=annotate(ras,usable,model,records,sourceNames);
    return {model,gates:usable,sourceNames};
  }

  circuitBtn.addEventListener("click",async()=>{
    const file=imageInput.files?.[0]||cameraInput?.files?.[0];if(!file)return;clearError();circuitBtn.disabled=true;if(ocrBtn)ocrBtn.disabled=true;if(simplifyBtn)simplifyBtn.disabled=true;if(batchResults)batchResults.hidden=true;if(resultBox)resultBox.hidden=true;ocrStatus.textContent="กำลังจำแนก Gate และเดินเส้น…";if(ocrProgress)ocrProgress.style.width="8%";
    try{const data=await analyzeCircuit(file);renderCircuit(data.model,data.gates,data.sourceNames);ocrStatus.textContent=`วิเคราะห์แล้ว — ${[...data.sourceNames.values()].join(", ")} • ${data.gates.length} Gate`;if(ocrProgress)ocrProgress.style.width="100%";}catch(err){setError(`วิเคราะห์วงจรไม่สำเร็จ: ${err.message||err}`);ocrStatus.textContent="วิเคราะห์วงจรไม่สำเร็จ";if(ocrProgress)ocrProgress.style.width="0%";}finally{circuitBtn.disabled=false;if(ocrBtn)ocrBtn.disabled=false;if(simplifyBtn)simplifyBtn.disabled=false;}
  });
  imageInput.addEventListener("change",()=>{circuitBtn.disabled=!imageInput.files?.length;});
  cameraInput?.addEventListener("change",()=>{circuitBtn.disabled=!(cameraInput.files?.length||imageInput.files?.length);});
  clearBtn?.addEventListener("click",()=>{circuitBtn.disabled=true;});
})();