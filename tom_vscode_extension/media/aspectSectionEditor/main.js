// @ts-nocheck
/*
 * Aspect Guidelines editor client (gsel7, gsel16, P-4). The host
 * (src/handlers/aspectSectionEditor-handler.ts) posts `data`: every section of
 * _ai/aspect_guidelines/ as it is on disk ({ id, name, label, placement,
 * defaultOption, options: [{ name, text }], problems }). The page edits a
 * section as a draft — kept per section while another is shown — and Save
 * posts the draft as a whole; the host writes section.yaml and the option
 * files and answers with the data (`saved`: that draft is done). Sections are
 * added, renamed and deleted through the host (it asks).
 *
 * A choice is Own text (<choice>.md in the aspect's folder) or a Guideline
 * file (_agent_guidelines/aspects/<aspect>/<choice>.md of a guideline layer,
 * gsel17): the data carries the layers (`layers`: base, label, own) and per
 * choice its own text (`ownText`) and its files (`files`, nearest first). A
 * draft choice keeps both texts (`ownText`, `fileText`) and the layer it
 * writes (`fileBase`); the text area edits the one of its mode. Switching to
 * Own text offers the file's text; *Create the workspace's own copy* points
 * the choice at the window workspace folder's layer, its text kept.
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
  return { id: s.id, name: s.name, label: s.label, placement: s.placement, defaultOption: s.defaultOption, removeWhen: s.removeWhen || '', order: typeof s.order === 'number' ? String(s.order) : '', options: s.options.map(function(o) {
    const mode = o.mode === 'file' ? 'file' : 'own';
    const files = o.files || [];
    const base = o.fileBase || '';
    const file = files.find(function(f) { return f.base === base; });
    return {
      name: o.name, origin: o.name, mode: mode, fileBase: base, when: o.when || '',
      ownText: o.ownText !== undefined ? o.ownText : (mode === 'own' ? o.text : ''),
      fileText: file ? file.text : (mode === 'file' ? o.text : ''),
      files: files,
    };
  }) };
}

function layers() { return data.layers || []; }

/*
 * Conditions (gsel20): the checkboxes under a Condition / Remove when field
 * write or extend its expression, combined with &&; unchecking takes the term
 * out again. The role-type term names the picked folders of _ai/role-types/.
 */
const CONDITION_TERMS = [
  { id: 'todo', label: 'only in todo prompts', term: 'prompt.kind == "todo"' },
  { id: 'process', label: 'only while a process runs', term: 'prompt.process != ""' },
  { id: 'direct', label: 'only on the direct API', term: 'prompt.transport == "direct"' },
  { id: 'agentSdk', label: 'only on the Agent SDK', term: 'prompt.transport == "agentSdk"' },
];
const ROLE_TERM = /\(?prompt\.roleType == "[^"]*"(?: \|\| prompt\.roleType == "[^"]*")*\)?/;

function splitTerms(expr) {
  return String(expr || '').split(/\s*&&\s*/).map(function(t) { return t.trim(); }).filter(Boolean);
}
function joinTerms(terms) { return terms.join(' && '); }
function hasTerm(expr, term) { return splitTerms(expr).indexOf(term) >= 0; }
function withTerm(expr, term, on) {
  const terms = splitTerms(expr).filter(function(t) { return t !== term; });
  if (on) { terms.push(term); }
  return joinTerms(terms);
}
/** The role types the expression's role-type term names. */
function roleTypesIn(expr) {
  const m = ROLE_TERM.exec(String(expr || ''));
  if (!m) { return []; }
  const out = [];
  m[0].replace(/prompt\.roleType == "([^"]*)"/g, function(_, name) { out.push(name); return ''; });
  return out;
}
/** The expression with its role-type term naming `types` (none: the term goes). */
function withRoleTypes(expr, types) {
  const terms = splitTerms(expr).filter(function(t) { return !ROLE_TERM.test(t) || ROLE_TERM.exec(t)[0] !== t; });
  if (types.length === 1) { terms.push('prompt.roleType == "' + types[0] + '"'); }
  if (types.length > 1) { terms.push('(' + types.map(function(t) { return 'prompt.roleType == "' + t + '"'; }).join(' || ') + ')'); }
  return joinTerms(terms);
}
window.TomConditionTerms = { CONDITION_TERMS: CONDITION_TERMS, withTerm: withTerm, hasTerm: hasTerm, roleTypesIn: roleTypesIn, withRoleTypes: withRoleTypes };

/** Errors of the conditions as the host checked them, by field key. */
let conditionErrors = {};

