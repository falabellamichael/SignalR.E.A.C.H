// ---------- model picker ----------
/* `openModelPicker({target, onPick, label})` — or, for the legacy call sites,
 * `openModelPicker(inputEl)` which writes the chosen id into that input.
 *
 * `target` decides WHICH endpoint is queried:
 *   undefined            -> the active connection (playground, refactor, agent form)
 *   'conn_x'             -> that saved connection
 *   {endpoint, accessKey} -> an ad-hoc lookup for a row not yet saved
 * The modal states which connection the list came from, because with several
 * providers configured "Pick a Model" alone no longer says which one's models
 * these are — picking a model that the active endpoint does not serve would fail
 * at request time with a confusing error.
 */
let modelPickerPick = null;
let modelPickerReturnFocus = null;
function closeModelPicker() {
  $('#model-modal').classList.add('hidden');
  if (modelPickerReturnFocus?.isConnected) modelPickerReturnFocus.focus();
  modelPickerReturnFocus = null;
}
async function openModelPicker(arg) {
  const modal = $('#model-modal');
  const choices = $('#model-choices');
  const search = $('#model-search');
  const source = $('#model-source');
  modelPickerReturnFocus = $('#account-menu')?.contains(document.activeElement) ? document.activeElement : null;

  let target;
  let label = '';
  let pick;
  if (arg && typeof arg === 'object' && !(arg instanceof HTMLElement) && (arg.onPick || arg.target || arg.label)) {
    target = arg.target;
    label = arg.label || '';
    pick = arg.onPick;
  } else {
    const inputEl = arg;
    target = undefined;
    pick = (id) => {
      if (inputEl) {
        inputEl.value = id;
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
  }
  modelPickerPick = pick;

  search.value = '';
  if (source) source.textContent = label ? `From: ${label}` : '';
  choices.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'dim';
  loading.style.padding = '12px';
  loading.textContent = 'Loading models…';
  choices.appendChild(loading);
  modal.classList.remove('hidden');
  search.focus();

  const res = await reachApi.listModels(target);
  choices.replaceChildren();
  if (!res.ok) {
    const err = document.createElement('div');
    err.className = 'dim';
    err.style.padding = '12px';
    err.textContent = `Could not load models: ${res.err}`;
    choices.appendChild(err);
    if (source) source.textContent = label ? `From: ${label} — request failed` : '';
    return;
  }
  // Prefer the server's own name for the connection; it is authoritative for
  // saved rows and derived from the hostname for ad-hoc ones.
  if (source) source.textContent = `From: ${res.connectionName || label || 'the active connection'}`;

  const render = (filter) => {
    choices.replaceChildren();
    const filtered = res.models.filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()));
    if (!filtered.length) {
      const none = document.createElement('div');
      none.className = 'dim';
      none.style.padding = '12px';
      none.textContent = 'No matches.';
      choices.appendChild(none);
      return;
    }
    for (const id of filtered) {
      const btn = document.createElement('button');
      btn.className = 'model-choice';
      btn.textContent = id;
      btn.onclick = () => {
        if (modelPickerPick) modelPickerPick(id);
        closeModelPicker();
      };
      choices.appendChild(btn);
    }
  };
  render('');
  search.oninput = () => render(search.value.trim());
}
$('#btn-agent-set-browse').onclick = () => openModelPicker($('#agent-set-model'));
$('#btn-model-cancel').onclick = closeModelPicker;

