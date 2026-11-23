// @ts-nocheck
/*
 * Role Editor client (vscimpb87, gsel7): one page with a Roles tab and a Role
 * Types tab. The host (src/handlers/rolesEditor-handler.ts) posts `data` for
 * one tab — its items, for roles the role types to pick (with their guideline
 * choices), for role types the tool groups and the always-on tools, and the
 * guideline aspects (`aspects`). Every message the page posts names its tab
 * (`kind`). Saving posts the whole item with its guideline choices; the host
 * writes the files (checked against their schemas) and answers with the data
 * again. `showTab` (a command opened the page on a tab) and `reload` (the
 * sections changed) ask for the data again.
 */
const vscode = acquireVsCodeApi();
const INIT = window.__INIT__ || {};
if (INIT.codiconsUri) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = INIT.codiconsUri;
  document.head.appendChild(link);
}
const Picker = window.TomAspectPicker;
const saved = vscode.getState() || {};
let kind = INIT.kind === 'roleTypes' ? 'roleTypes' : INIT.kind === 'roles' ? 'roles' : (saved.kind === 'roleTypes' ? 'roleTypes' : 'roles');
/** The selection per tab. */
const selectedBy = Object.assign({ roles: '', roleTypes: '' }, saved.selectedBy || {});
if (INIT.selected) { selectedBy[kind] = INIT.selected; }
/** The data per tab, as the host last sent it. */
const dataBy = { roles: { items: [] }, roleTypes: { items: [] } };
/** The guideline choices of the item shown, as edited (saved with the item). */
let draftChoices = {};

function data() { return dataBy[kind]; }
function selected() { return selectedBy[kind]; }

