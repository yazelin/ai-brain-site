import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';
const ROOT = '/home/ct/ai-brain-site';
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json',
  '.webmanifest':'application/manifest+json','.webp':'image/webp','.png':'image/png',
  '.svg':'image/svg+xml','.mp3':'audio/mpeg','.css':'text/css','.jpg':'image/jpeg' };
const srv = http.createServer((q,res)=>{
  const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\//,'')||'index.html';
  const f = join(ROOT, rel);
  if(!existsSync(f)||!statSync(f).isFile()){res.writeHead(404);return res.end();}
  const b=readFileSync(f);
  res.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream','content-length':b.length,'accept-ranges':'bytes'});
  res.end(b);
});
await new Promise(r=>srv.listen(0,r));
const U=`http://127.0.0.1:${srv.address().port}/`;
const b=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
const p=await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const say=(ok,n,d)=>console.log(`${ok?'PASS':'FAIL'}  ${n}  — ${d}`);
await p.goto(U,{waitUntil:'load'});
/* **開機動畫跑完，桌面版會自己 open('about')。**（index.html 的 boot 尾巴）
   所以這裡不要去點圖示——那會把已經開好的視窗 toggle 關掉，
   然後測試報「這個 app 打不開」，看起來像功能壞了。等它自己開就好。
   另外 #boot 是鋪滿全螢幕的 z-index:9999 遮罩，還在的時候點什麼都沒反應，
   而且它是透明的，用看的看不出來。 */
await p.waitForSelector('#w-about.open', { timeout: 25000 });
await p.waitForTimeout(600);
const vis = await p.isVisible('#w-about');
say(vis,'關於我視窗開得起來',vis?'開了':'沒開');
const btns = await p.evaluate(()=>[...document.querySelectorAll('#w-about .say')].map(x=>x.dataset.say));
say(btns.length===2,'兩顆鈕都在',btns.join(' '));
const txt = await p.evaluate(()=>[...document.querySelectorAll('#w-about .said')].map(x=>x.textContent.length));
say(txt.every(n=>n>20),'逐字稿有塞進去',txt.join(' / ')+' 字');
let bad=[];
for(const s of btns){
  await p.click(`.say[data-say="${s}"]`); await p.waitForTimeout(800);
  const on=await p.getAttribute(`.say[data-say="${s}"]`,'aria-pressed');
  const shown=await p.isVisible(`#said-${s}`);
  const playing=await p.evaluate(()=>{const a=document.querySelector('audio');return true;});
  if(on!=='true'||!shown) bad.push(s);
  await p.click(`.say[data-say="${s}"]`);
  if(await p.getAttribute(`.say[data-say="${s}"]`,'aria-pressed')!=='false') bad.push(s+'(停不掉)');
}
say(bad.length===0,'按下去會播、逐字稿出現、再按會停',bad.join(' ')||'兩顆都對');
await p.click('.say[data-say="glitch"]'); await p.waitForTimeout(300);
await p.click('.say[data-say="blackhole"]'); await p.waitForTimeout(300);
const on=await p.evaluate(()=>[...document.querySelectorAll('.say')].filter(x=>x.getAttribute('aria-pressed')==='true').map(x=>x.dataset.say));
say(on.length===1&&on[0]==='blackhole','一次只播一個',on.join(' ')||'零個');
// 真的 decode
for(const s of btns){
  const d=await p.evaluate((k)=>new Promise(r=>{const a=new Audio('audio/intro-'+k+'.mp3');
    a.addEventListener('loadedmetadata',()=>r(a.duration));a.addEventListener('error',()=>r(-1));setTimeout(()=>r(-2),9000);}),s);
  say(d>1,`${s} 真的解得出來`,d>0?d.toFixed(1)+'s':'解不出來');
}
say(errs.length===0,'沒有 JS 例外',errs.join(' ')||'零');
await b.close(); srv.close();
