# Claude Memory Sync

Claude Code hafızalarını, VS Code workspace dosyalarını ve Claude ayarlarını cihazlar arasında
(macOS / Windows) **kayıpsız** taşır, iki yönlü eşitler ve düzenli yedekler.

Kendi penceresi olan bir masaüstü uygulamasıdır (Electron). Pencere kapansa da menü çubuğunda /
sistem tepsisinde çalışmaya devam eder ve her gün kendiliğinden yedek alır. Aynı çekirdeği kullanan
bir komut satırı sürümü de vardır.

## Ekranlar

| Ekran | Ne yapar |
|---|---|
| Genel Bakış | Hafıza ve workspace sayıları, son yedek, son paketten beri değişenler, gelen paket uyarısı |
| Hafızalar | Cihazdaki tüm Claude projeleri; her projenin klasörü, hafıza klasörü, git deposu, dosyaları ve önizlemesi. Pakete girip girmeyeceği buradan seçilir. |
| Workspace’ler | Tarama klasörlerindeki `.code-workspace` dosyaları; her klasörün bu cihazda olup olmadığı, başka cihazda açılmayacak yollar ve tek tıkla düzeltme |
| Yedekler | Günlük, işlem öncesi ve elle alınan yedekler ile bulunan paketler; içerik, geri yükleme, çöp kutusuna taşıma |
| Aktarım | Paket oluşturma ve gelen paketi adım adım aktarma: Paket → Eşleştirme → Değişiklikler → Onay → Sonuç. Workspace’ler ayrı sekmede; repoları bu cihazda olanlar seçili gelir |
| Geçmiş | Yapılan her işlem; aktarımı tek tıkla geri alma |
| Ayarlar | Cihaz adı, günlük yedek saati ve saklama sayısı, yedek klasörü, açılışta başlama, paket içeriği |

## Kurulum ve geliştirme

Node.js 22.12+ gerekir.

```
npm install
npm run dev          # geliştirme modu (Vite + Electron)
npm test             # testler
npm run dist:mac     # macOS: release/ altında .dmg ve .zip
npm run dist:win     # Windows: release/ altında kurulum .exe
```

Tek adımda derlemek için Windows’ta `build-win.cmd`, macOS’ta `build-mac.command` dosyasına çift tıklamak yeterli:
git varsa kodu günceller, derleme araçlarını proje klasörüne indirir, paketleri üretip `release` klasörünü açar
(macOS’ta Apple Silicon ve Intel için ayrı `.dmg` ve `.zip`). Node.js dışında bir şey kurmak gerekmez.

Uygulama imzasız dağıtılır. macOS’ta ilk açılışta uygulamaya sağ tıklayıp **Aç** deyin; Windows’ta
SmartScreen uyarısında **Ek bilgi → Yine de çalıştır**.

`.memsync` dosyaları uygulamayla ilişkilendirilir: çift tıklayınca doğrudan aktarım ekranı açılır.
Dosyayı pencereye sürükleyip bırakmak da olur.

## Senaryolar

**Bir cihazdan diğerine ilk taşıma**
1. Eski cihaz: Aktarım → Paket oluştur. Paket (varsayılan Masaüstü) diğer cihaza taşınır.
2. Yeni cihaz: pakete çift tıkla. Projeler git deposundan ya da klasör yolundan bulunur; klasör varsa ama
   Claude Code onu hiç açmamışsa hafıza klasörü kurulur. Bulunamayan proje için `git clone` komutu gösterilir.

**Tekrar aktarma (iki cihazda da çalışıldıysa)**
Paketi aç; yalnızca değişenler gösterilir: yeni gelenler, güncellenenler, silinenler, çakışmalar.
Her dosyanın işareti tek tek kaldırılabilir, fark ekranı açılabilir. Çakışmalarda seçim zorunludur:
bu cihazdaki / gelen / ikisini de tut / atla. İşareti kaldırılan değişiklik sonraki aktarımda yine sorulur.

**Format öncesi / sonrası**
Önce: Paket oluştur, paketi cihazın dışına (harici disk, bulut) kopyala. Sonra: uygulamayı kur, paketi aç,
“Bu cihazı paketteki hâline getir” seç.

**Geri alma**
Geçmiş ekranında her aktarımın yanında **Geri al** vardır. Yalnızca o aktarımın değiştirdiği dosyalar,
aktarımdan hemen önce alınan yedekteki hâline döner.

## Ne yedekleniyor

