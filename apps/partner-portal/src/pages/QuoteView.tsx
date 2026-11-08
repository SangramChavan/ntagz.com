import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert, Button } from '../components/ui';
import { rupeesExact } from '../lib/format';
import { QUOTE_STATUS, day, waLink } from '../lib/quotes';
import { navigate } from '../router';
import type { Quote } from '../types';

export function QuoteView({ id }: { id: string }) {
  const [q, setQ] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { api.quote(id).then((r) => setQ(r.quote)).catch((e) => setError(e instanceof ApiError && e.status === 404 ? 'This quotation was not found.' : 'Could not load this quotation.')); }, [id]);
  const run = async (fn: () => Promise<{ quote: Quote }>) => {
    setBusy(true); setError('');
    try { setQ((await fn()).quote); setConfirmCancel(false); } catch (e) { setError(e instanceof ApiError ? e.message + (Object.values(e.fields).length ? ': ' + Object.values(e.fields).join(', ') : '') : 'Something went wrong.'); } finally { setBusy(false); }
  };
  if (error && !q) return <div class="card"><h1>Quotation</h1><Alert kind="bad">{error}</Alert><div class="row"><Button onClick={() => navigate('/quotes')}>Back to quotations</Button></div></div>;
  if (!q) return <p class="center" role="status">Loading…</p>;

  const s = q.status; const [label, tone] = QUOTE_STATUS[s];
  const copy = async () => { try { await navigator.clipboard.writeText(q.shareText ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy failed. Select the text and copy it by hand.'); } };
  const cancelable = ['draft', 'pending_approval', 'rejected', 'approved'].includes(s);

  return (
    <>
      <div class="card">
        <button class="backlink" type="button" onClick={() => navigate('/quotes')}>← All quotations</button>
        <div class="titlerow"><h1>{q.number}</h1><span class={`pill ${tone}`}>{label}</span></div>
        <p class="muted">For <button class="backlink" type="button" onClick={() => navigate('/leads/' + q.leadId)}>{q.leadBusiness ?? q.customerName}</button> · valid until {day(q.validUntil)}</p>
        {error && <Alert kind="bad">{error}</Alert>}
        {s === 'rejected' && <Alert kind="warn"><strong>Ntagz asked for changes.</strong><br />{q.decisionNote}</Alert>}
        {s === 'pending_approval' && <Alert kind="info">Waiting for Ntagz to approve this quotation. You cannot change it meanwhile.</Alert>}
        {s === 'expired' && <Alert kind="warn">This quotation passed its valid date. Prepare a new one if the customer is still interested.</Alert>}
        {s === 'accepted' && <Alert kind="ok">The customer accepted this quotation. Ntagz can see this and follows up on the order.</Alert>}

        <ul class="docs">
          {q.items?.map((i) => (
            <li class="doc" key={i.productId}>
              <div class="head"><span>{i.qty.toLocaleString('en-IN')} × {i.name}</span><strong>{rupeesExact(i.lineNetPaise)}</strong></div>
              <span class="small muted">{rupeesExact(i.unitPricePaise)} each{i.bulkPct > 0 ? ` · ${i.bulkPct}% quantity discount` : ''}{i.allInclusive ? ' · GST included' : ''}</span>
            </li>
          ))}
        </ul>
        <dl class="summary">
          <div><dt>List price</dt><dd>{rupeesExact(q.subtotalPaise)}</dd></div>
          {q.discountPaise > 0 && <div><dt>Quantity discount</dt><dd>−{rupeesExact(q.discountPaise)}</dd></div>}
          <div><dt>GST</dt><dd>{rupeesExact(q.gstPaise)}</dd></div>
          <div><dt>Shipping</dt><dd>{q.shipState ? (q.shippingPaise > 0 ? rupeesExact(q.shippingPaise) : 'Free') : 'Extra (not included)'}</dd></div>
          <div><dt><strong>Total</strong></dt><dd><strong>{rupeesExact(q.totalPaise)}</strong></dd></div>
          {q.notes && <div><dt>Your notes</dt><dd>{q.notes}</dd></div>}
        </dl>

        {(s === 'draft' || s === 'rejected') && (
          <div class="row">
            <Button onClick={() => navigate(`/quotes/${id}/edit`)}>{s === 'draft' ? 'Edit' : 'Revise'}</Button>
            {s === 'draft' && <Button primary busy={busy} onClick={() => void run(() => api.quoteAction(id, 'submit'))}>Send to Ntagz for approval</Button>}
          </div>
        )}
        {s === 'approved' && <div class="row"><Button primary busy={busy} onClick={() => void run(() => api.quoteAction(id, 'sent'))}>I sent it to the customer</Button></div>}
        {(s === 'approved' || s === 'sent') && (
          <div class="row">
            <Button onClick={() => void run(() => api.quoteAnswer(id, 'accepted'))}>Customer accepted</Button>
            <Button onClick={() => void run(() => api.quoteAnswer(id, 'declined'))}>Customer declined</Button>
          </div>
        )}
        {cancelable && !confirmCancel && <div class="row"><button class="backlink" type="button" onClick={() => setConfirmCancel(true)}>Cancel this quotation</button></div>}
        {confirmCancel && <div class="row"><Button busy={busy} onClick={() => void run(() => api.quoteAction(id, 'cancel'))}>Yes, cancel it</Button><Button onClick={() => setConfirmCancel(false)}>Keep it</Button></div>}
      </div>

      {q.shareText && ['approved', 'sent', 'accepted'].includes(s) && (
        <div class="card">
          <h2 class="mt0">Send this to your customer</h2>
          <p class="small muted">This summary is frozen: the prices stay as shown until {day(q.validUntil)}, even if catalogue prices change.</p>
          <label class="sr" for="share">Quotation text</label>
          <textarea id="share" readOnly value={q.shareText} rows={12} />
          <div class="row">
            <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy text'}</Button>
            <a class="btn" href={waLink(q.customerPhone, q.shareText)} target="_blank" rel="noopener">Open in WhatsApp</a>
          </div>
        </div>
      )}
    </>
  );
}
