import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { Alert, Button, Field } from '../components/ui';
import { rupeesExact } from '../lib/format';
import { day } from '../lib/quotes';
import type { Commission, CommissionStatus, CommissionTotals, LedgerEntry, Settlement } from '../types';

const STATUS: Record<CommissionStatus, [string, string]> = {
  pending: ['Waiting for approval', 'accent'], approved: ['Approved, in refund window', ''], payable: ['Ready to be paid', 'ok'], paid: ['Paid', 'ok'], reversed: ['Reversed', 'bad'], disputed: ['Under review', 'accent'],
};
const KIND: Record<string, string> = { refund_partial: 'Part of the order was refunded', refund_full: 'Order refunded', refund_after_payment: 'Order refunded after payout', manual: 'Adjusted by Ntagz', dispute: 'Dispute' };
const CHIPS: Array<[string, string]> = [['', 'All'], ['pending', 'Waiting'], ['approved', 'Approved'], ['payable', 'Ready'], ['paid', 'Paid'], ['disputed', 'Under review'], ['reversed', 'Reversed']];
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

export function Earnings() {
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Commission[] | null>(null);
  const [totals, setTotals] = useState<CommissionTotals | null>(null);
  const [statements, setStatements] = useState<Settlement[]>([]);
  const [open, setOpen] = useState<{ c: Commission; ledger: LedgerEntry[] } | null>(null);
  const [reason, setReason] = useState('');
  const [fieldErr, setFieldErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async (s = status) => {
    try { const r = await api.commissions(s || undefined); setItems(r.items); setTotals(r.totals); setError(''); } catch (e) { setError(err(e)); }
  };
  useEffect(() => { void load(); api.settlements().then((r) => setStatements(r.items)).catch(() => undefined); }, []);
  const show = async (id: string) => { try { const r = await api.commission(id); setOpen({ c: r.commission, ledger: r.ledger }); setReason(''); setFieldErr(''); } catch (e) { setError(err(e)); } };
  const dispute = async () => {
    if (!open) return; if (reason.trim().length < 3) { setFieldErr('Say what looks wrong.'); return; }
    setBusy(true);
    try { const r = await api.disputeCommission(open.c.id, reason.trim()); setOpen({ c: r.commission, ledger: r.ledger }); setReason(''); await load(); } catch (e) { setFieldErr(err(e)); } finally { setBusy(false); }
  };
  const sum = (...k: CommissionStatus[]) => (totals ? k.reduce((a, s) => a + totals[s].amountPaise, 0) : 0);

  if (open) {
    const c = open.c; const [label, tone] = STATUS[c.status]; const t = c.terms;
    return (
      <div class="card">
        <button class="backlink" type="button" onClick={() => setOpen(null)}>← All earnings</button>
        <div class="titlerow"><h1>{rupeesExact(c.amountPaise)}</h1><span class={`pill ${tone}`}>{label}</span></div>
        <p class="muted">{c.leadBusiness ?? 'Customer order'} · order {c.orderRef}</p>
        {c.status === 'disputed' && <Alert kind="info">Ntagz is reviewing this. You said: {c.disputeReason}</Alert>}
        {c.status === 'reversed' && <Alert kind="warn">This commission was reversed{c.reversedReason ? `: ${c.reversedReason}` : '.'}</Alert>}
        <dl class="summary">
          <div><dt>Order value (before GST)</dt><dd>{rupeesExact(c.basePaise)}</dd></div>
          {t?.pctBp != null && <div><dt>Rate</dt><dd>{(t.pctBp / 100).toString()}%{t.fixedPaise ? ` + ${rupeesExact(t.fixedPaise)}` : ''}{t.maxPaise ? ` (up to ${rupeesExact(t.maxPaise)})` : ''}</dd></div>}
          <div><dt>Original amount</dt><dd>{rupeesExact(c.originalAmountPaise)}</dd></div>
          {c.holdUntil && c.status === 'approved' && <div><dt>Payable after</dt><dd>{day(c.holdUntil)}</dd></div>}
          {c.settlementNumber && <div><dt>Paid in</dt><dd>{c.settlementNumber}</dd></div>}
        </dl>
        {open.ledger.length > 0 && <><h2>What changed</h2><ul class="docs">{open.ledger.map((l, i) => <li class="doc" key={i}><div class="head"><span>{KIND[l.kind] ?? l.kind}</span><strong>{l.deltaPaise ? (l.deltaPaise > 0 ? '+' : '−') + rupeesExact(Math.abs(l.deltaPaise)) : ''}</strong></div><span class="small muted">{day(l.at)} · {l.by}{l.reason ? ` · ${l.reason}` : ''}</span></li>)}</ul></>}
        {['pending', 'approved', 'payable', 'paid'].includes(c.status) && (
          <>
            <h2>Something wrong?</h2>
            <Field id="dispute" label="Tell Ntagz what looks wrong" error={fieldErr}>{(a) => <textarea {...a} value={reason} maxLength={500} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />}</Field>
            <div class="row"><Button busy={busy} onClick={() => void dispute()}>Raise with Ntagz</Button></div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div class="card">
        <h1>Earnings</h1>
        <p class="muted">Commission on customer orders from your leads. Earnings depend on your own sales; Ntagz does not guarantee any income.</p>
        {error && <Alert kind="bad">{error}</Alert>}
        {totals && (
          <dl class="summary">
            <div><dt>Ready to be paid</dt><dd><strong>{rupeesExact(sum('payable'))}</strong></dd></div>
            <div><dt>In approval / refund window</dt><dd>{rupeesExact(sum('pending', 'approved'))}</dd></div>
            <div><dt>Paid so far</dt><dd>{rupeesExact(sum('paid'))}</dd></div>
          </dl>
        )}
        <div class="chiprow" role="group" aria-label="Earnings status">
          {CHIPS.map(([k, l]) => <button key={k} class="chip" type="button" aria-pressed={status === k} onClick={() => { setStatus(k); void load(k); }}>{l}</button>)}
        </div>
        {items === null && !error && <p class="muted" role="status">Loading…</p>}
        {items && items.length === 0 && <p class="muted">{status ? 'Nothing in this status.' : 'No earnings yet. A commission appears here when Ntagz confirms a paid order for one of your leads.'}</p>}
        <ul class="leadlist">
          {items?.map((c) => (
            <li key={c.id}><button class="leadcard" type="button" onClick={() => void show(c.id)} aria-label={`Open earning ${rupeesExact(c.amountPaise)}`}>
              <span class="leadtop"><strong>{rupeesExact(c.amountPaise)} · {c.leadBusiness ?? 'Order ' + c.orderRef}</strong><span class={`pill ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></span>
              <span class="muted small">{day(c.createdAt)}{c.settlementNumber ? ` · ${c.settlementNumber}` : ''}</span>
            </button></li>
          ))}
        </ul>
      </div>
      {statements.length > 0 && (
        <div class="card">
          <h2>Payout statements</h2>
          <ul class="docs">{statements.map((s) => (
            <li class="doc" key={s.number}><div class="head"><span>{s.number} · {day(s.at)}</span><strong>{rupeesExact(s.netPaise)}</strong></div>
              <span class="small muted">{s.commissions} commission{s.commissions === 1 ? '' : 's'} · {rupeesExact(s.totalPaise)}{s.tdsPaise > 0 ? ` less TDS ${rupeesExact(s.tdsPaise)}` : ''} · ref {s.reference}</span></li>
          ))}</ul>
        </div>
      )}
    </>
  );
}
