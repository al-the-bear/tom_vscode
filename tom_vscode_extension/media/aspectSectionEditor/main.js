// @ts-nocheck
/*
 * Guideline Sections client (gsel7, P-4). The host
 * (src/handlers/aspectSectionEditor-handler.ts) posts `data`: every section of
 * _ai/aspect_guidelines/ as it is on disk ({ id, name, label, placement,
 * defaultOption, options: [{ name, text }], problems }). The page edits a
 * section as a draft — kept per section while another is shown — and Save
 * posts the draft as a whole; the host writes section.yaml and the option
 * files and answers with the data (`saved`: that draft is done). Sections are
 * added, renamed and deleted through the host (it asks).
 *
 * Each draft option keeps the name it has on disk (`origin`); Save sends the
 * options renamed in the draft as `renames` (old name → new name), and the host
 * carries the stored choices over (gsel7b) and answers what it rewrote
 * (`carried`), shown above the form.
 */
const vscode = acquireVsCodeApi();
const INIT = window.__INIT__ || {};
if (INIT.codiconsUri) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = INIT.codiconsUri;
  document.head.appendChild(link);
}

let data = { sections: [] };
let selected = INIT.selected || (vscode.getState() || {}).selected || '';
/** Unsaved drafts by section id. */
let drafts = {};
/** What the last rename carried over (the host's `carried`), shown until another section is picked. */
let carried = '';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function onDisk(id) { return (data.sections || []).find(function(s) { return s.id === id; }); }

function copyOf(s) {
  return { id: s.id, name: s.name, label: s.label, placement: s.placement, defaultOption: s.defaultOption, options: s.options.map(function(o) { return { name: o.name, text: o.text, origin: o.name }; }) };
}

/** The options renamed in the draft: { name on disk: new name }, those with a name on disk and a new name only. */
function renamesOf(d) {
  const renames = {};
  d.options.forEach(function(o) {
    const to = o.name.trim();
    if (o.origin && to && to !== o.origin) { renames[o.origin] = to; }
  });
  return renames;
}

/** The draft of the selected section (made on first look). */
function draft() {
  const s = onDisk(selected);
  if (!s) { return undefined; }
  if (!drafts[selected]) { drafts[selected] = copyOf(s); }
  return drafts[selected];
}

function isDirty(id) {
  const d = drafts[id];
  const s = onDisk(id);
  return !!(d && s && JSON.stringify(d) !== JSON.stringify(copyOf(s)));
}

function select(id) {
  if (id !== selected) { carried = ''; }
  selected = id;
  vscode.setState({ selected: id });
  render();
}

function renderList() {
  const list = document.getElementById('sectionList');
  list.innerHTML = (data.sections || []).map(function(s) {
    const d = drafts[s.id] || s;
    return '<li role="option" data-id="' + escapeHtml(s.id) + '" class="' + (s.id === selected ? 'active' : '') + '" title="' + escapeHtml(s.id + (d.name ? ' — ' + d.name : '')) + '">'
      + '<span>' + escapeHtml(s.id) + '</span>'
      + (d.name && d.name !== s.id ? '<span class="sub">' + escapeHtml(d.name) + '</span>' : '')
      + (isDirty(s.id) ? '<span class="dirty" title="Unsaved changes">\u25cf</span>' : '')
      + (s.problems && s.problems.length ? '<span class="codicon codicon-warning warn" title="' + escapeHtml(s.problems.join('\n')) + '"></span>' : '')
      + '</li>';
  }).join('');
  list.querySelectorAll('li').forEach(function(li) { li.addEventListener('click', function() { select(li.dataset.id); }); });
  const has = !!onDisk(selected);
  document.getElementById('btnRename').disabled = !has;
  document.getElementById('btnDelete').disabled = !has;
}

function defaultOptionsHtml(d) {
  const names = d.options.map(function(o) { return o.name; }).filter(function(n) { return n; });
  return '<option value="">(none: nothing unless a level chooses)</option>' + names.map(function(n) {
    return '<option value="' + escapeHtml(n) + '"' + (n === d.defaultOption ? ' selected' : '') + '>' + escapeHtml(n) + '</option>';
  }).join('');
}

