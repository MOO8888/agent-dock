const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const validSize = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
export const LAYOUT_KEY = 'dock-layout';
export const SPLITTER_SIZE = 8;
const sizeKeys = ['sidebar', 'monitor', 'overview', 'composer', 'preview', 'directory'];

export function paneWidths(appWidth, viewportWidth, preferences = {}, visibility = {}) {
  const compact = visibility.compact ?? viewportWidth <= 650;
  const monitorInline = visibility.monitorInline ?? viewportWidth > 900;
  const defaults = { sidebar: viewportWidth <= 1100 ? 200 : 224, monitor: viewportWidth >= 1600 ? 320 : viewportWidth <= 1100 ? 255 : 290 };
  const sidebarMin = 176;
  const sidebarMax = Math.max(sidebarMin, Math.floor(Math.min(420, appWidth - SPLITTER_SIZE - 320 - (monitorInline ? 220 + SPLITTER_SIZE : 0))));
  const sidebar = compact ? 64 : Math.round(clamp(validSize(preferences.sidebar) ? preferences.sidebar : defaults.sidebar, sidebarMin, sidebarMax));
  const monitorMax = monitorInline
    ? Math.max(220, Math.floor(Math.min(520, appWidth - sidebar - SPLITTER_SIZE * 2 - 320)))
    : Math.max(160, Math.floor(Math.min(520, viewportWidth - 32)));
  const monitorMin = Math.min(220, monitorMax);
  const monitor = Math.round(clamp(validSize(preferences.monitor) ? preferences.monitor : defaults.monitor, monitorMin, monitorMax));
  return { sidebar, monitor, sidebarMin, sidebarMax, monitorMin, monitorMax, defaults, sidebarVisible: !compact, monitorVisible: monitorInline || !!visibility.monitorOpen };
}

// Reserve space for the neighbouring pane; shrinking the window never rewrites saved sizes.
export function paneHeight(available, minimum, reserved, preferred, fallback) {
  const space = Math.max(0, Number.isFinite(available) ? available : 0);
  const max = Math.max(0, space - reserved - SPLITTER_SIZE);
  const min = Math.min(minimum, max);
  const value = validSize(preferred) ? preferred : validSize(fallback) ? fallback : min;
  return { min, max, value: clamp(value, min, max) };
}

export function readLayout(storage) {
  try {
    const data = JSON.parse(storage.getItem(LAYOUT_KEY));
    if (data?.version !== 1) return {};
    return Object.fromEntries(sizeKeys.filter(key => validSize(data[key])).map(key => [key, data[key]]));
  } catch { return {}; }
}