function keepState() { vscode.setState({ kind: kind, selectedBy: selectedBy }); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

const INTRO = {
  roles: 'A role is a folder of _ai/roles/: its role.md, the role type its role-config.yaml names, and its guideline choices. A prompt run as the role gets the type\'s tools (no type: the profile\'s tools) and the guideline choices of the type and the role.',
  roleTypes: 'A role type is a folder of _ai/role-types/ holding role-type.yaml. Its tools: the profile\'s default, or a selection that replaces the profile\'s; the always-on tools (greyed) are always there. Its guideline choices apply to every role of the type; a role\'s own win.',
};

function syncChrome() {
  document.querySelectorAll('.tab').forEach(function(t) {
    const on = t.dataset.kind === kind;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.getElementById('intro').textContent = INTRO[kind];
  document.getElementById('btnDelete').style.display = kind === 'roleTypes' ? '' : 'none';
  document.getElementById('btnAdd').title = kind === 'roles' ? 'Add a role' : 'Add a role type';
}

function current() { return (data().items || []).find(function(i) { return i.id === selected(); }); }

function select(id) {
  selectedBy[kind] = id;
  keepState();
  render();
}

/** Switch to tab `k` and ask the host for its data (`sel` chosen). */
function showTab(k, sel) {
  kind = k === 'roleTypes' ? 'roleTypes' : 'roles';
  if (sel) { selectedBy[kind] = sel; }
  keepState();
  syncChrome();
  render();
  vscode.postMessage({ type: 'ready', kind: kind, selected: selectedBy[kind] || undefined });
}

function renderList() {
  const list = document.getElementById('itemList');
  list.innerHTML = (data().items || []).map(function(item) {
    const badge = kind === 'roles'
      ? (item.roleType ? '<span class="badge">' + escapeHtml(item.roleType) + '</span>' : '')
      : (item.value && item.value.tools.mode === 'selected' ? '<span class="badge">' + item.value.tools.enabled.length + ' tools</span>' : '<span class="badge">profile</span>');
    const own = kind === 'roles' ? item.guidelines : (item.value && item.value.guidelines);
    const ind = own && Object.keys(own).length ? '<span class="badge guide" title="Guideline choices: ' + escapeHtml(choicesText(own)) + '"><span class="codicon codicon-book"></span></span>' : '';
    return '<li role="option" data-id="' + escapeHtml(item.id) + '" class="' + (item.id === selected() ? 'active' : '') + '">' + escapeHtml(item.id) + badge + ind + '</li>';
  }).join('');
  list.querySelectorAll('li').forEach(function(li) { li.addEventListener('click', function() { select(li.dataset.id); }); });
  document.getElementById('btnDelete').disabled = !current();
  syncMoveButtons();
}

/** A level's own choices as text (`answer: brief · night: remove`), labels from the sections. */
function choicesText(choices) {
  const sections = ((data().aspects || {}).sections || []);
  const keys = Object.keys(choices || {});
  if (!keys.length) { return 'none'; }
  return keys.map(function(k) {
    const s = sections.find(function(x) { return x.id === k; });
    const v = choices[k];
    return (s ? s.label : k) + ': ' + (v === 'remove' ? 'Remove' : v);
  }).join(' \u00b7 ');
}

/** The picker's levels for the item shown: a role's type's choices above its own; a role type's own. */
function pickerLevels() {
  if (kind === 'roleTypes') { return { roleType: draftChoices }; }
  const sel = document.getElementById('roleType');
  const typeId = sel ? sel.value : (current() || {}).roleType;
  const type = (data().roleTypes || []).find(function(t) { return t.id === typeId; });
  return { roleType: (type && type.guidelines) || {}, role: draftChoices };
}

function pickerView() {
  return Picker.view(data().aspects || { sections: [] }, pickerLevels(), kind === 'roles' ? 'role' : 'roleType');
}

function pickerTitle() { return kind === 'roles' ? 'Guidelines of the role' : 'Guidelines of the role type'; }

/** The guideline field: the picker button and this item's own choices beside it. */
function guidelinesFieldHtml() {
  return '<div class="field"><label class="title">Guidelines</label><div class="guide-row" id="guideRow"></div>'
    + '<div class="hint">' + (kind === 'roles'
      ? 'The role\'s choices, over its role type\'s. Saved to role-config.yaml with Save.'
      : 'The choices of the type\'s roles (a role\'s own win). Saved to role-type.yaml with Save.') + '</div></div>';
}

function renderGuideRow() {
  const row = document.getElementById('guideRow');
  if (!row || !Picker) { return; }
  const v = pickerView();
  row.innerHTML = Picker.buttonHtml(v, { title: pickerTitle(), id: 'btnGuidelines' })
    + '<span class="guide-choices" id="guideChoices">' + escapeHtml(choicesText(draftChoices)) + '</span>';
  document.getElementById('btnGuidelines').addEventListener('click', function(ev) {
    ev.stopPropagation();
    Picker.open(ev.currentTarget, pickerView(), {
      title: pickerTitle(),
      note: 'Saved with the ' + (kind === 'roles' ? 'role' : 'role type') + ' (Save).',
      onChoose: function(section, value) {
        const next = Object.assign({}, draftChoices);
        if (value === '') { delete next[section]; } else { next[section] = value; }
        draftChoices = next;
        renderGuideRow();
      },
      onEditSections: function() { vscode.postMessage({ type: 'aspectEditSections', kind: kind }); },
    });
  });
}

function renderRoleForm(item) {
  const options = ['<option value="">(none: the profile\'s tools)</option>'].concat((data().roleTypes || []).map(function(t) {
    return '<option value="' + escapeHtml(t.id) + '"' + (t.id === item.roleType ? ' selected' : '') + '>' + escapeHtml(t.id) + (t.name && t.name !== t.id ? ' — ' + escapeHtml(t.name) : '') + '</option>';
  }));
  return '<div class="field"><label class="title">Role</label><div>' + escapeHtml(item.id) + ' <span class="muted">(_ai/roles/' + escapeHtml(item.id) + '/)</span></div></div>'
    + (item.configError ? '<div class="field error">role-config.yaml could not be read: ' + escapeHtml(item.configError) + '</div>' : '')
    + '<div class="field"><label class="title" for="roleType">Role type</label><select id="roleType">' + options.join('') + '</select>'
    + '<div class="hint">Saved to role-config.yaml. A prompt run as this role gets the type\'s tools.</div></div>'
    + guidelinesFieldHtml()
    + '<div class="field"><label class="title" for="roleMd">role.md</label><textarea id="roleMd" spellcheck="false">' + escapeHtml(item.roleMd) + '</textarea></div>';
}

function renderRoleTypeForm(item) {
  const value = item.value || { tools: { mode: 'profileDefault' } };
  const mode = value.tools.mode;
  const enabled = new Set(value.tools.enabled || []);
  const alwaysOn = new Set(data().alwaysOn || []);
  const groups = (data().toolGroups || []).map(function(g) {
    const rows = g.tools.map(function(name) {
      const on = alwaysOn.has(name);
      return '<label class="tool-row' + (on ? ' always-on' : '') + '" title="' + (on ? 'Always on: the extension needs it whatever the role' : escapeHtml(name)) + '">'
        + '<input type="checkbox" class="tool-cb" value="' + escapeHtml(name) + '"' + (on || enabled.has(name) ? ' checked' : '') + (on ? ' disabled data-always-on="true"' : '') + '> ' + escapeHtml(name) + '</label>';
    }).join('');
    return '<div class="tool-group"><h4>' + escapeHtml(g.category)
      + ' <button class="group-all" data-group="' + escapeHtml(g.category) + '">all</button><button class="group-none" data-group="' + escapeHtml(g.category) + '">none</button></h4>'
      + '<div data-group-body="' + escapeHtml(g.category) + '">' + rows + '</div></div>';
  }).join('');
  return '<div class="field"><label class="title">Role type</label><div>' + escapeHtml(item.id) + ' <span class="muted">(_ai/role-types/' + escapeHtml(item.id) + '/role-type.yaml)</span></div>'
    + (item.usedBy && item.usedBy.length ? '<div class="hint">Used by: ' + item.usedBy.map(escapeHtml).join(', ') + '</div>' : '<div class="hint">No role names it yet.</div>') + '</div>'
    + (item.error ? '<div class="field error">role-type.yaml could not be read: ' + escapeHtml(item.error) + '</div>' : '')
    + '<div class="field"><label class="title" for="rtName">Name</label><input type="text" id="rtName" value="' + escapeHtml(value.name || '') + '"></div>'
    + '<div class="field"><label class="title" for="rtDescription">Description</label><input type="text" id="rtDescription" value="' + escapeHtml(value.description || '') + '"></div>'
    + guidelinesFieldHtml()
    + '<div class="field"><label class="title">Tools</label>'
    + '<label><input type="radio" name="toolsMode" value="profileDefault"' + (mode !== 'selected' ? ' checked' : '') + '> The profile\'s default (its own tool selection, unchanged)</label><br>'
    + '<label><input type="radio" name="toolsMode" value="selected"' + (mode === 'selected' ? ' checked' : '') + '> These tools (they replace the profile\'s selection):</label>'
    + '<div id="toolGroups" class="' + (mode === 'selected' ? '' : 'muted') + '">' + groups + '</div></div>';
}

function render() {
  renderList();
  const form = document.getElementById('form');
  if (data().error) { form.innerHTML = '<p class="error">' + escapeHtml(data().error) + '</p>'; return; }
  const item = current();
  if (!item) {
    form.innerHTML = '<p class="muted">' + ((data().items || []).length ? 'Pick one on the left.' : 'None yet: add one with +.') + '</p>';
    return;
  }
  const own = kind === 'roles' ? item.guidelines : (item.value && item.value.guidelines);
  draftChoices = Object.assign({}, own || {});
  form.innerHTML = (kind === 'roles' ? renderRoleForm(item) : renderRoleTypeForm(item))
    + '<div class="save-row"><button class="primary" id="btnSave">Save</button><span class="muted">Ctrl/Cmd+S</span></div>';
  document.getElementById('btnSave').addEventListener('click', save);
  renderGuideRow();
  if (kind === 'roles') {
    // Another role type: its choices are the level above the role's.
    document.getElementById('roleType').addEventListener('change', renderGuideRow);
  } else {
    const sync = function() {
      const on = document.querySelector('input[name="toolsMode"]:checked').value === 'selected';
      document.getElementById('toolGroups').className = on ? '' : 'muted';
      form.querySelectorAll('.tool-cb').forEach(function(cb) { if (!cb.dataset.alwaysOn) { cb.disabled = !on; } });
    };
    form.querySelectorAll('input[name="toolsMode"]').forEach(function(r) { r.addEventListener('change', sync); });
    form.querySelectorAll('.group-all, .group-none').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const body = form.querySelector('[data-group-body="' + btn.dataset.group + '"]');
        body.querySelectorAll('.tool-cb').forEach(function(cb) { if (!cb.disabled) { cb.checked = btn.classList.contains('group-all'); } });
      });
    });
    sync();
  }
}

