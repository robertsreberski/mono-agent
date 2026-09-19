
// Progressive enhancement only: no model requests, tracking, or persistence.
const explorer = document.querySelector('[data-workflow-explorer]');
if (explorer) {
  const nav = explorer.querySelector('.workflow-tabs');
  const tabs = [...explorer.querySelectorAll('[data-workflow]')];
  const panels = [...explorer.querySelectorAll('[data-panel]')];
  const activate = (index, focus = false, updateUrl = false) => {
    if (updateUrl && location.hash !== `#${panels[index].id}`) {
      history.pushState(null, '', `#${panels[index].id}`);
    }
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    if (focus) tabs[index].focus();
  };
  if (nav && tabs.length && tabs.length === panels.length) {
    nav.setAttribute('role', 'tablist');
    tabs.forEach((tab, index) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panels[index].id);
      panels[index].setAttribute('role', 'tabpanel');
      panels[index].setAttribute('aria-labelledby', tab.id);
      panels[index].tabIndex = 0;
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        activate(index, false, true);
      });
      tab.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (event.key === ' ') next = index;
        if (next !== undefined) {
          event.preventDefault();
          activate(next, true, true);
        }
      });
    });
    // Honor direct links while leaving every panel readable without JavaScript.
    const linked = panels.findIndex(panel => `#${panel.id}` === location.hash);
    activate(linked >= 0 ? linked : 0);
    window.addEventListener('hashchange', () => {
      const index = panels.findIndex(panel => `#${panel.id}` === location.hash);
      if (index >= 0) activate(index);
    });
    window.addEventListener('popstate', () => {
      const index = panels.findIndex(panel => `#${panel.id}` === location.hash);
      activate(index >= 0 ? index : 0);
    });
    explorer.dataset.enhanced = 'true';
  }
}

const copy = document.querySelector('.copy-command');
const command = document.querySelector('#install-command');
const status = document.querySelector('.copy-status');
if (copy && command && status) {
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    try {
      await navigator.clipboard.writeText(command.textContent.trim());
      status.textContent = 'Install command copied.';
    } catch {
      status.textContent = 'Copy unavailable. Select and copy the command above.';
    } finally {
      copy.disabled = false;
    }
  });
}

// A compact disclosure menu, with plain visible links when JS is unavailable.
const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#site-navigation');
const compact = matchMedia('(max-width: 640px)');
if (menu && navigation) {
  menu.hidden = false;
  document.documentElement.dataset.navigation = 'enhanced';
  const closeMenu = (focus = false) => {
    menu.setAttribute('aria-expanded', 'false');
    if (focus) menu.focus();
  };
  menu.addEventListener('click', () => menu.setAttribute('aria-expanded', String(menu.getAttribute('aria-expanded') !== 'true')));
  navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') closeMenu(true); });
  document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });
  compact.addEventListener('change', () => closeMenu());
}

// A restrained card fan settles into the reading grid. No pinning or animation loop.
const cards = document.querySelector('.block-summary');
if (cards) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  const paint = () => {
    frame = 0;
    const top = cards.getBoundingClientRect().top;
    cards.style.setProperty('--card-open', String(Math.max(0, Math.min(1, (innerHeight - top) / (innerHeight * .7)))));
  };
  const schedule = () => {
    const rect = cards.getBoundingClientRect();
    if (!reduce.matches && !frame && rect.bottom >= 0 && rect.top <= innerHeight) frame = requestAnimationFrame(paint);
  };
  const preference = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    cards.dataset.cardsMotion = String(!reduce.matches);
    paint();
  };
  reduce.addEventListener('change', preference);
  addEventListener('scroll', schedule, {passive:true});
  addEventListener('resize', schedule, {passive:true});
  preference();
}
