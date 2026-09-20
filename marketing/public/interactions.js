
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
    // Hash scrolling can precede enhancement/layout in WebKit. Reveal the
    // selected panel, then align the anchor against its final readable layout.
    const revealLinked = index => requestAnimationFrame(() => {
      if (`#${panels[index].id}` === location.hash) {
        panels[index].scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    });
    if (linked >= 0) revealLinked(linked);
    window.addEventListener('hashchange', () => {
      const index = panels.findIndex(panel => `#${panel.id}` === location.hash);
      if (index >= 0) { activate(index); revealLinked(index); }
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

// A short native-scroll deck; keyboard and motion preferences restore static flow.
const cards = document.querySelector('.block-summary');
const heroArt = document.querySelector('.hero-art picture');
const motionToggle = document.querySelector('.motion-toggle');
if (cards) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const grid = cards.querySelector('.block-chapters');
  const layers = [...grid.querySelectorAll('.block-chapter')];
  let frame = 0;
  let paused = false;
  let focusedIndex = null;
  let activeIndex = 0;
  let pointerFocus = false;
  const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const clamp = value => Math.max(0, Math.min(1, value));
  const setActive = index => {
    activeIndex = Math.max(0, Math.min(layers.length - 1, index));
    cards.dataset.activeCard = String(activeIndex);
    layers.forEach((card, cardIndex) => {
      card.dataset.active = String(cardIndex === activeIndex);
    });
  };
  const clearDeckStyles = () => layers.forEach(card => card.removeAttribute('style'));
  const setState = state => {
    if (cards.dataset.motionState === state) return;
    cards.dataset.motionState = state;
    if (state !== 'scroll') clearDeckStyles();
  };
  const paintDeck = () => {
    const bounds = cards.getBoundingClientRect();
    const stickyTop = parseFloat(getComputedStyle(grid).top) || 0;
    const inset = parseFloat(getComputedStyle(cards).paddingTop);
    const travel = Math.max(1, cards.clientHeight - grid.offsetHeight - inset * 2);
    const progress = clamp((stickyTop - bounds.top - inset) / travel);
    const timeline = progress * (layers.length - 1);
    setActive(Math.round(timeline));
    layers.forEach((card, index) => {
      // A reading beat, then an eased throw; the incoming face stays opaque.
      const turn = Math.floor(timeline);
      const phase = ease((timeline - turn - .18) / .64);
      const position = turn + phase;
      const offset = index - position;
      const direction = index % 2 === 0 ? -1 : 1;
      let x, y, z, rotate, scale, opacity, order;
      if (offset < 0) {
        const tossed = clamp(-offset);
        x = direction * card.offsetWidth * .85 * tossed;
        y = -6 - Math.sin(tossed * Math.PI) * 65 - tossed * 24;
        z = 32 + 32 * Math.sin(tossed * Math.PI);
        rotate = direction * 24 * tossed;
        scale = 1 + .035 * Math.sin(tossed * Math.PI);
        opacity = 1 - ease((tossed - .6) / .3);
        order = tossed < .85 ? 30 : 0;
      } else {
        const depth = Math.min(3, offset);
        x = direction * depth * 8;
        y = depth * 14 - 6;
        z = 32 - depth * 22;
        rotate = direction * depth * 2;
        scale = 1 - depth * .025;
        opacity = 1;
        order = 20 - Math.ceil(depth * 2);
      }
      const values = {
        x: `${x.toFixed(2)}px`, y: `${y.toFixed(2)}px`, z: `${z.toFixed(2)}px`,
        rotate: `${rotate.toFixed(2)}deg`, scale: scale.toFixed(4),
        opacity: opacity.toFixed(3), order, face: offset < 0 || index === activeIndex ? 1 : 0,
      };
      Object.entries(values).forEach(([name, value]) => card.style.setProperty(`--deck-${name}`, value));
      card.style.pointerEvents = values.face && opacity > .5 ? 'auto' : 'none';
    });
  };
  const paint = () => {
    frame = 0;
    const state = focusedIndex !== null
      ? 'focused'
      : paused
        ? 'paused'
        : reduce.matches
          ? 'reduced'
          : 'scroll';
    setState(state);
    if (state === 'scroll') paintDeck();
    if (heroArt) {
      const hero = document.querySelector('.hero').getBoundingClientRect();
      const travel = clamp(-hero.top / hero.height);
      heroArt.style.transform = !reduce.matches && !paused
        ? `translateY(${-travel * 16}px) rotate(${travel * -2}deg)`
        : 'none';
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const preference = () => {
    if (motionToggle) motionToggle.hidden = reduce.matches;
    paint();
  };
  motionToggle?.addEventListener('click', () => {
    paused = !paused;
    motionToggle.setAttribute('aria-pressed', String(paused));
    motionToggle.textContent = paused ? 'Resume motion' : 'Pause motion';
    paint();
  });
  const keepFocusVisible = target => requestAnimationFrame(() => {
    if (target !== document.activeElement) return;
    const bounds = target.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > innerHeight) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  });
  grid.addEventListener('pointerdown', () => { pointerFocus = true; });
  document.addEventListener('keydown', () => { pointerFocus = false; });
  grid.addEventListener('focusin', event => {
    // Do not relocate a pointer target between pointerdown and click.
    if (pointerFocus) { pointerFocus = false; return; }
    const card = event.target.closest('.block-chapter');
    focusedIndex = layers.indexOf(card);
    if (focusedIndex >= 0) setActive(focusedIndex);
    paint();
    keepFocusVisible(event.target);
  });
  grid.addEventListener('focusout', event => {
    if (!grid.contains(event.relatedTarget)) {
      focusedIndex = null;
      schedule();
      if (event.relatedTarget instanceof HTMLElement) keepFocusVisible(event.relatedTarget);
    }
  });
  reduce.addEventListener('change', preference);
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  new ResizeObserver(schedule).observe(grid);
  setActive(activeIndex);
  preference();
}
