'use strict';
// ---------------------------------------------------------------- basics
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const todayStr = () => new Date().toLocaleDateString('sv-SE');
const addDays = (d, n) => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); };
let META = { kinds: [], sources: [], supported: [] };
let BRAINS = [];      // all brains on this machine
let BRAIN = null;     // the active brain: { id, name, type: 'local' | 'azure', inbox, ... }
let current = { view: null, thought: null };
let drawWires = null;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// Brain-specific API calls go to /api/b/<active brain>/...; /api/brains and /api/meta are global.
const apiUrl = url => url.replace(/^\/api\/(?!brains\b|meta\b|b\/)/, () => `/api/b/${encodeURIComponent(BRAIN.id)}/`);

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(apiUrl(url), opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 5000 : 2500);
}
window.addEventListener('unhandledrejection', e => toast(e.reason?.message || String(e.reason), true));

function fmtDate(s) {
  if (!s) return '';
  if (s === todayStr()) return 'Today';
  if (s === addDays(todayStr(), -1)) return 'Yesterday';
  const d = new Date(s.slice(0, 10) + 'T00:00');
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function select(options, value, onchange) {
  const s = h('select', {}, ...options.map(o => h('option', { value: o }, o)));
  s.value = value;
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

function chip(t, onRemove) {
  return h('span', { class: `chip k-${t.kind}` },
    h('a', { href: `#/t/${t.id}` }, t.name),
    onRemove && h('button', { type: 'button', title: 'Remove', onclick: e => { e.preventDefault(); onRemove(); } }, '×'));
}

const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ---------------------------------------------------------------- picker (find or create a thought)
function openPicker(anchor, { placeholder = 'Find or create a thought…', exclude = [], onPick }) {
  closePicker();
  const input = h('input', { placeholder });
  const list = h('div', { class: 'list' });
  const box = h('div', { class: 'picker' }, input, list);
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - 290)) + 'px';
  box.style.top = (r.bottom + 310 > innerHeight ? Math.max(8, r.top - 310) : r.bottom + 4) + 'px';
  let options = [], active = 0, seq = 0;

  async function refresh() {
    const raw = input.value.trim();
    const name = raw.replace(/^@/, '').trim();
    const my = ++seq;
    const res = await api('GET', `/api/thoughts?limit=12&q=${encodeURIComponent(name)}`);
    if (my !== seq) return;
    options = res.filter(t => !exclude.includes(t.id));
    if (name && !res.some(t => t.name.toLowerCase() === name.toLowerCase()))
      options.push({ create: true, name, kind: raw.startsWith('@') ? 'person' : 'topic' });
    active = 0; draw();
  }
  function draw() {
    list.replaceChildren(...options.map((o, i) => h('div', {
      class: (i === active ? 'active ' : '') + (o.create ? 'create' : `kdot k-${o.kind}`),
      onmousedown: e => { e.preventDefault(); choose(o); },
    }, o.create ? `＋ Create ${o.kind} “${o.name}”` : o.name)));
    if (!options.length) list.append(h('div', { class: 'muted' }, 'Type a name…'));
  }
  async function choose(o) {
    if (!o) return;
    const t = o.create ? await api('POST', '/api/thoughts', { name: o.name, kind: o.kind }) : o;
    closePicker();
    onPick(t);
  }
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, options.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(options[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
  });
  const outside = e => { if (!box.contains(e.target)) closePicker(); };
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  box._cleanup = () => document.removeEventListener('mousedown', outside);
  input.focus();
  refresh();
}
function closePicker() { const p = $('.picker'); if (p) { p._cleanup?.(); p.remove(); } }

function addTopicBtn(exclude, onPick, label = '＋ topic') {
  return h('button', { class: 'add', type: 'button', onclick: e => openPicker(e.currentTarget, { exclude, onPick }) }, label);
}

// ---------------------------------------------------------------- modal
function modal(title, content, makeButtons) {
  let bd;
  const close = () => { document.removeEventListener('keydown', onKey); closePicker(); bd.remove(); };
  const box = h('div', { class: 'modal' }, h('h2', {}, title), content,
    h('div', { class: 'buttons' }, h('span', { class: 'muted' }, 'Ctrl+Enter to save · Esc to close'), ...makeButtons(close)));
  bd = h('div', { class: 'backdrop', onmousedown: e => { if (e.target === bd) close(); } }, box);
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); box.querySelector('.buttons button.primary')?.click(); }
  }
  document.addEventListener('keydown', onKey);
  document.body.append(bd);
  return { close, box };
}

