import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert, Button, Field } from '../components/ui';
import { rupeesExact } from '../lib/format';
import { navigate } from '../router';
import type { Lead, QuoteProduct, QuoteTotals } from '../types';

interface Line { productId: string; qty: string }
const OPEN = ['new', 'contacted', 'qualified', 'quotation'];

// New quotation (leadId given) or revise a draft / rejected one (quoteId given). The total shown is the server's, from the checkout engine.
export function QuoteEditor({ leadId, quoteId }: { leadId?: string; quoteId?: string }) {
  const [products, setProducts] = useState<QuoteProduct[]>([]);
  const [lead, setLead] = useState<Lead | null>(null);
  const [state, setState] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<Line[]>([{ productId: '', qty: '' }]);
  const [days, setDays] = useState('15');
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<QuoteTotals | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    (async () => {
      try {
        setProducts(await api.quoteProducts());
        if (quoteId) {
          const { quote } = await api.quote(quoteId);
          setState(quote.shipState ?? undefined); setNotes(quote.notes ?? '');
          setLines((quote.items ?? []).map((i) => ({ productId: i.productId, qty: String(i.qty) })));
        } else if (leadId) {
          const l = (await api.leads()).items.find((x) => x.id === leadId);
          if (!l || !OPEN.includes(l.status)) { setBanner('This lead is not open for quoting.'); } else { setLead(l); setState(l.state ?? undefined); }
        }
      } catch (e) { setBanner(e instanceof ApiError ? e.message : 'Something went wrong.'); }
      setReady(true);
    })();
  }, []);

  const valid = lines.filter((l) => l.productId && /^\d+$/.test(l.qty));
  const items = valid.map((l) => ({ productId: l.productId, qty: Number(l.qty) }));
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!items.length) { setPreview(null); setPreviewErr(''); return; }
    timer.current = window.setTimeout(() => { api.quotePrice(items, state).then((r) => { setPreview(r.totals); setPreviewErr(''); }).catch((e) => { setPreview(null); setPreviewErr(e instanceof ApiError ? [e.message, ...Object.values(e.fields)].join(' · ') : 'Could not price this.'); }); }, 400);
    return () => window.clearTimeout(timer.current);
  }, [JSON.stringify(items), state]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const pick = (i: number, id: string) => { const p = products.find((x) => x.id === id); setLine(i, { productId: id, qty: p ? String(p.moq) : '' }); };

  const save = async () => {
    setBanner(''); setErrs({});
    if (!items.length || items.length !== lines.filter((l) => l.productId || l.qty).length) { setBanner('Choose a product and a whole-number quantity on every line.'); return; }
    setBusy(true);
    try {
      const body = { items, validDays: Number(days) || undefined, notes: notes.trim() || undefined };
      const r = quoteId ? await api.editQuote(quoteId, body) : await api.createQuote({ ...body, leadId: leadId! });
      navigate('/quotes/' + r.quote.id);
    } catch (e) { if (e instanceof ApiError) { setBanner(e.message); setErrs(e.fields); } else setBanner('Something went wrong. Please try again.'); setBusy(false); }
  };

  if (!ready) return <p class="center" role="status">Loading…</p>;
  if (!quoteId && !lead) return <div class="card"><h1>New quotation</h1><Alert kind="bad">{banner || 'Lead not found.'}</Alert><div class="row"><Button onClick={() => navigate('/leads')}>Back to leads</Button></div></div>;
  return (
    <>
      <div class="card">
        <button class="backlink" type="button" onClick={() => navigate(quoteId ? '/quotes/' + quoteId : '/leads/' + leadId)}>← Back</button>
        <h1>{quoteId ? 'Revise quotation' : 'New quotation'}</h1>
        {lead && <p class="muted">For <strong>{lead.businessName}</strong> ({lead.contactName}, {lead.phone}){lead.state ? ` · delivering to ${lead.state}` : ' · no delivery state on the lead, so shipping is left out'}.</p>}
        {banner && <Alert kind="bad">{banner}</Alert>}
        <ul class="docs">
          {lines.map((l, i) => {
            const p = products.find((x) => x.id === l.productId);
            return (
              <li class="doc" key={i}>
                <Field id={`prod-${i}`} label={`Product ${i + 1}`} error={errs[`items.${i}`]}>{(a) => (
                  <select {...a} value={l.productId} onChange={(e) => pick(i, (e.target as HTMLSelectElement).value)}>
                    <option value="">Choose a product…</option>
                    {products.map((x) => <option key={x.id} value={x.id}>{x.name} · {rupeesExact(x.listPricePaise)}{x.allInclusive ? ' incl. GST' : ' + GST'}</option>)}
                  </select>)}
                </Field>
                <Field id={`qty-${i}`} label="Quantity" hint={p ? (p.fixed ? 'Sold as one kit.' : `Minimum ${p.moq}. Bigger quantities earn quantity discounts automatically.`) : undefined}>{(a) => <input {...a} type="number" inputMode="numeric" min={p?.moq ?? 1} value={l.qty} onInput={(e) => setLine(i, { qty: (e.target as HTMLInputElement).value })} />}</Field>
                {lines.length > 1 && <button class="backlink" type="button" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>Remove this line</button>}
              </li>
            );
          })}
        </ul>
        <div class="row"><Button onClick={() => setLines((ls) => [...ls, { productId: '', qty: '' }])}>Add another product</Button></div>
      </div>

      <div class="card">
        <h2 class="mt0">Price</h2>
        {previewErr && <Alert kind="bad">{previewErr}</Alert>}
        {!preview && !previewErr && <p class="muted">Choose products to see the price.</p>}
        {preview && (
          <dl class="summary">
            <div><dt>List price</dt><dd>{rupeesExact(preview.subtotalPaise)}</dd></div>
            {preview.discountPaise > 0 && <div><dt>Quantity discount</dt><dd>−{rupeesExact(preview.discountPaise)}</dd></div>}
            <div><dt>GST</dt><dd>{rupeesExact(preview.gstPaise)}</dd></div>
            <div><dt>Shipping</dt><dd>{state ? (preview.shippingPaise > 0 ? rupeesExact(preview.shippingPaise) : 'Free') : 'Extra (not included)'}</dd></div>
            <div><dt><strong>Total</strong></dt><dd><strong>{rupeesExact(preview.totalPaise)}</strong></dd></div>
          </dl>
        )}
        <p class="small muted">This is the amount your customer would be charged at checkout. Prices cannot be changed by hand.</p>
        <Field id="days" label="Valid for (days)" error={errs.validDays}>{(a) => <input {...a} type="number" inputMode="numeric" min={1} max={60} value={days} onInput={(e) => setDays((e.target as HTMLInputElement).value)} />}</Field>
        <Field id="notes" label="Notes for Ntagz (optional)" hint="For example custom branding or delivery needs. Ntagz sees this when approving.">{(a) => <textarea {...a} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />}</Field>
        <div class="row"><Button primary busy={busy} onClick={() => void save()}>{quoteId ? 'Save changes' : 'Save draft'}</Button></div>
      </div>
    </>
  );
}
