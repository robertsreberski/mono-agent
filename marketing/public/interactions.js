
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
// A short scroll-led composition: reversible, no wheel interception, no loop.
const story = document.querySelector('[data-block-story]');
if (story) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const toggle = story.querySelector('.blocks-motion');
  const caption = story.querySelector('.block-caption');
  const chapters = [...story.querySelectorAll('.block-chapter')];
  const labels = ['01 / Foundation', '02 / Connections', '03 / Execution', '04 / Continuity'];
  let paused = false;
  let frame = 0;
  const update = () => {
    frame = 0;
    const rect = story.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (innerHeight * .35 - rect.top) / Math.max(1, rect.height - innerHeight * .55)));
    const readingLine = compact.matches ? story.querySelector('.block-visual').getBoundingClientRect().bottom + 24 : innerHeight * .35;
    let active = 0;
    chapters.forEach((chapter, i) => { if (chapter.getBoundingClientRect().top <= readingLine) active = i; });
    caption.textContent = labels[active];
    if (!paused) {
      story.style.setProperty('--block-progress', String(progress));
      story.dataset.phase = String(active);
    }
  };
  const requestUpdate = () => {
    if (reduce.matches || frame) return;
    const rect = story.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) return;
    frame = requestAnimationFrame(update);
  };
  const preference = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    story.dataset.motion = String(!reduce.matches);
    story.dataset.paused = String(paused);
    toggle.hidden = reduce.matches;
    if (!reduce.matches) update();
    else caption.textContent = 'Four layers. One agent.';
  };
  toggle.addEventListener('click', () => {
    paused = !paused;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.textContent = paused ? 'Resume motion' : 'Pause motion';
    preference();
  });
  reduce.addEventListener('change', preference);
  addEventListener('scroll', requestUpdate, { passive:true });
  addEventListener('resize', requestUpdate, { passive:true });
  preference();
}