// Capture a snippet (chat, mail, transcript, note) — or edit an existing one.
function captureModal({ item = null, thoughts = [] } = {}) {
  const edit = !!item;
  let topics = edit ? [...item.thoughts] : [...thoughts];
  const title = h('input', { value: item?.title || '', placeholder: 'Optional — the first line is used if empty' });
  const source = select(META.sources, item?.source || lsGet('brain.source', 'note'), () => {});
  const date = h('input', { type: 'date', value: item?.occurred_at || todayStr() });
  const people = h('input', { value: item?.people || '', placeholder: 'Who was involved (comma separated)' });
  const body = h('textarea', { value: item?.body || '', placeholder: 'Paste the chat, mail, transcript or note…' });
  const chips = h('div', { class: 'card-foot' });
  const drawChips = () => chips.replaceChildren(
    ...topics.map(t => chip(t, () => { topics = topics.filter(x => x.id !== t.id); drawChips(); })),
    addTopicBtn(topics.map(t => t.id), t => { topics.push(t); drawChips(); }, '＋ attach to topic / person'));
  drawChips();

  const alsoCb = h('input', { type: 'checkbox', title: 'Also create an action' });
  const alsoTitle = h('input', { placeholder: 'Also create an action: I need to…' });
  const alsoDue = h('input', { type: 'date', title: 'Due date' });
  alsoTitle.addEventListener('input', () => (alsoCb.checked = !!alsoTitle.value.trim()));

  const form = h('div', { class: 'form' },
    h('label', { class: 'wide' }, 'Title', title),
    h('label', {}, 'Source', source),
    h('label', {}, 'Date', date),
    h('label', {}, 'People', people),
    h('label', { class: 'wide' }, 'Content', body),
    h('div', { class: 'wide' }, h('div', { class: 'muted', style: 'font-size:12px' }, 'Topics'), chips),
    !edit && h('div', { class: 'also wide' }, alsoCb, alsoTitle, alsoDue));

  const { close } = modal(`${edit ? 'Edit item' : 'Capture'} · ${brainLabel()}`, form, close => [
    h('button', { onclick: close }, 'Cancel'),
    h('button', { class: 'primary', onclick: () => save(close) }, edit ? 'Save' : 'Save'),
  ]);
  (edit ? title : body).focus();

  async function save(close) {
    const data = { title: title.value, source: source.value, occurred_at: date.value || todayStr(), people: people.value, body: body.value, thoughtIds: topics.map(t => t.id) };
    if (!data.title.trim() && !data.body.trim()) return toast('Nothing to save', true);
    lsSet('brain.source', data.source);
    if (edit) {
      await api('PATCH', `/api/items/${item.id}`, data);
      toast('Saved');
    } else {
      const it = await api('POST', '/api/items', data);
      if (alsoCb.checked && alsoTitle.value.trim())
        await api('POST', '/api/actions', { title: alsoTitle.value, due: alsoDue.value || null, item_id: it.id, thoughtIds: data.thoughtIds });
      toast(topics.length ? 'Saved and filed under ' + topics.map(t => t.name).join(', ') : 'Saved to Inbox');
    }
    close();
    render();
  }
}

function actionModal({ title = '', item = null, thoughts = [] } = {}) {
  let topics = [...thoughts];
  const t = h('input', { value: title, placeholder: 'What needs to happen?' });
  const due = h('input', { type: 'date' });
  const owner = h('input', { placeholder: 'me' });
  const status = select(['open', 'waiting'], 'open', () => {});
  const chips = h('div', { class: 'card-foot' });
  const drawChips = () => chips.replaceChildren(
    ...topics.map(x => chip(x, () => { topics = topics.filter(y => y.id !== x.id); drawChips(); })),
    addTopicBtn(topics.map(x => x.id), x => { topics.push(x); drawChips(); }));
  drawChips();
  const form = h('div', { class: 'form' },
    h('label', { class: 'wide' }, 'Action', t),
    h('label', {}, 'Due', due), h('label', {}, 'Owner', owner), h('label', {}, 'Status', status),
    h('div', { class: 'wide' }, h('div', { class: 'muted', style: 'font-size:12px' }, 'Topics'), chips),
    item && h('div', { class: 'wide muted' }, `From: ${item.title}`));
  modal('New action', form, close => [
    h('button', { onclick: close }, 'Cancel'),
    h('button', { class: 'primary', onclick: async () => {
      if (!t.value.trim()) return toast('Action needs a title', true);
      await api('POST', '/api/actions', { title: t.value, due: due.value || null, owner: owner.value, status: status.value, item_id: item?.id, thoughtIds: topics.map(x => x.id) });
      toast('Action added'); close(); render();
    } }, 'Add action'),
  ]);
  t.focus(); t.select();
}

async function openItem(id) { captureModal({ item: await api('GET', `/api/items/${id}`) }); }

// ---------------------------------------------------------------- shared components
// ---------------------------------------------------------------- search highlighting
const termRegex = terms => terms?.length
  ? new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'giu')
  : null;
