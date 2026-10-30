import React, { useEffect, useState } from 'react';
import { Brain, FolderTree, ShieldCheck, Send, Save, PackagePlus, Download, Inbox, TriangleAlert, Clock, ArrowRight, Wrench } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Button, Card, Badge, Stat, Banner, PageHead, Path, PathLink, Loading } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, KIND_LABEL } from '../format.js';
import { ActivityRow } from './Activity.jsx';

function Warning({ w, go }) {
  if (w.code === 'no-claude') {
    return (
      <Banner tone="warn" icon={TriangleAlert}>
        Bu cihazda Claude Code klasörü bulunamadı: <Path>{w.path}</Path>. Claude Code kurulup bir kez çalıştırılınca hafızalar burada görünür.
      </Banner>
    );
  }
  if (w.code === 'root-missing') {
    return (
      <Banner tone="warn" icon={TriangleAlert} action={<Button size="sm" onClick={() => go('workspaces')}>Düzenle</Button>}>
        Workspace tarama klasörü bulunamadı: <Path>{w.path}</Path>
      </Banner>
    );
  }
  if (w.code === 'no-roots') {
    return (
      <Banner tone="warn" icon={FolderTree} action={<Button size="sm" onClick={() => go('workspaces')}>Klasör ekle</Button>}>
        Workspace dosyalarının arandığı bir klasör seçilmedi. Repolarının durduğu klasörü eklersen .code-workspace dosyaları da yedeklenir.
      </Banner>
    );
  }
  if (w.code === 'workspace-fixable') {
    return (
      <Banner tone="warn" icon={Wrench} action={<Button size="sm" onClick={() => go('workspaces')}>Göster</Button>}>
        {w.count} workspace dosyasında başka cihazda açılmayacak yol var (mutlak yol ya da ters eğik çizgi). Tek tıkla düzeltilebilir.
      </Banner>
    );
  }
  return null;
}

