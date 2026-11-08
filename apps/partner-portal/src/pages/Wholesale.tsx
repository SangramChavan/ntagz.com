import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert, Button, Field } from '../components/ui';
import { rupeesExact } from '../lib/format';
import { day } from '../lib/quotes';
import type { Credit, WholesaleCatalogue, WholesaleOrder, WholesalePlaced, WholesalePrice } from '../types';

const STATUS: Record<string, [string, string]> = { awaiting_payment: ['Awaiting payment', 'accent'], expired: ['Expired', ''], cancelled: ['Cancelled', ''], confirmed: ['Paid', 'ok'], placed: ['Paid', 'ok'] };
const msg = (e: unknown) => (e instanceof ApiError ? [e.message, ...Object.values(e.fields)].join(' · ') : 'Something went wrong. Please try again.');

// Wholesale ordering at your partner price. Prices, GST, shipping and the stock-credit split are all computed by the server; nothing here can change them.
export function Wholesale() {
  const [cat, setCat] = useState<WholesaleCatalogue | null>(null);
  const [orders, setOrders] = useState<WholesaleOrder[]>([]);
  const [credit, setCredit] = useState<Credit | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [useCredit, setUseCredit] = useState(true);
  const [addr, setAddr] = useState({ address: '', pincode: '', state: '', phone: '', gstin: '' });
  const [preview, setPreview] = useState<WholesalePrice | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [placed, setPlaced] = useState<WholesalePlaced | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const timer = useRef<number>(0);

  const reload = async () => {
    try { const [c, o] = await Promise.all([api.wholesaleCatalogue(), api.wholesaleOrders()]); setCat(c); setOrders(o.items); setCredit(o.credit); setLoadErr(''); }
    catch (e) { setLoadErr(msg(e)); }
  };
  useEffect(() => { void reload(); }, []);

  const items = Object.entries(qty).filter(([, v]) => /^\d+$/.test(v) && Number(v) > 0).map(([productId, v]) => ({ productId, qty: Number(v) }));
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!items.length) { setPreview(null); setPreviewErr(''); return; }
    timer.current = window.setTimeout(() => { api.wholesalePrice(items, addr.state.trim() || undefined, useCredit).then((r) => { setPreview(r); setPreviewErr(''); }).catch((e) => { setPreview(null); setPreviewErr(msg(e)); }); }, 400);
    return () => window.clearTimeout(timer.current);
  }, [JSON.stringify(items), addr.state, useCredit]);

  const place = async () => {
    setBanner(''); setErrs({}); setBusy(true);
    try {
      const r = await api.wholesalePlace(items, { ...addr, gstin: addr.gstin.trim() || undefined }, useCredit);
      setPlaced(r); setQty({}); setPreview(null); await reload();
    } catch (e) { if (e instanceof ApiError) { setBanner(e.message); setErrs(e.fields); } else setBanner(msg(e)); }
    setBusy(false);
  };
  const cancel = async (id: string) => { try { const r = await api.wholesaleCancel(id); setOrders(r.items); setCredit(r.credit); const c = await api.wholesaleCatalogue(); setCat(c); } catch (e) { setBanner(msg(e)); } };

  if (loadErr) return <div class="card"><h1>Wholesale</h1><Alert kind="bad">{loadErr}</Alert><Button onClick={() => void reload()}>Try again</Button></div>;
  if (!cat || !credit) return <p class="center" role="status">Loading…</p>;
  const set = (k: keyof typeof addr, v: string) => setAddr((a) => ({ ...a, [k]: v }));
  return (
    <>
      <div class="card">
        <h1>Wholesale orders</h1>
        <p class="muted">Order stock at your partner price. Your opening stock order is held as stock credit and is used first, as products at your partner price. Nothing is refunded in cash.</p>
        <dl class="summary">
          <div><dt>Stock credit available</dt><dd>{rupeesExact(credit.availablePaise)}</dd></div>
          <div><dt>Opening stock order</dt><dd>{rupeesExact(credit.grantedPaise)}</dd></div>
          <div><dt>Used so far</dt><dd>{rupeesExact(credit.consumedPaise)}</dd></div>
          {credit.heldPaise > 0 && <div><dt>Reserved on unpaid orders</dt><dd>{rupeesExact(credit.heldPaise)}</dd></div>}
        </dl>
      </div>

      {placed && (
        <Alert kind="ok">
          {placed.kind === 'order'
            ? <>Order {placed.orderRef} placed and paid from your stock credit ({rupeesExact(placed.totalPaise)}). A GST invoice follows.</>
            : <>Your order is saved. Pay {rupeesExact(placed.payablePaise)} to confirm it{placed.creditPaise > 0 ? ` (${rupeesExact(placed.creditPaise)} comes from your stock credit)` : ''}. <a class="btn primary" href={placed.payUrl}>Pay {rupeesExact(placed.payablePaise)}</a></>}
        </Alert>
      )}

      <div class="card">
        <h2 class="mt0">Products</h2>
        {!cat.ready && <Alert kind="warn">Your partner prices are not available yet. Ntagz will confirm them with you; ordering opens as soon as they are set.</Alert>}
        <p class="small muted">Prices are before GST ({cat.gstPct}% is added at checkout). Delivery is charged by the same rules as normal orders.</p>
        <ul class="docs">
          {cat.products.map((p) => (
            <li class="doc" key={p.id}>
              <div class="head"><strong>{p.name}</strong>{p.priced && p.discountPct ? <span class="tag">−{p.discountPct}%</span> : null}</div>
              {p.priced
                ? <p class="small muted">Your price {rupeesExact(p.partnerExPaise!)} each{p.discountPct ? ` (retail ${rupeesExact(p.retailExPaise)})` : ''} · minimum {p.moq}{p.fixed ? ', sold as one kit' : ''}</p>
                : <p class="small muted">Price not available yet.</p>}
              {p.priced && <Field id={`q-${p.id}`} label={`Quantity of ${p.name}`}>{(a) => <input {...a} type="number" inputMode="numeric" min={0} value={qty[p.id] ?? ''} onInput={(e) => setQty((q) => ({ ...q, [p.id]: (e.target as HTMLInputElement).value }))} />}</Field>}
            </li>
          ))}
        </ul>
      </div>

      <div class="card">
        <h2 class="mt0">Your order</h2>
        {previewErr && <Alert kind="bad">{previewErr}</Alert>}
        {!preview && !previewErr && <p class="muted">Enter quantities to see the total.</p>}
        {preview && (
          <dl class="summary">
            {preview.lines.map((l) => <div key={l.productId}><dt>{l.qty} × {l.name}</dt><dd>{rupeesExact(l.lineExPaise)}</dd></div>)}
            {preview.totals.discountPaise > 0 && <div><dt>Partner discount already applied</dt><dd>{rupeesExact(preview.totals.discountPaise)}</dd></div>}
            <div><dt>GST</dt><dd>{rupeesExact(preview.totals.gstPaise)}</dd></div>
            <div><dt>Shipping</dt><dd>{addr.state.trim() ? (preview.totals.shippingPaise > 0 ? rupeesExact(preview.totals.shippingPaise) : 'Free') : 'Enter the state below'}</dd></div>
            <div><dt><strong>Order total</strong></dt><dd><strong>{rupeesExact(preview.totals.totalPaise)}</strong></dd></div>
            {preview.creditPaise > 0 && <div><dt>Paid from stock credit</dt><dd>−{rupeesExact(preview.creditPaise)}</dd></div>}
            <div><dt><strong>To pay now</strong></dt><dd><strong>{rupeesExact(preview.payablePaise)}</strong></dd></div>
          </dl>
        )}
        {credit.availablePaise > 0 && <label class="check"><input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit((e.target as HTMLInputElement).checked)} /> Use my stock credit</label>}
        {banner && <Alert kind="bad">{banner}</Alert>}
        <Field id="w-address" label="Delivery address" error={errs.address}>{(a) => <textarea {...a} value={addr.address} onInput={(e) => set('address', (e.target as HTMLTextAreaElement).value)} />}</Field>
        <Field id="w-pin" label="PIN code" error={errs.pincode}>{(a) => <input {...a} inputMode="numeric" maxLength={6} value={addr.pincode} onInput={(e) => set('pincode', (e.target as HTMLInputElement).value)} />}</Field>
        <Field id="w-state" label="State" error={errs.state}>{(a) => <input {...a} value={addr.state} onInput={(e) => set('state', (e.target as HTMLInputElement).value)} />}</Field>
        <Field id="w-phone" label="Mobile number for delivery" error={errs.phone}>{(a) => <input {...a} inputMode="tel" value={addr.phone} onInput={(e) => set('phone', (e.target as HTMLInputElement).value)} />}</Field>
        <Field id="w-gstin" label="GST number (optional)" hint="Printed on your GST invoice." error={errs.gstin}>{(a) => <input {...a} maxLength={15} value={addr.gstin} onInput={(e) => set('gstin', (e.target as HTMLInputElement).value.toUpperCase())} />}</Field>
        <div class="row"><Button primary busy={busy} disabled={!items.length || !preview} onClick={() => void place()}>{preview && preview.payablePaise === 0 ? 'Place order with stock credit' : 'Place order'}</Button></div>
      </div>

      <div class="card">
        <h2 class="mt0">Your wholesale orders</h2>
        {!orders.length && <p class="muted">No orders yet.</p>}
        <ul class="leadlist">
          {orders.map((o) => {
            const [label, cls] = STATUS[o.status] ?? [o.status.replace(/_/g, ' '), ''];
            return (
              <li key={o.kind + o.id} class="leadcard">
                <span class="leadtop"><strong>{o.ref} · {rupeesExact(o.totalPaise)}</strong><span class={`pill ${cls}`}>{label}</span></span>
                <span class="muted small">{day(o.at)} · {o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}{o.creditPaise > 0 ? ` · stock credit ${rupeesExact(o.creditPaise)}` : ''}</span>
                {o.status === 'awaiting_payment' && (
                  <span class="row"><a class="btn primary" href={o.payUrl ?? '#'}>Pay {rupeesExact(o.payablePaise)}</a><Button onClick={() => void cancel(o.id)}>Cancel order</Button></span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