/** What Save posts: the whole item, its guideline choices included. */
function collect() {
  const item = current();
  if (!item) { return undefined; }
  if (kind === 'roles') {
    return { type: 'save', kind: kind, id: item.id, roleType: document.getElementById('roleType').value, roleMd: document.getElementById('roleMd').value, guidelines: Object.assign({}, draftChoices) };
  }
  const mode = document.querySelector('input[name="toolsMode"]:checked').value;
  const enabled = Array.prototype.slice.call(document.querySelectorAll('.tool-cb'))
    .filter(function(cb) { return cb.checked && !cb.dataset.alwaysOn; })
    .map(function(cb) { return cb.value; });
  const value = {
    name: document.getElementById('rtName').value,
    description: document.getElementById('rtDescription').value,
    tools: mode === 'selected' ? { mode: 'selected', enabled: enabled } : { mode: 'profileDefault' },
    guidelines: Object.assign({}, draftChoices),
  };
  return { type: 'save', kind: kind, id: item.id, value: value };
}

function save() {
  const msg = collect();
  if (msg) { vscode.postMessage(msg); }
}

document.querySelectorAll('.tab').forEach(function(t) {
  t.addEventListener('click', function() { if (t.dataset.kind !== kind) { showTab(t.dataset.kind); } });
});
document.getElementById('btnAdd').addEventListener('click', function() { vscode.postMessage({ type: 'add', kind: kind }); });
document.getElementById('btnDelete').addEventListener('click', function() { if (current()) { vscode.postMessage({ type: 'delete', kind: kind, id: selected() }); } });
document.getElementById('btnRefresh').addEventListener('click', function() { vscode.postMessage({ type: 'refresh', kind: kind, selected: selected() }); });
// Up / Down: the selected entry moves one place in the list (the order is stored by the host; the folders stay).
document.getElementById('btnMoveUp').addEventListener('click', function() { if (current()) { vscode.postMessage({ type: 'move', kind: kind, id: selected(), direction: 'up' }); } });
document.getElementById('btnMoveDown').addEventListener('click', function() { if (current()) { vscode.postMessage({ type: 'move', kind: kind, id: selected(), direction: 'down' }); } });
/** The move buttons follow the selection: off at the list's ends and without one. */
function syncMoveButtons() {
  var ids = (data().items || []).map(function(i) { return i.id; });
  var at = ids.indexOf(selected());
  document.getElementById('btnMoveUp').disabled = at <= 0;
  document.getElementById('btnMoveDown').disabled = at < 0 || at >= ids.length - 1;
}
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
});

