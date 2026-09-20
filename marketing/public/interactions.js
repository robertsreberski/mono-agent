// Progressive enhancement only: no model requests, tracking, or persistence.
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
  let lastProgress = -1;
  let geometry = null;
  const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const clamp = value => Math.max(0, Math.min(1, value));
  const setActive = index => {
    const next = Math.max(0, Math.min(layers.length - 1, index));
    if (next === activeIndex && cards.dataset.motionState) return;
    activeIndex = next;
    cards.dataset.activeCard = String(activeIndex);
    layers.forEach((card, cardIndex) => {
      card.dataset.active = String(cardIndex === activeIndex);
    });
  };
  const clearDeckStyles = () => layers.forEach(card => card.removeAttribute('style'));
  const setState = state => {
    if (cards.dataset.motionState === state) return;
    cards.dataset.motionState = state;
    geometry = null;
    lastProgress = -1;
    if (state !== 'scroll') clearDeckStyles();
  };
  const paintDeck = () => {
    const bounds = cards.getBoundingClientRect();
    // Batch every layout read before writes; never measure a card mid-paint.
    if (!geometry) {
      const top = parseFloat(getComputedStyle(grid).top) || 0;
      const inset = parseFloat(getComputedStyle(cards).paddingTop);
      geometry = { top, inset, travel: Math.max(1, cards.clientHeight - grid.offsetHeight - inset * 2), width: layers[0].offsetWidth };
    }
    const progress = clamp((geometry.top - bounds.top - geometry.inset) / geometry.travel);
    if (progress === lastProgress) return;
    lastProgress = progress;
    const timeline = progress * (layers.length - 1);
    setActive(Math.round(timeline));
    const turn = Math.floor(timeline);
    const phase = ease((timeline - turn - .18) / .64);
    const position = turn + phase;
    layers.forEach((card, index) => {
      // A reading beat, then an eased throw; the incoming face stays opaque.
      const offset = index - position;
      const direction = index % 2 === 0 ? -1 : 1;
      let x, y, z, rotate, scale, opacity, order;
      if (offset < 0) {
        const tossed = clamp(-offset);
        x = direction * geometry.width * .85 * tossed;
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
      card.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,${z.toFixed(2)}px) rotate(${rotate.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      const alpha = opacity.toFixed(3);
      const face = offset < 0 || index === activeIndex ? '1' : '0';
      const pointer = face === '1' && opacity > .5 ? 'auto' : 'none';
      if (card.style.opacity !== alpha) card.style.opacity = alpha;
      if (card.style.zIndex !== String(order)) card.style.zIndex = String(order);
      if (card.style.getPropertyValue('--deck-face') !== face) card.style.setProperty('--deck-face', face);
      if (card.style.pointerEvents !== pointer) card.style.pointerEvents = pointer;
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
    const hero = heroArt && !compact.matches ? document.querySelector('.hero').getBoundingClientRect() : null;
    setState(state);
    if (state === 'scroll') paintDeck();
    if (hero) {
      const travel = clamp(-hero.top / hero.height);
      heroArt.style.transform = !reduce.matches && !paused
        ? `translateY(${-travel * 16}px) rotate(${travel * -2}deg)`
        : 'none';
    } else if (heroArt) heroArt.style.transform = 'none';
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
  const invalidate = () => { geometry = null; lastProgress = -1; schedule(); };
  addEventListener('resize', invalidate, { passive: true });
  new ResizeObserver(invalidate).observe(grid);
  setActive(activeIndex);
  preference();
}
