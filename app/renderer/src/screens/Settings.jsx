import React, { useEffect, useState } from 'react';
import { Monitor, Clock, AppWindow, Package, FolderSearch, FolderPlus, Trash2, Info, FolderOpen } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Button, Toggle, PageHead, Path, PathLink, Loading } from '../ui.jsx';

function Section({ icon: Icon, title, sub, children }) {
  return (
    <Card>
      <div className="card-head">
        <Icon size={16} />
        <div>
          <div className="card-title">{title}</div>
          {sub ? <div className="card-sub">{sub}</div> : null}
        </div>
      </div>
      <div className="rows">{children}</div>
    </Card>
  );
}

function Line({ label, sub, children }) {
  return (
    <div className="row" style={{ padding: '12px 18px' }}>
      <div className="row-main">
        <div style={{ fontWeight: 540 }}>{label}</div>
        {sub ? <div className="muted small" style={{ whiteSpace: 'normal' }}>{sub}</div> : null}
      </div>
      <div className="row-side">{children}</div>
    </div>
  );
}

export default function Settings() {
  const { version, refresh, toast } = useApp();
  const [s, setS] = useState(null);
  const [name, setName] = useState('');
  const [info, setInfo] = useState(null);

  useEffect(() => {
    api.settings().then((x) => {
      setS(x);
      setName(x.deviceName);
    });
    shell.appInfo().then(setInfo);
  }, [version]);

  if (!s) return <Loading />;

  const save = async (patch, message = 'Kaydedildi.') => {
    try {
      await api.updateSettings(patch);
      toast(message);
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const chooseBackupDir = async () => {
    const p = await shell.chooseFolder({ title: 'Yedeklerin kaydedileceği klasör', defaultPath: s.device.backupDir });
    if (p) save({ backupDir: p }, 'Yedek klasörü değişti. Önceki yedekler eski yerinde kalır.');
  };
  const addBundleDir = async () => {
    const p = await shell.chooseFolder({ title: 'Paketlerin aranacağı klasör (ör. bulut klasörü, USB bellek)' });
    if (p) save({ bundleDirs: [...s.bundleDirs, p] });
  };

  return (
    <div className="page">
      <PageHead title="Ayarlar" sub="Ayarlar bu cihaza özeldir; diğer cihazın ayarlarını değiştirmez." />
      <div className="stack">
        <Section icon={Monitor} title="Bu cihaz">
          <Line label="Cihaz adı" sub="Paketlerde ve çakışma kopyalarının adında görünür (ör. not--macbook.md).">
            <input className="input" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} />
            <Button size="sm" disabled={!name.trim() || name === s.deviceName} onClick={() => save({ deviceName: name })}>Kaydet</Button>
          </Line>
          <Line label="İşletim sistemi">{s.device.platformName}</Line>
          <Line label="Claude klasörü" sub="CLAUDE_CONFIG_DIR ortam değişkeni varsa o kullanılır."><PathLink path={s.device.claudeDir} /></Line>
          <Line label="Uygulama verisi" sub="Ayarlar, sürüm geçmişi ve işlem kayıtları."><PathLink path={s.device.stateHome} /></Line>
        </Section>

        <Section icon={Clock} title="Otomatik yedek" sub="Yedekler bu cihazdaki her şeyi içerir: tüm proje hafızaları, workspace dosyaları ve Claude ayarları.">
          <Line label="Her gün otomatik yedek al" sub="Bilgisayar o saatte kapalıysa ilk açılışta alınır. Bir önceki günden beri değişiklik yoksa yeni dosya yazılmaz.">
            <Toggle on={s.daily.enabled} onChange={(v) => save({ daily: { enabled: v } })} label="Günlük yedek" />
          </Line>
          <Line label="Saat">
            <input className="input" type="time" value={s.daily.time} disabled={!s.daily.enabled} onChange={(e) => e.target.value && save({ daily: { time: e.target.value } }, 'Saat kaydedildi.')} />
          </Line>
          <Line label="Saklanacak günlük yedek" sub="Daha eskileri silinir.">
            <input className="input" type="number" min="1" max="365" style={{ width: 80 }} defaultValue={s.daily.keep} onBlur={(e) => Number(e.target.value) !== s.daily.keep && save({ daily: { keep: Number(e.target.value) } })} />
          </Line>
          <Line label="Saklanacak işlem öncesi yedek" sub="Her aktarım, geri yükleme ve geri almadan önce alınan yedekler. Geri alma bu yedeklerle yapılır.">
            <input className="input" type="number" min="1" max="1000" style={{ width: 80 }} defaultValue={s.keepBefore} onBlur={(e) => Number(e.target.value) !== s.keepBefore && save({ keepBefore: Number(e.target.value) })} />
          </Line>
          <Line label="Yedek klasörü" sub={<Path>{s.device.backupDir}</Path>}>
            <Button size="sm" icon={FolderOpen} onClick={() => shell.openPath(s.device.backupDir)}>Aç</Button>
            <Button size="sm" onClick={chooseBackupDir}>Değiştir</Button>
            {s.backupDir ? <Button size="sm" variant="ghost" onClick={() => save({ backupDir: null })}>Varsayılan</Button> : null}
          </Line>
        </Section>

        <Section icon={AppWindow} title="Uygulama">
          <Line label="Bilgisayar açılınca başlat" sub={info && !info.packaged ? 'Yalnızca kurulu uygulamada çalışır (geliştirme modunda etkisiz).' : 'Pencere açılmadan, menü çubuğunda / sistem tepsisinde başlar.'}>
            <Toggle on={s.openAtLogin} onChange={(v) => save({ openAtLogin: v })} label="Açılışta başlat" />
          </Line>
          <Line label="Pencere kapanınca arka planda çalış" sub="Günlük yedeğin alınabilmesi için uygulamanın açık olması gerekir. Kapalıysa Çıkış menüden yapılır.">
            <Toggle on={s.runInBackground} onChange={(v) => save({ runInBackground: v })} label="Arka planda çalış" />
          </Line>
        </Section>

        <Section icon={Package} title="Paket içeriği" sub="Başka cihaza giden pakete varsayılan olarak nelerin gireceği. Paket oluştururken tek tek de seçebilirsin.">
          <Line label="Claude ayarları" sub="~/.claude altındaki CLAUDE.md, agents, commands, skills ve output-styles. Claude hesabından gelen skills/synced hariç.">
            <Toggle on={s.includeClaude} onChange={(v) => save({ includeClaude: v })} label="Claude ayarları" />
          </Line>
          <Line label="Claude uygulamasının geçici oturumları" sub="Klasörsüz açılan oturumların hafızaları. Başka cihazda karşılıkları olmaz; genelde gerekmez.">
            <Toggle on={s.includeScratch} onChange={(v) => save({ includeScratch: v })} label="Geçici oturumlar" />
          </Line>
          <Line label="Pakete girmeyen projeler" sub={s.excludedProjects.length ? s.excludedProjects.join(', ') : 'Yok. Hafızalar ekranından seçilir.'} />
        </Section>

        <Section icon={FolderSearch} title="Paketlerin arandığı yerler" sub="Masaüstü, İndirilenler ve yedek klasörü her zaman taranır. Bulut klasörü ya da USB bellek eklersen oradaki paketler de bulunur.">
          {s.bundleDirs.map((d) => (
            <Line key={d} label={<Path>{d}</Path>}>
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => save({ bundleDirs: s.bundleDirs.filter((x) => x !== d) })}>Çıkar</Button>
            </Line>
          ))}
          <Line label="Klasör ekle">
            <Button size="sm" icon={FolderPlus} onClick={addBundleDir}>Ekle</Button>
          </Line>
        </Section>

        <Section icon={Info} title="Hakkında">
          <Line label="Claude Memory Sync" sub="Claude Code hafızalarını, workspace dosyalarını ve Claude ayarlarını cihazlar arasında kayıpsız taşır ve yedekler.">
            <span className="muted">Sürüm {s.device.appVersion}</span>
          </Line>
        </Section>
      </div>
    </div>
  );
}
