import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ESTIMATE_LABEL } from '../lib/catalog';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-white hover:brightness-110 border border-accent',
    secondary: 'bg-white text-gray-800 border border-gray-300 hover:border-gray-400 hover:bg-gray-50',
    ghost: 'text-gray-700 hover:bg-gray-100 border border-transparent',
    danger: 'bg-white text-danger border border-gray-300 hover:border-danger',
  };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}

export function EstimateBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800 ${className}`}>
      {ESTIMATE_LABEL}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-gray-50';

export function TextInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

/** Number input that keeps the user's text while typing and only commits valid numbers. */
export function NumberInput({ value, onChange, min, max, step = 1, suffix, className = '' }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; className?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(Math.round(value * 100) / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={`relative ${className}`}>
      <input
        type="number"
        className={`${inputClass} ${suffix ? 'pr-10' : ''}`}
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) onChange(v);
        }}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">{suffix}</span>}
    </div>
  );
}

export function Select<T extends string>({ value, onChange, options, className = '' }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; enabled?: boolean }[]; className?: string }) {
  return (
    <select className={`${inputClass} ${className}`} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.enabled === false}>
          {o.label}
          {o.enabled === false ? ' — coming soon' : ''}
        </option>
      ))}
    </select>
  );
}

export function Panel({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-gray-200 bg-white ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-base font-semibold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-gray-300 bg-gray-50 px-1 py-px font-mono text-[10px] text-gray-600">{children}</kbd>;
}

/**
 * Number input where empty means "use the default". The default shows as the placeholder,
 * and clearing the field hands `undefined` back.
 */
export function OptionalNumberInput({ value, placeholder, onChange, step = 1, suffix, className = '', id }: { value: number | undefined; placeholder: number; onChange: (v: number | undefined) => void; step?: number; suffix?: string; className?: string; id?: string }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if ((text === '' ? undefined : Number(text)) !== value) setText(value === undefined ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={`relative ${className}`}>
      <input
        id={id}
        type="number"
        step={step}
        className={`${inputClass} ${suffix ? 'pr-12' : ''} placeholder:text-gray-400`}
        placeholder={String(placeholder)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === '') onChange(undefined);
          else if (Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value));
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">{suffix}</span>}
    </div>
  );
}
