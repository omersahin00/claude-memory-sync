<div align="center">

<img src="build/icon.png" width="96" alt="">

# Claude Memory Sync

**Claude Code hafızalarını, VS Code workspace’lerini ve Claude ayarlarını macOS ile Windows arasında kayıpsız taşır, iki yönlü eşitler ve her gün kendiliğinden yedekler.**

![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-1f2328?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-5FA04E?logo=nodedotjs&logoColor=white)

[Neler yapar](#neler-yapar) · [Ekranlar](#ekranlar) · [Kurulum](#kurulum) · [Kullanım](#kullanım) · [Nasıl çalışır](#nasıl-çalışır) · [Komut satırı](#komut-satırı) · [Geliştirme](#geliştirme)

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/genel-bakis-dark.png">
  <img src="docs/screenshots/genel-bakis.png" alt="Genel Bakış: hafıza ve workspace sayıları, son yedek, gelen paket">
</picture>

## Neden

Claude Code her proje için öğrendiklerini, yani hafızasını, bilgisayarın içinde `~/.claude/projects/<proje>/memory`
altında tutar. Başka bir bilgisayara geçince bu hafızalar orada yoktur. Proje klasörlerinin yolu iki cihazda farklı
olduğu için elle kopyalamak da işe yaramaz. Claude Memory Sync hafızaları projeleriyle eşleştirerek taşır, iki cihazda
da değişenleri tek tek gösterir ve onaylamadığın hiçbir dosyaya dokunmaz.

## Neler yapar

- **Her şeyi tek yerde gösterir.** Bu cihazdaki tüm Claude projeleri, hafıza dosyaları ve workspace’ler; her birinin
  hangi klasörden alındığı ve hangisinin pakette olduğu.
- **Tek dosyayla taşır.** Seçtiklerini bir `.memsync` paketine koyar. Diğer cihazda pakete çift tıklamak aktarımı başlatır.
- **Projeleri kendisi bulur.** Klasörler iki cihazda farklı yerlerde olsa da proje, git deposundan ya da klasör yolundan
  eşleşir. Emin olamadığını seçili getirmez.
- **İki yönlü, sürüm kontrollü eşitler.** Yeni, güncellenen, silinen ve iki cihazda da değişen dosyalar ayrı listelenir.
  Çakışmada “bu cihazdaki”, “gelen” ya da “ikisini de tut” seçilir; `MEMORY.md` satır satır birleşir.
- **Workspace’leri repolarıyla taşır.** Her workspace’in açtığı repolar bu cihazda aranır; repoları burada olmayanlar
  seçilmeden gelir.
- **Her işlemden önce yedek alır,** daha önce yedek alınmış olsa bile. Her aktarım tek tıkla geri alınır.
- **Her gün kendiliğinden yedekler.** Pencere kapansa da menü çubuğunda / sistem tepsisinde çalışmaya devam eder.
- **Komut satırından da kullanılır.** `cli.js` aynı çekirdeği kullanır.

## Ekranlar

### Hafızalar

Cihazdaki her Claude projesi: proje klasörü, hafıza klasörü, git deposu, dosyalar ve önizleme. Pakete hangilerinin
gireceği buradan seçilir.

![Hafızalar: proje listesi ve bir projenin ayrıntısı](docs/screenshots/hafizalar.png)

### Workspace’ler

Tarama klasörlerindeki `.code-workspace` dosyaları ve açtıkları klasörler. Başka cihazda açılmayacak yollar (mutlak
yol, ters eğik çizgi) gösterilir ve tek tıkla düzeltilir.

![Workspace’ler: dosyalar, açtıkları klasörler ve uyarılar](docs/screenshots/workspaceler.png)

### Aktarım

Gelen paket beş adımda aktarılır: **Paket → Eşleştirme → Değişiklikler → Onay → Sonuç**.

**Eşleştirme.** Paketteki her parçanın bu cihazda nereye yazılacağı. Bu cihazda olmayan proje için `git clone` komutu
gösterilir.

![Aktarım: eşleştirme](docs/screenshots/aktarim-eslestirme.png)

**Değişiklikler.** Yalnızca değişen dosyalar, gruplar hâlinde. Her dosyanın farkı açılabilir, işareti kaldırılabilir;
işareti kaldırılan değişiklik sonraki aktarımda yine sorulur.

![Aktarım: değişiklikler ve çakışma kararı](docs/screenshots/aktarim-degisiklikler.png)

**Workspace’ler sekmesi.** Her workspace, açtığı repolarla birlikte listelenir. Repoları bu cihazda olanlar seçili gelir.

![Aktarım: workspace’ler ve repoları](docs/screenshots/aktarim-workspaceler.png)

### Yedekler ve geçmiş

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/yedekler.png" alt="Yedekler"></td>
    <td width="50%"><img src="docs/screenshots/gecmis.png" alt="Geçmiş"></td>
  </tr>
  <tr>
    <td>Günlük, işlem öncesi ve elle alınan yedekler ile başka cihazlardan gelen paketler. İçerikleri görülür, istenen yedeğe dönülür.</td>
    <td>Yapılan her işlem. Bir aktarımı geri almak yalnızca onun değiştirdiği dosyaları işlem öncesindeki hâline döndürür.</td>
  </tr>
</table>

## Kurulum

Hazır paket henüz yayımlanmadı; uygulama kaynak koddan tek tıkla derlenir. Gereken tek şey
[Node.js](https://nodejs.org) 22.12 veya üstü. Derleme araçları proje klasörüne iner, sisteme başka bir şey kurulmaz.

1. Repoyu indir:
   ```
   git clone https://github.com/omersahin00/claude-memory-sync.git
   ```
2. Klasördeki derleme dosyasına çift tıkla. Kodu günceller, derler ve `release` klasörünü açar.

   | Sistem | Dosya | `release` klasöründe çıkan |
   |---|---|---|
   | macOS | `build-mac.command` | `Claude Memory Sync-<sürüm>-arm64.dmg` (Apple Silicon) ve `…-x64.dmg` (Intel) |
   | Windows | `build-win.cmd` | `Claude Memory Sync Setup <sürüm>.exe` |

3. macOS’ta dmg’yi açıp uygulamayı **Applications** klasörüne sürükle. Windows’ta kurulum dosyasını çalıştır.

Uygulama imzasızdır. Başka bir bilgisayardan alınan kopya ilk açılışta uyarı verebilir: macOS’ta uygulamaya sağ tıklayıp
**Aç** de (gerekirse **Sistem Ayarları → Gizlilik ve Güvenlik → Yine de Aç**), Windows’ta SmartScreen uyarısında
**Ek bilgi → Yine de çalıştır**.

## Kullanım

**İlk taşıma.** Eski cihazda **Aktarım → Paket oluştur**. Paket varsayılan olarak Masaüstü’ne kaydedilir; onu diğer
cihaza götürüp çift tıkla. Projeler git deposundan ya da klasör yolundan bulunur. Klasör cihazda varsa ama Claude Code onu
hiç açmamışsa hafıza klasörü kurulur.

**Tekrar aktarma.** İki cihazda da çalıştıktan sonra yeni paketi aç; yalnızca değişenler gelir. Çakışmalarda seçim
zorunludur: bu cihazdaki, gelen, ikisini de tut ya da atla.

**Format öncesi ve sonrası.** Önce paket oluştur ve cihazın dışına (harici disk, bulut) kopyala. Sonra uygulamayı kur,
paketi aç ve **Bu cihazı paketteki hâline getir**’i seç.

**Geri alma.** **Geçmiş** ekranında her aktarımın yanında **Geri al** vardır.

## Nasıl çalışır

### Ne yedekleniyor

| Kategori | Kaynak |
|---|---|
| Proje hafızaları | `~/.claude/projects/<proje>/memory/**` (her proje) |
| Workspace dosyaları | Tarama klasörleri altındaki `*.code-workspace` (en fazla 3 seviye; git repolarının içi hariç) |
| Claude ayarları | `~/.claude/CLAUDE.md`, `agents/`, `commands/`, `skills/` (`skills/synced` hariç), `output-styles/` |

Yedek her şeyi içerir; başka cihaza giden paket yalnızca seçilenleri. Claude uygulamasının geçici oturumları
(`scratch-workspaces`) yedeğe girer, pakete varsayılan olarak girmez. `CLAUDE_CONFIG_DIR` ortam değişkeni tanınır.

### Eşleştirme

Claude’un proje klasörünün adı projenin tam yolundan türetilir, bu yüzden aynı proje iki cihazda farklı adla durur.
Gelen her proje şu sırayla eşleşir: daha önce onaylanmış eşleşme → aynı git deposu → ev klasörüne göre aynı yol
(`Documents/GitHub/x`) → cihazda olan ama Claude’un henüz açmadığı klasör. Yalnızca adı aynı olan proje önerilir ama
seçili gelmez. Workspace klasörü, gelen workspace’lerin açtığı repoların durduğu yerden bulunur. Yapılan eşleştirme
kaydedilir, sonraki aktarımlarda sorulmaz.

### Sürüm kontrolü

Her cihaz, her dosyanın gördüğü sürümlerin özetini (hash) tutar ve pakete koyar. Böylece “karşıda silindi” ile “burada
yeni eklendi” ayırt edilir.

| Durum | Grup | Varsayılan |
|---|---|---|
| Yalnız karşıda eklenmiş | Yeni | Alınır |
| Yalnız karşıda eklenmiş workspace, açtığı repolar burada değil | Yeni | Alınmaz, sonra yine sorulur |
| Yalnız karşıda değişmiş | Güncellenen | Alınır |
| Karşıda silinmiş, burada değişmemiş | Silinen | Silinir |
| İki tarafta da değişmiş | Çakışma | Seçim zorunlu |
| Burada değişmiş, karşıda silinmiş (ya da tersi) | Çakışma | Seçim zorunlu |
| Yalnız burada eklenmiş, değişmiş ya da silinmiş | Korunur | Dokunulmaz |
| `MEMORY.md` | Birleştirme | Satır satır birleşir; aynı satır farklıysa sorulur |

### Güvenlik

- Her aktarım, geri yükleme, geri alma ve workspace düzeltmesinden önce, daha önce yedek alınmış olsa bile, cihazın tam
  yedeği alınır ve geri okunarak doğrulanır.
- Plan hazırlandıktan sonra değişen dosya varsa (ör. Claude o sırada yazdıysa) hiçbir şey yazılmaz, plan yenilenir.
- Dosyalar önce geçici dosyaya yazılıp tek adımda yerine konur. Bir dosyada hata olursa o ana kadar yapılanlar geri alınır.
- İşlem bitince her dosya tekrar okunup doğrulanır; sürüm geçmişi ancak bundan sonra güncellenir.
- Paketteki her dosyanın özeti okunurken kontrol edilir; bozuk paket reddedilir.
- Satır sonu (CRLF/LF) ve BOM farkı değişiklik sayılmaz.
- Boşalmış görünen hafıza klasörü pakete konmaz, böylece karşı cihazda toplu silmeye dönüşmez.
- Windows’ta geçersiz dosya adları ve yalnızca büyük/küçük harfle ayrılan adlar, işlem başlamadan engellenir.
- Arayüz yalnızca izin verilen çekirdek fonksiyonlarını çağırabilir. Uygulama internete çıkmaz.

### Dosyalar nerede

| Ne | Nerede |
|---|---|
| Ayarlar, sürüm geçmişi, işlem kaydı | `~/.claude-memory-sync/` (`config.json`, `history.json`, `state.json`, `activity.jsonl`) |
| Yedekler | `~/.claude-memory-sync/backups/{daily,before,manual}` (Ayarlar’dan değiştirilebilir) |
| Paketler | Varsayılan Masaüstü: `claude-memory-<cihaz>-<tarih>.memsync` |

`.memsync` dosyası gzip’li JSON’dur; açılmaz, olduğu gibi uygulamaya verilir.

## Komut satırı

```
node cli.js status              # bu cihazda ne var (bir şey yazmaz)
node cli.js backup [-o klasör]  # başka cihaz için paket oluşturur
node cli.js sync <dosya>        # paketi iki yönlü birleştirir
node cli.js restore <dosya>     # bu cihazı paketteki hâline getirir
node cli.js config              # cihaz adı ve workspace klasörleri
```

## Geliştirme

```
npm install
npm run dev          # geliştirme modu (Vite + Electron)
npm test             # testler
npm run dist:mac     # macOS: release/ altında Apple Silicon (arm64) ve Intel (x64) .dmg
npm run dist:win     # Windows: release/ altında kurulum .exe
```

`release` klasörü yalnızca kurulum dosyalarını tutar; derlemenin ara dosyaları `dist/electron` altında kalır. Bu
sayfadaki ekran görüntüleri gerçek veri kullanmadan, iki örnek cihazla üretilir:

```
CMS_SCALE=2 node scripts/screenshots.mjs <klasör> [light|dark]
```

| Klasör | İçerik |
|---|---|
| `lib/` | Çekirdek. `engine.js` tek giriş noktasıdır; arayüz de komut satırı da onu kullanır |
| `app/` | Electron ana süreci, preload ve React arayüzü (`app/renderer`) |
| `cli.js`, `lib/commands/` | Komut satırı |
| `scripts/` | Geliştirme, paketleme ve ekran görüntüsü yardımcıları |
| `test/` | `node:test` testleri |
| `docs/` | [Tasarım notları](docs/TASARIM.md) ve ekran görüntüleri |

## 1.x’ten geçiş

İlk açılışta eski `config.json` (`reposRoot`, `prefix`) yeni biçime çevrilir; eski dosyalar `config.v1.json` ve
`history.v1.json` olarak saklanır. Eski paketler okunur, ama 1.x yeni paketleri okuyamaz; iki cihaz da güncellenmelidir.
1.x yalnızca belirli bir önekle başlayan repoları alıyordu; artık tüm projeler görünür, pakete girecekler seçilir.
