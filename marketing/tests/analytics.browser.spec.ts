import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const key = 'mono-analytics-consent-vercel-v1';
// Deterministic provider boundary for CI; the REAL installed Astro component and
// SDK still mount/queue events. An optional captured vendor script supports a
// local compatibility smoke without committing third-party hosted code.
const provider = process.env.VERCEL_VENDOR_FIXTURE
  ? readFileSync(process.env.VERCEL_VENDOR_FIXTURE, 'utf8')
  : `(()=>{let before=e=>e;window.va=(type,data)=>{if(type==='beforeSend'){before=data;return;}
    if(type!=='pageview'&&type!=='event')return;
    const event=before({type,url:location.href,payload:data});if(!event)return;
    fetch('/_vercel/insights/'+(type==='pageview'?'view':'event'),{method:'POST',body:JSON.stringify({o:event.url})});
  };(window.vaq||[]).forEach(args=>window.va(...args));})();`;
async function configured(page: Page) {
  const requests: string[] = [];
  const events: any[] = [];
  // Test-only: all provider traffic is intercepted locally, never real ingestion.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {get: () => false});
    const agent = navigator.userAgent.replace('Headless', '');
    Object.defineProperty(navigator, 'userAgent', {get: () => agent});
  });
  await page.route('**/_vercel/insights/**', async route => {
    requests.push(route.request().url());
    if (route.request().method() === 'POST') events.push(route.request().postDataJSON());
    await route.fulfill({status:200, contentType: route.request().url().endsWith('script.js') ? 'application/javascript' : 'application/json', body: route.request().url().endsWith('script.js') ? provider : '{}'});
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' || !['/', '/privacy/'].includes(url.pathname)) return route.fallback();
    const response = await route.fetch();
    const html = (await response.text()).replace(/data-analytics-hosts="[^"]*"/, 'data-analytics-hosts="127.0.0.1"');
    await route.fulfill({response, body:html});
  });
  return {requests, events};
}
async function loaded(page: Page) {
  await page.waitForFunction(() => typeof (window as any).webAnalyticsBeforeSend === 'function');
}