| Kategori | Kaynak |
|---|---|
| Proje hafızaları | `~/.claude/projects/<kodlanmış yol>/memory/**` (her proje) |
| Workspace dosyaları | Tarama klasörleri altındaki `*.code-workspace` (en fazla 3 seviye; git repolarının içi hariç) |
| Claude ayarları | `~/.claude/CLAUDE.md`, `agents/`, `commands/`, `skills/` (`skills/synced` hariç), `output-styles/` |

Yedekler her şeyi içerir. Başka cihaza giden paket, seçilenleri içerir. Claude uygulamasının geçici
oturumları (`scratch-workspaces`) yedeğe girer, pakete varsayılan olarak girmez. `CLAUDE_CONFIG_DIR`
ortam değişkeni tanınır.

## Nasıl karar veriyor

Her cihaz, her dosyanın gördüğü sürümlerin hash’lerini tutar (`history.json`) ve pakete de koyar.
Böylece “karşıda silindi” ile “burada yeni eklendi” ayırt edilir.

| Durum | Grup | Varsayılan |
|---|---|---|
| Yalnız karşıda eklenmiş | Yeni | Alınır |
| Yalnız karşıda değişmiş | Güncellenen | Alınır |
| Karşıda silinmiş, burada değişmemiş | Silinen | Silinir |
| İki tarafta da değişmiş | Çakışma | Seçim zorunlu |
| Burada değişmiş, karşıda silinmiş / tersi | Çakışma | Seçim zorunlu |
| Yalnız burada eklenmiş, değişmiş ya da silinmiş | Korunacak | Dokunulmaz |
| `MEMORY.md` | Birleştirme | Satır satır birleştirilir; aynı satır farklıysa sorulur |

## Güvenlik

- Her aktarım, geri yükleme, geri alma ve workspace düzeltmesinden önce, daha önce yedek alınmış olsa bile,
  cihazın tam yedeği alınır ve geri okunarak doğrulanır.
- Plan hazırlandıktan sonra değişen dosya varsa (ör. Claude o sırada yazdıysa) hiçbir şey yazılmaz, plan yenilenir.
- Dosyalar önce geçici dosyaya yazılıp tek adımda yerine konur; bir dosyada hata olursa o ana kadar yapılanlar geri alınır.
- İşlem bitince her dosya tekrar okunup doğrulanır; sürüm geçmişi ancak bundan sonra güncellenir.
- Paketteki her dosyanın hash’i okunurken kontrol edilir; bozuk paket reddedilir.
- Satır sonu (CRLF/LF) ve BOM farkı değişiklik sayılmaz.
- Boşalmış görünen hafıza klasörü pakete konmaz (karşı cihazda toplu silmeye dönüşmesin).
- Windows’ta geçersiz dosya adları ve yalnızca büyük/küçük harfle ayrılan adlar işlem başlamadan engellenir.
- Pencere yalnızca izin verilen çekirdek fonksiyonlarını çağırabilir; internete çıkmaz.

## Dosyalar nerede

| Ne | Nerede |
|---|---|
| Ayarlar, sürüm geçmişi, işlem kaydı | `~/.claude-memory-sync/` (`config.json`, `history.json`, `state.json`, `activity.jsonl`) |
| Yedekler | `~/.claude-memory-sync/backups/{daily,before,manual}` (Ayarlar’dan değiştirilebilir) |
| Paketler | Varsayılan Masaüstü: `claude-memory-<cihaz>-<tarih>.memsync` |

`.memsync` dosyası gzip’li JSON’dur; açılmaz, olduğu gibi uygulamaya verilir.

## 1.x’ten geçiş

İlk açılışta eski `config.json` (`reposRoot`, `prefix`) yeni biçime çevrilir; eski dosyalar
`config.v1.json` ve `history.v1.json` olarak saklanır. Eski paketler okunur. Eski komut satırı yeni
paketleri okuyamaz; iki cihaz da güncellenmelidir. “sasa” öneki şartı kalktı: tüm projeler görünür,
pakete girecekler seçilir.

## Komut satırı

```
node cli.js status              # bu cihazda ne var (bir şey yazmaz)
node cli.js backup [-o klasör]  # başka cihaz için paket oluşturur
node cli.js sync <dosya>        # paketi iki yönlü birleştirir
node cli.js restore <dosya>     # bu cihazı paketteki hâline getirir
node cli.js config              # cihaz adı ve workspace klasörleri
```

Tasarım ayrıntıları: [docs/TASARIM.md](docs/TASARIM.md)
