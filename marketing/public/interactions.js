// Progressive enhancement only: no model requests, tracking, or persistence.
const explorer = document.querySelector('[data-workflow-explorer]');
if (explorer) {
  const nav = explorer.querySelector('.workflow-tabs');
  const tabs = [...explorer.querySelectorAll('[data-workflow]')];
  const panels = [...explorer.querySelectorAll('[data-panel]')];
  const activate = (index, focus = false) => {
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
        activate(index);
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
          activate(next, true);
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

// Small pointer-responsive artwork; no scroll hijacking or continuous loop.
const hero = document.querySelector('.hero');
const art = document.querySelector('.hero-art');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
if (hero && art) {
  let frame = 0;
  const reset = () => {
    cancelAnimationFrame(frame);
    art.style.removeProperty('--art-x');
    art.style.removeProperty('--art-y');
  };
  hero.addEventListener('pointermove', (event) => {
    if (motion.matches || !finePointer.matches || event.pointerType !== 'mouse') return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const box = hero.getBoundingClientRect();
      art.style.setProperty('--art-x', `${((event.clientX - box.left) / box.width - 0.5) * 12}px`);
      art.style.setProperty('--art-y', `${((event.clientY - box.top) / box.height - 0.5) * 8}px`);
    });
  });
  hero.addEventListener('pointerleave', reset);
  motion.addEventListener('change', reset);
  finePointer.addEventListener('change', reset);
}
