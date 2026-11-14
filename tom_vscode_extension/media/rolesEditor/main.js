// @ts-nocheck
/*
 * Role Editor / Role Type Editor client (vscimpb87). The host
 * (src/handlers/rolesEditor-handler.ts) posts `data` — the items of the kind,
 * and for roles the role types to pick, for role types the tool groups and the
 * always-on tools. Saving posts the whole item; the host writes the files
 * (checked against their schemas) and answers with the data again.
 */
const vscode = acquireVsCodeApi();
const INIT = window.__INIT__ || {};
if (INIT.codiconsUri) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = INIT.codiconsUri;
  document.head.appendChild(link);
}
const KIND = INIT.kind === 'roleTypes' ? 'roleTypes' : 'roles';
vscode.setState(Object.assign({}, vscode.getState() || {}, { kind: KIND }));

let data = { items: [] };
let selected = (vscode.getState() || {}).selected || '';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

document.getElementById('headline').textContent = INIT.title || (KIND === 'roles' ? 'Role Editor' : 'Role Type Editor');
document.getElementById('intro').textContent = KIND === 'roles'
  ? 'A role is a folder of _ai/roles/: its role.md, and the role type its role-config.yaml names. A prompt run as the role gets the type\'s tools; no type: the profile\'s tools.'
  : 'A role type is a folder of _ai/role-types/ holding role-type.yaml. Its tools: the profile\'s default, or a selection that replaces the profile\'s; the always-on tools (greyed) are always there.';
document.getElementById('btnDelete').style.display = KIND === 'roleTypes' ? '' : 'none';
document.getElementById('btnAdd').title = KIND === 'roles' ? 'Add a role' : 'Add a role type';

function current() { return (data.items || []).find(function(i) { return i.id === selected; }); }

function select(id) {
  selected = id;
  vscode.setState(Object.assign({}, vscode.getState() || {}, { selected: id }));
  render();
}

function renderList() {
  const list = document.getElementById('itemList');
  list.innerHTML = (data.items || []).map(function(item) {
    const badge = KIND === 'roles'
      ? (item.roleType ? '<span class="badge">' + escapeHtml(item.roleType) + '</span>' : '')
      : (item.value && item.value.tools.mode === 'selected' ? '<span class="badge">' + item.value.tools.enabled.length + ' tools</span>' : '<span class="badge">profile</span>');
    return '<li role="option" data-id="' + escapeHtml(item.id) + '" class="' + (item.id === selected ? 'active' : '') + '">' + escapeHtml(item.id) + badge + '</li>';
  }).join('');
  list.querySelectorAll('li').forEach(function(li) { li.addEventListener('click', function() { select(li.dataset.id); }); });
  document.getElementById('btnDelete').disabled = !current();
}

function renderRoleForm(item) {
  const options = ['<option value="">(none: the profile\'s tools)</option>'].concat((data.roleTypes || []).map(function(t) {
    return '<option value="' + escapeHtml(t.id) + '"' + (t.id === item.roleType ? ' selected' : '') + '>' + escapeHtml(t.id) + (t.name && t.name !== t.id ? ' — ' + escapeHtml(t.name) : '') + '</option>';
  }));
  return '<div class="field"><label class="title">Role</label><div>' + escapeHtml(item.id) + ' <span class="muted">(_ai/roles/' + escapeHtml(item.id) + '/)</span></div></div>'
    + (item.configError ? '<div class="field error">role-config.yaml could not be read: ' + escapeHtml(item.configError) + '</div>' : '')
    + '<div class="field"><label class="title" for="roleType">Role type</label><select id="roleType">' + options.join('') + '</select>'
    + '<div class="hint">Saved to role-config.yaml. A prompt run as this role gets the type\'s tools.</div></div>'
    + '<div class="field"><label class="title" for="roleMd">role.md</label><textarea id="roleMd" spellcheck="false">' + escapeHtml(item.roleMd) + '</textarea></div>';
}

function renderRoleTypeForm(item) {
  const value = item.value || { tools: { mode: 'profileDefault' } };
  const mode = value.tools.mode;
  const enabled = new Set(value.tools.enabled || []);
  const alwaysOn = new Set(data.alwaysOn || []);
  const groups = (data.toolGroups || []).map(function(g) {
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
    + '<div class="field"><label class="title">Tools</label>'
    + '<label><input type="radio" name="toolsMode" value="profileDefault"' + (mode !== 'selected' ? ' checked' : '') + '> The profile\'s default (its own tool selection, unchanged)</label><br>'
    + '<label><input type="radio" name="toolsMode" value="selected"' + (mode === 'selected' ? ' checked' : '') + '> These tools (they replace the profile\'s selection):</label>'
    + '<div id="toolGroups" class="' + (mode === 'selected' ? '' : 'muted') + '">' + groups + '</div></div>';
}

function render() {
  renderList();
  const form = document.getElementById('form');
  if (data.error) { form.innerHTML = '<p class="error">' + escapeHtml(data.error) + '</p>'; return; }
  const item = current();
  if (!item) {
    form.innerHTML = '<p class="muted">' + ((data.items || []).length ? 'Pick one on the left.' : 'None yet: add one with +.') + '</p>';
    return;
  }
  form.innerHTML = (KIND === 'roles' ? renderRoleForm(item) : renderRoleTypeForm(item))
    + '<div class="save-row"><button class="primary" id="btnSave">Save</button><span class="muted">Ctrl/Cmd+S</span></div>';
  document.getElementById('btnSave').addEventListener('click', save);
  if (KIND === 'roleTypes') {
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

/** What Save posts: the whole item. */
function collect() {
  const item = current();
  if (!item) { return undefined; }
  if (KIND === 'roles') {
    return { type: 'save', id: item.id, roleType: document.getElementById('roleType').value, roleMd: document.getElementById('roleMd').value };
  }
  const mode = document.querySelector('input[name="toolsMode"]:checked').value;
  const enabled = Array.prototype.slice.call(document.querySelectorAll('.tool-cb'))
    .filter(function(cb) { return cb.checked && !cb.dataset.alwaysOn; })
    .map(function(cb) { return cb.value; });
  const value = { name: document.getElementById('rtName').value, description: document.getElementById('rtDescription').value, tools: mode === 'selected' ? { mode: 'selected', enabled: enabled } : { mode: 'profileDefault' } };
  return { type: 'save', id: item.id, value: value };
}

function save() {
  const msg = collect();
  if (msg) { vscode.postMessage(msg); }
}

document.getElementById('btnAdd').addEventListener('click', function() { vscode.postMessage({ type: 'add' }); });
document.getElementById('btnDelete').addEventListener('click', function() { if (current()) { vscode.postMessage({ type: 'delete', id: selected }); } });
document.getElementById('btnRefresh').addEventListener('click', function() { vscode.postMessage({ type: 'refresh', selected: selected }); });
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
});

window.addEventListener('message', function(event) {
  const msg = event.data;
  if (!msg || msg.type !== 'data') { return; }
  data = msg;
  if (msg.selected) { selected = msg.selected; }
  if (!current() && (data.items || []).length) { selected = data.items[0].id; }
  render();
});

vscode.postMessage({ type: 'ready' });
