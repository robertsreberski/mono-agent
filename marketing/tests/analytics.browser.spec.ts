import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Synthetic public project token; all ingestion requests are intercepted.
async function configured(page: Page) {
  const events: any[] = [];
  await page.route('https://eu.i.posthog.com/**', async route => {
    if (route.request().method() === 'POST') events.push(route.request().postDataJSON());
    await route.fulfill({status: 200, body: '{}', headers: {'access-control-allow-origin': '*'}});
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/') return route.fallback();
    const response = await route.fetch();
    const html = (await response.text()).replace(/data-posthog-key(?:="[^"]*")?/, 'data-posthog-key="phc_test"')
      .replace(/data-analytics-hosts="[^"]*"/, 'data-analytics-hosts="127.0.0.1"');
    await route.fulfill({response, body: html});
  });
  return events;
}

test('no analytics in unconfigured or unapproved-host builds', async ({page}) => {
  const external: string[] = [];
  page.on('request', request => { if (request.url().includes('posthog.com')) external.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.analytics-notice')).toBeHidden();
  await expect(page.locator('.analytics-settings')).toBeHidden();
  expect(external).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`consent controls are accessible and fit at ${width}`, async ({page}) => {
    await page.setViewportSize({width, height: 844});
    const events = await configured(page);
    await page.goto('/');
    await expect(page.locator('.analytics-notice')).toBeVisible();
    expect(events).toEqual([]);
    const box = await page.locator('.analytics-notice').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
    await page.getByRole('button', {name: 'No thanks', exact:true}).click();
    await expect(page.locator('.analytics-notice')).toBeHidden();
    await page.reload();
    await expect(page.locator('.analytics-notice')).toBeHidden();
    expect(events).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('mono-analytics-session-v1'))).toBeNull();
  });
}

test('accepted events omit sensitive URLs, identifiers and form data; withdrawal stops capture', async ({page}) => {
  const events = await configured(page);
  await page.goto('/?email=private@example.com&utm_source=github&utm_campaign=launch&token=secret#comparison');
  await page.getByRole('button', {name:'Allow analytics', exact:true}).click();
  await expect.poll(() => events.filter(e => e.event === '$pageview').length).toBe(1);
  await page.evaluate(() => document.dispatchEvent(new Event('mono:install-copied')));
  await expect.poll(() => events.some(e => e.event === 'install_command_copied')).toBe(true);
  const view = events.find(e => e.event === '$pageview');
  expect(view.api_key).toBe('phc_test');
  expect(view.distinct_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(view.properties.$process_person_profile).toBe(false);
  expect(view.properties.$geoip_disable).toBe(true);
  expect(view.properties.utm_source).toBe('github');
  expect(view.properties.$current_url).not.toMatch(/[?#]/);
  expect(JSON.stringify(events)).not.toMatch(/private@example|token=secret|\$identify/);
  await page.getByRole('button', {name:'Analytics preferences'}).click();
  await page.getByRole('button', {name:'No thanks',exact:true}).click();
  const count = events.length;
  await page.evaluate(() => document.dispatchEvent(new Event('mono:install-copied')));
  await page.reload();
  await expect(page.locator('.analytics-notice')).toBeHidden();
  expect(events.length).toBe(count);
  expect(await page.evaluate(() => sessionStorage.getItem('mono-analytics-session-v1'))).toBeNull();
});

test('privacy signals override previously accepted consent', async ({page}) => {
  const events = await configured(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'globalPrivacyControl', {value:true});
    localStorage.setItem('mono-analytics-consent-v1', JSON.stringify({choice:'yes', at:Date.now()}));
  });
  await page.goto('/');
  await expect(page.locator('.analytics-notice')).toBeHidden();
  await page.getByRole('button', {name:'Analytics preferences'}).click();
  await expect(page.getByRole('button', {name:'Allow analytics',exact:true})).toBeDisabled();
  expect(events).toEqual([]);
});

test('storage failure does not imply consent or break navigation', async ({page}) => {
  const events = await configured(page);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('unavailable'); };
    Storage.prototype.setItem = () => { throw new Error('unavailable'); };
  });
  await page.goto('/');
  expect(events).toEqual([]);
  await page.getByRole('button', {name:'No thanks',exact:true}).click();
  await expect(page.locator('.hero-actions a').first()).toBeVisible();
});

test('privacy page remains accessible without analytics', async ({page}) => {
  await page.goto('/privacy/');
  await expect(page.getByRole('heading', {level:1})).toHaveText('Privacy & analytics');
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
});