export default function Home() {
  const { go, toast, refresh, version } = useApp();
  const [ov, setOv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.overview().then(setOv).catch(setError);
  }, [version]);

  if (error) return <div className="page"><Banner tone="error" icon={TriangleAlert}>{errorText(error)}</Banner></div>;
  if (!ov) return <Loading />;

  const c = ov.counts;
  const d = ov.daily;
  const pending = ov.pending.new + ov.pending.changed;

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api.createBackup('manual');
      toast(`Yedek alındı ve doğrulandı: ${r.stats.projects} proje, ${r.stats.memoryFiles} hafıza dosyası`);
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead title="Genel Bakış" sub={`${ov.device.name} · ${ov.device.platformName}. Bu cihazdaki Claude hafızaları, workspace dosyaları ve yedekler.`}>
        <Button icon={Save} onClick={backupNow} disabled={busy} data-testid="backup-now">
          {busy ? 'Yedek alınıyor…' : 'Şimdi yedek al'}
        </Button>
        <Button icon={PackagePlus} onClick={() => go('transfer', { tab: 'export' })}>Paket oluştur</Button>
        <Button variant="primary" icon={Download} onClick={() => go('transfer', { tab: 'import' })}>Paket aktar</Button>
      </PageHead>

      {ov.incoming.map((b) => (
        <Banner key={b.path} tone="info" icon={Inbox} action={<Button size="sm" variant="primary" onClick={() => go('transfer', { bundle: b.path })}>Gözden geçir ve aktar</Button>}>
          <span className="strong">{b.device.name}</span> cihazından gelen, henüz aktarılmamış bir paket var · {fmtDate(b.createdAt)} ·{' '}
          {b.stats.projects} proje, {b.stats.memoryFiles} hafıza dosyası
          <div><Path>{b.path}</Path></div>
        </Banner>
      ))}
      {ov.warnings.map((w, i) => <Warning key={i} w={w} go={go} />)}

      <div className="grid cols-4">
        <Stat icon={Brain} label="Proje hafızaları" value={`${c.projects} proje`} note={`${c.memoryFiles} dosya · ${fmtBytes(c.bytes)}`} onClick={() => go('projects')} />
        <Stat icon={FolderTree} label="Workspace dosyaları" value={`${c.workspaceFiles} dosya`} note={`${c.workspaceRoots} tarama klasörü`} onClick={() => go('workspaces')} />
        <Stat
          icon={ShieldCheck}
          label="Son yedek"
          value={ov.lastBackup ? fmtRelative(ov.lastBackup.createdAt) : 'Henüz yok'}
          note={ov.lastBackup ? `${KIND_LABEL[ov.lastBackup.kind]} · ${fmtDate(ov.lastBackup.createdAt)}` : 'Şimdi bir yedek al'}
          onClick={() => go('backups')}
        />
        <Stat
          icon={Send}
          label="Son paketten beri"
          value={pending ? `${pending} dosya` : 'Değişiklik yok'}
          note={pending ? `${ov.pending.new} yeni · ${ov.pending.changed} değişmiş; henüz hiçbir pakette yok` : 'Her şey son pakette var'}
          onClick={() => go('transfer', { tab: 'export' })}
        />
      </div>

      <div className="grid cols-2 mt">
        <Card>
          <div className="card-head">
            <Clock size={16} />
            <div className="card-title">Otomatik günlük yedek</div>
            <div className="spacer" />
            <Badge tone={d.enabled ? 'green' : ''}>{d.enabled ? 'Açık' : 'Kapalı'}</Badge>
          </div>
          <div className="card-pad">
            <dl className="kv">
              <dt>Saat</dt>
              <dd>{d.enabled ? `Her gün ${d.time}` : '-'}</dd>
              <dt>Son günlük yedek</dt>
              <dd>{d.lastAt ? `${fmtDate(d.lastAt)}${d.lastUnchanged ? ' (değişiklik yoktu)' : ''}` : 'Henüz yok'}</dd>
              <dt>Sıradaki</dt>
              <dd>{!d.enabled || !d.nextAt ? '-' : d.due ? 'Birazdan (uygulama açıkken)' : fmtRelative(d.nextAt)}</dd>
              <dt>Yedek klasörü</dt>
              <dd><PathLink path={ov.device.backupDir} /></dd>
            </dl>
            <div className="muted small mt">
              Uygulama açıkken ya da arka planda (menü çubuğunda / sistem tepsisinde) çalışırken yedek alınır. Bilgisayar o saatte kapalıysa ilk fırsatta alınır.
            </div>
          </div>
          <div className="card-foot">
            <Button size="sm" onClick={() => go('settings')}>Ayarları değiştir</Button>
            <Button size="sm" variant="ghost" onClick={() => shell.openPath(ov.device.backupDir)}>Klasörü aç</Button>
          </div>
        </Card>

        <Card>
          <div className="card-head">
            <Brain size={16} />
            <div className="card-title">Nereden alınıyor</div>
          </div>
          <div className="card-pad">
            <dl className="kv">
              <dt>Claude klasörü</dt>
              <dd><PathLink path={ov.device.claudeDir} /></dd>
              <dt>Proje hafızaları</dt>
              <dd className="small">Her proje için <span className="code">projects/&lt;proje&gt;/memory</span></dd>
              <dt>Claude ayarları</dt>
              <dd className="small">{c.claudeFiles ? `${c.claudeFiles} dosya (CLAUDE.md, agents, commands, skills)` : 'Yok'}</dd>
              <dt>Uygulama verisi</dt>
              <dd><PathLink path={ov.device.stateHome} /></dd>
            </dl>
            {c.scratchProjects ? (
              <div className="muted small mt">
                {c.scratchProjects} hafıza, Claude uygulamasının geçici oturumlarına ait; yedeklere girer, paketlere varsayılan olarak girmez.
              </div>
            ) : null}
          </div>
          <div className="card-foot">
            <Button size="sm" onClick={() => go('projects')}>Hafızaları gör</Button>
          </div>
        </Card>
      </div>

      <Card className="mt">
        <div className="card-head">
          <div className="card-title">Son işlemler</div>
          <div className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => go('activity')}>
            Tümü <ArrowRight size={14} />
          </Button>
        </div>
        {ov.recent.length ? (
          <div className="rows">
            {ov.recent.slice(0, 5).map((e) => <ActivityRow key={e.id} e={e} compact />)}
          </div>
        ) : (
          <div className="card-pad muted">Henüz bir işlem yapılmadı.</div>
        )}
      </Card>
    </div>
  );
}
