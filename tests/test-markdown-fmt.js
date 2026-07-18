const { spawn } = require('child_process');
const os=require('os'),fs=require('fs'),path=require('path');
const puppeteer=require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'rz-mi-')); const PORT=3257; const base=`http://localhost:${PORT}`;
const srv=spawn('node',['/home/phil/dev/rhizome/server.js'],{env:{...process.env,DATA_DIR:DATA,PORT:String(PORT),HOST:'127.0.0.1',RHIZOME_ADMIN_PASSWORD:'adminpw',RHIZOME_INVITE_CODE:'x'},stdio:['ignore','ignore','inherit']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m);if(!c)fail++;};
const cookieFrom=sc=>{const m=(sc||'').match(/rz_session=([^;]+)/);return m?'rz_session='+m[1]:'';};
(async()=>{
  for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/me');if(r.status)break;}catch{}await sleep(200);}
  const ck=cookieFrom((await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'phil',password:'adminpw'})})).headers.get('set-cookie'));
  const me=await(await fetch(base+'/api/me',{headers:{Cookie:ck}})).json(); const gid=me.graphs[0].id;
  const doc={root:'root',nodes:{root:{id:'root',text:'',children:['pg']},pg:{id:'pg',text:'Page',children:['n1','n2','n3','nq','nn']},
    n1:{id:'n1',text:'',children:[]},n2:{id:'n2',text:'',children:[]},n3:{id:'n3',text:'',children:[]},nq:{id:'nq',text:'',children:[]},nn:{id:'nn',text:'',children:[]}}};
  await fetch(`${base}/api/g/${gid}/doc`,{method:'PUT',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify({doc})});
  const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const p=await b.newPage(); let errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.setCookie({name:'rz_session',value:ck.split('=')[1],domain:'localhost',path:'/'});
  await p.goto(base+'/#/n/pg',{waitUntil:'domcontentloaded'}); await sleep(1500);
  const type=async(id,text)=>{ const c=await p.$(`.item[data-id="${id}"] .content`); await c.click(); await sleep(120); await p.keyboard.type(text,{delay:12}); await sleep(300); };
  await type('n1','**fett**');
  await type('n2','*kursiv*');
  await type('n3','`code`');
  // block: quote + number (schon vorhanden)
  await type('nq','> zitat');
  await type('nn','1. eins');
  await sleep(300);
  const r=await p.evaluate(()=>({
    b: !!document.querySelector('.item[data-id="n1"] b'),
    i: !!document.querySelector('.item[data-id="n2"] i'),
    code: !!document.querySelector('.item[data-id="n3"] code'),
    quote: document.querySelector('.item[data-id="nq"]')?.className||'',
    number: document.querySelector('.item[data-id="nn"]')?.className||'',
    bText: document.querySelector('.item[data-id="n1"] b')?.textContent,
  }));
  ok(r.b && r.bText==='fett','**fett** → <b>fett</b>');
  ok(r.i,'*kursiv* → <i>');
  ok(r.code,'`code` → <code>');
  ok(/fmt-quote/.test(r.quote),`> zitat → quote (${r.quote})`);
  ok(/fmt-number/.test(r.number),`1. eins → number (${r.number})`);
  console.log('PAGE ERRORS:',errs.length?errs:'keine'); if(errs.length)fail++;
  console.log(fail?`\n${fail} FEHL`:'\nInline+Block-Markdown (Web) funktioniert');
  await b.close(); srv.kill(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);srv.kill();process.exit(2);});
