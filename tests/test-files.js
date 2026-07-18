const { spawn } = require('child_process');
const os=require('os'),fs=require('fs'),path=require('path');
const puppeteer=require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'rz-pdf-')); const PORT=3239; const base=`http://localhost:${PORT}`;
const srv=spawn('node',['/home/phil/dev/rhizome/server.js'],{env:{...process.env,DATA_DIR:DATA,PORT:String(PORT),HOST:'127.0.0.1',RHIZOME_ADMIN_PASSWORD:'adminpw',RHIZOME_INVITE_CODE:'x'},stdio:['ignore','ignore','inherit']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m);if(!c)fail++;};
const cookieFrom=sc=>{const m=(sc||'').match(/rz_session=([^;]+)/);return m?'rz_session='+m[1]:'';};
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
(async()=>{
  for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/me');if(r.status)break;}catch{}await sleep(200);}
  const ck=cookieFrom((await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'phil',password:'adminpw'})})).headers.get('set-cookie'));
  const up=await fetch(`${base}/api/upload?name=report.pdf`,{method:'POST',headers:{Cookie:ck},body:PDF});
  const {url:pdfUrl}=await up.json();
  ok(/\/files\/[0-9a-f]{24}-report\.pdf$/.test(pdfUrl),`PDF hochgeladen (${pdfUrl})`);
  const served=await fetch(base+pdfUrl,{headers:{Cookie:ck}});
  ok(served.headers.get('content-type')==='application/pdf','wird als application/pdf ausgeliefert');
  const me=await(await fetch(base+'/api/me',{headers:{Cookie:ck}})).json(); const gid=me.graphs[0].id;
  const doc={root:'root',nodes:{root:{id:'root',text:'',children:['n1']},n1:{id:'n1',text:'Docs',children:['n2']},n2:{id:'n2',text:'doc',children:[],files:[{url:pdfUrl,name:'report.pdf',type:'application/pdf'}]}}};
  await fetch(`${base}/api/g/${gid}/doc`,{method:'PUT',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify({doc})});
  const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const p=await b.newPage(); let errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.setCookie({name:'rz_session',value:ck.split('=')[1],domain:'localhost',path:'/'});
  await p.goto(base+'/#/n/n1',{waitUntil:'domcontentloaded'}); await sleep(1500);
  ok(await p.$('.att-chip')!==null,'Nicht-Bild-Anhang rendert als Chip (nicht als Bild)');
  // der Chip darf NICHT von der Row ueberlagert sein, sonst verschluckt sie den Klick
  const hit=await p.evaluate(()=>{ const n=document.querySelector('.att-name'); const r=n.getBoundingClientRect();
    const top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return !!top?.closest?.('.att-chip'); });
  ok(hit,'die Chip-Klickflaeche liegt frei (wird nicht von der Row ueberlagert)');
  const fileResps=[]; p.on('response',r=>{ if(r.url().includes('/files/')) fileResps.push(r.status()); });
  await (await p.$('.att-name')).click();   // ECHTER Mausklick (kein synthetisches .click())
  await sleep(500);
  ok(await p.$('.file-preview-ov')!==null,'echter Klick auf den Chip oeffnet die In-App-Vorschau');
  const frame=await p.$eval('.fp-frame',e=>e.getAttribute('src')).catch(()=>null);
  ok(frame && frame.includes('.pdf'),`PDF im iframe eingebettet (${frame})`);
  ok(fileResps.some(s=>s===200),`iframe laedt das PDF (Status ${fileResps.join(',')||'keiner'})`);
  await (await p.$('.fp-close')).click(); await sleep(200);
  ok(await p.$('.file-preview-ov')===null,'Schliessen-Button entfernt die Vorschau');
  console.log('PAGE ERRORS:',errs.length?errs:'keine'); if(errs.length)fail++;
  console.log(fail?`\n${fail} FEHLGESCHLAGEN`:'\nAlle PDF/File-Checks bestanden');
  await b.close(); srv.kill(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);srv.kill();process.exit(2);});