test('unapproved hosts never mount analytics', async ({page}) => {
  const requests: string[] = [];
  page.on('request', request => {if(request.url().includes('/insights/')) requests.push(request.url());});
  await page.goto('/'); await loaded(page);
  await expect(page.locator('.analytics-notice')).toBeHidden();
  await expect(page.locator('.analytics-settings')).toBeHidden();
  expect(requests).toEqual([]);
  expect(await page.locator('body > vercel-analytics').count()).toBe(0);
});
for (const width of [390, 1440]) {
  test(`consent controls are accessible and fit at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:844});
    const {requests} = await configured(page);
    await page.goto('/'); await loaded(page);
    await expect(page.locator('.analytics-notice')).toBeVisible();
    expect(requests).toEqual([]);
    const box = await page.locator('.analytics-notice').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x+box!.width).toBeLessThanOrEqual(width);
    expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
    await page.getByRole('button',{name:'No thanks',exact:true}).click();
    await page.reload(); await loaded(page);
    await expect(page.locator('.analytics-notice')).toBeHidden();
    expect(requests).toEqual([]);
  });
}
test('native Astro mounts after consent, strips page queries, drops custom events and unloads on withdrawal', async ({page}) => {
  const {requests,events} = await configured(page);
  await page.goto('/?email=private@example.com&utm_source=github#comparison');
  await loaded(page); expect(requests).toEqual([]);
  await page.getByRole('button',{name:'Allow analytics',exact:true}).click();
  await expect.poll(()=>events.length).toBe(1);
  expect(events[0].o).toBe('http://127.0.0.1:4330/');
  expect(await page.evaluate(()=>Object.keys(sessionStorage))).toEqual([]);
  expect(await page.locator('body > vercel-analytics').count()).toBe(1);
  await page.evaluate(()=>{(window as any).va('event',{name:'github_clicked',data:{email:'private@example.com'}});});
  await page.getByRole('button',{name:'Analytics preferences'}).click();
  await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'No thanks',exact:true}).click()]);
  await loaded(page);
  expect(events.length).toBe(1);
  expect(requests.filter(url=>url.endsWith('script.js')).length).toBe(1);
  expect(await page.locator('body > vercel-analytics').count()).toBe(0);
  await expect(page.locator('.analytics-notice')).toBeHidden();
});
for (const signal of ['globalPrivacyControl','doNotTrack']) {
  test(`${signal} overrides stored consent`, async ({page}) => {
    const {requests} = await configured(page);
    await page.addInitScript(({key,signal})=>{
      localStorage.setItem(key,JSON.stringify({choice:'yes',at:Date.now()}));
      Object.defineProperty(navigator,signal,{value:signal==='doNotTrack'?'1':true});
    },{key,signal});
    await page.goto('/'); await loaded(page);
    expect(requests).toEqual([]);
    await page.getByRole('button',{name:'Analytics preferences'}).click();
    await expect(page.getByRole('button',{name:'Allow analytics',exact:true})).toBeDisabled();
  });
}
test('unavailable storage cannot grant consent', async ({page}) => {
  const {requests} = await configured(page);
  await page.addInitScript(()=>{Storage.prototype.setItem=()=>{throw Error('unavailable');};});
  await page.goto('/'); await loaded(page);
  await page.getByRole('button',{name:'Allow analytics',exact:true}).click();
  await expect(page.locator('.analytics-status')).toContainText('could not be saved');
  expect(requests).toEqual([]);
});
test('failed withdrawal persistence still blocks events and focus cannot re-enable them', async ({page}) => {
  const {events} = await configured(page); await page.goto('/');
  await page.getByRole('button',{name:'Allow analytics',exact:true}).click();
  await expect.poll(()=>events.length).toBe(1);
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('unavailable');};});
  await page.getByRole('button',{name:'Analytics preferences'}).click();
  await page.getByRole('button',{name:'No thanks',exact:true}).click();
  await expect(page.locator('.analytics-status')).toContainText('could not be saved');
  const allowed = await page.evaluate(()=>{
    window.dispatchEvent(new Event('focus'));
    return (window as any).webAnalyticsBeforeSend({type:'pageview',url:location.href});
  });
  expect(allowed).toBeNull(); expect(events.length).toBe(1);
});
test('old provider consent is not reused; expired and future consent do not grant permission', async ({page}) => {
  const {requests} = await configured(page);
  await page.addInitScript(()=>{
    localStorage.setItem('mono-analytics-consent-v1',JSON.stringify({choice:'yes',at:Date.now()}));
    sessionStorage.setItem('mono-analytics-session-v1','old-provider-id');
  });
  await page.goto('/'); await loaded(page);
  await expect(page.locator('.analytics-notice')).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('mono-analytics-session-v1'))).toBeNull();
  for (const at of [Date.now()-181*86400000,Date.now()+86400000]) {
    await page.evaluate(({key,at})=>localStorage.setItem(key,JSON.stringify({choice:'yes',at})),{key,at});
    await page.reload(); await loaded(page);
    await expect(page.locator('.analytics-notice')).toBeVisible();
  }
  expect(requests).toEqual([]);
});
test('privacy page has accessible controls and respects saved refusal', async ({page}) => {
  const {requests} = await configured(page);
  await page.goto('/privacy/'); await loaded(page);
  await expect(page.getByRole('heading',{level:1})).toHaveText('Privacy & analytics');
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.getByRole('button',{name:'No thanks',exact:true}).click();
  await page.goto('/'); await loaded(page);
  await expect(page.locator('.analytics-notice')).toBeHidden(); expect(requests).toEqual([]);
});
test('withdrawal in another tab unloads the active provider', async ({page,context}) => {
  const first = await configured(page); await page.goto('/');
  await page.getByRole('button',{name:'Allow analytics',exact:true}).click();
  await expect.poll(()=>first.events.length).toBe(1);
  const other = await context.newPage(); await configured(other); await other.goto('/privacy/');
  await other.getByRole('button',{name:'Analytics preferences'}).click();
  await Promise.all([page.waitForEvent('load'),other.getByRole('button',{name:'No thanks',exact:true}).click()]);
  await loaded(page);
  expect(await page.locator('body > vercel-analytics').count()).toBe(0);
  expect(first.events.length).toBe(1);
});
