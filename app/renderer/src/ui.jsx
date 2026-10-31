import React, { createContext, useContext, useEffect } from 'react';
import { X, Loader2, FolderOpen, CircleHelp } from 'lucide-react';
import { shell } from './api.js';
import { tildify } from './format.js';
import { t } from './i18n.js';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export function Button({ variant = '', size = '', icon: Icon, children, className = '', ...rest }) {
  return (
    <button type="button" className={`btn ${variant} ${size} ${className}`} {...rest}>
      {Icon ? <Icon size={size === 'sm' ? 14 : 16} strokeWidth={2} /> : null}
      {children}
    </button>
  );
}

export const Card = ({ className = '', children, ...rest }) => (
  <div className={`card ${className}`} {...rest}>
    {children}
  </div>
);

export const Badge = ({ tone = '', children, title }) => (
  <span className={`badge ${tone}`} title={title}>
    {children}
  </span>
);

export function Toggle({ on, onChange, disabled, label }) {
  return <button type="button" role="switch" aria-checked={Boolean(on)} aria-label={label} className={`switch ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Segmented({ value, options, onChange }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Path = ({ children, className = '' }) => (
  <span className={`path ${className}`} title={typeof children === 'string' ? children : undefined}>
    {typeof children === 'string' ? tildify(children) : children}
  </span>
);

// A path with a small "show in Finder/Explorer" button next to it.
export function PathLink({ path, label }) {
  if (!path) return <span className="muted">-</span>;
  return (
    <span className="row-flex" style={{ alignItems: 'flex-start', gap: 6 }}>
      <Path>{label || path}</Path>
      <button type="button" className="btn ghost sm icon" style={{ height: 20, width: 22 }} title={t('common.showInFolder')} onClick={() => shell.reveal(path)}>
        <FolderOpen size={13} />
      </button>
    </span>
  );
}

// onHelp: a small help button next to the title, labelled helpLabel.
export function PageHead({ title, sub, onHelp, helpLabel, children }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title row-flex">
          {title}
          {onHelp ? <Button variant="ghost" size="sm" className="icon" icon={CircleHelp} onClick={onHelp} title={helpLabel} aria-label={helpLabel} data-testid="page-help" /> : null}
        </h1>
        {sub ? <div className="page-sub">{sub}</div> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  );
}

export function Stat({ icon: Icon, label, value, note, onClick }) {
  return (
    <Card className={`stat ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="stat-label">
        {Icon ? <Icon size={15} /> : null}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </Card>
  );
}

export function Banner({ tone = 'info', icon: Icon, children, action }) {
  return (
    <div className={`banner ${tone}`}>
      {Icon ? <Icon size={18} /> : null}
      <div className="banner-text">{children}</div>
      {action}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      {Icon ? <Icon size={28} strokeWidth={1.6} /> : null}
      {title ? <div className="empty-title">{title}</div> : null}
      {children}
    </div>
  );
}

export const Loading = ({ text = t('common.loading') }) => (
  <div className="loading">
    <Loader2 size={18} className="spin" />
    {text}
  </div>
);

function useEscape(onClose) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Drawer({ title, sub, onClose, actions, children }) {
  useEscape(onClose);
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-title">{title}</div>
            {sub ? <div className="muted small">{sub}</div> : null}
          </div>
          {actions}
          <Button variant="ghost" className="icon" icon={X} onClick={onClose} aria-label={t('common.close')} />
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Modal({ title, onClose, footer, wide, children }) {
  useEscape(onClose);
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          {onClose ? <Button variant="ghost" className="icon" icon={X} onClick={onClose} aria-label={t('common.close')} /> : null}
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

// Unified line diff from lib/merge lineDiff: [{ t: ' ' | '+' | '-' | '…', s }]
export function DiffView({ lines, minusLabel, plusLabel }) {
  if (!lines || !lines.length) return <div className="muted">{t('common.noDiff')}</div>;
  return (
    <>
      <div className="diff-legend">
        <span className="row-flex"><span className="dot-i red" />{minusLabel}</span>
        <span className="row-flex"><span className="dot-i green" />{plusLabel}</span>
      </div>
      <div className="diff">
        {lines.map((d, i) => {
          const cls = d.t === '+' ? 'add' : d.t === '-' ? 'del' : d.t === '…' ? 'gap' : '';
          return (
            <div key={i} className={`diff-line ${cls}`}>
              <span className="diff-sign">{d.t === '+' || d.t === '-' ? d.t : ''}</span>
              <span>{d.t === '…' ? d.s || '…' : d.s || ' '}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
