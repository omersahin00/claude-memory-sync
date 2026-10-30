// Calls into lib/engine through the preload bridge: api.overview(), api.prepare({...}) ...
const bridge = window.cms;

async function call(method, args) {
  const r = await bridge.invoke(method, args);
  if (r.ok) return r.value;
  const err = new Error(r.error.message);
  Object.assign(err, r.error);
  throw err;
}

export const api = new Proxy({}, { get: (_, method) => (...args) => call(method, args) });

export const shell = {
  chooseBundle: () => bridge.chooseBundle(),
  chooseFolder: (opts) => bridge.chooseFolder(opts),
  reveal: (p) => bridge.reveal(p),
  openPath: (p) => bridge.openPath(p),
  trash: (p) => bridge.trash(p),
  appInfo: () => bridge.appInfo(),
  takePendingBundle: () => bridge.takePendingBundle(),
  pathForFile: (f) => bridge.pathForFile(f),
  on: (channel, cb) => bridge.on(channel, cb),
};

const MESSAGES = {
  PENDING: 'Karar bekleyen dosyalar var.',
  STALE: 'Plan hazırlandıktan sonra bazı dosyalar değişti. Değişiklikler yeniden okundu, lütfen tekrar gözden geçir.',
  PLAN_EXPIRED: 'Bu plan artık geçerli değil. Paketi yeniden aç.',
  BLOCKED: 'Bu aktarımı engelleyen sorunlar var.',
  EMPTY_EXPORT: 'Pakete konacak bir şey seçilmedi.',
  NOT_UNDOABLE: 'Bu işlem geri alınamıyor.',
  BACKUP_MISSING: 'Bu işlemden önce alınan yedek artık yok; geri alınamıyor.',
  BUNDLE_UNREADABLE: 'Paket dosyası okunamadı.',
  BUNDLE_CORRUPT: 'Dosya bozuk ya da bu uygulamanın paketi değil.',
  BUNDLE_NOT_BUNDLE: 'Bu dosya bir hafıza paketi değil.',
  BUNDLE_VERSION: 'Paket bu sürümden daha yeni bir uygulamayla oluşturulmuş. Uygulamayı güncelle.',
  BUNDLE_INTEGRITY: 'Paketteki bir dosya bozulmuş (taşıma sırasında zarar görmüş olabilir). Paket kullanılamaz.',
  BUNDLE_INVALID: 'Paketin içeriği geçersiz.',
  BUNDLE_HEADER: 'Paketin başlık bilgisi eksik.',
};

export function errorText(e) {
  if (!e) return '';
  if (e.code === 'APPLY_FAILED') {
    return e.rolledBack
      ? 'Yazma sırasında hata oluştu; o ana kadar yapılanlar geri alındı, dosyalar eski hâlinde.'
      : `Yazma sırasında hata oluştu ve her şey geri alınamadı. İşlem öncesi yedekten dönebilirsin: ${e.backupPath}`;
  }
  if (e.code === 'VERIFY_FAILED') return `Yazılan dosyalar doğrulanamadı. İşlem öncesi yedekten dönebilirsin: ${e.backupPath}`;
  return MESSAGES[e.code] || e.message || String(e);
}
