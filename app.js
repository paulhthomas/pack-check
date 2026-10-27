// Sole Mate pack check: verify every item on an online order by barcode before it ships.
// Runs as an embedded app page in Shopify admin. Talks to the Admin API directly (no server).

const API = 'shopify:admin/api/2026-10/graphql.json';
const COLLECTION_METHOD = 'Sole Mate Merthyr Tydfil';
const app = document.getElementById('app');

let orders = [];
let staffName = null; // filled from the logged-in Shopify user when available
let current = null; // { order, lines: [...], overrides: [] }

// ---------- Shopify API ----------
async function gql(query, variables = {}) {
  const res = await fetch(API, { method: 'POST', body: JSON.stringify({ query, variables }) });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

const ORDERS_QUERY = `
query ($q: String!) {
  orders(first: 50, sortKey: CREATED_AT, query: $q) {
    nodes {
      id name createdAt sourceName tags
      shippingLine { title }
      shippingAddress { name address1 address2 city zip countryCodeV2 }
      billingAddress { name }
      customer { displayName }
      lineItems(first: 50) {
        nodes {
          id name sku quantity unfulfilledQuantity requiresShipping variantTitle
          image { url(transform: { maxWidth: 160 }) }
          product { title }
          variant { id title barcodes(first: 10) { nodes { value } } }
        }
      }
    }
  }
}`;

// Who is logged in: the app runs as the signed-in staff member, so ask Shopify who that is.
// Falls back to asking for initials if Shopify won't say.
async function loadStaff() {
  try {
    const data = await gql('{ currentStaffMember { name } }');
    if (data.currentStaffMember && data.currentStaffMember.name) staffName = data.currentStaffMember.name;
  } catch (e) { console.warn('Staff lookup failed, using initials instead:', e.message); }
}

async function loadOrders() {
  app.innerHTML = '<p class="empty">Loading orders…</p>';
  try {
    if (!staffName) await loadStaff();
    const data = await gql(ORDERS_QUERY, { q: 'fulfillment_status:unshipped status:open' });
    orders = data.orders.nodes
      .filter(o => o.sourceName !== 'pos')
      .filter(o => !o.tags.includes('scan-verified'))
      .map(o => ({ ...o, packLines: o.lineItems.nodes.filter(l => l.requiresShipping && l.unfulfilledQuantity > 0) }))
      .filter(o => o.packLines.length > 0);
    orders.forEach(clearStaleFlag);
    renderList();
  } catch (e) {
    app.innerHTML = `<div class="banner warn">Couldn't load orders: ${esc(e.message)}</div><button onclick="loadOrders()">Try again</button>`;
  }
}

// ---------- Address check (same rules as the Flow check) ----------
const STREET = /\b(road|rd|street|st|lane|ln|close|cl|avenue|ave|terrace|terr|way|drive|dr|crescent|cres|place|pl|gardens|gdns|grove|hill|row|walk|park|view|square|sq|mews|rise|court|ct|heol|stryd|ffordd|lon|llys|maes|cwrt)\.?$/i;
const HOUSE = /\b(house|farm|cottage|barn|lodge|end|hall|manor|villa|bungalow|mill|grange|ty|tŷ|bwthyn|fferm|plas)\b/i;
const POSTCODE = /^(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/;

function addressIssues(o) {
  if (isCollection(o)) return [];
  const a = o.shippingAddress;
  if (!a) return [];
  const a1 = (a.address1 || '').trim(), a2 = (a.address2 || '').trim();
  const issues = [];
  if (!a1 && !a2) issues.push('Address lines are blank');
  else if (!/\d/.test(a1 + ' ' + a2) && !a1.includes(',') && a1.split(/\s+/).length <= 3 && STREET.test(a1) && !HOUSE.test(a1)) {
    issues.push('No house number or name');
  }
  if (a.countryCodeV2 === 'GB' && !POSTCODE.test((a.zip || '').trim().toUpperCase())) issues.push('Postcode looks wrong');
  if (/\d/.test(a.name || '')) issues.push('Number typed in the name field');
  return issues;
}
// Pick-up orders: the in-store pick-up method, or an online order with nowhere to post it
const isCollection = o => (o.shippingLine && o.shippingLine.title === COLLECTION_METHOD) || !o.shippingAddress;
// Pick-up orders have no delivery address, so fall back to the billing name or the customer record
const customerName = o => (o.shippingAddress && o.shippingAddress.name) || (o.billingAddress && o.billingAddress.name) || (o.customer && o.customer.displayName) || '';
// Live check only: once the address is fixed, the alert goes, even if the order still carries an old address-flag tag
const isFlagged = o => !o.tags.includes('address-ok') && addressIssues(o).length > 0;

// ---------- Order list ----------
function renderList() {
  const rows = orders.map(o => {
    const items = o.packLines.reduce((n, l) => n + l.unfulfilledQuantity, 0);
    const pills = (isFlagged(o) ? '<span class="pill warn">Check address</span>' : '') + (isCollection(o) ? '<span class="pill info">Collection</span>' : '');
    return `<button class="order" onclick="openOrder('${o.id}')">
      <b>${esc(o.name)}</b>${pills}<br>
      <span class="meta">${esc(customerName(o))} · ${items} item${items === 1 ? '' : 's'} · ${new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
    </button>`;
  }).join('');
  app.innerHTML = `
    <div class="topbar"><h1>Orders to pack</h1><button class="ghost" onclick="loadOrders()">Refresh</button></div>
    <p class="sub">Packing as ${esc(packer() || 'not set')}${staffName ? '' : ' · <a href="#" onclick="setPacker();return false;">change</a>'}</p>
    ${rows || '<p class="empty">Nothing waiting to pack.</p>'}`;
}

// ---------- Pack screen ----------
function openOrder(id) {
  if (!packer()) setPacker();
  const order = orders.find(o => o.id === id);
  clearStaleFlag(order);
  const saved = JSON.parse(localStorage.getItem('pack:' + id) || '{}');
  current = {
    order,
    overrides: saved.overrides || [],
    lines: order.packLines.map(l => ({
      ...l,
      need: l.unfulfilledQuantity,
      got: (saved.got && saved.got[l.id]) || 0,
      codes: ((l.variant && l.variant.barcodes.nodes) || []).map(b => norm(b.value)).filter(Boolean),
    })),
  };
  renderPack();
}

function renderPack(feedback) {
  const { order, lines } = current;
  const a = order.shippingAddress || {};
  const issues = order.tags.includes('address-ok') ? [] : addressIssues(order);
  const flagged = isFlagged(order);
  const allDone = lines.every(l => l.got >= l.need);

  const lineHtml = lines.map((l, i) => {
    const done = l.got >= l.need;
    const noCode = l.codes.length === 0;
    return `<div class="line ${done ? 'done' : ''} ${noCode && !done ? 'nobarcode' : ''}">
      <img src="${l.image ? l.image.url : ''}" alt="">
      <div>
        <div class="name">${esc(l.product ? l.product.title : l.name)}</div>
        <div class="variant">${esc(l.variantTitle && l.variantTitle !== 'Default Title' ? l.variantTitle : '')}</div>
        <div class="small">${l.sku ? 'SKU ' + esc(l.sku) + ' · ' : ''}${noCode ? 'No barcode in Shopify' : esc(l.codes.join(', '))}</div>
      </div>
      <div class="count">${l.got}/${l.need}</div>
      ${noCode && !done ? `<button class="ghost confirm" onclick="confirmByEye(${i})">No barcode: confirm by eye</button>` : ''}
    </div>`;
  }).join('');

  app.innerHTML = `
    <div class="topbar"><button class="ghost" onclick="backToList()">‹ Orders</button><h1>${esc(order.name)}</h1></div>
    ${flagged ? `<div class="banner warn"><b>Check this address.</b> ${esc(issues.join('. '))}. Check the inbox in case the customer has replied; if not, pack and send as normal.
      <div class="actions"><button onclick="addressOk()">Named house – OK</button><button class="ghost" onclick="openInAdmin()">Edit address in Shopify</button></div></div>` : ''}
    <div class="addr">${isCollection(order) ? '<b>Collection in store</b><br>' : ''}${esc(customerName(order))}${isCollection(order) && !order.shippingAddress ? '' : '<br>' + esc([a.address1, a.address2, a.city, a.zip].filter(Boolean).join(', '))}</div>
    <div class="scanbar">
      <button class="scanbtn" onclick="scan()">Scan item</button>
      <div class="row2"><input id="typed" inputmode="numeric" autocomplete="off" placeholder="Or type a barcode"><button class="ghost" onclick="checkTyped()">Check</button></div>
      <div id="feedback" class="${feedback ? feedback.kind : ''}">${feedback ? esc(feedback.text) : ''}</div>
    </div>
    ${lineHtml}
    <button style="width:100%;margin-top:8px" ${allDone ? '' : 'disabled'} onclick="complete()">${allDone ? 'Complete – all items checked' : 'Scan every item to complete'}</button>
`;
  const input = document.getElementById('typed');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') checkTyped(); });
}

async function scan() {
  if (!window.shopify || !shopify.scanner) { renderPack({ kind: 'stop', text: "Shopify's scanner isn't available here. Type the barcode instead." }); return; }
  try {
    const result = await shopify.scanner.capture();
    await handleCode(result && result.data);
  } catch (e) { /* scan cancelled */ }
}

function checkTyped() {
  const input = document.getElementById('typed');
  const value = input.value; input.value = '';
  handleCode(value);
}

async function handleCode(raw) {
  const code = norm(raw);
  if (!code) return;
  const line = current.lines.find(l => l.codes.includes(code));
  if (line && line.got < line.need) {
    line.got += 1; save(); buzz(true);
    renderPack({ kind: 'go', text: `✓ ${line.product ? line.product.title : line.name}${line.variantTitle && line.variantTitle !== 'Default Title' ? ' – ' + line.variantTitle : ''}` });
    return;
  }
  if (line) { buzz(false); renderPack({ kind: 'warn', text: `Already have all of ${line.variantTitle || line.name}. Is this an extra one?` }); return; }
  // Not on this order: find out what was scanned so the packer knows what went wrong
  buzz(false);
  try {
    const data = await gql(`query ($q: String!) { productVariants(first: 3, query: $q) { nodes { displayName } } }`, { q: 'barcode:' + String(raw).trim() });
    const found = data.productVariants.nodes;
    renderPack({ kind: 'stop', text: found.length
      ? `✗ Wrong item. You scanned ${found[0].displayName}, which isn't on this order.`
      : `✗ Unknown barcode ${String(raw).trim()}. It isn't saved on any product in Shopify.` });
  } catch (e) {
    renderPack({ kind: 'stop', text: `✗ ${String(raw).trim()} doesn't match anything on this order.` });
  }
}

function confirmByEye(i) {
  const line = current.lines[i];
  const reason = prompt(`No barcode is saved for ${line.name}. Check it by eye, then say what you checked (e.g. "size 9 label checked"):`);
  if (!reason) return;
  line.got = line.need;
  current.overrides.push(`${line.name}: ${reason} (${packer()})`);
  save();
  renderPack({ kind: 'warn', text: `Confirmed by eye: ${line.name}` });
}

async function complete() {
  const { order, overrides } = current;
  const tags = ['scan-verified'].concat(overrides.length ? ['scan-override'] : []);
  try {
    const data = await gql(`mutation ($id: ID!, $tags: [String!]!, $mf: [MetafieldsSetInput!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { message } }
      metafieldsSet(metafields: $mf) { userErrors { message } }
    }`, {
      id: order.id, tags,
      mf: [
        { ownerId: order.id, namespace: 'pack_check', key: 'packed_by', type: 'single_line_text_field', value: packer() || 'unknown' },
        { ownerId: order.id, namespace: 'pack_check', key: 'packed_at', type: 'date_time', value: new Date().toISOString() },
      ].concat(overrides.length ? [{ ownerId: order.id, namespace: 'pack_check', key: 'overrides', type: 'multi_line_text_field', value: overrides.join('\n') }] : []),
    });
    const errs = [...data.tagsAdd.userErrors, ...data.metafieldsSet.userErrors];
    if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
    localStorage.removeItem('pack:' + order.id);
    if (window.shopify && shopify.toast) shopify.toast.show(`${order.name} checked and ready to label`);
    orders = orders.filter(o => o.id !== order.id);
    current = null;
    renderList();
  } catch (e) {
    renderPack({ kind: 'stop', text: `Couldn't save: ${e.message}. Try Complete again.` });
  }
}

async function addressOk() {
  const { order } = current;
  try {
    await gql(`mutation ($id: ID!) {
      a: tagsAdd(id: $id, tags: ["address-ok"]) { userErrors { message } }
      r: tagsRemove(id: $id, tags: ["address-flag"]) { userErrors { message } }
    }`, { id: order.id });
    order.tags = order.tags.filter(t => t !== 'address-flag').concat('address-ok');
    renderPack({ kind: 'go', text: 'Address marked OK' });
  } catch (e) {
    renderPack({ kind: 'stop', text: `Couldn't save: ${e.message}` });
  }
}

function openInAdmin() {
  const num = current.order.id.split('/').pop();
  window.open(`shopify://admin/orders/${num}`, '_top');
}

// Address corrected since Flow flagged it: remove the tag so admin filters and the daily report stay accurate
function clearStaleFlag(order) {
  if (!order.tags.includes('address-flag') || addressIssues(order).length > 0) return;
  order.tags = order.tags.filter(t => t !== 'address-flag');
  gql(`mutation ($id: ID!) { tagsRemove(id: $id, tags: ["address-flag"]) { userErrors { message } } }`, { id: order.id })
    .catch(e => console.warn('Could not remove address-flag:', e.message));
}

function backToList() { current = null; renderList(); }

// ---------- Helpers ----------
function save() {
  const got = {}; current.lines.forEach(l => { got[l.id] = l.got; });
  localStorage.setItem('pack:' + current.order.id, JSON.stringify({ got, overrides: current.overrides }));
}
// Compare barcodes ignoring spaces and leading zeros (scanners sometimes add a 0 to 12-digit codes)
function norm(v) { return String(v || '').replace(/\s/g, '').replace(/^0+/, ''); }
function packer() { return staffName || localStorage.getItem('packer'); }
function setPacker() {
  const v = prompt('Your initials, so packed orders show who checked them:', packer() || '');
  if (v) localStorage.setItem('packer', v.trim().toUpperCase());
  if (!current) renderList();
}
function buzz(ok) { if (navigator.vibrate) navigator.vibrate(ok ? 60 : [120, 80, 120]); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

loadOrders();
