// @ts-check
// The mdb Processes panel. The extension (src/vscode/processPanel.ts) posts the process list as
// { type: 'processes', processes: PanelProcess[] }; the panel posts actions back as { type, id, ... }.
(function () {
  'use strict';
  // @ts-ignore acquireVsCodeApi is provided by the webview.
  const vscode = acquireVsCodeApi();

  // ---------------------------------------------------------------------------------------------- DOM helpers

  /**
   * Creates an element. `props` keys starting with "on" add event listeners, `class` sets the class name, anything
   * else is set as an attribute. Children are nodes or strings; strings become text, never HTML.
   * @param {string} tag
   * @param {Record<string, any>} [props]
   * @param {...(Node | string | null | undefined | false)} children
   * @returns {HTMLElement}
   */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('on')) {
        node.addEventListener(key.slice(2), value);
      } else if (key === 'class') {
        node.className = value;
      } else {
        node.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child !== null && child !== undefined && child !== false) {
        node.append(child);
      }
    }
    return node;
  }

  /** @param {string} name a codicon name, such as "debug-pause" */
  function icon(name) {
    return el('i', { class: `codicon codicon-${name}` });
  }

  /**
   * A borderless icon button.
   * @param {string} iconName
   * @param {string} title
   * @param {(event: MouseEvent) => void} onClick
   */
  function iconButton(iconName, title, onClick) {
    const button = el('button', { class: 'icon-button', title, 'aria-label': title, onclick: onClick }, icon(iconName));
    return {
      node: button,
      /** @param {string} name @param {string} label */
      set(name, label) {
        button.replaceChildren(icon(name));
        button.title = label;
        button.setAttribute('aria-label', label);
      },
    };
  }

  /**
   * Makes `container`'s children match `items`, one component per item, keyed by `keyOf`. Components for keys
   * already present are reused and updated, so their DOM (and focus, hover, scroll) survives; new keys get a
   * component from `create`; components whose key is gone are removed.
   * @template T
   * @param {HTMLElement & { components?: Map<string, { node: HTMLElement, update(item: T): void }> }} container
   * @param {T[]} items
   * @param {(item: T) => string} keyOf
   * @param {() => { node: HTMLElement, update(item: T): void }} create
   */
  function syncList(container, items, keyOf, create) {
    const previous = container.components ?? new Map();
    const next = new Map();
    items.forEach((item, index) => {
      const key = keyOf(item);
      const component = previous.get(key) ?? create();
      component.update(item);
      next.set(key, component);
      if (container.children[index] !== component.node) {
        container.insertBefore(component.node, container.children[index] ?? null);
      }
    });
    for (const [key, component] of previous) {
      if (!next.has(key)) {
        component.node.remove();
      }
    }
    container.components = next;
  }

  // ---------------------------------------------------------------------------------------------- components

  /**
   * A popup menu. `open` shows it below an element; clicking an item, clicking elsewhere, or Escape closes it.
   * Items are { label, icon, run } objects, or '-' for a separator.
   */
  const menu = (() => {
    const node = el('div', { class: 'menu', role: 'menu' });
    node.hidden = true;
    document.body.append(node);
    const close = () => { node.hidden = true; };
    document.addEventListener('click', (event) => {
      if (!node.contains(/** @type {Node} */ (event.target))) {
        close();
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
      }
    });
    window.addEventListener('blur', close);
    return {
      /**
       * @param {HTMLElement} anchor
       * @param {Array<'-' | MenuItemAction>} items
       */
      open(anchor, items) {
        const createMenuItem = (/** @type { '-' | MenuItemAction } */ item) => {
          if (!isMenuSeparator(item)) {
            return el('div', { class: 'menu-item', role: 'menuitem', onclick: () => { close(); item.run(); } }, icon(item.icon ?? 'blank'), item.label);
          } else {
            return el('div', { class: 'menu-separator' });
          }
        };
        node.replaceChildren(...items.map((item) => createMenuItem(item)));
        node.hidden = false;
        const box = anchor.getBoundingClientRect();
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        node.style.left = `${Math.max(4, Math.min(box.right - width, window.innerWidth - width - 4))}px`;
        node.style.top = `${box.bottom + height + 2 > window.innerHeight ? Math.max(4, box.top - height - 2) : box.bottom + 2}px`;
      },
    };
  })();

  const MENU_SEPARATOR = '-';

  /**
   * The "…" menu of a process row. Add an entry here, and handle its action in ProcessPanel.menuAction.
   * `when` decides whether the entry is shown for a process.
   * @typedef {{ label: string, icon: string, action: string, when?: (p: any) => boolean } | '-'} MenuItem
   * @typedef {{ label: string, icon?: string, run: () => void}} MenuItemAction
   * @type {Array<'-' | { label: string, icon: string, action: string, when?: (p: any) => boolean }>}
   */
  const PROCESS_MENU = [
    { label: 'Copy pid', icon: 'copy', action: 'copyPid' },
    { label: 'Copy command line', icon: 'copy', action: 'copyCommandLine' },
    MENU_SEPARATOR,
    { label: 'Stop', icon: 'debug-stop', action: 'stop', when: (p) => p.state !== 'exited' },
  ];

  const isMenuSeparator = (/** @type {MenuItem | MenuItemAction} */ str) => str === MENU_SEPARATOR;

  /**
   * One process: `P1  12345  foo bar baz   [pause|continue] […]`, indented by its depth in the fork tree.
   */
  function ProcessRow() {
    /** @type {any} */
    let process;
    const name = el('span', { class: 'name' });
    const pid = el('span', { class: 'pid' });
    const args = el('span', { class: 'args' });
    const run = iconButton('debug-pause', 'Pause', () => {
      vscode.postMessage({ type: process.state === 'stopped' ? 'continue' : 'pause', id: process.id });
    });
    const more = iconButton('ellipsis', 'More actions', (event) => {
      event.stopPropagation();
      const items = PROCESS_MENU.filter((item) => isMenuSeparator(item) || !item.when || item.when(process));
      menu.open(more.node, items.map((item) => (isMenuSeparator(item) ? item : {
        label: item.label, icon: item.icon, run: () => vscode.postMessage({ type: 'menu', id: process.id, action: item.action }),
      })));
    });
    const node = el('div', { class: 'row', role: 'treeitem' }, name, pid, args, el('span', { class: 'actions' }, run.node, more.node));

    return {
      node,
      /** @param {{ process: any, depth: number }} item */
      update({ process: next, depth }) {
        process = next;
        node.style.paddingLeft = `${8 + depth * 16}px`;
        node.classList.toggle('exited', process.state === 'exited');
        node.title = process.argv.join(' ');
        name.textContent = process.name;
        pid.textContent = String(process.pid);
        args.textContent = commandLine(process.argv);
        run.node.hidden = process.state === 'exited';
        if (process.state === 'stopped') {
          run.set('debug-continue', 'Continue');
        } else {
          run.set('debug-pause', 'Pause');
        }
      },
    };
  }

  /** The executable's base name followed by its arguments. */
  function commandLine(/** @type {string[]} */ argv) {
    if (argv.length === 0) {
      return '';
    }
    return [argv[0].split('/').pop(), ...argv.slice(1)].join(' ');
  }

  function Tabs(/** @type {HTMLElement} */rootElement) {
    /** @typedef {{button: HTMLElement, pane: HTMLElement }} Tab */
    let /** @type {Map<string, Tab>} */ entries = new Map();

    let tabHeader = el('div', {class: 'tab'});
    let tabBody = el('div');

    rootElement.append(tabHeader, tabBody);

    let show = (/** @type {string} */ id) => {
      for (const [key, {button, pane}] of entries) {
        const on = key === id;
        button.classList.toggle('active', on);
        button.setAttribute('aria-selected', String(on));
        pane.hidden = !on;
      }

      vscode.setState({ ...(vscode.getState() ?? {}), tab: id });
    };

    return {
      show: show,
      createTab: (/** @type string */ id, /** @type {String} */ label, content) => {
        let tabButton = el('button', {class: 'tablinks', onclick: () => show(id) });
        tabButton.textContent = label;
        tabHeader.appendChild(tabButton);
        let tabPane = el('div', { class: 'tab-content', id: id });
        tabBody.appendChild(tabPane);
        tabPane.hidden = true;

        entries.set(id, { button: tabButton, pane: tabPane });
        return {
          content: content(tabPane)
        };
      },
    };
  }

  // ---------------------------------------------------------------------------------------------- the panel

  const tabs = Tabs(document.getElementById('root'));
  const saved = vscode.getState() ?? {};

  function ProcessTab(/** @type {HTMLElement} */pane) {
    /** @type {any[]} */
    let processes = [];

    let filterText = saved.filter ?? '';

    const filter = /** @type {HTMLInputElement} */ (el('input', {
      class: 'filter', type: 'text', placeholder: 'Filter processes: name, pid or arguments', 'aria-label': 'Filter processes',
      spellcheck: 'false',
    }));
    filter.value = filterText;

    filter.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && filter.value) {
        filter.value = '';
        filter.dispatchEvent(new Event('input'));
      }
    });
    const tree = el('div', { class: 'tree', role: 'tree' });
    const empty = el('div', { class: 'empty' });
    pane.append(el('div', { class: 'filter-row' }, filter), tree, empty);

    /** Every word of the filter must appear in the process's name, pid or command line. */
    function matches(/** @type {any} */ process) {
      const text = `${process.name} ${process.pid} ${process.argv.join(' ')}`.toLowerCase();
      const words = String(filterText).toLowerCase().split(/\s+/).filter((word) => word.length > 0);
      return words.every((word) => text.includes(word));
    }

    /**
     * The processes to show, parents before their children, each with its depth. When filtering, a matching
     * process's ancestors are shown too, so it stays in context.
     */
    function visibleRows() {
      const byId = new Map(processes.map((p) => [p.id, p]));
      const childrenOf = new Map();
      const roots = [];
      for (const p of processes) {
        if (p.parentId && byId.has(p.parentId)) {
          childrenOf.set(p.parentId, [...(childrenOf.get(p.parentId) ?? []), p]);
        } else {
          roots.push(p);
        }
      }
      const shown = new Set();
      for (const p of processes.filter(matches)) {
        for (let at = p; at && !shown.has(at.id); at = byId.get(at.parentId)) {
          shown.add(at.id);
        }
      }
      /** @type {Array<{ process: any, depth: number }>} */
      const rows = [];
      const visit = (/** @type {any} */ p, /** @type {number} */ depth) => {
        if (shown.has(p.id)) {
          rows.push({ process: p, depth });
        }
        for (const child of childrenOf.get(p.id) ?? []) {
          visit(child, depth + 1);
        }
      };
      roots.forEach((p) => visit(p, 0));
      return rows;
    }

    function renderProcessTab() {
      const rows = visibleRows();
      syncList(tree, rows, (row) => row.process.id, ProcessRow);
      empty.textContent = processes.length === 0 ? 'Start an mdb debug session; its processes, including fork children, appear here.'
        : rows.length === 0 ? 'No process matches the filter.' : '';
      empty.hidden = rows.length > 0;
    }

    filter.addEventListener('input', () => {
      filterText = filter.value;
      vscode.setState({ ...(vscode.getState() ?? {}), filter: filterText });
      renderProcessTab();
    });

    return {
      update: (state) => {
        processes = state;
        renderProcessTab();
      },
    };
  }

  // TODO
  function BreakpointsTab(pane) {
    return {
      update: (state) => {},
    };
  }

  let processTab = tabs.createTab('processes', 'Processes', ProcessTab);
  let breakpointsTab = tabs.createTab('breakpoints', 'Breakpoints', BreakpointsTab);

  tabs.show(saved.tab ?? 'processes');

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'processes') {
      processTab.content.update(event.data.processes);
    }
  });
  vscode.postMessage({ type: 'ready' });
}());