// Text with every search term wrapped in <mark> (DOM nodes, never HTML strings).
function highlight(text, terms) {
  const re = termRegex(terms);
  text = String(text ?? '');
  if (!re) return [text];
  const out = []; let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('mark', {}, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
// Up to `max` short excerpts around the matches in a long text.
function snippets(text, terms, max = 3, radius = 70) {
  const re = termRegex(terms);
  if (!re || !text) return [];
  const out = []; let until = -1;
  for (const m of text.matchAll(re)) {
    if (m.index < until) continue;
    let from = Math.max(0, m.index - radius), to = Math.min(text.length, m.index + m[0].length + radius);
    if (from > 0) { const sp = text.indexOf(' ', from); if (sp > 0 && sp < m.index) from = sp + 1; }
    if (to < text.length) { const sp = text.lastIndexOf(' ', to); if (sp > m.index + m[0].length) to = sp; }
    out.push((from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : ''));
    until = to;
    if (out.length >= max) break;
  }
  return out;
}

function itemCard(it, { inbox = false, terms = null } = {}) {
  let card, lastSel = '';
  const body = h('div', { class: 'card-body' }, highlight(it.body, terms));
  const long = it.body.split('\n').length > 6 || it.body.length > 600;
  const found = long && terms ? snippets(it.body, terms) : [];
  const more = long && h('button', { class: 'link', onclick: () => {
    body.classList.toggle('open'); more.textContent = body.classList.contains('open') ? 'Show less' : 'Show more';
  } }, 'Show more');
  const selectionIn = () => { const s = getSelection(); return s && !s.isCollapsed && card.contains(s.anchorNode) ? s.toString().trim().slice(0, 300) : ''; };
  card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('span', { class: 'badge' }, it.source),
      h('span', { class: 'muted' }, fmtDate(it.occurred_at)),
      h('span', { class: 'card-title' }, highlight(it.title, terms)),
      it.people && h('span', { class: 'muted' }, '· ', highlight(it.people, terms))),
    found.length > 0 && h('div', { class: 'snippets', title: 'Where your search terms occur in this item' },
      found.map(s => h('div', {}, highlight(s, terms)))),
    it.file && /\.(png|jpe?g)$/i.test(it.file) && h('a', { href: apiUrl(`/api/items/${it.id}/file`), target: '_blank', title: 'Open image' },
      h('img', { class: 'thumb', src: apiUrl(`/api/items/${it.id}/file`), alt: it.title, loading: 'lazy' })),
    it.body && body, more,
    h('div', { class: 'card-foot' },
      it.file && h('a', { class: 'from', href: apiUrl(`/api/items/${it.id}/file`), target: '_blank', title: 'Open the original file' }, '📎 ', highlight(it.file.replace(/^\d+-/, ''), terms)),
      ...it.thoughts.map(t => chip(t, async () => { await api('DELETE', `/api/items/${it.id}/thoughts/${t.id}`); render(); })),
      addTopicBtn(it.thoughts.map(t => t.id), async t => { await api('POST', `/api/items/${it.id}/thoughts/${t.id}`); render(); }),
      h('span', { class: 'spacer' }),
      it.openActions ? h('span', { class: 'muted' }, `☐ ${it.openActions} open action${it.openActions > 1 ? 's' : ''}`) : null,
      h('button', { class: 'link', title: 'Create an action from this item (select text first to use it as the title)',
        onmousedown: () => (lastSel = selectionIn()),
        onclick: () => actionModal({ title: lastSel || it.title, item: it, thoughts: it.thoughts }) }, '→ Action'),
      h('button', { class: 'link', onclick: () => captureModal({ item: it }) }, 'Edit'),
      h('button', { class: 'link danger', onclick: async () => {
        if (confirm(`Delete "${it.title}"?`)) { await api('DELETE', `/api/items/${it.id}`); render(); }
      } }, 'Delete'),
      inbox && it.thoughts.length > 0 && h('button', { title: 'Keep the topics attached above and remove from the Inbox', onclick: async () => {
        await api('PATCH', `/api/items/${it.id}`, { status: 'filed' }); toast('Removed from Inbox'); render();
      } }, '✓ Done'),
      inbox && h('button', { class: 'primary', title: 'Attach to a topic/person and remove from the Inbox', onclick: e => openPicker(e.currentTarget, {
        placeholder: 'Move to topic / person… (@Name = person)',
        exclude: it.thoughts.map(t => t.id),
        onPick: async t => {
          await api('POST', `/api/items/${it.id}/thoughts/${t.id}`);
          await api('PATCH', `/api/items/${it.id}`, { status: 'filed' });
          toast(`Moved to “${t.name}”`); render();
        } }) }, 'Move to…')));
  return card;
}

function actionRow(a) {
  const overdue = a.status !== 'done' && a.due && a.due < todayStr();
  const save = async (patch, rerender) => { await api('PATCH', `/api/actions/${a.id}`, patch); Object.assign(a, patch); rerender ? render() : refreshSide(); };
  const cb = h('input', { type: 'checkbox', checked: a.status === 'done', title: 'Done', onchange: () => save({ status: cb.checked ? 'done' : 'open' }, true) });
  const title = h('input', { class: 't', value: a.title, onchange: () => save({ title: title.value }) });
  const due = h('input', { type: 'date', class: 'due', value: a.due || '', title: 'Due date', onchange: () => save({ due: due.value || null }, true) });
  const owner = h('input', { class: 'owner', value: a.owner, placeholder: 'owner: me', onchange: () => save({ owner: owner.value }) });
  return h('div', { class: `act${a.status === 'done' ? ' done' : ''}${overdue ? ' overdue' : ''}` },
    cb, title,
    h('button', { class: 'link danger', title: 'Delete action', onclick: async () => {
      if (confirm(`Delete action "${a.title}"?`)) { await api('DELETE', `/api/actions/${a.id}`); render(); }
    } }, '×'),
    h('div', { class: 'meta' }, due, owner, select(['open', 'waiting', 'done'], a.status, v => save({ status: v }, true)),
      ...a.thoughts.map(t => chip(t, async () => { await api('DELETE', `/api/actions/${a.id}/thoughts/${t.id}`); render(); })),
      addTopicBtn(a.thoughts.map(t => t.id), async t => { await api('POST', `/api/actions/${a.id}/thoughts/${t.id}`); render(); }),
      a.item_id && h('a', { class: 'from', href: '#', title: `Source: ${a.item_title}`, onclick: e => { e.preventDefault(); openItem(a.item_id); } }, `↳ ${a.item_title}`)));
}

function bucket(a) {
  const t = todayStr();
  if (!a.due) return 'No due date';
  if (a.due < t) return 'Overdue';
  if (a.due === t) return 'Today';
  if (a.due <= addDays(t, 7)) return 'Next 7 days';
  return 'Later';
}
function groupedActions(list) {
  const order = ['Overdue', 'Today', 'Next 7 days', 'Later', 'No due date'];
  const groups = Object.groupBy ? Object.groupBy(list, bucket) : list.reduce((g, a) => ((g[bucket(a)] ||= []).push(a), g), {});
  return order.filter(k => groups[k]).flatMap(k => [
    h('div', { class: `group-title${k === 'Overdue' ? ' overdue' : ''}` }, `${k} (${groups[k].length})`),
    ...groups[k].map(actionRow)]);
}