/** A condition field with its checkboxes; `key` names it ('remove' or 'opt-<i>'). */
function conditionHtml(key, label, expr, hint) {
  const roleTypes = data.roleTypes || [];
  const picked = roleTypesIn(expr);
  return '<div class="cond" data-cond="' + escapeHtml(key) + '">'
    + '<label class="cond-label">' + escapeHtml(label) + '</label>'
    + '<input type="text" class="cond-input" spellcheck="false" value="' + escapeHtml(expr) + '" placeholder="' + escapeHtml(hint) + '" aria-label="' + escapeHtml(label) + '">'
    + '<div class="cond-error' + (conditionErrors[key] ? ' shown' : '') + '">' + escapeHtml(conditionErrors[key] || '') + '</div>'
    + '<div class="cond-boxes">'
    + CONDITION_TERMS.map(function(t) {
      return '<label class="cond-box"><input type="checkbox" data-term="' + t.id + '"' + (hasTerm(expr, t.term) ? ' checked' : '') + '> ' + escapeHtml(t.label) + '</label>';
    }).join('')
    + (roleTypes.length ? '<span class="cond-roles">only for role types: ' + roleTypes.map(function(rt) {
      return '<label class="cond-box"><input type="checkbox" data-role-type="' + escapeHtml(rt) + '"' + (picked.indexOf(rt) >= 0 ? ' checked' : '') + '> ' + escapeHtml(rt) + '</label>';
    }).join('') + '</span>' : '')
    + '</div></div>';
}
function layerOf(base) { return layers().find(function(l) { return l.base === base; }); }
function ownLayer() { return layers().find(function(l) { return l.own; }); }

/** The guideline file of `name` in `layer`, as shown (relative to the Tom root). */
function fileDisplay(layer, aspect, name) {
  return (layer.folder === '.' ? '' : layer.folder + '/') + '_agent_guidelines/aspects/' + aspect + '/' + (name || '<choice>') + '.md';
}

/** The text of the file `o` has in the layer `base`, undefined when it has none there. */
function fileTextIn(o, base) {
  const f = (o.files || []).find(function(x) { return x.base === base; });
  return f ? f.text : undefined;
}