function optionHtml(o, i, count, d) {
  return '<div class="option" data-index="' + i + '">'
    + '<div class="option-head">'
    + '<input type="text" class="opt-name" placeholder="short name (the file name, e.g. brief)" value="' + escapeHtml(o.name) + '" aria-label="Option short name">'
    + (o.name && o.name === d.defaultOption ? '<span class="is-default">default</span>' : '')
    + '<button class="icon-btn opt-up" title="Move up"' + (i === 0 ? ' disabled' : '') + '><span class="codicon codicon-arrow-up"></span></button>'
    + '<button class="icon-btn opt-down" title="Move down"' + (i === count - 1 ? ' disabled' : '') + '><span class="codicon codicon-arrow-down"></span></button>'
    + '<button class="icon-btn opt-delete" title="Delete the option (its file goes with Save)"><span class="codicon codicon-trash"></span></button>'
    + '</div>'
    + '<textarea class="opt-text" spellcheck="false" aria-label="Option text">' + escapeHtml(o.text) + '</textarea>'
    + '</div>';
}

function render() {
  renderList();
  const form = document.getElementById('form');
  if (data.error) { form.innerHTML = '<p class="error">' + escapeHtml(data.error) + '</p>'; return; }
  const s = onDisk(selected);
  const d = draft();
  if (!s || !d) {
    form.innerHTML = '<p class="muted">' + ((data.sections || []).length ? 'Pick a section on the left.' : 'No sections yet: add one with +.') + '</p>';
    return;
  }
  form.innerHTML = (carried ? '<div class="hint carried" role="status"><span class="codicon codicon-check"></span> ' + escapeHtml(carried) + '</div>' : '')
    + '<div class="field"><label class="title">Section</label><div>' + escapeHtml(s.id) + ' <span class="muted">(_ai/aspect_guidelines/' + escapeHtml(s.id) + '/)</span></div>'
    + '<div class="hint">The short name every level\'s choice names; rename it with the pencil above the list (the choices stored on every level follow).</div></div>'
    + (s.problems && s.problems.length ? '<ul class="problems">' + s.problems.map(function(p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul>' : '')
    + '<div class="row">'
    + '<div class="field"><label class="title" for="secName">Name</label><input type="text" id="secName" value="' + escapeHtml(d.name) + '" placeholder="e.g. Answer mode"></div>'
    + '<div class="field"><label class="title" for="secLabel">Short label</label><input type="text" id="secLabel" value="' + escapeHtml(d.label) + '" placeholder="' + escapeHtml(d.name || 'the name') + '"><div class="hint">In the buttons\' hover help (Answer: brief). Empty: the name.</div></div>'
    + '</div><div class="row">'
    + '<div class="field"><label class="title" for="secPlacement">Placement</label><select id="secPlacement">'
    + '<option value="system"' + (d.placement !== 'user' ? ' selected' : '') + '>System prompt</option>'
    + '<option value="user"' + (d.placement === 'user' ? ' selected' : '') + '>User prompt (before the prompt text)</option>'
    + '</select><div class="hint">Copilot has no system prompt: there both go before the prompt text.</div></div>'
    + '<div class="field"><label class="title" for="secDefault">Default option</label><select id="secDefault">' + defaultOptionsHtml(d) + '</select>'
    + '<div class="hint">Chosen when no level chooses.</div></div>'
    + '</div>'
    + '<div class="field"><label class="title">Options</label>'
    + '<div class="hint">Each option is &lt;short name&gt;.md: Markdown; placeholders (${guidelines-…}, ${file-…} …) are resolved when the text is sent. "remove" is no option name: it is the levels\' Remove.</div>'
    + '<div id="options">' + d.options.map(function(o, i) { return optionHtml(o, i, d.options.length, d); }).join('') + '</div>'
    + '<button class="secondary" id="btnAddOption"><span class="codicon codicon-add"></span> Add option</button></div>'
    + '<div class="save-row"><button class="primary" id="btnSave">Save</button><button class="secondary" id="btnRevert">Revert</button><span class="muted">Ctrl/Cmd+S</span></div>';
  wireForm(d);
}

function changed() { renderList(); }

function wireForm(d) {
  const form = document.getElementById('form');
  document.getElementById('secName').addEventListener('input', function(e) { d.name = e.target.value; changed(); });
  document.getElementById('secLabel').addEventListener('input', function(e) { d.label = e.target.value; changed(); });
  document.getElementById('secPlacement').addEventListener('change', function(e) { d.placement = e.target.value; changed(); });
  document.getElementById('secDefault').addEventListener('change', function(e) { d.defaultOption = e.target.value; render(); });
  form.querySelectorAll('.option').forEach(function(block) {
    const i = Number(block.dataset.index);
    block.querySelector('.opt-name').addEventListener('input', function(e) {
      const before = d.options[i].name;
      d.options[i].name = e.target.value;
      // The default follows its option's new name.
      if (before && before === d.defaultOption) { d.defaultOption = e.target.value.trim(); }
      document.getElementById('secDefault').innerHTML = defaultOptionsHtml(d);
      changed();
    });
    block.querySelector('.opt-text').addEventListener('input', function(e) { d.options[i].text = e.target.value; changed(); });
    block.querySelector('.opt-up').addEventListener('click', function() { move(d, i, -1); });
    block.querySelector('.opt-down').addEventListener('click', function() { move(d, i, 1); });
    block.querySelector('.opt-delete').addEventListener('click', function() {
      const gone = d.options.splice(i, 1)[0];
      if (gone && gone.name === d.defaultOption) { d.defaultOption = ''; }
      render();
    });
  });
  document.getElementById('btnAddOption').addEventListener('click', function() {
    d.options.push({ name: '', text: '', origin: '' });
    render();
    const names = document.querySelectorAll('.opt-name');
    if (names.length) { names[names.length - 1].focus(); }
  });
  document.getElementById('btnSave').addEventListener('click', save);
  document.getElementById('btnRevert').addEventListener('click', function() { delete drafts[selected]; render(); });
}

function move(d, i, by) {
  const j = i + by;
  if (j < 0 || j >= d.options.length) { return; }
  const o = d.options.splice(i, 1)[0];
  d.options.splice(j, 0, o);
  render();
}

function save() {
  const d = draft();
  if (!d) { return; }
  const renames = renamesOf(d);
  const message = { type: 'save', section: { id: d.id, name: d.name, label: d.label, placement: d.placement, defaultOption: d.defaultOption, options: d.options.map(function(o) { return { name: o.name.trim(), text: o.text }; }) } };
  if (Object.keys(renames).length) { message.renames = renames; }
  vscode.postMessage(message);
}

document.getElementById('btnAdd').addEventListener('click', function() { vscode.postMessage({ type: 'addSection' }); });
document.getElementById('btnRename').addEventListener('click', function() { if (onDisk(selected)) { vscode.postMessage({ type: 'renameSection', id: selected }); } });
document.getElementById('btnDelete').addEventListener('click', function() { if (onDisk(selected)) { vscode.postMessage({ type: 'deleteSection', id: selected }); } });
document.getElementById('btnRefresh').addEventListener('click', function() { drafts = {}; vscode.postMessage({ type: 'refresh', selected: selected }); });
document.getElementById('btnFolder').addEventListener('click', function() { vscode.postMessage({ type: 'openFolder', id: onDisk(selected) ? selected : '' }); });
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
});

window.addEventListener('message', function(event) {
  const msg = event.data;
  if (!msg || msg.type !== 'data') { return; }
  data = msg;
  carried = msg.carried || (msg.saved || msg.renamed ? '' : carried);
  if (msg.saved) { delete drafts[msg.saved]; }
  if (msg.deleted) { delete drafts[msg.deleted]; }
  if (msg.renamed && drafts[msg.renamed.from]) {
    // The draft goes with its section to the new folder name.
    drafts[msg.renamed.to] = Object.assign(drafts[msg.renamed.from], { id: msg.renamed.to });
    delete drafts[msg.renamed.from];
  }
  // Drafts of sections no longer on disk go.
  Object.keys(drafts).forEach(function(id) { if (!onDisk(id)) { delete drafts[id]; } });
  if (msg.selected) { selected = msg.selected; }
  if (!onDisk(selected) && (data.sections || []).length) { selected = data.sections[0].id; }
  vscode.setState({ selected: selected });
  render();
});

vscode.postMessage({ type: 'ready', selected: selected || undefined });
