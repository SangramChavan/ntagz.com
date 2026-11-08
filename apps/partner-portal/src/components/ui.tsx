import type { ComponentChildren } from 'preact';

export interface FieldAttrs { id: string; 'aria-invalid'?: 'true'; 'aria-describedby'?: string }

export function Field(p: { id: string; label: string; hint?: string; error?: string; children: (a: FieldAttrs) => ComponentChildren }) {
  const describedBy = [p.hint ? `${p.id}-hint` : '', p.error ? `${p.id}-err` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div class="field">
      <label for={p.id}>{p.label}</label>
      {p.hint && <p class="hint" id={`${p.id}-hint`}>{p.hint}</p>}
      {p.children({ id: p.id, 'aria-invalid': p.error ? 'true' : undefined, 'aria-describedby': describedBy })}
      {p.error && <div class="err" id={`${p.id}-err`}>{p.error}</div>}
    </div>
  );
}
export function Alert(p: { kind: 'bad' | 'warn' | 'ok' | 'info'; children: ComponentChildren }) {
  return <div class={`alert ${p.kind}`} role={p.kind === 'bad' ? 'alert' : 'status'}>{p.children}</div>;
}
export function Button(p: { primary?: boolean; busy?: boolean; type?: 'button' | 'submit'; onClick?: () => void; children: ComponentChildren; disabled?: boolean }) {
  return <button class={`btn${p.primary ? ' primary' : ''}`} type={p.type ?? 'button'} onClick={p.onClick} disabled={p.disabled || p.busy}>{p.busy ? 'Please wait…' : p.children}</button>;
}
