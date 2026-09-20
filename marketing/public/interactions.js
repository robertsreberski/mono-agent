
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

// Native scroll drives one finite deck-to-grid gesture and a small hero tilt.
// No pinning, wheel/touch interception, timers, or continuous animation loop.
const cards = document.querySelector('.block-summary');
const heroArt = document.querySelector('.hero-art picture');
const motionToggle = document.querySelector('.motion-toggle');
if (cards) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const grid = cards.querySelector('.block-chapters');
  const layers = [...grid.children];
  let frame = 0;
  let paused = false;
  let focused = false;
  let geometry = [];
  const clamp = value => Math.max(0, Math.min(1, value));
  const measure = () => {
    // Untransformed layout coordinates: never feed transformed bounds back into poses.
    geometry = layers.map((card, index) => ({
      x: grid.clientWidth / 2 - card.offsetLeft - card.offsetWidth / 2,
      y: -card.offsetTop + index * 9,
      angle: [-9, -3, 3, 9][index],
    }));
  };
  const paint = () => {
    frame = 0;
    const active = !reduce.matches && !paused && !focused;
    const top = cards.getBoundingClientRect().top;
    const progress = active ? clamp((innerHeight * .95 - top) / (innerHeight * .5)) : 1;
    const open = progress * progress * (3 - 2 * progress);
    cards.dataset.cardsMotion = String(active && progress < 1);
    cards.style.setProperty('--card-open', String(progress));
    layers.forEach((card, index) => {
      const pose = geometry[index];
      const rest = 1 - open;
      card.style.setProperty('--deck-x', `${pose.x * rest}px`);
      card.style.setProperty('--deck-y', `${pose.y * rest}px`);
      card.style.setProperty('--deck-angle', `${pose.angle * rest}deg`);
      card.style.setProperty('--deck-tilt', `${32 * rest}deg`);
      card.style.setProperty('--deck-scale', String(1 - .16 * rest));
    });
    if (heroArt) {
      const hero = document.querySelector('.hero').getBoundingClientRect();
      const travel = active ? clamp(-hero.top / hero.height) : 0;
      heroArt.style.transform = active ? `translateY(${-travel * 16}px) rotate(${travel * -2}deg)` : 'none';
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const resize = () => { measure(); schedule(); };
  const preference = () => {
    if (motionToggle) motionToggle.hidden = reduce.matches;
    schedule();
  };
  motionToggle?.addEventListener('click', () => {
    paused = !paused;
    motionToggle.setAttribute('aria-pressed', String(paused));
    motionToggle.textContent = paused ? 'Resume motion' : 'Pause motion';
    schedule();
  });
  // Keyboard navigation must never land on an obscured, overlapped link.
  grid.addEventListener('focusin', () => { focused = true; paint(); });
  grid.addEventListener('focusout', event => {
    if (!grid.contains(event.relatedTarget)) { focused = false; schedule(); }
  });
  reduce.addEventListener('change', preference);
  addEventListener('scroll', schedule, {passive:true});
  addEventListener('resize', resize, {passive:true});
  new ResizeObserver(resize).observe(grid);
  measure(); preference();
}
