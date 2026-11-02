import React, { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { api, errorText } from '../api.js';
import { useApp, Modal, Button, Path, TimePicker } from '../ui.jsx';
import { t } from '../i18n.js';

// A new install has the daily backup off and asks once. It stays until answered: there is nothing to close it with, and
// after a restart it is still here. Either answer can be changed later on Overview, in Settings or in the tray menu.
export default function DailyQuestion({ daily }) {
  const { device, refresh, toast } = useApp();
  const [time, setTime] = useState(daily.time);
  const [busy, setBusy] = useState(false);

  const answer = async (enabled) => {
    setBusy(true);
    try {
      await api.updateSettings({ daily: enabled ? { enabled, time } : { enabled } });
      toast(enabled ? t('settings.backup.turnedOn', { time }) : t('intro.daily.stayedOff'));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('intro.daily.title')}
      footer={(
        <>
          <Button onClick={() => answer(false)} disabled={busy} data-testid="daily-no">{t('intro.daily.no')}</Button>
          <Button variant="primary" icon={CalendarClock} onClick={() => answer(true)} disabled={busy} data-testid="daily-yes">{t('intro.daily.yes')}</Button>
        </>
      )}
    >
      <div className="stack" style={{ gap: 12 }}>
        <div>{t('intro.daily.text')}</div>
        <div className="row-flex">
          <span style={{ fontWeight: 540 }}>{t('intro.daily.time')}</span>
          <TimePicker value={time} onChange={setTime} label={t('settings.backup.time')} disabled={busy} />
        </div>
        <div className="muted small">{t('intro.daily.first')} {t('home.daily.note')}</div>
        <div className="muted small">
          {device ? t('intro.daily.where', { path: <Path>{device.backupDir}</Path> }) : null} {t('intro.daily.later')}
        </div>
      </div>
    </Modal>
  );
}
