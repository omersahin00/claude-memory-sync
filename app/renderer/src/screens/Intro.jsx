import React, { useEffect, useState } from 'react';
import { Brain, ShieldCheck, FolderLock, Monitor, FileText, Download, Info, Settings2 } from 'lucide-react';
import { api, shell } from '../api.js';
import { Card, Badge, Button, Banner } from '../ui.jsx';
import { label } from '../format.js';
import { t } from '../i18n.js';

const FOLDER_ICON = { desktop: Monitor, documents: FileText, downloads: Download };
export const ACCESS_TONE = { ok: 'green', denied: 'amber', missing: '' };

// That nothing leaves this computer, for the first start and for Settings.
export function PrivacyCard({ mac }) {
  return (
    <Card>
      <div className="card-head">
        <ShieldCheck size={16} />
        <div className="card-title">{t('intro.privacyTitle')}</div>
      </div>
      <div className="card-pad stack" style={{ gap: 8 }}>
        <div>{t('intro.privacy')}</div>
        {mac ? <div className="muted small">{t('intro.icloud')}</div> : null}
      </div>
    </Card>
  );
}

function FolderRows({ access }) {
  return (
    <div className="rows">
      {['desktop', 'documents', 'downloads'].map((id) => {
        const Icon = FOLDER_ICON[id];
        const a = access && access.find((x) => x.id === id);
        return (
          <div key={id} className="row" style={{ padding: '12px 18px', alignItems: 'flex-start' }}>
            <div className="row-icon"><Icon size={16} /></div>
            <div className="row-main">
              <div className="row-title">{label('folder', id)}</div>
              <div className="muted small" style={{ whiteSpace: 'normal', marginTop: 2 }}>{t(`intro.why.${id}`)}</div>
            </div>
            {a ? <Badge tone={ACCESS_TONE[a.state]}>{label('access', a.state)}</Badge> : null}
          </div>
        );
      })}
    </div>
  );
}

// First start, and on macOS every new build: what the app reads and why, and that nothing leaves this computer, before
// macOS asks about Desktop, Documents and Downloads.
export default function Intro({ platform, onDone }) {
  const mac = platform === 'darwin';
  const [step, setStep] = useState('explain'); // explain | asking | result
  const [access, setAccess] = useState(null);

  // A permission given in System Settings meanwhile shows when the window is back in front.
  useEffect(() => {
    if (step !== 'result') return undefined;
    const recheck = () => api.folderAccess().then(setAccess).catch(() => {});
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [step]);

  const ask = async () => {
    setStep('asking');
    let result = [];
    try {
      result = await shell.completeIntro();
    } catch { /* the app starts anyway */ }
    if (!mac) {
      onDone();
      return;
    }
    setAccess(result);
    setStep('result');
  };
  const denied = (access || []).some((a) => a.state === 'denied');

  return (
    <div className="intro">
      <div className="intro-card stack">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark"><Brain size={18} /></div>
          <div>
            <div className="brand-name">Claude Memory Sync</div>
            <div className="brand-sub">{t('intro.title')}</div>
          </div>
        </div>

        <PrivacyCard mac={mac} />

        {mac ? (
          <Card>
            <div className="card-head">
              <FolderLock size={16} />
              <div className="card-title">{step === 'result' ? t('intro.resultTitle') : t('intro.foldersTitle')}</div>
            </div>
            <FolderRows access={step === 'result' ? access : null} />
          </Card>
        ) : null}

        {mac ? (
          <Banner tone={step === 'result' && denied ? 'warn' : 'info'} icon={Info}>
            {t('intro.denied')} {t('intro.again')}
          </Banner>
        ) : null}

        <div className="row-flex" style={{ justifyContent: 'flex-end' }}>
          {step === 'result' && denied ? <Button icon={Settings2} onClick={() => shell.openPrivacySettings()}>{t('intro.openSettings')}</Button> : null}
          {step === 'result' ? (
            <Button variant="primary" size="lg" onClick={onDone} data-testid="intro-start">{t('intro.start')}</Button>
          ) : (
            <Button variant="primary" size="lg" onClick={ask} disabled={step === 'asking'} data-testid="intro-continue">
              {step === 'asking' ? t('intro.asking') : mac ? t('intro.continue') : t('intro.start')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