// ---------------------------------------------------------------- links to documents / web pages
const LINK_ICON = { onedrive: '☁️', teams: '💬', web: '🌐', file: '📄' };
function linkIcon(l) {
  const ext = (l.url.split(/[?#]/)[0].match(/\.(\w{2,5})$/) || [])[1]?.toLowerCase();
  return { docx: '📝', doc: '📝', xlsx: '📊', xls: '📊', pptx: '📽️', ppt: '📽️', pdf: '📕', one: '📓' }[ext] || LINK_ICON[l.kind] || '🔗';
}
function openFileLink(l, reveal = false) {
  return api('POST', `/api/weblinks/${l.id}/open`, { reveal }).catch(e => toast(e.message, true));
}
function linkRow(l, { showThought = false } = {}) {
  const sub = l.kind === 'file' ? l.url : (() => { try { const u = new URL(l.url); return u.hostname.replace(/^www\./, ''); } catch { return l.url; } })();
  const titleEl = l.kind === 'file'
    ? h('a', { href: '#', class: 'wl-title', title: `Open ${l.url}`, onclick: e => { e.preventDefault(); openFileLink(l); } }, l.title)
    : h('a', { href: l.url, class: 'wl-title', target: '_blank', rel: 'noopener noreferrer', title: l.url }, l.title);
  return h('div', { class: 'wl' },
    h('span', { class: 'wl-icon' }, linkIcon(l)),
    h('div', { class: 'wl-main' }, titleEl, h('div', { class: 'wl-sub', title: l.url }, sub),
      showThought && h('div', {}, chip({ id: l.thought_id, name: l.thought_name, kind: l.thought_kind }))),
    h('div', { class: 'wl-tools' },
      l.kind === 'file' && h('button', { class: 'link', title: 'Show in folder', onclick: () => openFileLink(l, true) }, '📂'),
      h('button', { class: 'link', title: 'Copy link', onclick: async () => { try { await navigator.clipboard.writeText(l.url); toast('Link copied'); } catch { toast('Could not copy', true); } } }, '⧉'),
      h('button', { class: 'link', title: 'Rename', onclick: async () => {
        const t = prompt('Title for this link', l.title);
        if (t !== null) { await api('PATCH', `/api/weblinks/${l.id}`, { title: t }); render(); }
      } }, '✎'),
      h('button', { class: 'link danger', title: 'Remove link', onclick: async () => {
        if (confirm(`Remove link "${l.title}"?`)) { await api('DELETE', `/api/weblinks/${l.id}`); render(); }
      } }, '×')));
}
function linksPanel(d) {
  const url = h('input', { placeholder: 'Paste a OneDrive/SharePoint link, web address or file path' });
  const title = h('input', { placeholder: 'Title (optional — guessed from the link)' });
  const add = async (u = url.value, t = title.value) => {
    if (!u.trim()) return url.focus();
    try { await api('POST', `/api/thoughts/${d.id}/weblinks`, { url: u, title: t }); toast('Link added'); render(); }
    catch (e) { toast(e.message, true); }
  };
  for (const el of [url, title]) el.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  const panel = h('section', { class: 'panel links-panel' },
    h('h3', {}, `Links (${d.weblinks.length})`),
    d.weblinks.length ? d.weblinks.map(l => linkRow(l)) : h('div', { class: 'empty' }, 'No links yet. Paste one below, or drag a link from your browser onto this box.'),
    h('div', { class: 'wl-add' }, url, title, h('button', { onclick: () => add() }, 'Add link')));
  // accept links dragged from a browser tab / address bar
  const isLink = e => [...(e.dataTransfer?.types || [])].some(t => t === 'text/uri-list' || t === 'text/plain') && ![...e.dataTransfer.types].includes('Files');
  panel.addEventListener('dragover', e => { if (isLink(e)) { e.preventDefault(); panel.classList.add('drag'); } });
  panel.addEventListener('dragleave', () => panel.classList.remove('drag'));
  panel.addEventListener('drop', e => {
    if (!isLink(e)) return;
    e.preventDefault(); panel.classList.remove('drag');
    const u = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n').find(s => s.trim() && !s.startsWith('#'));
    if (u) add(u.trim(), '');
  });
  return panel;
}

// ---------------------------------------------------------------- views
async function renderThought(idParam) {
  const d = await api('GET', `/api/thoughts/${idParam}`);
  current.thought = { id: d.id, name: d.name, kind: d.kind };
  document.title = `${d.name} · Brain`;

  const node = (t, rel) => h('a', { class: `node k-${t.kind}`, href: `#/t/${t.id}`, 'data-rel': rel, title: t.name },
    t.name,
    rel !== 'sibling' && h('span', { class: 'x', title: 'Unlink', onclick: async e => {
      e.preventDefault(); e.stopPropagation();
      await api('DELETE', `/api/links/${d.id}/${t.id}`); render();
    } }, '×'));
  const linkBtn = (rel, label) => h('button', { class: 'add', title: `Link a ${rel} thought`, onclick: e => openPicker(e.currentTarget, {
    exclude: [d.id], onPick: async t => { await api('POST', '/api/links', { from: d.id, to: t.id, rel }); render(); } }) }, label);
  const zone = (cls, label, list, rel, btn) => h('div', { class: `zone ${cls}` },
    h('div', { class: 'zone-label' }, label, btn), ...list.map(t => node(t, rel)));

  const nameIn = h('input', { class: 'name', value: d.name, title: 'Click to rename' });
  nameIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') nameIn.blur();
    if (e.key === 'Escape') { nameIn.value = d.name; nameIn.blur(); }
  });
  nameIn.addEventListener('change', async () => {
    try { await api('PATCH', `/api/thoughts/${d.id}`, { name: nameIn.value }); d.name = nameIn.value.trim(); toast('Renamed'); refreshSide(); }
    catch (e) { nameIn.value = d.name; toast(e.message, true); }
  });
  const center = h('div', { class: `center k-${d.kind}` }, nameIn,
    h('div', { class: 'row' },
      select(META.kinds, d.kind, async v => { await api('PATCH', `/api/thoughts/${d.id}`, { kind: v }); render(); }),
      d.isHome ? h('span', { class: 'muted' }, '⌂ home')
        : h('button', { class: 'link', onclick: async () => { await api('POST', `/api/thoughts/${d.id}/home`); toast('Home thought set'); render(); } }, 'Make home'),
      !d.isHome && h('button', { class: 'link danger', onclick: async () => {
        if (!confirm(`Delete thought "${d.name}"? Linked items and actions are kept.`)) return;
        await api('DELETE', `/api/thoughts/${d.id}`); location.hash = '#/';
      } }, 'Delete')));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wires');
  const plex = h('div', { class: 'plex' }, svg,
    zone('parents', 'Parents', d.parents, 'parent', linkBtn('parent', '＋')),
    zone('jumps', 'Jumps', d.jumps, 'jump', linkBtn('jump', '＋')),
    center,
    zone('siblings', d.siblings.length ? 'Siblings' : '', d.siblings, 'sibling'),
    zone('children', 'Children', d.children, 'child', linkBtn('child', '＋')));

  drawWires = () => {
    const pr = plex.getBoundingClientRect(), c = center.getBoundingClientRect();
    const P = (x, y) => `${(x - pr.left).toFixed(1)},${(y - pr.top).toFixed(1)}`;
    svg.replaceChildren();
    for (const n of plex.querySelectorAll('.node[data-rel]')) {
      const r = n.getBoundingClientRect(), rel = n.dataset.rel;
      let dAttr;
      if (rel === 'parent' || rel === 'child') {
        const [ax, ay] = [c.left + c.width / 2, rel === 'parent' ? c.top : c.bottom];
        const [bx, by] = [r.left + r.width / 2, rel === 'parent' ? r.bottom : r.top];
        const my = (ay + by) / 2;
        dAttr = `M${P(ax, ay)} C${P(ax, my)} ${P(bx, my)} ${P(bx, by)}`;
      } else if (rel === 'jump') {
        const [ax, ay, bx, by] = [c.left, c.top + c.height / 2, r.right, r.top + r.height / 2];
        const mx = (ax + bx) / 2;
        dAttr = `M${P(ax, ay)} C${P(mx, ay)} ${P(mx, by)} ${P(bx, by)}`;
      } else continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', dAttr);
      if (rel === 'jump') path.setAttribute('class', 'jump');
      svg.append(path);
    }
  };

  // notes
  const notes = h('textarea', { class: 'notes', value: d.notes, placeholder: 'What do I need to know about this? Key facts, decisions, context…' });
  const saved = h('span', { class: 'saved' });
  let notesTimer;
  notes.addEventListener('input', () => {
    saved.textContent = 'editing…'; clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => { await api('PATCH', `/api/thoughts/${d.id}`, { notes: notes.value }); saved.textContent = 'saved'; }, 600);
  });

  const openActs = d.actions.filter(a => a.status !== 'done');
  const doneActs = d.actions.filter(a => a.status === 'done');
  const doneBox = h('div', { hidden: true }, ...doneActs.map(actionRow));
  const here = [current.thought];

  main.replaceChildren(plex, h('div', { class: 'detail' },
    h('section', { class: 'panel' }, h('h3', {}, 'Notes', saved), notes),
    h('section', { class: 'panel' },
      h('h3', {}, `Actions (${openActs.length})`, h('button', { class: 'add', onclick: () => actionModal({ thoughts: here }) }, '＋ action')),
      openActs.length ? openActs.map(actionRow) : h('div', { class: 'empty' }, 'No open actions.'),
      doneActs.length && h('button', { class: 'link', onclick: e => { doneBox.hidden = !doneBox.hidden; e.target.textContent = (doneBox.hidden ? 'Show' : 'Hide') + ` ${doneActs.length} done`; } }, `Show ${doneActs.length} done`),
      doneBox)),
    h('div', { class: 'detail detail-2' },
      h('section', { class: 'panel' },
        h('h3', {}, `Timeline (${d.items.length})`, h('button', { class: 'add', onclick: () => captureModal({ thoughts: here }) }, '＋ capture here')),
        d.items.length ? d.items.map(it => itemCard(it)) : h('div', { class: 'empty' }, 'Nothing captured for this thought yet. Press c, or drop a file here to attach it.')),
      linksPanel(d)));
  requestAnimationFrame(drawWires);
}

