import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type DraftInput } from '../api';
import { Alert, Button, Field } from '../components/ui';
import { BUSINESS_TYPES, DOC_LABEL, INVEST, OPTIONAL_DOCS, REQUIRED_DOCS, STATES, STEPS, resumeStep, stepOfField } from '../lib/steps';
import { fileSize, MAX_FILE, rupees } from '../lib/format';
import * as v from '../lib/validate';
import type { DocRow, DocType, Mine, PartnerType } from '../types';

interface D {
  typeKey: string; businessName: string; business_type: string; city: string; state: string; pincode: string; shop_details: string;
  name: string; phone: string; pan: string; experience: string; customer_base: string; sales_marketing: string;
  investment_capacity: string; staff_available: string; vehicle_available: boolean;
}
const fromMine = (m: Mine | null): D => {
  const a = m?.application; const f = a?.form ?? {};
  return {
    typeKey: a?.typeKey ?? '', businessName: a?.businessName ?? '', business_type: f.business_type ?? '', city: a?.city ?? '', state: a?.state ?? '', pincode: a?.pincode ?? '',
    shop_details: f.shop_details ?? '', name: f.name ?? '', phone: f.phone ?? '', pan: '', experience: f.experience ?? '', customer_base: f.customer_base ?? '', sales_marketing: f.sales_marketing ?? '',
    investment_capacity: f.investment_capacity ?? '', staff_available: f.staff_available !== undefined ? String(f.staff_available) : '', vehicle_available: f.vehicle_available ?? false,
  };
};

