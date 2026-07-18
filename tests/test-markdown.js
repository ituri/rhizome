const { spawn } = require('child_process');
const os=require('os'),fs=require('fs'),path=require('path');
const puppeteer=require('/home/phil/dev/rhizome/tests/node_modules/puppeteer-core');
const DATA=fs.mkdtempSync(path.join(os.tmpdir(),'rz-ml-')); const PORT=3255; const base=`http://localhost:${PORT}`;
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
  const p=await b.newPage(); let errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.setCookie({name:'rz_session',value:ck.split('=')[1],domain:'localhost',path:'/'});
  await p.goto(base+'/#/n/pg',{waitUntil:'domcontentloaded'}); await sleep(1500);
  const content=await p.$('.item[data-id="n1"] .content');
  ok(content!==null,'editierbares Bullet gefunden');
  await content.click(); await sleep(200);
  await p.keyboard.type('See [Google](https://google.com) now', {delay: 15});
  await sleep(500);
  // reveal: while editing, [text](url) stays RAW markdown (no live conversion to an anchor)
  const dom=await p.evaluate(()=>{ const el=document.querySelector('.item[data-id="n1"] .content');
    return {text:el?.textContent||'',anchors:el?.querySelectorAll('a').length??-1}; });
  ok(dom.text.includes('[Google](https://google.com)') && dom.anchors===0,`[text](url) bleibt roh beim Editieren ("${dom.text}", a=${dom.anchors})`);
  const txt=dom.text;
  ok(txt.includes('See ')&&txt.includes(' now'),`umgebender Text bleibt ("${txt}")`);
  // persistiert? blur + Server prüfen
  await p.evaluate(()=>window.commitActiveText&&window.commitActiveText()); await sleep(1200);
  const back=await (await fetch(`${base}/api/g/${gid}/doc`,{headers:{Cookie:ck}})).json();
  const html=(back.doc.nodes.n1&&back.doc.nodes.n1.text)||'';
  ok(/href="https:\/\/google\.com"/.test(html) && html.includes('>Google<'),`Link persistiert (${JSON.stringify(html)})`);
  console.log('PAGE ERRORS:',errs.length?errs:'keine'); if(errs.length)fail++;
  console.log(fail?`\n${fail} FEHL`:'\nMarkdown-Link (Web) funktioniert');
  await b.close(); srv.kill(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);srv.kill();process.exit(2);});