async function renderInbox() {
  const items = await api('GET', '/api/items?status=inbox');
  document.title = 'Inbox · Brain';
  main.replaceChildren(
    h('h2', {}, `Inbox (${items.length})`),
    h('p', { class: 'muted' }, 'Everything captured but not yet triaged. Attach each item to topics or people, turn the to-dos into actions, then ✓ File it.'),
    ...(items.length ? items.map(it => itemCard(it, { inbox: true }))
      : [h('div', { class: 'empty' }, `Inbox zero. Capture with c, drop files on this page, or save files into ${BRAIN.inbox}`)]));
}

async function renderActions(tab) {
  const list = await api('GET', `/api/actions?status=${tab}`);
  document.title = 'Actions · Brain';
  const quick = h('input', { placeholder: tab === 'waiting' ? 'Add something you are waiting for… (Enter)' : 'Add an action… (Enter)' });
  quick.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !quick.value.trim()) return;
    await api('POST', '/api/actions', { title: quick.value, status: tab === 'waiting' ? 'waiting' : 'open' });
    render();
  });
  const tabs = [['open', 'Open'], ['waiting', 'Waiting for'], ['done', 'Done'], ['all', 'All']];
  main.replaceChildren(
    h('h2', {}, 'Actions'),
    h('div', { class: 'tabs' }, ...tabs.map(([k, label]) => h('button', { class: k === tab ? 'on' : '', onclick: () => (location.hash = `#/actions/${k}`) }, label))),
    h('div', { class: 'quick', hidden: tab === 'done' || tab === 'all' }, quick),
    h('section', { class: 'panel' },
      !list.length ? h('div', { class: 'empty' }, 'Nothing here.')
        : tab === 'done' || tab === 'all' ? list.map(actionRow) : groupedActions(list)));
  if (tab !== 'done' && tab !== 'all') quick.focus();
}

