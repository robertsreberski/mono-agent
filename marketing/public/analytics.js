// Native Vercel Astro integration, mounted only after provider-specific consent.
const template = document.querySelector('#analytics-template');
const hosts = (template?.dataset.analyticsHosts || '').split(',');
const eligible = hosts.includes(location.hostname);
const banner = document.querySelector('.analytics-notice');
const settings = document.querySelector('.analytics-settings');
const feedback = document.querySelector('.analytics-status');
const storageKey = 'mono-analytics-consent-vercel-v1';
const maxAge = 180 * 86400000;
let mounted = false;
let consent = false;
let deniedOnPage = false;
const privacySignal = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';

// Do not reuse permission or session identifiers from the previous provider.
try {
  localStorage.removeItem('mono-analytics-consent-v1');
  sessionStorage.removeItem('mono-analytics-session-v1');
} catch { /* Storage may be unavailable; analytics stay off. */ }

function preference() {
  try {
    const item = JSON.parse(localStorage.getItem(storageKey) || 'null');
    const age = Date.now() - item?.at;
    return item && Number.isFinite(item.at) && age >= 0 && age < maxAge && ['yes', 'no'].includes(item.choice) ? item.choice : null;
  } catch { return null; }
}

// Installed BEFORE the Astro custom element can inject/queue its first pageview.
window.webAnalyticsBeforeSend = event => {
  if (!eligible || !consent || privacySignal() || preference() !== 'yes' || event.type !== 'pageview') return null;
  try {
    const url = new URL(event.url);
    if (url.origin !== location.origin) return null;
    return { ...event, url: `${url.origin}${url.pathname}` };
  } catch { return null; }
};

function begin() {
  if (mounted || !eligible || !consent || privacySignal() || preference() !== 'yes') return;
  mounted = true;
  document.body.append(template.content.cloneNode(true));
}
function sync() {
  const saved = preference();
  consent = !deniedOnPage && saved === 'yes' && !privacySignal();
  banner.hidden = privacySignal() || saved !== null;
  banner.querySelector('[data-consent="yes"]').disabled = privacySignal();
  if (!consent && mounted && (saved !== 'yes' || privacySignal())) {
    // Unload the provider script/listeners too, not merely suppress its events.
    location.reload();
    return;
  }
  if (privacySignal()) feedback.textContent = 'Your browser privacy signal is respected. Analytics are off.';
  begin();
}
function choose(allow) {
  consent = false;
  const choice = allow && !privacySignal() ? 'yes' : 'no';
  deniedOnPage = choice === 'no';
  let persisted = false;
  try { localStorage.setItem(storageKey, JSON.stringify({choice, at: Date.now()})); persisted = true; } catch { /* Fail closed. */ }
  if (choice === 'yes' && (!persisted || preference() !== 'yes')) {
    deniedOnPage = true;
    feedback.textContent = 'Your preference could not be saved. Analytics remain off.';
    return;
  }
  sync();
  banner.hidden = true;
  feedback.textContent = consent ? 'Analytics allowed. Change your choice anytime.' : 'Analytics off. No further page views will be sent.';
  if (!persisted) feedback.textContent = 'Analytics are off for this page, but your preference could not be saved.';
  settings.focus({preventScroll: true});
}
if (eligible && template && banner && settings && feedback) {
  settings.hidden = false;
  settings.addEventListener('click', () => {
    banner.hidden = false;
    banner.querySelector('[data-consent="yes"]').disabled = privacySignal();
    banner.querySelector('[data-consent="no"]').focus();
  });
  banner.querySelector('[data-consent="yes"]').addEventListener('click', () => choose(true));
  banner.querySelector('[data-consent="no"]').addEventListener('click', () => choose(false));
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) sync();
  });
  window.addEventListener('focus', sync);
  sync();
}
