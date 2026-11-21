// Progressive enhancement for the homepage example folder and copy buttons.
// Without JavaScript the server-rendered native disclosures stay complete.
function enhanceFolder() {
  const fallback = document.querySelector('.folder-fallback');
  const window_ = document.querySelector('.folder-window');
  if (!fallback || !window_) return;
  const nav = window_.querySelector('.folder-nav');
  const view = window_.querySelector('.folder-view');
  const compact = matchMedia('(max-width: 660px)');
  const root = 'payments-maintainer/';
  const parent = (path) => path.split('/').slice(0, -1).join('/');
  const name = (path) => path.split('/').at(-1);
  const model = new Map();
  for (const src of fallback.querySelectorAll('[data-path]')) {
    model.set(src.dataset.path, { ...src.dataset, text: src.querySelector(':scope > pre')?.textContent });
  }
  // Root order follows the server-rendered disclosures (private rows are a note instead).
  const order = [...fallback.querySelectorAll(':scope > details[data-path]:not([data-kind="private"])')].map((node) => node.dataset.path);
  const children = (dir) => dir === '' ? order.map((key) => model.get(key)) :
    [...model.values()].filter((entry) => parent(entry.path) === dir);
  const primary = order.slice(0, 5);
  const expanded = new Set();
  let selected = 'IDENTITY.md', active = selected, dir = '', trail = [];
  let mobileFile = null, moreOpen = false;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function art(id) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'pen-art'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', `#folio-${id}`); svg.append(use);
    return svg;
  }
  function rowIcon(folder) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'row-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', folder
      ? 'M2.8 6.8 3 4.8l6.2-.1 2.2 2.6 9.3.2-.3 11.5-17.7-.2Z M3.1 9.3l17.3.1'
      : 'M5.2 2.8 14.5 3l4.5 4.3-.3 13.7-13.7.1Z M14.3 3.2l.4 4.7 4.1-.2 M8.5 11.8l6.9-.1 M8.4 15.2l6.8.1');
    svg.append(path);
    return svg;
  }
  const displayPath = (entry) => name(entry.path) + (entry.kind === 'dir' ? '/' : '');
  function row(entry, tag) {
    const node = el(tag, 'folder-row');
    if (tag === 'button') node.type = 'button';
    node.dataset.key = entry.path;
    const label = el('span', 'folder-row-copy');
    label.append(el('code', 'file-name', displayPath(entry)));
    if (entry.role) label.append(el('span', 'file-role', entry.role));
    node.append(rowIcon(entry.kind === 'dir'), label);
    if (tag === 'button' || entry.kind === 'dir') {
      const arrow = el('span', 'file-chevron');
      arrow.setAttribute('aria-hidden', 'true');
      node.append(arrow);
    }
    return node;
  }
  function showFile(entry) {
    const page = el('article', 'file-page paper-object');
    const heading = el('header', 'file-head');
    const title = el('h3', 'file-title', displayPath(entry));
    title.tabIndex = -1;
    const text = el('div', 'file-heading');
    text.append(el('p', 'file-role', entry.role), title, el('p', 'file-note', entry.note));
    heading.append(art(({ '01':'config','02':'role','03':'skill','04':'folder','05':'cron','06':'tools','07':'cron' })[entry.number] ?? 'role'), text);
    const pre = el('pre', 'file-text'); pre.append(el('code', '', entry.text));
    page.append(heading, pre);
    view.replaceChildren(page);
    view.hidden = false;
    if (compact.matches) {
      view.prepend(backButton()); view.append(backButton());
      focusHeading(title);
    }
  }
  function keepNote() {
    const note = el('p', 'folder-private');
    note.append(el('strong', '', 'Kept on your machine: '), el('code', '', '.env'), ' (keys and sign-ins), ', el('code', '', '.mono-agent/'), ' (conversations, memory, logs).');
    return note;
  }
  function focusedTree(key) {
    const items = [...nav.querySelectorAll('[role="treeitem"]')];
    const next = items.find((item) => item.dataset.key === key && !item.closest('[hidden]'));
    if (!next) return;
    items.forEach((item) => { item.tabIndex = item === next ? 0 : -1; });
    active = key;
    next.focus();
  }
  function desktop() {
    nav.hidden = false;
    const tree = el('ul', 'folder-tree');
    tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Example folder files');
    function add(list, directory) {
      for (const entry of children(directory)) {
        const item = el('li', 'tree-item'); item.dataset.key = entry.path;
        item.setAttribute('role', 'treeitem'); item.setAttribute('aria-label', displayPath(entry));
        item.tabIndex = entry.path === active ? 0 : -1;
        const leaf = row(entry, 'span'); delete leaf.dataset.key;
        const isDir = entry.kind === 'dir';
        item.append(leaf); list.append(item);
        let group;
        if (isDir) {
          group = el('ul', 'tree-group'); group.setAttribute('role', 'group');
          group.hidden = !expanded.has(entry.path); item.setAttribute('aria-expanded', String(!group.hidden));
          add(group, entry.path); item.append(group);
        } else item.setAttribute('aria-selected', String(selected === entry.path));
        function activate() {
          if (isDir) {
            group.hidden = !group.hidden;
            item.setAttribute('aria-expanded', String(!group.hidden));
            if (group.hidden) expanded.delete(entry.path); else expanded.add(entry.path);
          } else {
            nav.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
            item.setAttribute('aria-selected', 'true'); selected = entry.path; showFile(entry);
          }
          focusedTree(entry.path);
        }
        leaf.onclick = activate;
        item.onkeydown = (event) => {
          if (event.target !== item) return;
          const visible = [...tree.querySelectorAll('[role="treeitem"]')].filter((node) => !node.closest('[hidden]'));
          const i = visible.indexOf(item);
          let next;
          switch (event.key) {
            case 'ArrowDown': next = visible[i + 1]; break;
            case 'ArrowUp': next = visible[i - 1]; break;
            case 'Home': next = visible[0]; break;
            case 'End': next = visible.at(-1); break;
            case 'ArrowRight': if (group?.hidden) activate(); else if (group) next = visible[i + 1]; break;
            case 'ArrowLeft': if (group && !group.hidden) activate(); else next = item.parentElement.closest('[role="treeitem"]'); break;
            case ' ': case 'Enter': activate(); break;
            default: return;
          }
          event.preventDefault(); if (next) focusedTree(next.dataset.key);
        };
      }
    }
    add(tree, ''); nav.replaceChildren(tree, keepNote());
    if (!tree.querySelector('[tabindex="0"]:not([hidden] *)')) tree.querySelector('[role="treeitem"]').tabIndex = 0;
    showFile(model.get(selected));
  }
  function focusHeading(node) {
    node.focus({ preventScroll: true });
    const back = window_.querySelector('.folder-view:not([hidden]) .explorer-back, .folder-nav:not([hidden]) .explorer-back');
    if (!back) return;
    const rect = back.getBoundingClientRect();
    if (rect.top < 16 || rect.bottom > innerHeight * .75) back.scrollIntoView({ block: 'start' });
  }
  // The page's hand-drawn tab arrow, mirrored in CSS: never an arrow glyph.
  function backArrow() {
    const svg = document.querySelector('.tab-arrow').cloneNode(true);
    svg.setAttribute('class', 'back-arrow');
    return svg;
  }
  function backButton() {
    const previous = trail.at(-1)?.dir ?? '';
    const back = el('button', 'explorer-back');
    back.type = 'button'; back.onclick = backToList;
    back.append(backArrow(), `Back to ${previous ? `${name(previous)}/` : root}`);
    return back;
  }
  function backToList() {
    const previous = trail.pop();
    if (!previous) return;
    dir = previous.dir; mobileFile = null;
    phone();
    [...nav.querySelectorAll('[data-key]')].find((node) => node.dataset.key === previous.key)?.focus({ preventScroll: true });
    scrollTo(0, previous.y);
  }
  function phone(focus = false) {
    if (mobileFile) { nav.hidden = true; showFile(mobileFile); return; }
    nav.hidden = false; view.hidden = true;
    nav.replaceChildren();
    if (dir) nav.append(backButton());
    const heading = el('h3', 'folder-crumb', dir ? `${dir}/` : 'Files in this folder');
    heading.tabIndex = -1; nav.append(heading);
    function list(entries) {
      const ul = el('ul', 'phone-files');
      for (const entry of entries) {
        const button = row(entry, 'button'), li = el('li'); li.append(button); ul.append(li);
        button.onclick = () => {
          if (!dir) moreOpen = nav.querySelector('.more-files').open;
          trail.push({ dir, key: entry.path, y: scrollY });
          if (entry.kind === 'dir') dir = entry.path; else mobileFile = entry;
          phone(true);
        };
      }
      return ul;
    }
    nav.append(list(dir ? children(dir) : primary.map((key) => model.get(key))));
    if (!dir) {
      const more = el('details', 'more-files'); more.open = moreOpen;
      more.ontoggle = () => { if (more.isConnected) moreOpen = more.open; };
      more.append(el('summary', '', 'More files'), list(order.slice(primary.length).map((key) => model.get(key))));
      nav.append(more, keepNote());
    }
    if (focus) focusHeading(heading);
  }
  function render() { if (compact.matches) phone(); else desktop(); }
  // Build while the native disclosures are still available, then swap once ready.
  render(); fallback.hidden = true; window_.hidden = false;
  compact.addEventListener('change', () => { dir = ''; trail = []; mobileFile = null; render(); });
}