async function renderSearch(q) {
  const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
  document.title = `Search · Brain`;
  $('#search').value = q;
  const count = k => `${r[k].length}${r.more[k] ? '+' : ''}`;
  const moreNote = k => r.more[k] && h('div', { class: 'muted', style: 'margin:-10px 0 18px' }, `Showing the first ${r[k].length}. Add more words to narrow the search.`);
  const total = r.thoughts.length + r.items.length + r.actions.length + r.weblinks.length;
  main.replaceChildren(
    h('h2', {}, `Search: “${q}”`),
    h('div', { class: 'muted', style: 'margin:-6px 0 16px' },
      r.terms.length > 1 ? ['Results contain all of: ', ...r.terms.flatMap((t, i) => [i ? ', ' : '', h('mark', {}, t)])] : null,
      r.terms.length > 1 ? ' · ' : null,
      total ? `${count('thoughts')} thoughts · ${count('items')} items · ${count('actions')} actions · ${count('weblinks')} links`
        : 'Nothing found. Try fewer or shorter words.'),
    h('h3', {}, `Thoughts (${count('thoughts')})`),
    h('div', { class: 'card-foot', style: 'margin-bottom:18px' }, r.thoughts.length ? r.thoughts.map(t => chip(t)) : h('span', { class: 'empty' }, 'None')),
    h('h3', { title: 'Everything captured: pasted text, mails, transcripts, and the text read from PDFs and images' }, `Items (${count('items')})`),
    ...(r.items.length ? r.items.map(it => itemCard(it, { inbox: it.status === 'inbox', terms: r.terms })) : [h('div', { class: 'empty', style: 'margin-bottom:18px' }, 'None')]),
    moreNote('items'),
    h('h3', { style: 'margin-top:18px' }, `Actions (${count('actions')})`),
    h('section', { class: 'panel', style: 'margin-bottom:18px' }, r.actions.length ? r.actions.map(actionRow) : h('div', { class: 'empty' }, 'None')),
    moreNote('actions'),
    h('h3', {}, `Links (${count('weblinks')})`),
    h('section', { class: 'panel', style: 'margin-bottom:18px' }, r.weblinks.length ? r.weblinks.map(l => linkRow(l, { showThought: true })) : h('div', { class: 'empty' }, 'None')));
}

// ---------------------------------------------------------------- routing & sidebar
function parseRoute() {
  const [a, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 't' && rest[0]) return { view: 'thought', id: rest[0] };
  if (a === 'inbox') return { view: 'inbox' };
  if (a === 'actions') return { view: 'actions', tab: ['open', 'waiting', 'done', 'all'].includes(rest[0]) ? rest[0] : 'open' };
  if (a === 'search') return { view: 'search', q: decodeURIComponent(rest.join('/')) };
  return { view: 'thought', id: 'home' };
}

async function render() {
  const r = parseRoute();
  const sameThought = r.view === 'thought' && current.thought && String(current.thought.id) === r.id;
  const scroll = scrollY;
  current = { view: r.view, thought: r.view === 'thought' ? current.thought : null };
  drawWires = null;
  closePicker();
  const navKey = r.view === 'thought' ? (r.id === 'home' ? 'home' : '') : r.view;
  document.querySelectorAll('.side [data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === navKey));
  try {
    if (r.view === 'thought') await renderThought(r.id);
    else if (r.view === 'inbox') await renderInbox();
    else if (r.view === 'actions') await renderActions(r.tab);
    else if (r.view === 'search') await renderSearch(r.q);
    if (sameThought || r.view !== 'thought') scrollTo(0, scroll);
  } catch (e) {
    main.replaceChildren(h('div', { class: 'empty' }, e.message), h('a', { href: '#/' }, 'Go home'));
  }
  refreshSide();
}

async function refreshSide() {
  let s;
  try { s = await api('GET', '/api/stats'); } catch { return; }   // e.g. cloud brain temporarily unreachable
  const ci = $('#c-inbox'), ca = $('#c-actions');
  ci.textContent = s.inbox || '';
  ca.textContent = s.open ? (s.overdue ? `${s.overdue}! / ${s.open}` : s.open) : '';
  ca.className = 'count' + (s.overdue ? ' alert' : '');
  ca.title = `${s.open} open, ${s.waiting} waiting, ${s.overdue} overdue`;
  $('#recent').replaceChildren(...s.recent.map(t => h('a', { href: `#/t/${t.id}`, class: `kdot k-${t.kind}`, title: t.name }, t.name)));
}

window.addEventListener('hashchange', render);
window.addEventListener('resize', () => drawWires && drawWires());

// ---------------------------------------------------------------- header search
(() => {
  const input = $('#search'), box = $('#search-suggest');
  let opts = [], active = 0, seq = 0, timer = null, terms = [];
  // Options: "search everything", matching thoughts, then items whose text contains the words.
  const go = o => {
    box.hidden = true; input.blur();
    location.hash = o.search || o.item ? `#/search/${encodeURIComponent(o.q)}` : `#/t/${o.id}`;
  };
  const row = o => o.search ? `🔍 Search everything for “${o.q}”`
    : o.item ? h('span', { class: 'sugg-item' },
        h('span', {}, '📄 ', highlight(o.item.title || '(untitled)', terms), h('span', { class: 'muted' }, ` · ${o.item.source} · ${fmtDate(o.item.occurred_at)}`)),
        o.snippet && h('span', { class: 'muted sugg-snip' }, highlight(o.snippet, terms)))
    : o.name;
  const draw = () => {
    const nodes = [];
    opts.forEach((o, i) => {
      if (o.item && !opts[i - 1]?.item) nodes.push(h('div', { class: 'sugg-head' }, 'Items containing these words'));
      nodes.push(h('div', { class: (i === active ? 'active ' : '') + (o.search || o.item ? '' : `kdot k-${o.kind}`), onmousedown: e => { e.preventDefault(); go(o); } }, row(o)));
    });
    box.replaceChildren(...nodes);
    box.hidden = !opts.length;
  };
  input.addEventListener('input', () => {
    const q = input.value.trim(), my = ++seq;
    clearTimeout(timer);
    if (!q) { opts = []; return draw(); }
    timer = setTimeout(async () => {
      const [res, found] = await Promise.all([
        api('GET', `/api/thoughts?limit=8&q=${encodeURIComponent(q)}`),
        api('GET', `/api/search?limit=5&q=${encodeURIComponent(q)}`).catch(() => null),
      ]);
      if (my !== seq) return;
      terms = found?.terms || [];
      const items = (found?.items || []).map(it => ({ item: it, q, snippet: snippets(it.body, terms, 1, 50)[0] }));
      opts = [{ search: true, q }, ...res, ...items];
      active = res.length && res[0].name.toLowerCase() === q.toLowerCase() ? 1 : 0;
      draw();
    }, 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, opts.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      // Suggestions may still be loading or belong to older text: then just search.
      go(opts[0]?.q === q && opts[active] ? opts[active] : { search: true, q });
    }
    else if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 100));
})();

// ---------------------------------------------------------------- capture button, shortcuts, file drop
$('#capture-btn').addEventListener('click', () => captureModal({ thoughts: current.thought ? [current.thought] : [] }));

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return;
  if ($('.backdrop') || $('.picker')) return;
  const keys = {
    c: () => captureModal({ thoughts: current.thought ? [current.thought] : [] }),
    '/': () => $('#search').focus(),
    i: () => (location.hash = '#/inbox'),
    a: () => (location.hash = '#/actions'),
    h: () => (location.hash = '#/'),
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

(() => {
  const drop = $('#drop');
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    depth++;
    $('#drop-target').textContent = `${brainLabel()} → ${current.thought ? `attached to “${current.thought.name}”` : 'Inbox'}`;
    drop.hidden = false;
  });
  addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.hidden = true; } });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; drop.hidden = true;
    const tid = current.thought?.id;
    let ok = 0; const failed = [];
    const files = [...e.dataTransfer.files];
    if (files.some(f => /\.(pdf|png|jpe?g)$/i.test(f.name))) toast(`Importing ${files.length} file(s)… reading text from images/PDFs can take a few seconds`);
    for (const f of files) {
      const r = await fetch(apiUrl(`/api/import?name=`) + `${encodeURIComponent(f.name)}${tid ? `&thought=${tid}` : ''}`, { method: 'POST', body: f });
      if (r.ok) ok++; else failed.push(`${f.name}: ${(await r.json().catch(() => ({}))).error || r.statusText}`);
    }
    if (failed.length) toast(`Imported ${ok}. Failed: ${failed.join('; ')}`, true);
    else toast(`Imported ${ok} file${ok === 1 ? '' : 's'}${tid ? ` into “${current.thought.name}”` : ' to the Inbox'}`);
    render();
  });
})();