window.addEventListener('message', function(event) {
  const msg = event.data;
  if (!msg) { return; }
  if (msg.type === 'showTab') { showTab(msg.kind, msg.selected); return; }
  if (msg.type === 'reload') { vscode.postMessage({ type: 'refresh', kind: kind, selected: selected() }); return; }
  const k = msg.kind === 'roleTypes' ? 'roleTypes' : 'roles';
  if (msg.type === 'order') {
    // The host stored a new order: only the list is drawn again, the form being edited stays.
    var rank = {};
    (msg.ids || []).forEach(function(id, i) { rank[id] = i; });
    (dataBy[k].items || []).sort(function(a, b) { return (rank[a.id] === undefined ? 1e9 : rank[a.id]) - (rank[b.id] === undefined ? 1e9 : rank[b.id]); });
    if (k === kind) { renderList(); }
    return;
  }
  if (msg.type !== 'data') { return; }
  dataBy[k] = msg;
  if (msg.selected) { selectedBy[k] = msg.selected; }
  if (!(msg.items || []).some(function(i) { return i.id === selectedBy[k]; }) && (msg.items || []).length) { selectedBy[k] = msg.items[0].id; }
  keepState();
  if (k === kind) { render(); }
});

syncChrome();
vscode.postMessage({ type: 'ready', kind: kind, selected: selectedBy[kind] || undefined });
