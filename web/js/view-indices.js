// Step 3: pick the indices and the frequency, then calculate.

import { $, h, replace, icon, show, createStatus } from './dom.js';
import { groupIndices, indexAvailability } from './shape.js';

let listStatus = null;
let computeStatus = null;
let busy = false;
let aborter = null;

export function init(ctx) {
  const { state } = ctx;
  listStatus = createStatus($('indices-status'), ctx);
  computeStatus = createStatus($('compute-status'), ctx);

  for (const id of ['freq-annual', 'freq-monthly']) {
    $(id).addEventListener('change', (ev) => {
      if (!ev.target.checked) return;
      state.frequency = ev.target.value;
      ctx.persist();
      render(ctx);
    });
  }
  $('btn-select-all').addEventListener('click', () => {
    for (const ix of state.indices || []) if (availability(ctx, ix).ok) state.selection.add(ix.id);
    touched(ctx);
  });
  $('btn-select-none').addEventListener('click', () => {
    state.selection.clear();
    touched(ctx);
  });
  $('indices-groups').addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.matches('[data-index]')) {
      if (el.checked) state.selection.add(el.getAttribute('data-index'));
      else state.selection.delete(el.getAttribute('data-index'));
      touched(ctx, false);
    } else if (el.matches('[data-group]')) {
      const group = el.getAttribute('data-group');
      for (const ix of state.indices || []) {
        if (ix.group !== group || !availability(ctx, ix).ok) continue;
        if (el.checked) state.selection.add(ix.id);
        else state.selection.delete(ix.id);
      }
      touched(ctx);
    }
  });
  $('btn-calculate').addEventListener('click', () => calculate(ctx));
  ctx.actions.calculate = () => calculate(ctx);
}

// "Checked against R" when the values agree with the original tool for the sample station;
// "Differs from R" when they were compared and do not (the validation report explains why).
// Nothing at all when an index has not been compared.
export function validationBadge(ctx, ix) {
  if (ix.validated) return h('span', { class: 'badge' }, icon('badge'), ctx.t('indices.validated'));
  if (differs(ix)) return h('span', { class: 'badge badge-warn' }, icon('warning'), ctx.t('indices.differs'));
  return null;
}

const differs = (ix) => !ix.validated && ix.validation && typeof ix.validation === 'object' && Object.values(ix.validation).some((v) => v === 'differs');

const availability = (ctx, ix) => indexAvailability(ix, ctx.state.dataset, ctx.state.frequency);

// The ids that will actually be sent: ticked and possible at the current frequency.
function effective(ctx) {
  const { state } = ctx;
  return (state.indices || []).filter((ix) => state.selection.has(ix.id) && availability(ctx, ix).ok).map((ix) => ix.id);
}

function touched(ctx, repaintList = true) {
  ctx.state.selectionTouched = true;
  ctx.persist();
  if (repaintList) paintGroups(ctx);
  else paintCounts(ctx);
}

function paintCounts(ctx) {
  const { state, t, tn, fmt } = ctx;
  const ids = effective(ctx);
  const possible = (state.indices || []).filter((ix) => availability(ctx, ix).ok);
  $('selection-count').textContent = t('indices.count', { n: fmt.int(ids.length), total: fmt.int(possible.length) });
  $('btn-calculate-text').textContent = ids.length ? tn('indices.calculateN', ids.length, { n: fmt.int(ids.length) }) : t('indices.calculate');
  const btn = $('btn-calculate');
  btn.disabled = busy;
  if (ids.length && !busy) btn.removeAttribute('aria-disabled');
  else btn.setAttribute('aria-disabled', 'true');
  for (const box of document.querySelectorAll('#indices-groups [data-group]')) {
    const group = box.getAttribute('data-group');
    const items = possible.filter((ix) => ix.group === group);
    const on = items.filter((ix) => state.selection.has(ix.id)).length;
    box.checked = items.length > 0 && on === items.length;
    box.indeterminate = on > 0 && on < items.length;
    box.disabled = items.length === 0;
  }
}

function reasonText(ctx, a) {
  const { t, fmt } = ctx;
  if (a.reason === 'inputs') return t('indices.reason.inputs', { variables: a.missingInputs.map((v) => fmt.variable(v)).join(', ') });
  if (a.reason === 'frequency') return t('indices.reason.frequency.' + ctx.state.frequency);
  return '';
}