// ---------------------------------------------------------------- brains: switcher, new brain, manage
const brainIcon = b => (b.type === 'local' ? '💻' : '☁️');
const brainLabel = (b = BRAIN) => `${brainIcon(b)} ${b.name}`;
const brainWhere = b => b.type === 'local' ? `Local (SQLite on this computer): ${b.db}` : `Azure SQL: ${b.server} / ${b.database}`;

function drawBrainSwitch() {
  document.documentElement.dataset.brainType = BRAIN.type;
  $('#brain-switch').replaceChildren(h('button', {
    class: `brain-btn ${BRAIN.type}`, title: `${brainWhere(BRAIN)}\nInbox folder: ${BRAIN.inbox}\nClick to switch brain`,
    onclick: e => openBrainMenu(e.currentTarget),
  }, brainLabel(), ' ▾'));
}

function openBrainMenu(anchor) {
  closePicker();
  const item = (label, cls, fn) => h('div', { class: cls, onmousedown: e => { e.preventDefault(); closePicker(); fn(); } }, label);
  const box = h('div', { class: 'picker menu' }, h('div', { class: 'list' },
    ...BRAINS.map(b => item(brainLabel(b) + (b.id === BRAIN.id ? '  ✓' : ''), b.id === BRAIN.id ? 'active' : '', () => switchBrain(b.id))),
    h('hr'),
    item('＋ New brain…', 'create', newBrainModal),
    item('⚙ Manage brains…', '', manageBrainsModal)));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - 290)) + 'px';
  box.style.top = r.bottom + 4 + 'px';
  const outside = e => { if (!box.contains(e.target)) closePicker(); };
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  box._cleanup = () => document.removeEventListener('mousedown', outside);
}

function switchBrain(id) {
  BRAIN = BRAINS.find(b => b.id === id) || BRAINS[0];
  lsSet('brain.current', BRAIN.id);
  current = { view: null, thought: null };
  $('#search').value = '';
  drawBrainSwitch();
  if (location.hash === '' || location.hash === '#/' || location.hash === '#') render(); else location.hash = '#/';
}

async function reloadBrains(selectId) {
  BRAINS = await api('GET', '/api/brains');
  switchBrain(selectId && BRAINS.some(b => b.id === selectId) ? selectId : (BRAINS.find(b => b.id === BRAIN?.id) || BRAINS[0]).id);
}