export function initResizableWorkspace({ app, storage = localStorage }) {
  let preferences = readLayout(storage), layout = {}, drag = null;
  const find = selector => app.querySelector(selector);
  const handles = [...app.querySelectorAll('[data-resize]')];
  const verticalPanes = { overview: find('#project-overview'), composer: find('#composer'), preview: find('#screen'), directory: find('#directory-projects') };
  const visible = node => !!node && !!node.getClientRects().length;
  const innerHeight = node => {
    const style = getComputedStyle(node);
    return node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  };
  const outerHeight = node => {
    const style = getComputedStyle(node);
    return node.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  };
  const save = () => { try { storage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, ...preferences })); } catch { /* Resizing works without browser storage. */ } };

  function applyHeight(key, available, minimum, reserved) {
    const pane = verticalPanes[key];
    if (!visible(pane)) return;
    // Measure the natural height when resetting, instead of reusing the last explicit size.
    if (!validSize(preferences[key])) app.style.removeProperty('--' + key + '-height');
    const fallback = key === 'preview' ? 166 : pane.getBoundingClientRect().height;
    const bounds = paneHeight(available, minimum, reserved, preferences[key], fallback);
    layout[key] = bounds.value; layout[key + 'Min'] = bounds.min; layout[key + 'Max'] = bounds.max;
    app.style.setProperty('--' + key + '-height', bounds.value + 'px');
  }

  function apply() {
    const compact = window.matchMedia('(max-width: 650px)').matches;
    const monitorInline = !window.matchMedia('(max-width: 900px)').matches;
    // CSS and JavaScript use the same media queries, including fractional widths at browser zoom.
    layout = paneWidths(app.clientWidth, window.innerWidth, preferences, { compact, monitorInline, monitorOpen: find('.monitor').classList.contains('mobile-open') });
    app.style.setProperty('--sidebar-width', layout.sidebar + 'px');
    app.style.setProperty('--monitor-width', layout.monitor + 'px');
    if (visible(verticalPanes.overview)) applyHeight('overview', find('#project-view').clientHeight, 160, 240);
    if (visible(verticalPanes.composer)) {
      const activity = find('#execution-activity'),route=find('#workflow-route');
      const controls=['.message-mode','#agent-controls','#attachment-drafts','.composer-footer'].reduce((height,selector)=>{const el=find(selector);return height+(visible(el)?outerHeight(el):0);},0);
      applyHeight('composer', innerHeight(find('#chat-pane')) - (visible(activity) ? outerHeight(activity) : 0)-(visible(route)?outerHeight(route):0), Math.max(112,controls+34), 60);
    }
    if (visible(verticalPanes.preview)) {
      const monitor = find('.monitor');
      const above = ['.monitor-heading', '.monitor-title', '.monitor-select'].reduce((sum, selector) => sum + outerHeight(find(selector)), 0);
      applyHeight('preview', innerHeight(monitor) - above, 120, 160);
    }
    const sidebar = find('.sidebar');
    const fixed = [...sidebar.children].filter(node => node !== verticalPanes.directory && node !== find('#directory-team'));
    const available = innerHeight(sidebar) - fixed.reduce((sum, node) => sum + outerHeight(node), 0) - parseFloat(getComputedStyle(sidebar).rowGap) * (sidebar.children.length - 1);
    // The directory splitter itself was included above, so add its gap back before applying bounds.
    applyHeight('directory', available + SPLITTER_SIZE, 90, 100);
    for (const handle of handles) {
      const key = handle.dataset.resize, active = visible(handle) && layout[key + 'Max'] > layout[key + 'Min'];
      handle.setAttribute('aria-valuemin', Math.round(layout[key + 'Min'] || 0));
      handle.setAttribute('aria-valuemax', Math.round(layout[key + 'Max'] || 0));
      handle.setAttribute('aria-valuenow', Math.round(layout[key] || 0));
      handle.setAttribute('aria-valuetext', Math.round(layout[key] || 0) + ' 像素');
      handle.setAttribute('aria-disabled', String(!active));
      handle.tabIndex = active ? 0 : -1;
    }
  }

  function change(key, value) {
    preferences[key] = clamp(value, layout[key + 'Min'], layout[key + 'Max']);
    apply();
  }
  function finish(cancel = false) {
    if (!drag) return;
    const finished = drag; drag = null;
    if (cancel) { preferences = finished.before; apply(); } else save();
    document.body.classList.remove('resizing-width', 'resizing-height');
    finished.handle.classList.remove('dragging');
    if (finished.handle.hasPointerCapture(finished.pointerId)) finished.handle.releasePointerCapture(finished.pointerId);
  }

  for (const handle of handles) {
    const key = handle.dataset.resize, horizontal = handle.getAttribute('aria-orientation') === 'horizontal';
    const coordinate = event => horizontal ? event.clientY : event.clientX;
    const sign = ['monitor', 'composer'].includes(key) ? -1 : 1;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || handle.tabIndex < 0) return;
      if (drag) finish();
      event.preventDefault();
      drag = { key, handle, pointerId: event.pointerId, start: coordinate(event), size: layout[key], before: { ...preferences } };
      handle.setPointerCapture(event.pointerId); handle.focus(); handle.classList.add('dragging');
      document.body.classList.add(horizontal ? 'resizing-height' : 'resizing-width');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || drag.handle !== handle || drag.pointerId !== event.pointerId) return;
      change(key, drag.size + (coordinate(event) - drag.start) * sign);
    });
    handle.addEventListener('pointerup', () => finish());
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish());
    handle.addEventListener('dblclick', () => { delete preferences[key]; apply(); save(); });
    handle.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { finish(true); return; }
      const previous = horizontal ? 'ArrowUp' : 'ArrowLeft', next = horizontal ? 'ArrowDown' : 'ArrowRight';
      if (![previous, next, 'Home', 'End', 'Enter'].includes(event.key) || handle.tabIndex < 0) return;
      event.preventDefault();
      if (event.key === 'Enter') delete preferences[key];
      else if (event.key === 'Home') change(key, layout[key + 'Min']);
      else if (event.key === 'End') change(key, layout[key + 'Max']);
      else change(key, layout[key] + (event.shiftKey ? 32 : 16) * (event.key === next ? 1 : -1) * sign);
      apply(); save();
    });
  }
  window.addEventListener('resize', () => { if (drag) finish(); apply(); });
  window.addEventListener('blur', () => finish());
  apply();
  return { refresh: apply };
}
