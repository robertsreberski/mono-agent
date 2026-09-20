// Explicit, consent-gated PostHog Capture API integration. No SDK autocapture,
// cookies, fingerprinting, identity calls, session replay, or form-value access.
const root = document.documentElement;
const key = root.dataset.posthogKey || '';
const hosts = (root.dataset.analyticsHosts || '').split(',').map(h => h.trim());
const eligible = /^phc_[a-zA-Z0-9]+$/.test(key) && hosts.includes(location.hostname);
const banner = document.querySelector('.analytics-notice');
const settings = document.querySelector('.analytics-settings');
const feedback = document.querySelector('.analytics-status');
const storageKey = 'mono-analytics-consent-v1';
const sessionKey = 'mono-analytics-session-v1';
const maxAge = 180 * 86400000;
const privacySignal = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
let consent = false;
let viewed = false;
let session;
let observer;
const seen = new Set();
const sections = new Set(['top', 'configuration', 'console', 'comparison', 'start', 'faq']);

function preference() {
  try {
    const item = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return item && Date.now() - item.at < maxAge && ['yes', 'no'].includes(item.choice) ? item.choice : null;
  } catch { return null; } // Unavailable storage never grants consent.
}
function sessionId() {
  if (session && Date.now() - session.at < 1800000) {
    session.at = Date.now();
  } else {
    try { session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch { session = null; }
    if (!session || typeof session.id !== 'string' || !/^[a-f0-9-]{36}$/.test(session.id) || Date.now() - session.at >= 1800000) {
      session = { id: crypto.randomUUID(), at: Date.now() };
    }
    session.at = Date.now();
  }
  try { sessionStorage.setItem(sessionKey, JSON.stringify(session)); } catch { /* In-memory only. */ }
  return session.id;
}
function capture(event, properties = {}) {
  if (!eligible || !consent || privacySignal) return;
  const id = sessionId();
  const body = JSON.stringify({
    api_key: key, event, distinct_id: id,
    properties: {
      $process_person_profile: false, $geoip_disable: true, $session_id: id,
      $current_url: `${location.origin}${location.pathname}`, $pathname: location.pathname,
      $host: location.hostname, viewport: innerWidth < 700 ? 'mobile' : 'desktop',
      ...properties,
    },
  });
  // Only the EU ingestion endpoint is permitted. Omit credentials and referrer;
  // never send arbitrary URLs, DOM text, form values, emails, or user identifiers.
  fetch('https://eu.i.posthog.com/i/v0/e/', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body,
    credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
  }).then(response => {
    if (!response.ok) console.warn('Analytics event not delivered:', response.status);
  }).catch(() => console.warn('Analytics event not delivered: network unavailable.'));
}
function begin() {
  if (viewed || !consent || privacySignal) return;
  viewed = true;
  const acquisition = {};
  try { if (document.referrer) acquisition.referrer_host = new URL(document.referrer).hostname; } catch { /* No valid source. */ }
  const params = new URLSearchParams(location.search);
  for (const field of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const value = params.get(field);
    if (value && /^[a-zA-Z0-9_-]{1,64}$/.test(value)) acquisition[field] = value;
  }
  capture('$pageview', acquisition);
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && consent && !seen.has(entry.target.id)) {
          seen.add(entry.target.id);
          capture('section_viewed', { section: entry.target.id });
        }
      }
    }, { threshold: 0.15 });
    sections.forEach(id => { const el = document.getElementById(id); if (el) observer.observe(el); });
  }
}
function choose(allow) {
  consent = allow && !privacySignal;
  try { localStorage.setItem(storageKey, JSON.stringify({choice: consent ? 'yes' : 'no', at: Date.now()})); } catch { /* Choice applies to this page only. */ }
  banner.hidden = true;
  if (consent) begin();
  else {
    observer?.disconnect(); observer = null; viewed = false; seen.clear(); session = null;
    try { sessionStorage.removeItem(sessionKey); } catch { /* No stored identifier. */ }
  }
  feedback.textContent = consent ? 'Analytics allowed. Change your choice anytime.' : 'Analytics off. No further events will be sent.';
  settings.focus({preventScroll: true});
}
if (eligible && banner && settings && feedback) {
  settings.hidden = false;
  const saved = preference();
  consent = saved === 'yes' && !privacySignal;
  banner.hidden = privacySignal || saved !== null;
  if (privacySignal) feedback.textContent = 'Your browser privacy signal is respected. Analytics are off.';
  settings.addEventListener('click', () => {
    banner.hidden = false;
    banner.querySelector('[data-consent="yes"]').disabled = privacySignal;
    banner.querySelector('[data-consent="no"]').focus();
  });
  banner.querySelector('[data-consent="yes"]').addEventListener('click', () => choose(true));
  banner.querySelector('[data-consent="no"]').addEventListener('click', () => choose(false));
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a');
    if (!link) return;
    const url = new URL(link.href);
    const section = link.closest('section')?.id;
    const placement = sections.has(section) ? section : 'navigation';
    if (url.hostname === 'github.com' && url.pathname === '/robertsreberski/mono-agent') capture('github_clicked', { placement });
    else if (url.hostname === 'mono-agent-docs.vercel.app') capture('docs_clicked', { placement });
    else if (url.origin === location.origin && url.hash === '#configuration') capture('blueprint_opened', { placement });
  });
  document.addEventListener('mono:install-copied', () => capture('install_command_copied'));
  document.querySelectorAll('.faq details').forEach((item, index) => item.addEventListener('toggle', () => {
    if (item.open) capture('faq_opened', { question: index + 1 });
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && viewed) capture('$pageleave');
  });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    consent = preference() === 'yes' && !privacySignal;
    if (consent) begin();
    else {
      observer?.disconnect(); observer = null; viewed = false; seen.clear(); session = null;
      try { sessionStorage.removeItem(sessionKey); } catch { /* Nothing to clear. */ }
    }
  });
  begin();
}