function paintGroups(ctx) {
  const { state, t, fmt } = ctx;
  const box = $('indices-groups');
  const groups = groupIndices(state.indices);
  const base = state.dataset && state.dataset.base_period;
  replace(
    box,
    groups.map(({ group, items }) =>
      h(
        'fieldset',
        { class: 'group' },
        h('legend', { text: ctx.i18n.has('group.' + group) ? t('group.' + group) : group }),
        h('label', { class: 'group-all' }, h('input', { type: 'checkbox', 'data-group': group, id: 'grp-' + group }), h('span', { text: t('indices.groupAll') })),
        h(
          'ul',
          { class: 'index-list' },
          items.map((ix) => {
            const a = availability(ctx, ix);
            const id = 'ix-' + ix.id;
            const input = h('input', { type: 'checkbox', id, 'data-index': ix.id, 'aria-describedby': id + '-d' });
            input.checked = a.ok && state.selection.has(ix.id);
            input.disabled = !a.ok;
            return h(
              'li',
              { class: 'index-row' + (a.ok ? '' : ' is-off') },
              input,
              h(
                'label',
                { for: id },
                h('span', { class: 'index-name', text: ix.name || ix.id }),
                ' ',
                h('span', { class: 'index-long', text: ix.long_name || '' }),
                ' ',
                h('span', { class: 'index-units', text: '(' + fmt.unit(ix.units) + ')' }),
                ' ',
                validationBadge(ctx, ix),
                h(
                  'span',
                  { class: 'index-desc', id: id + '-d' },
                  ix.description || '',
                  ix.needs_base_period && base ? ' ' + t('indices.usesBase', { start: base.start, end: base.end }) : '',
                ),
                a.ok ? null : h('span', { class: 'index-reason', text: reasonText(ctx, a) }),
              ),
            );
          }),
        ),
      ),
    ),
  );
  paintCounts(ctx);
}

async function calculate(ctx) {
  const { state, t, tn, fmt, api } = ctx;
  if (busy || !state.dataset) return;
  const ids = effective(ctx);
  if (!ids.length) {
    computeStatus.error(t('indices.none'));
    return;
  }
  const ds = state.dataset;
  busy = true;
  state.busy = true;
  aborter = new AbortController();
  paintCounts(ctx);
  computeStatus.busy(tn('indices.status.calculating', ids.length, { n: fmt.int(ids.length) }), {
    slowAfter: 15,
    slowText: t('indices.status.slow'),
    onCancel: () => aborter.abort(),
  });
  const finish = () => {
    busy = false;
    state.busy = false;
    aborter = null;
    paintCounts(ctx);
  };
  try {
    const result = await api.compute(ds.id, ids, state.frequency, {
      signal: aborter.signal,
      onEvent: (ev) => {
        if (ev.type === 'retry') computeStatus.retrying(ev);
        else if (ev.type === 'attempt') computeStatus.attempt();
      },
    });
    finish();
    state.result = result;
    state.computedAt = Date.now();
    ctx.store.saveResult(result, state.computedAt);
    computeStatus.clear();
    ctx.announce(tn('indices.done', (result.results || []).length, { n: fmt.int((result.results || []).length) }));
    ctx.go(4);
  } catch (err) {
    finish();
    if (err && err.kind === 'aborted') {
      computeStatus.clear();
      ctx.announce(t('error.cancelled'));
    } else if (err && err.expired) {
      computeStatus.clear();
      ctx.markExpired('compute');
    } else {
      const d = ctx.describeError(err);
      computeStatus.error(d.message, { details: d.details, hint: d.hint, actions: [{ label: t('common.retry'), onClick: () => calculate(ctx), primary: true }] });
    }
  }
}

export function render(ctx) {
  const { state, t, fmt } = ctx;
  if (!state.dataset) return;
  $('freq-annual').checked = state.frequency === 'annual';
  $('freq-monthly').checked = state.frequency === 'monthly';

  if (!state.indices) {
    replace($('indices-groups'));
    show($('validated-note'), false);
    if (state.indicesError) {
      const d = ctx.describeError(state.indicesError);
      listStatus.error(t('indices.listFailed', { reason: d.message }), {
        actions: [
          {
            label: t('common.retry'),
            primary: true,
            onClick: () => {
              state.indicesError = null;
              render(ctx);
            },
          },
        ],
      });
    } else {
      if (!listStatus.busyNow) listStatus.busy(t('indices.listLoading'));
      ctx
        .ensureIndices()
        .then(() => render(ctx))
        .catch(() => render(ctx));
    }
    paintCounts(ctx);
    return;
  }
  listStatus.clear();

  // First visit: everything that can be calculated is ticked.
  if (!state.selectionTouched && state.selection.size === 0) {
    for (const ix of state.indices) if (indexAvailability(ix, state.dataset, 'annual').ok) state.selection.add(ix.id);
  }

  const note = $('validated-note');
  const nValidated = state.indices.filter((ix) => ix.validated).length;
  const nDiffers = state.indices.filter(differs).length;
  replace(
    note,
    nValidated ? icon('badge', 'tone-ok') : icon('info'),
    h('span', {
      text:
        (nValidated ? t('indices.validatedNote', { n: fmt.int(nValidated), total: fmt.int(state.indices.length) }) : t('indices.validatedNone')) +
        (nDiffers ? ' ' + ctx.tn('indices.differsNote', nDiffers, { n: fmt.int(nDiffers) }) : ''),
    }),
  );
  show(note, true);
  paintGroups(ctx);
}