enhanceFolder();

const copyStatus = document.querySelector('.copy-status');
let copyReset;
let copyGeneration = 0;
const copyButtons = [...document.querySelectorAll('.copy-command')];
if (copyButtons.length) copyStatus.hidden = false;
for (const button of copyButtons) {
  const code = button.parentElement.querySelector('code');
  button.hidden = false;
  button.addEventListener('click', async () => {
    const ticket = ++copyGeneration;
    clearTimeout(copyReset);
    copyButtons.forEach((target) => { target.textContent = 'Copy'; });
    copyStatus.textContent = '';
    const command = code.textContent;
    let ok = false;
    try { await navigator.clipboard.writeText(command); ok = true; } catch {
      if (ticket !== copyGeneration) return;
      const field = document.createElement('textarea');
      field.value = command; field.readOnly = true; field.style.position = 'fixed'; field.style.inset = '0 auto auto -9999px';
      document.body.append(field); field.select();
      try { ok = document.execCommand('copy'); } catch { /* Select the visible command instead. */ }
      field.remove(); button.focus({ preventScroll: true });
    }
    if (ticket !== copyGeneration) return;
    if (ok) {
      button.textContent = 'Copied'; copyStatus.textContent = 'Copied';
      copyReset = setTimeout(() => { button.textContent = 'Copy'; copyStatus.textContent = ''; }, 1800);
    } else {
      const range = document.createRange(); range.selectNodeContents(code);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      copyStatus.textContent = 'Couldn’t copy — the command is selected';
    }
  });
}
