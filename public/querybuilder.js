/* Visual query builder — compose a {{query:…}} block from checkboxes/inputs instead of hand-writing
 * the syntax, with a live preview, then insert it as a bullet. Reachable from the command palette
 * ("Insert query…"). Uses globals from app.js (state, opNewAt, N, plainOf, …) like pages.js. */
(function () {
  let overlay = null;

  // assemble the {{query:…}} text from the current form state
  function compose(form) {
    const conds = [];
    const ref = form.ref.value.trim();
    if (ref) conds.push(ref.startsWith('#') ? ref : `[[${ref}]]`);
    if (form.todo.checked) conds.push('{is:todo}');
    if (form.done.checked) conds.push('{is:done}');
    if (form.image.checked) conds.push('{has:image}');
    if (form.link.checked) conds.push('{has:link}');
    if (form.date.value) conds.push(`{date:${form.date.value}}`);
    if (!conds.length) return '';
    const body = conds.length === 1 ? conds[0] : `{${form.mode.value}: ${conds.join(' ')}}`;
    const view = form.view.value;
    return `{{query: ${body}}}` + (view !== 'list' ? ` {view:${view}}` : '');
  }

  function close() { overlay?.remove(); overlay = null; document.removeEventListener('keydown', onKey, true); }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  window.showQueryBuilder = function showQueryBuilder() {
    if (state.readOnly) return;
    close();
    overlay = document.createElement('div');
    overlay.className = 'qbuild-overlay';
    overlay.innerHTML = `
      <div class="qbuild" role="dialog" aria-label="Insert query">
        <div class="qbuild-title">Insert query</div>
        <label class="qbuild-row">References page / tag
          <input type="text" class="qb-ref" placeholder="Projekt X  or  #idea" />
        </label>
        <div class="qbuild-checks">
          <label><input type="checkbox" class="qb-todo" /> is a to-do</label>
          <label><input type="checkbox" class="qb-done" /> is done</label>
          <label><input type="checkbox" class="qb-image" /> has an image</label>
          <label><input type="checkbox" class="qb-link" /> has a link</label>
        </div>
        <label class="qbuild-row">Date
          <select class="qb-date">
            <option value="">any</option>
            <option value="today">today</option>
            <option value="this week">this week</option>
            <option value="last week">last week</option>
            <option value="this month">this month</option>
          </select>
        </label>
        <div class="qbuild-row2">
          <label>Match
            <select class="qb-mode"><option value="and">all</option><option value="or">any</option></select>
          </label>
          <label>View
            <select class="qb-view">
              <option value="list">list</option><option value="table">table</option>
              <option value="board">board</option><option value="calendar">calendar</option>
            </select>
          </label>
        </div>
        <div class="qbuild-preview"><code class="qb-preview"></code></div>
        <div class="qbuild-actions">
          <button type="button" class="qb-cancel">Cancel</button>
          <button type="button" class="qb-insert" disabled>Insert</button>
        </div>
      </div>`;
    document.body.append(overlay);

    const $ = s => overlay.querySelector(s);
    const form = {
      ref: $('.qb-ref'), todo: $('.qb-todo'), done: $('.qb-done'), image: $('.qb-image'),
      link: $('.qb-link'), date: $('.qb-date'), mode: $('.qb-mode'), view: $('.qb-view'),
    };
    const preview = $('.qb-preview');
    const insertBtn = $('.qb-insert');
    const refresh = () => {
      const text = compose(form);
      preview.textContent = text || '(add at least one condition)';
      insertBtn.disabled = !text;
    };
    overlay.addEventListener('input', refresh);
    overlay.addEventListener('change', refresh);
    $('.qb-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    insertBtn.addEventListener('click', () => {
      const text = compose(form);
      if (!text) return;
      close();
      opNewAt(state.zoom, 0, text); // drop the query block at the top of the current page
    });
    document.addEventListener('keydown', onKey, true);
    refresh();
    form.ref.focus();
  };
})();