function newBrainModal() {
  const name = h('input', { placeholder: 'e.g. Personal brain' });
  const typeLocal = h('input', { type: 'radio', name: 'btype', value: 'local', checked: true });
  const typeAzure = h('input', { type: 'radio', name: 'btype', value: 'azure' });
  const server = h('input', { placeholder: 'myserver.database.windows.net' });
  const database = h('input', { placeholder: 'brain' });
  const auth = h('select', {}, h('option', { value: 'entra' }, 'Microsoft account (Entra ID)'), h('option', { value: 'sql' }, 'SQL login (user + password)'));
  const tenantId = h('input', { placeholder: 'Optional: tenant ID or domain of your personal Azure (e.g. contoso.onmicrosoft.com)' });
  const user = h('input', { placeholder: 'SQL user', autocomplete: 'off' });
  const password = h('input', { type: 'password', placeholder: 'Password (stored encrypted with Windows DPAPI)', autocomplete: 'new-password' });
  const inbox = h('input', { placeholder: 'Default: inbox-<name> in the app folder' });
  const entraBox = h('label', { class: 'wide' }, 'Tenant', tenantId);
  const sqlBox = h('div', { class: 'wide form', style: 'grid-template-columns:1fr 1fr' }, h('label', {}, 'User', user), h('label', {}, 'Password', password));
  const azureBox = h('div', { class: 'wide form', style: 'grid-template-columns:1fr 1fr' },
    h('label', {}, 'Server', server), h('label', {}, 'Database', database),
    h('label', { class: 'wide' }, 'Sign-in', auth), entraBox, sqlBox,
    h('p', { class: 'wide muted', style: 'margin:0;font-size:12px' },
      'Microsoft account: sign in once with Azure CLI (az login --tenant <tenant>) or VS Code. ',
      'Make sure the Azure SQL firewall allows this computer’s IP address.'));
  const note = h('p', { class: 'wide muted', style: 'margin:0;font-size:12px' });
  const sync = () => {
    const az = typeAzure.checked;
    azureBox.hidden = !az;
    entraBox.hidden = auth.value !== 'entra';
    sqlBox.hidden = auth.value !== 'sql';
    note.textContent = az
      ? '☁️ Stored in your Azure SQL database, so you can open it from every laptop where you add it. Original files are stored in the database too.'
      : '💻 Stored only on this computer in a SQLite file. A local brain never uses the cloud.';
  };
  for (const el of [typeLocal, typeAzure, auth]) el.addEventListener('change', sync);
  sync();
  const form = h('div', { class: 'form' },
    h('label', { class: 'wide' }, 'Name', name),
    h('div', { class: 'wide brain-type' },
      h('label', {}, typeLocal, ' 💻 Local (this computer only)'),
      h('label', {}, typeAzure, ' ☁️ Azure SQL (cloud, shared between laptops)')),
    note, azureBox,
    h('label', { class: 'wide' }, 'Inbox folder (watched for new files)', inbox));
  let saving = false;
  modal('New brain', form, close => {
    const btn = h('button', { class: 'primary', onclick: async () => {
      if (saving) return;
      saving = true; btn.disabled = true; btn.textContent = typeAzure.checked ? 'Connecting… (a paused database can take a minute)' : 'Creating…';
      try {
        const b = await api('POST', '/api/brains', {
          name: name.value, type: typeAzure.checked ? 'azure' : 'local', inbox: inbox.value,
          server: server.value, database: database.value, auth: auth.value, tenantId: tenantId.value, user: user.value, password: password.value,
        });
        toast(`Brain “${b.name}” created`);
        close();
        await reloadBrains(b.id);
      } catch (e) { toast(e.message, true); }
      finally { saving = false; btn.disabled = false; btn.textContent = 'Create brain'; }
    } }, 'Create brain');
    return [h('button', { onclick: close }, 'Cancel'), btn];
  });
  name.focus();
}

function manageBrainsModal() {
  const rows = BRAINS.map(b => {
    const name = h('input', { value: b.name });
    const inbox = h('input', { value: b.inbox });
    const pw = b.type === 'azure' && b.auth === 'sql' ? h('input', { type: 'password', placeholder: 'New SQL password (leave empty to keep)', autocomplete: 'new-password' }) : null;
    return h('div', { class: 'brain-row' },
      h('div', { class: 'brain-row-head' }, h('b', {}, brainLabel(b)), b.id === BRAIN.id && h('span', { class: 'badge' }, 'active')),
      h('div', { class: 'muted', style: 'font-size:12px;word-break:break-all' }, brainWhere(b)),
      h('div', { class: 'form', style: 'grid-template-columns:1fr 2fr;margin-top:6px' },
        h('label', {}, 'Name', name), h('label', {}, 'Inbox folder', inbox), pw && h('label', { class: 'wide' }, 'Password', pw)),
      h('div', { class: 'card-foot' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'link danger', onclick: async () => {
          if (!confirm(`Remove “${b.name}” from this computer's list?\n\nThe data itself is NOT deleted (${b.type === 'local' ? 'the SQLite file stays on disk' : 'the Azure database is untouched'}). You can add it again later.`)) return;
          try { await api('DELETE', `/api/brains/${encodeURIComponent(b.id)}`); toast('Removed from list'); closeAll(); await reloadBrains(); } catch (e) { toast(e.message, true); }
        } }, 'Remove from list'),
        h('button', { onclick: async () => {
          try {
            await api('PATCH', `/api/brains/${encodeURIComponent(b.id)}`, { name: name.value, inbox: inbox.value, ...(pw && pw.value ? { password: pw.value } : {}) });
            toast('Saved'); closeAll(); await reloadBrains();
          } catch (e) { toast(e.message, true); }
        } }, 'Save')));
  });
  let closeAll = () => {};
  const m = modal('Manage brains', h('div', {}, ...rows), close => [h('button', { onclick: close }, 'Close')]);
  closeAll = m.close;
}

// ---------------------------------------------------------------- start
(async () => {
  META = await api('GET', '/api/meta');
  BRAINS = await api('GET', '/api/brains');
  BRAIN = BRAINS.find(b => b.id === lsGet('brain.current', '')) || BRAINS[0];
  drawBrainSwitch();
  render();
  setInterval(refreshSide, 15000); // picks up files imported by the folder watcher
})();
