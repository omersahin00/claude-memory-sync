const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

// Paths under the home folder are shown as ~/… (the full path stays in the tooltip and in every action).
let home = null;
export const setHome = (h) => {
  home = h;
};
export function tildify(p) {
  if (!home || typeof p !== 'string') return p;
  const low = (s) => (/^[a-z]:\\/i.test(s) ? s.toLowerCase() : s);
  if (low(p) === low(home)) return '~';
  const sep = home.includes('\\') ? '\\' : '/';
  return low(p).startsWith(low(home) + sep) ? `~${p.slice(home.length)}` : p;
}
const pad = (n) => String(n).padStart(2, '0');

export function fmtDate(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(v) {
  const d = new Date(v);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRelative(v, now = Date.now()) {
  if (!v) return '-';
  const d = new Date(v);
  const s = (now - d.getTime()) / 1000;
  if (s < 0) {
    const ahead = -s;
    if (ahead < 3600) return `${Math.max(1, Math.round(ahead / 60))} dk sonra`;
    const today = new Date(now);
    if (d.toDateString() === today.toDateString()) return `bugün ${fmtTime(d)}`;
    const tomorrow = new Date(now + 86400000);
    if (d.toDateString() === tomorrow.toDateString()) return `yarın ${fmtTime(d)}`;
    return fmtDate(d);
  }
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `${Math.round(s / 3600)} saat önce`;
  const yesterday = new Date(now - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return `dün ${fmtTime(d)}`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} gün önce`;
  return fmtDate(d);
}

export function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export const KIND_LABEL = { daily: 'Günlük yedek', before: 'İşlem öncesi yedek', manual: 'Elle alınan yedek', export: 'Paket' };
export const KIND_TONE = { daily: 'blue', before: 'violet', manual: 'green', export: 'accent' };

export const TYPE_LABEL = { project: 'Proje hafızası', workspaceRoot: 'Workspace klasörü', claude: 'Claude ayarları' };

export const HOW = {
  self: ['Bu cihazın yedeği', 'green'],
  saved: ['Daha önce eşleştirildi', 'green'],
  git: ['Aynı git deposu', 'green'],
  path: ['Aynı klasör', 'green'],
  key: ['Aynı isim', 'green'],
  name: ['Yalnızca isim aynı', 'amber'],
  manual: ['Senin seçimin', 'accent'],
  repos: ['Repoları burada', 'green'],
  claude: ['Claude klasörü', 'green'],
};

export const MATCH_WARNING = {
  'name-only': 'Yalnızca isim aynı; aynı proje olduğundan emin değilsen seçme.',
  'git-mismatch': 'Bu isimde bir proje var ama git deposu farklı.',
  'duplicate-target': 'Bu hedefe başka bir proje zaten eşleşti.',
};

// Sections of the review screen, in display order.
export const GROUPS = {
  conflict: { label: 'Çakışmalar', tone: 'amber', desc: 'İki cihazda da farklı değişmiş. Her biri için ne olacağını sen seçmelisin.' },
  new: { label: 'Yeni gelenler', tone: 'green', desc: 'Karşı cihazda eklenmiş, bu cihazda yok.' },
  updated: { label: 'Güncellenenler', tone: 'blue', desc: 'Karşı cihazda değişmiş, bu cihazda değişmemiş.' },
  deleted: { label: 'Silinenler', tone: 'red', desc: 'Karşı cihazda silinmiş, bu cihazda değişmemiş.' },
  index: { label: 'İçindekiler dosyaları (MEMORY.md)', tone: 'violet', desc: 'Satır satır birleştirilir; iki cihazdaki yeni satırlar korunur.' },
  kept: { label: 'Bu cihazda olduğu gibi kalacak', tone: 'gray', desc: 'Yalnız bu cihazda eklenmiş, değişmiş ya da silinmiş. Dokunulmaz.' },
};
export const RESTORE_GROUPS = {
  new: { label: 'Eklenecek', tone: 'green', desc: 'Pakette var, bu cihazda yok.' },
  updated: { label: 'Paketteki hâli yazılacak', tone: 'blue', desc: 'Bu cihazdaki farklı; paketteki hâline döner.' },
  deleted: { label: 'Silinecek', tone: 'red', desc: 'Bu cihazda var, pakette yok.' },
};
export const GROUP_ORDER = ['conflict', 'new', 'updated', 'deleted', 'index', 'kept'];

export const ACTION_TEXT = {
  conflict: 'İki cihazda da değişmiş',
  'conflict-remote-deleted': 'Burada değişmiş, karşıda silinmiş',
  'conflict-local-deleted': 'Burada silinmiş, karşıda değişmiş',
  'local-only': 'Yalnız bu cihazda var',
  'local-newer': 'Bu cihazdaki daha yeni',
  'local-deleted': 'Bu cihazda silinmiş, silinmiş kalacak',
};

export const INDEX_TEXT = {
  merge: 'birleştirilecek',
  update: 'gelen hâli yazılacak',
  add: 'eklenecek',
  delete: 'silinecek',
  kept: 'değişmeyecek',
  same: 'değişmeyecek',
};

export const ACTIVITY = {
  backup: 'Yedek alındı',
  export: 'Paket oluşturuldu',
  sync: 'Paket aktarıldı',
  restore: 'Yedeğe dönüldü',
  undo: 'İşlem geri alındı',
  'workspace-fix': 'Workspace dosyası düzeltildi',
  migrate: 'Eski sürümden geçildi',
};

export const WS_WARNING = {
  absolute: 'Mutlak yol: başka cihazda ya da işletim sisteminde açılmaz',
  backslash: 'Ters eğik çizgi (\\) macOS ve Linux’ta çalışmaz',
  'outside-root': 'Tarama klasörünün dışında; diğer cihazda da aynı göreli yerde olmalı',
  missing: 'Bu cihazda yok',
};

export const BLOCKING = {
  'case-collision': (e) => `${e.scope}: "${e.a}" ve "${e.b}" yalnızca büyük/küçük harfle ayrılıyor; bu cihazda aynı dosya olur.`,
  'windows-name': (e) => `${e.scope}: ${e.rel} adı Windows'ta geçersiz.`,
};

export const EXPORT_WARNING = {
  'empty-memory': (w) => `${w.name}: hafıza klasörü boş görünüyor ama önceden dosyaları vardı. Yanlışlıkla silinmiş olabilir; pakete konmadı.`,
  'empty-workspaces': (w) => `${w.path}: workspace dosyası bulunamadı ama önceden vardı; pakete konmadı.`,
  'empty-claude': () => 'Claude ayarları klasörü boş görünüyor ama önceden dosyaları vardı; pakete konmadı.',
};