/** Switch a draft choice's mode (gsel17). */
function setMode(o, mode) {
  if (mode === o.mode) { return; }
  if (mode === 'file') {
    if (!o.fileBase) { o.fileBase = (o.files && o.files[0] && o.files[0].base) || (layers()[0] && layers()[0].base) || ''; }
    const onDiskText = fileTextIn(o, o.fileBase);
    // A new file starts with the own text: the text moves into the file.
    if (onDiskText === undefined && !o.fileText) { o.fileText = o.ownText; }
  }
  o.mode = mode;
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

function fileLineHtml(o, d) {
  if (o.mode !== 'file') {
    // Own text: offer the guideline file's text when there is one.
    const text = o.fileText || ((o.files || [])[0] || {}).text || '';
    return text && text !== o.ownText
      ? '<div class="hint file-line"><button class="secondary opt-copy" title="Put the guideline file\'s text into the field">Copy the guideline file\'s text into the field</button></div>'
      : '';
  }
  const layer = layerOf(o.fileBase);
  if (!layer) { return '<div class="hint file-line error">This window has no guideline folder: the choice cannot be a guideline file here.</div>'; }
  const exists = fileTextIn(o, o.fileBase) !== undefined;
  const own = ownLayer();
  return '<div class="hint file-line">' + (exists ? 'Edits ' : 'New file ') + '<code>' + escapeHtml(fileDisplay(layer, d.id, o.name)) + '</code> (' + escapeHtml(layer.label) + ')'
    + (own && own.base !== o.fileBase ? ' <button class="secondary opt-own-copy" title="Write this text into the window workspace folder\'s own file instead; the other file stays">Create the workspace\'s own copy</button>' : '')
    + '</div>';
}

function optionHtml(o, i, count, d) {
  const text = o.mode === 'file' ? o.fileText : o.ownText;
  return '<div class="option" data-index="' + i + '">'
    + '<div class="option-head">'
    + '<input type="text" class="opt-name" placeholder="short name (the file name, e.g. brief)" value="' + escapeHtml(o.name) + '" aria-label="Choice short name">'
    + '<select class="opt-mode" aria-label="Where the choice\'s text is" title="Own text: in this aspect\'s folder. Guideline file: _agent_guidelines/aspects/, which Claude Code can import outside the extension.">'
    + '<option value="own"' + (o.mode !== 'file' ? ' selected' : '') + '>Own text</option>'
    + '<option value="file"' + (o.mode === 'file' ? ' selected' : '') + (layers().length ? '' : ' disabled') + '>Guideline file</option>'
    + '</select>'
    + (o.name && o.name === d.defaultOption ? '<span class="is-default">default</span>' : '')
    + '<button class="icon-btn opt-up" title="Move up"' + (i === 0 ? ' disabled' : '') + '><span class="codicon codicon-arrow-up"></span></button>'
    + '<button class="icon-btn opt-down" title="Move down"' + (i === count - 1 ? ' disabled' : '') + '><span class="codicon codicon-arrow-down"></span></button>'
    + '<button class="icon-btn opt-delete" title="Delete the choice (its file goes with Save: the own text, or the guideline file it edits)"><span class="codicon codicon-trash"></span></button>'
    + '</div>'
    + fileLineHtml(o, d)
    + '<textarea class="opt-text" spellcheck="false" aria-label="Choice text">' + escapeHtml(text) + '</textarea>'
    + conditionHtml('opt-' + i, 'Condition', o.when || '', 'always sent when chosen; e.g. prompt.transport != "direct"')
    + '</div>';
}

/** The workspace level's problems (gsel19): broken @<path> lines of workspace_aspects.md / .yaml. */
function workspaceProblemsHtml() {
  const list = data.workspaceProblems || [];
  return list.length
    ? '<div class="field"><label class="title">Workspace level</label><ul class="problems workspace-problems">' + list.map(function(p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul></div>'
    : '';
}

function render() {
  renderList();
  const form = document.getElementById('form');
  if (data.error) { form.innerHTML = '<p class="error">' + escapeHtml(data.error) + '</p>'; return; }
  const s = onDisk(selected);
  const d = draft();
  if (!s || !d) {
    form.innerHTML = workspaceProblemsHtml() + '<p class="muted">' + ((data.sections || []).length ? 'Pick an aspect on the left.' : 'No aspects yet: add one with +.') + '</p>';
    return;
  }
  form.innerHTML = workspaceProblemsHtml() + (carried ? '<div class="hint carried" role="status"><span class="codicon codicon-check"></span> ' + escapeHtml(carried) + '</div>' : '')
    + '<div class="field"><label class="title">Aspect</label><div>' + escapeHtml(s.id) + ' <span class="muted">(_ai/aspect_guidelines/' + escapeHtml(s.id) + '/)</span></div>'
    + '<div class="hint">The short name every level\'s choice names; rename it with the pencil above the list (the choices stored on every level follow).</div></div>'
    + (s.problems && s.problems.length ? '<ul class="problems">' + s.problems.map(function(p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul>' : '')
    + '<div class="row">'
    + '<div class="field"><label class="title" for="secName">Name</label><input type="text" id="secName" value="' + escapeHtml(d.name) + '" placeholder="e.g. Answer mode"></div>'
    + '<div class="field"><label class="title" for="secLabel">Short label</label><input type="text" id="secLabel" value="' + escapeHtml(d.label) + '" placeholder="' + escapeHtml(d.name || 'the name') + '"><div class="hint">In the buttons\' hover help (Answer: brief). Empty: the name.</div></div>'
    + '</div><div class="row">'
    + '<div class="field"><label class="title" for="secPlacement">Placement</label><select id="secPlacement">'
    + '<option value="system"' + (d.placement !== 'user' ? ' selected' : '') + '>System prompt</option>'
    + '<option value="user"' + (d.placement === 'user' ? ' selected' : '') + '>User prompt (before the prompt text)</option>'
    + '</select></div>'
    + '<div class="field"><label class="title" for="secDefault">Default choice</label><select id="secDefault">' + defaultOptionsHtml(d) + '</select>'
    + '<div class="hint">Chosen when no level chooses.</div></div>'
    + '<div class="field"><label class="title" for="secOrder">Order</label><input type="number" id="secOrder" value="' + escapeHtml(d.order || '') + '" placeholder="by id">'
    + '<div class="hint">Its place among the aspects in the prompt, lowest first; empty: after those with one, by id.</div></div>'
    + '</div>'
    + '<div class="field"><label class="title">Remove when</label>' + conditionHtml('remove', 'Remove when', d.removeWhen || '', 'never; e.g. prompt.transport == "direct"')
    + '<div class="hint">While this expression holds the aspect sends nothing, whatever a level chose. Conditions are template expressions (as in ${{ … }}) over the chat variables, the placeholders and prompt.transport, prompt.kind, prompt.todo, prompt.role, prompt.roleType, prompt.run, prompt.process, prompt.quest, prompt.workspace, prompt.night.</div></div>'
    + '<div class="field"><label class="title">Choices</label>'
    + '<div class="hint">Each choice is &lt;short name&gt;.md, Markdown: <b>Own text</b> in this aspect\'s folder, or a <b>Guideline file</b> _agent_guidelines/aspects/' + escapeHtml(s.id) + '/&lt;short name&gt;.md of the root or a workspace folder (the nearest wins; Claude Code can import it). Placeholders (${guidelines-…}, ${file-…} …) are resolved when the text is sent. "remove" is no choice name: it is the levels\' Remove.</div>'
    + '<div id="options">' + d.options.map(function(o, i) { return optionHtml(o, i, d.options.length, d); }).join('') + '</div>'
    + '<button class="secondary" id="btnAddOption"><span class="codicon codicon-add"></span> Add choice</button></div>'
    + '<div class="save-row"><button class="primary" id="btnSave">Save</button><button class="secondary" id="btnRevert">Revert</button><span class="muted">Ctrl/Cmd+S</span></div>';
  wireForm(d);
}

function changed() { renderList(); }

function wireForm(d) {
  const form = document.getElementById('form');
  document.getElementById('secName').addEventListener('input', function(e) { d.name = e.target.value; changed(); });
  document.getElementById('secLabel').addEventListener('input', function(e) { d.label = e.target.value; changed(); });
  document.getElementById('secPlacement').addEventListener('change', function(e) { d.placement = e.target.value; changed(); });
  document.getElementById('secOrder').addEventListener('input', function(e) { d.order = e.target.value; changed(); });
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
    block.querySelector('.opt-text').addEventListener('input', function(e) {
      const o = d.options[i];
      if (o.mode === 'file') { o.fileText = e.target.value; } else { o.ownText = e.target.value; }
      changed();
    });
    block.querySelector('.opt-mode').addEventListener('change', function(e) { setMode(d.options[i], e.target.value); render(); });
    const copy = block.querySelector('.opt-copy');
    if (copy) {
      copy.addEventListener('click', function() {
        const o = d.options[i];
        o.ownText = o.fileText || ((o.files || [])[0] || {}).text || '';
        render();
      });
    }
    const ownCopy = block.querySelector('.opt-own-copy');
    if (ownCopy) { ownCopy.addEventListener('click', function() { const own = ownLayer(); if (own) { d.options[i].fileBase = own.base; render(); } }); }
    block.querySelector('.opt-up').addEventListener('click', function() { move(d, i, -1); });
    block.querySelector('.opt-down').addEventListener('click', function() { move(d, i, 1); });
    block.querySelector('.opt-delete').addEventListener('click', function() {
      const gone = d.options.splice(i, 1)[0];
      if (gone && gone.name === d.defaultOption) { d.defaultOption = ''; }
      render();
    });
  });
  form.querySelectorAll('.cond').forEach(function(block) {
    const key = block.dataset.cond;
    const get = function() { return key === 'remove' ? (d.removeWhen || '') : (d.options[Number(key.slice(4))].when || ''); };
    const set = function(v) { if (key === 'remove') { d.removeWhen = v; } else { d.options[Number(key.slice(4))].when = v; } };
    block.querySelector('.cond-input').addEventListener('input', function(e) {
      set(e.target.value);
      vscode.postMessage({ type: 'checkCondition', key: key, expression: e.target.value });
      changed();
    });
    block.querySelectorAll('input[data-term]').forEach(function(box) {
      box.addEventListener('change', function() {
        const t = CONDITION_TERMS.find(function(x) { return x.id === box.dataset.term; });
        set(withTerm(get(), t.term, box.checked));
        vscode.postMessage({ type: 'checkCondition', key: key, expression: get() });
        render();
      });
    });
    block.querySelectorAll('input[data-role-type]').forEach(function(box) {
      box.addEventListener('change', function() {
        const types = Array.from(block.querySelectorAll('input[data-role-type]')).filter(function(b) { return b.checked; }).map(function(b) { return b.dataset.roleType; });
        set(withRoleTypes(get(), types));
        vscode.postMessage({ type: 'checkCondition', key: key, expression: get() });
        render();
      });
    });
  });
  document.getElementById('btnAddOption').addEventListener('click', function() {
    d.options.push({ name: '', origin: '', mode: 'own', fileBase: '', ownText: '', fileText: '', files: [], when: '' });
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
  const message = { type: 'save', section: { id: d.id, name: d.name, label: d.label, placement: d.placement, defaultOption: d.defaultOption, options: d.options.map(function(o) {
    const out = o.mode === 'file'
      ? { name: o.name.trim(), text: o.fileText, mode: 'file', fileBase: o.fileBase }
      : { name: o.name.trim(), text: o.ownText };
    if (o.when && o.when.trim()) { out.when = o.when.trim(); }
    return out;
  }) } };
  if (d.removeWhen && d.removeWhen.trim()) { message.section.removeWhen = d.removeWhen.trim(); }
  if (d.order !== undefined && String(d.order).trim() !== '' && Number.isFinite(Number(d.order))) { message.section.order = Number(d.order); }
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
  if (msg && msg.type === 'conditionCheck') {
    // The answer to a condition typed: shown under its field (without a redraw, so the typing goes on).
    if (msg.error) { conditionErrors[msg.key] = msg.error; } else { delete conditionErrors[msg.key]; }
    const box = document.querySelector('.cond[data-cond="' + msg.key + '"] .cond-error');
    if (box) { box.textContent = msg.error || ''; box.classList.toggle('shown', !!msg.error); }
    return;
  }
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
