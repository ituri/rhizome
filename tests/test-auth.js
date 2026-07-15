const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) failures++; };

(async () => {
  // raw API checks — auth is now account/session based
  let r = await fetch('http://localhost:3212/api/doc');
  assert(r.status === 401, 'API rejects unauthenticated doc fetch (401)');
  r = await fetch('http://localhost:3212/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'phil', password: 'wrong' }),
  });
  assert(r.status === 401, 'wrong password rejected');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('PAGEERROR:', e.message); failures++; });
  await page.goto('http://localhost:3212/#/', { waitUntil: 'domcontentloaded' });
  await sleep(500);
  const loginShown = await page.$eval('#login-screen', el => !el.hidden);
  assert(loginShown, 'login screen shown when accounts exist');
  await page.type('#login-username', 'phil');
  await page.type('#login-password', 'wrongpass');
  await page.click('#login-submit');
  await sleep(400);
  const errShown = await page.$eval('#login-error', el => !el.hidden);
  assert(errShown, 'error shown for wrong password');
  await page.evaluate(() => { document.querySelector('#login-password').value = ''; });
  await page.type('#login-password', 's3cret');
  await page.click('#login-submit');
  await page.waitForSelector('.day-section, .tree .item .content', { timeout: 8000 });
  assert(true, 'correct login unlocks and loads the outline');
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAUTH TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