export function Apply({ initial, onSubmitted }: { initial: Mine | null; onSubmitted: () => void }) {
  const [mine, setMine] = useState<Mine | null>(initial);
  const [types, setTypes] = useState<PartnerType[]>([]);
  const [d, setD] = useState<D>(fromMine(initial));
  const [step, setStep] = useState(() => resumeStep(initial?.application ?? null, initial?.documents ?? []));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<DocType | ''>('');
  const head = useRef<HTMLHeadingElement>(null);
  const docs: DocRow[] = mine?.documents ?? [];
  const set = <K extends keyof D>(k: K, val: D[K]) => setD((p) => ({ ...p, [k]: val }));

  useEffect(() => { api.types().then(setTypes).catch(() => setBanner('Could not load partner categories. Refresh the page.')); }, []);
  useEffect(() => { head.current?.focus(); window.scrollTo(0, 0); }, [step]);

  const fail = (e: unknown) => {
    if (e instanceof ApiError) { setBanner(e.message); setErrs(e.fields); return e; }
    setBanner('Something went wrong. Please try again.'); return null;
  };

  // Client-side hints per step; the server re-validates everything.
  const check = (s: number): Record<string, string> => {
    const x: Record<string, string> = {};
    if (s === 0 && !d.typeKey) x.typeKey = 'Choose a category.';
    if (s === 1) {
      if (!d.businessName.trim()) x.businessName = 'Enter your business name.';
      if (!d.business_type) x.business_type = 'Choose a business type.';
      if (!d.city.trim()) x.city = 'Enter your city.';
      if (!d.state) x.state = 'Choose your state.';
      if (!v.pincode(d.pincode)) x.pincode = 'Enter a 6-digit PIN code.';
    }
    if (s === 2) {
      if (!d.name.trim()) x.name = 'Enter your full name.';
      if (!v.phone(d.phone)) x.phone = 'Enter a 10-digit mobile number.';
      if (d.pan ? !v.pan(d.pan) : !mine?.application?.panLast4) x.pan = d.pan ? 'PAN looks wrong. Example: ABCDE1234F' : 'Enter your PAN.';
    }
    if (s === 3 && !d.investment_capacity) x.investment_capacity = 'Choose an option.';
    return x;
  };
  const payload = (s: number): DraftInput => {
    if (s === 0) return { typeKey: d.typeKey };
    if (s === 1) return { typeKey: d.typeKey, businessName: d.businessName.trim(), city: d.city.trim(), state: d.state, pincode: d.pincode.trim(), form: { business_type: d.business_type, ...(d.shop_details.trim() ? { shop_details: d.shop_details.trim() } : {}) } };
    if (s === 2) return { ...(d.pan ? { pan: d.pan.trim() } : {}), form: { name: d.name.trim(), phone: d.phone.trim(), ...(d.experience.trim() ? { experience: d.experience.trim() } : {}), ...(d.customer_base.trim() ? { customer_base: d.customer_base.trim() } : {}), ...(d.sales_marketing.trim() ? { sales_marketing: d.sales_marketing.trim() } : {}) } };
    return { form: { investment_capacity: d.investment_capacity, ...(d.staff_available !== '' ? { staff_available: Number(d.staff_available) } : {}), vehicle_available: d.vehicle_available } };
  };

  const focusFirst = (keys: string[]) => setTimeout(() => {
    const k = keys[0]; if (!k) return;
    (document.getElementById(k) ?? document.querySelector<HTMLElement>('input[name=type]') ?? document.querySelector<HTMLElement>('[role=alert]'))?.focus();
  }, 0);

  const next = async () => {
    setBanner(''); const bad = check(step); setErrs(bad);
    if (Object.keys(bad).length) { setBanner('Please correct the highlighted fields.'); focusFirst(Object.keys(bad)); return; }
    if (step === 4) { setStep(5); return; }
    setBusy(true);
    try { const m = await api.save(payload(step)); setMine({ ...m, documents: mine?.documents ?? m.documents }); if (step === 2) set('pan', ''); setStep(step + 1); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };

  const upload = async (type: DocType, file: File | undefined) => {
    if (!file) return; setBanner('');
    if (file.size > MAX_FILE) { setBanner(`${file.name} is larger than 5 MB.`); return; }
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) { setBanner('Upload a PDF, PNG or JPEG file.'); return; }
    setUploading(type);
    try { await api.upload(type, file); setMine(await api.mine()); }
    catch (e) { fail(e); } finally { setUploading(''); }
  };

  const submit = async () => {
    setBanner(''); setErrs({}); setBusy(true);
    try { await api.submit(); onSubmitted(); }
    catch (e) {
      const err = fail(e);
      if (err && Object.keys(err.fields).length) setStep(Math.min(...Object.keys(err.fields).map(stepOfField)));
    } finally { setBusy(false); }
  };

  const has = (t: DocType) => docs.filter((x) => x.type === t && x.status !== 'rejected');
  const missingDocs = REQUIRED_DOCS.filter((t) => has(t).length === 0);
  const typeLabel = types.find((t) => t.key === d.typeKey)?.label ?? d.typeKey;
  const a = mine?.application;

  return (
    <div class="card">
      <ol class="steps" aria-label="Application steps">
        {STEPS.map((s, i) => <li key={s} class={i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>{i + 1}. {s}</li>)}
      </ol>
      {a?.status === 'documents_required' && <Alert kind="warn"><strong>Ntagz asked for more:</strong> {a.decisionNote}</Alert>}
      {banner && <Alert kind="bad">{banner}</Alert>}

      {step === 0 && (<>
        <h1 ref={head} tabIndex={-1}>Choose your partner category</h1>
        <p class="muted">Pick the partnership that fits how you work. Fees shown are proposed and may be updated by Ntagz.</p>
        <fieldset class="types" aria-describedby={errs.typeKey ? 'typeKey-err' : undefined}>
          <legend class="sr">Partner category</legend>
          {types.map((t) => (
            <label class="type" key={t.key}>
              <input type="radio" name="type" value={t.key} checked={d.typeKey === t.key} onChange={() => set('typeKey', t.key)} />
              <span class="name">{t.label}</span><br />
              <span class="fee">Joining fee {rupees(t.feePaise)}{t.gstRateBp === null ? ' (taxes as applicable)' : ''}</span>
            </label>
          ))}
        </fieldset>
        {errs.typeKey && <div class="err" id="typeKey-err">{errs.typeKey}</div>}
        <p class="small muted mt4">A partnership is a business relationship. Ntagz does not guarantee any income, and there is no payment for recruiting other partners.</p>
      </>)}

      {step === 1 && (<>
        <h1 ref={head} tabIndex={-1}>Your business</h1>
        <p class="muted">Applying as <strong>{typeLabel}</strong>.</p>
        <Field id="businessName" label="Business name" error={errs.businessName}>{(x) => <input {...x} type="text" autoComplete="organization" value={d.businessName} onInput={(e) => set('businessName', (e.target as HTMLInputElement).value)} />}</Field>
        <Field id="business_type" label="Type of business" error={errs.business_type}>{(x) => <select {...x} value={d.business_type} onChange={(e) => set('business_type', (e.target as HTMLSelectElement).value)}><option value="">Choose…</option>{BUSINESS_TYPES.map((b) => <option key={b}>{b}</option>)}</select>}</Field>
        <Field id="city" label="City" error={errs.city}>{(x) => <input {...x} type="text" autoComplete="address-level2" value={d.city} onInput={(e) => set('city', (e.target as HTMLInputElement).value)} />}</Field>
        <Field id="state" label="State" error={errs.state}>{(x) => <select {...x} autoComplete="address-level1" value={d.state} onChange={(e) => set('state', (e.target as HTMLSelectElement).value)}><option value="">Choose…</option>{STATES.map((s) => <option key={s}>{s}</option>)}</select>}</Field>
        <Field id="pincode" label="PIN code" error={errs.pincode}>{(x) => <input {...x} type="text" inputMode="numeric" maxLength={6} autoComplete="postal-code" value={d.pincode} onInput={(e) => set('pincode', (e.target as HTMLInputElement).value.replace(/\D/g, ''))} />}</Field>
        <Field id="shop_details" label="Shop or office details (optional)" hint="Size, location, footfall, or whether you work from home." error={errs.shop_details}>{(x) => <textarea {...x} value={d.shop_details} onInput={(e) => set('shop_details', (e.target as HTMLTextAreaElement).value)} />}</Field>
      </>)}

      {step === 2 && (<>
        <h1 ref={head} tabIndex={-1}>About you</h1>
        <Field id="name" label="Full name" error={errs.name}>{(x) => <input {...x} type="text" autoComplete="name" value={d.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} />}</Field>
        <Field id="phone" label="Mobile number" error={errs.phone}>{(x) => <input {...x} type="tel" inputMode="tel" autoComplete="tel" value={d.phone} onInput={(e) => set('phone', (e.target as HTMLInputElement).value)} />}</Field>
        <Field id="pan" label="PAN" hint={a?.panLast4 ? `Saved, ending ${a.panLast4}. Enter it again only to change it. Ntagz never stores the full number.` : 'Ntagz keeps only the last 4 characters. Upload the PAN card in the documents step.'} error={errs.pan}>{(x) => <input {...x} type="text" autoCapitalize="characters" autoComplete="off" maxLength={10} value={d.pan} onInput={(e) => set('pan', (e.target as HTMLInputElement).value.toUpperCase())} />}</Field>
        <Field id="experience" label="Business experience (optional)" error={errs.experience}>{(x) => <textarea {...x} value={d.experience} onInput={(e) => set('experience', (e.target as HTMLTextAreaElement).value)} />}</Field>
        <Field id="customer_base" label="Your existing customers (optional)" hint="Who do you already sell to?" error={errs.customer_base}>{(x) => <textarea {...x} value={d.customer_base} onInput={(e) => set('customer_base', (e.target as HTMLTextAreaElement).value)} />}</Field>
        <Field id="sales_marketing" label="How would you find customers? (optional)" error={errs.sales_marketing}>{(x) => <textarea {...x} value={d.sales_marketing} onInput={(e) => set('sales_marketing', (e.target as HTMLTextAreaElement).value)} />}</Field>
      </>)}

      {step === 3 && (<>
        <h1 ref={head} tabIndex={-1}>Capacity</h1>
        <Field id="investment_capacity" label="How much can you invest to start?" hint="Used only to understand your plans. It is not a promise or a commitment." error={errs.investment_capacity}>{(x) => <select {...x} value={d.investment_capacity} onChange={(e) => set('investment_capacity', (e.target as HTMLSelectElement).value)}><option value="">Choose…</option>{INVEST.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <Field id="staff_available" label="People available to help you (optional)" error={errs.staff_available}>{(x) => <input {...x} type="number" inputMode="numeric" min={0} max={500} value={d.staff_available} onInput={(e) => set('staff_available', (e.target as HTMLInputElement).value)} />}</Field>
        <div class="field"><label class="check"><input type="checkbox" checked={d.vehicle_available} onChange={(e) => set('vehicle_available', (e.target as HTMLInputElement).checked)} /> I have a vehicle for field visits and installations</label></div>
      </>)}

      {step === 4 && (<>
        <h1 ref={head} tabIndex={-1}>Documents</h1>
        <p class="muted">PDF, PNG or JPEG, up to 5 MB each. Files are stored privately and only the Ntagz review team can open them.</p>
        <ul class="docs">
          {[...REQUIRED_DOCS, ...OPTIONAL_DOCS].map((t) => {
            const mineDocs = docs.filter((x) => x.type === t);
            const required = REQUIRED_DOCS.includes(t);
            return (
              <li class="doc" key={t}>
                <div class="head"><label for={`doc-${t}`}>{DOC_LABEL[t]}</label><span class={`tag${required && !has(t).length ? ' need' : ''}`}>{required ? (has(t).length ? 'Uploaded' : 'Required') : 'Optional'}</span></div>
                {mineDocs.map((x) => <p class="small" key={x.id}>{x.status === 'rejected' ? 'Rejected' : 'Uploaded'} · {x.mime.replace('application/', '').replace('image/', '').toUpperCase()} · {fileSize(x.size)}{x.note ? ` · ${x.note}` : ''}</p>)}
                <input id={`doc-${t}`} type="file" accept="application/pdf,image/png,image/jpeg" disabled={uploading !== '' || !a} onChange={(e) => { const el = e.target as HTMLInputElement; void upload(t, el.files?.[0]); el.value = ''; }} />
                {uploading === t && <p class="small muted" role="status">Uploading…</p>}
              </li>
            );
          })}
        </ul>
        {errs.document_pan && <div class="err">{errs.document_pan}</div>}
        {errs.document_address_proof && <div class="err">{errs.document_address_proof}</div>}
      </>)}

      {step === 5 && (<>
        <h1 ref={head} tabIndex={-1}>Review and submit</h1>
        <p class="muted">Check your details. After you submit, you cannot edit the application unless Ntagz asks for changes.</p>
        <dl class="summary">
          {([
            ['Category', typeLabel, 0], ['Business', `${d.businessName}${d.business_type ? ' · ' + d.business_type : ''}`, 1],
            ['Location', [d.city, d.state, d.pincode].filter(Boolean).join(', '), 1], ['Name', d.name, 2], ['Mobile', d.phone, 2],
            ['PAN', a?.panLast4 ? `ending ${a.panLast4}` : 'not entered', 2], ['Can invest', INVEST.find(([k]) => k === d.investment_capacity)?.[1] ?? '', 3],
          ] as Array<[string, string, number]>).map(([k, val, s]) => (
            <div key={k}><dt>{k}</dt><dd>{val || <span class="muted">—</span>} <button class="edit-btn" aria-label={`Edit ${k}`} onClick={() => setStep(s)}>Edit</button></dd></div>
          ))}
          <div><dt>Documents</dt><dd>{docs.filter((x) => x.status !== 'rejected').length} uploaded{missingDocs.length ? ` · missing: ${missingDocs.map((t) => DOC_LABEL[t]).join(', ')}` : ''} <button class="edit-btn" aria-label="Edit documents" onClick={() => setStep(4)}>Edit</button></dd></div>
        </dl>
      </>)}

      <div class="row">
        {step > 0 && <Button onClick={() => { setBanner(''); setErrs({}); setStep(step - 1); }}>Back</Button>}
        {step < 5 && <Button primary busy={busy} onClick={() => void next()}>{step === 4 ? 'Continue' : 'Save and continue'}</Button>}
        {step === 5 && <Button primary busy={busy} onClick={() => void submit()}>Submit application</Button>}
      </div>
      <p class="small muted mt4">Your progress is saved at each step. You can close this page and come back.</p>
    </div>
  );
}
