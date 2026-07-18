const { spawn } = require('child_process');
const os=require('os'),fs=require('fs'),path=require('path');
const puppeteer=require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'rz-en-')); const PORT=3302; const base=`http://localhost:${PORT}`;
const srv=spawn('node',['/home/phil/dev/rhizome/server.js'],{env:{...process.env,DATA_DIR:DATA,PORT:String(PORT),HOST:'127.0.0.1',RHIZOME_ADMIN_PASSWORD:'adminpw',RHIZOME_INVITE_CODE:'x'},stdio:['ignore','ignore','inherit']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m);if(!c)fail++;};
const cookieFrom=sc=>{const m=(sc||'').match(/rz_session=([^;]+)/);return m?'rz_session='+m[1]:'';};
(async()=>{
  for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/me');if(r.status)break;}catch{}await sleep(200);}
  const ck=cookieFrom((await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'phil',password:'adminpw'})})).headers.get('set-cookie'));
  const me=await(await fetch(base+'/api/me',{headers:{Cookie:ck}})).json(); const gid=me.graphs[0].id;
  const doc={root:'root',nodes:{root:{id:'root',text:'',children:['pg']},pg:{id:'pg',text:'Page',children:['n1']},n1:{id:'n1',text:'',children:[]}}};
  await fetch(`${base}/api/g/${gid}/doc`,{method:'PUT',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify({doc})});
  const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.setCookie({name:'rz_session',value:ck.split('=')[1],domain:'localhost',path:'/'});
  await p.goto(base+'/#/n/pg',{waitUntil:'domcontentloaded'}); await sleep(1500);
  // type in n1, then press ENTER (split → new bullet). n1 must render immediately.
  await (await p.$('.item[data-id="n1"] .content')).click(); await sleep(150);
  await p.keyboard.type('A **bold** __under__ *it*',{delay:15}); await sleep(500);
  await p.keyboard.press('Enter'); await sleep(700);   // <-- the reported trigger
  const n1=await p.evaluate(()=>document.querySelector('.item[data-id="n1"] .content')?.innerHTML||'');
  ok(/<b>bold<\/b>/.test(n1),`Enter: **bold** gerendert ("${n1}")`);
  ok(/<u>under<\/u>/.test(n1),'Enter: __under__ → <u>under</u> gerendert');
  ok(/<i>it<\/i>/.test(n1),'Enter: *it* → <i> gerendert');
  ok(!n1.includes('**')&&!n1.includes('__'),'keine rohen Marker mehr sichtbar');
  console.log(fail?`\n${fail} FEHL`:'\nEnter rendert sofort (opSplit löst auf), __under__ funktioniert');
  await b.close(); srv.kill(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);srv.kill();process.exit(2);});
