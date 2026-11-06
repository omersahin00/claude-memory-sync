# Claude Memory Sync 2 — Tasarım

## Amaç

Claude Code hafızalarını, VSCode workspace dosyalarını ve Claude genel ayarlarını macOS ve Windows
arasında kayıpsız taşımak, iki yönlü eşitlemek ve düzenli yedeklemek. Kendi penceresi ve menü
çubuğu / tepsi simgesi olan bir Electron uygulaması; komut satırı (`node cli.js`) da kalır.

## Gereksinimler

1. Mac ve Windows'ta çalışan, kendi arayüzü olan uygulama.
2. Generic: önek şartı yok; cihazdaki tüm Claude projeleri görünür, istenen seçilir.
3. Yedek alma, paket oluşturma, aktarma, geri yükleme, geri alma.
4. Önceki yedekleri ve paketleri kendiliğinden bulup listeleme.
5. Portatif kullanım: `.memsync` dosyası verilir, içindeki her şey aktarılır (çift tıklama, sürükle-bırak).
6. Arka planda çalışıp takvimli, şifreli ve artımlı yedek; bilgisayar açılınca başlama.
7. Workspace (`.code-workspace`) dosyalarına tam destek.
8. Sade arayüz; neyin nereden alındığı, nereye yazılacağı her adımda görünür.
9. Tekrar aktarımda versiyon kontrolü: yeni, değişen, silinen, çakışan her dosya ayrı gösterilir ve onaylanır.
10. Her aktarımdan, geri yüklemeden ve geri almadan önce, daha önce yedek alınmış olsa bile yeni yedek.
11. Claude Code sohbetleri, kendilerine ait her şeyle birlikte ve hiçbir şeyi kaybetmeden taşınabilir.

## Mimari

| Katman | Yer | Görev |
|---|---|---|
| Çekirdek | `lib/` | Bağımlılıksız Node kodu. `engine.js` tek giriş noktası; CLI ve uygulama aynı çekirdeği kullanır. |
| Ana süreç | `app/main.js` | Pencere, IPC, tepsi simgesi, zamanlayıcı, dosya ilişkilendirme. |
| Köprü | `app/preload.js` | Arayüze yalnızca izin verilen çekirdek fonksiyonlarını açar (contextIsolation, sandbox). |
| Arayüz | `app/renderer/` | React + Vite. İnternete çıkmaz, dış kaynak yüklemez. |
| CLI | `cli.js` | `status`, `backup`, `export`, `sync`, `restore`. |
| Diller | `app/locales/` | Arayüz metinleri, dil başına bir JSON dosyası; ana süreç ve arayüz aynı dosyaları okur. |
| Ortak motor | `core/` | Folder Backup'la ortak yedek motoru (restic ile şifreli, artımlı yedek). Folder Backup'ın `lib/` klasöründen `npm run core` ile alınır, burada değiştirilmez. |
| Yedekler | `lib/backups.js`, `lib/stage.js` | Bu cihazın yedekleri: ortak motorun bir seti (Claude seti) ve her yedekten önce doldurulan "stage" klasörü. |

### Ortak motor (`core/`)

Yedekleri şifreli ve artımlı almak için Folder Backup'ın motoru kullanılır. Motor Folder Backup'ta yazılır; bu uygulama
onu `npm run core` ile (`scripts/sync-core.js`) `core/` klasörüne alır. restic indirme betiği `scripts/fetch-restic.js`
de onunla gelir.

- `core/SOURCE.json` her dosyanın SHA-256 değerini ve kaynak commit'i tutar. `test/core.test.js` bir dosya burada
  değiştirilirse düşer; motordaki değişiklik Folder Backup'ta yapılır, sonra yeniden alınır.
- restic 0.19.1, Folder Backup'taki gibi indirilip SHA-256 ile doğrulanır. `vendor/restic` altına iner (git'e girmez),
  kurulum dosyasında `Resources/restic` altında durur; lisansı ve içindeki Go modüllerinin lisansları
  (`licenses/restic-third-party.txt`, motorla birlikte gelir) yanında.
- Bu uygulama Folder Backup olmadan da tek başına çalışır. İkisi aynı bilgisayarda kurulu olduğunda birbirlerinin
  yedeklerini görürler (aşağıda "Folder Backup ile birlikte"). Her yedeğin tek sahibi vardır: takvimini yalnızca sahibi
  çalıştırır.
- Komut satırı da yedekleri kullanır: `node cli.js setup-backups <klasör>` kurar, `undo` son işlemi geri alır; şifre
  `CLAUDE_MEMORY_SYNC_PASSWORD` ortam değişkeninden gelir (uygulamanın sakladığını yalnızca uygulama çözebilir).

## Arayüz düzeni

Kenar çubuğunda ekranlar ve altında Hızlı işlemler var. Uygulamanın asıl işleri (Şimdi yedek al, Tam yedek al, Paket
oluştur, Paket aktar) her ekranda aynı yerde ve aynı sırada durur; ekranlar bunları tekrar etmez. Sayfa başlığında
yalnızca o ekrana özgü işler olur (Yedekler'de yedek klasörünü açma ve Yedek içeriği gibi). Şimdi yedek al ve Tam yedek
al bulunulan ekrandan ayrılmadan çalışır; paket işlemleri Aktarım'ın ilgili sekmesini açar.

## Dil desteği

- Arayüz İngilizce, Türkçe, Almanca, İspanyolca ve Fransızca. Her dil `app/locales/<kod>.json`; klasöre yeni dosya
  koymak yeni dil demek, kod değişmez.
- Dil, Ayarlar’daki seçim (`config.json` → `language`); seçilmemişse sistemin tercih ettiği dillerden dosyası olan
  ilki, o da yoksa İngilizce. Ana süreç seçer (`app/i18n.js`), arayüz ilk çizimden önce sorar; değiştirilince
  pencere, tepsi menüsü ve bildirimler hemen yeni dile geçer.
- Metinler anahtarla alınır (`t('home.sub', { device })`). `{ad}` yer tutucuları doldurulur, sayılar dilin
  biçimiyle yazılır. Çoğul biçimi olan metinler `{ "one": …, "other": … }`; biçim `Intl.PluralRules` ile seçilir.
  Bir dilde eksik metin İngilizcesiyle gösterilir.
- Tarih, saat ve “3 gün önce” gibi göreli zamanlar `Intl` ile dilin kendi biçiminde yazılır.
- CLI ve çekirdeğin hata mesajları İngilizce kalır; arayüz ve bildirimler hata kodlarını (`errors.<KOD>`) kendi diline
  çevirir. Sistemin dosya hataları da böyle (`EACCES`, `ENOENT` ...). Metni olmayan kod "beklenmeyen hata" der ve yalnızca
  o zaman İngilizce ayrıntıyı gösterir.
- `test/i18n.test.js`: her dilde İngilizcedeki bütün metinler aynı yer tutucularla var mı, koddaki her anahtar
  dosyada var mı. Ekran görüntüsü betiği her ekranın metnini de yazar; çevrilmemiş metin oradan aranır.

## Ne yedekleniyor

| Kategori | Kaynak | Paketteki anahtar |
|---|---|---|
| Proje hafızaları | `~/.claude/projects/<kodlanmış yol>/memory/**` | `memory/<proje>/<dosya>` |
| Workspace dosyaları | Tarama klasörleri altındaki `*.code-workspace` (en fazla 3 seviye, git repolarının içi hariç) | `workspace/<kök>/<dosya>` |
| Claude ayarları | `~/.claude/CLAUDE.md`, `agents/`, `commands/`, `skills/` (`skills/synced` hariç), `output-styles/` | `claude/<dosya>` |
| Sohbetler (seçilince) | Aşağıda, "Sohbetler" | `p/<id>.jsonl`, `p/<id>/…`, `h/<id>/…`, `u/<id>/…` |

Takvimli ve elle alınan yedek, Yedek içeriği'nde bırakılanları içerir (aşağıda). İşlem öncesi yedek her zaman bütün
hafızaları, workspace dosyalarını ve Claude ayarlarını içerir; tam yedek sohbetler dahil her şeyi. Paket (başka cihaza
götürülecek dosya) seçilenleri içerir.
Claude uygulamasının geçici çalışma alanları (`scratch-workspaces`) yedeğe girer, pakette varsayılan olarak yoktur.

## Proje kimliği ve eşleştirme

Claude proje klasörünün adı mutlak yoldan türetilir; cihazdan cihaza değişir. Bu yüzden her projeye
klasör adından türetilen bir anahtar verilir (`shop-web`, `desktop`). Anahtar cihazda kalıcıdır.

Claude Code (2.1) bu adı şöyle verir; uygulama aynısını yapar:
- **Yolun NFC biçimi:** Ş gibi harfler tek karakter olarak yazılır. macOS bir adı NFD (S ve çengel) olarak
  tutabilir; Finder'da açılan Türkçe adlı klasörler çoğu zaman öyledir.
- Harf ve rakam dışındaki her karakter `-` olur.
- 200 karakteri geçen ad orada kesilir ve sonuna yolun özeti eklenir. Kesilmiş bir ad geri okunamaz; klasörü,
  masaüstü uygulamasının kayıtlarında geçen yollardan biri verir.
- Eski sürümlerin verdiği ad (yolun geldiği biçimde, kesilmeden) de tanınır.

Yer ve ad karşılaştırmaları NFC biçimde yapılır. Windows NFC ve NFD adları ayrı tutar (macOS tutmaz). Bu yüzden diğer
cihazdan gelen yolun klasörü iki biçimde de aranır. Masaüstü kaydına ve istemlere yol, Claude'un yazdığı gibi NFC
yazılır; Windows'ta masaüstü kaydına klasörün diskteki adı yazılır.

Gelen paketteki proje hedef cihazda şu sırayla eşleşir:

| Sıra | Yöntem | Varsayılan |
|---|---|---|
| 1 | Daha önce onaylanmış eşleşme | Seçili |
| 2 | Aynı anahtar ve aynı git remote | Seçili |
| 3 | Aynı anahtar ve ev klasörüne göre aynı yol (`Documents/GitHub/x`) | Seçili |
| 4 | Aynı yol cihazda var ama Claude projesi yok → hafıza klasörü oluşturulur | Seçili |
| 5 | Yalnızca isim aynı | Seçili değil, uyarılı |
| 6 | Eşleşme yok | Kullanıcı proje ya da klasör seçer veya atlar |

Kullanıcının yaptığı eşleştirme kaydedilir; sonraki aktarımlarda sorulmaz.

Workspace klasörü şu sırayla bulunur: daha önce onaylanmış klasör, aynı anahtarlı tarama klasörü, workspace’lerin
açtığı repoların en çoğunun durduğu klasör (tarama klasörleri, Claude projelerinin üst klasörleri ve bilinen yerler
aranır; eşitlikte ev klasörüne göre aynı yol öne geçer), son olarak ev klasörüne göre aynı yol. Değişiklikler adımında
workspace’ler ayrı sekmede tek tek, açtıkları repolarla birlikte listelenir.

## Versiyon kontrolü

Her cihaz, her dosyanın gördüğü sürümlerin hash'lerini `history.json`'da tutar ve pakete koyar.
Böylece "karşıda silindi" ile "burada yeni eklendi" ayrılır.

| Durum | Grup | Varsayılan |
|---|---|---|
| Yalnız karşıda eklenmiş | Yeni | Al |
| Yalnız karşıda eklenmiş workspace, açtığı klasörlerin hepsi burada değil | Yeni | Alma; sonraki aktarımda yine sorulur |
| Yalnız karşıda değişmiş | Güncellenmiş | Al |
| Karşıda silinmiş, burada değişmemiş | Silinmiş | Sil |
| İki tarafta da değişmiş | Çakışma | Seçim zorunlu: bu cihaz / gelen / ikisini de tut |
| Burada değişmiş, karşıda silinmiş | Çakışma | Seçim zorunlu: tut / sil |
| Burada silinmiş, karşıda değişmiş | Çakışma | Seçim zorunlu: geri getir / silinmiş kalsın |
| Yalnız burada eklenmiş, değişmiş ya da silinmiş | Korunacak | Dokunulmaz |
| Karşı cihazın pakete koymadığı workspace dosyası | (listelenmez) | Dokunulmaz; geri yüklemede de silinmez |
| `MEMORY.md` | Birleştirme | Satır satır birleştirilir; aynı satır farklıysa seçim zorunlu |

Her dosyanın işareti tek tek kaldırılabilir; fark ekranı her dosya için açılır.
İşareti kaldırılan değişiklik geçmişe yazılmaz, sonraki aktarımda yine sorulur.

## Sohbetler

Bir sohbet: proje klasöründeki `<id>.jsonl` (konuşma) ve `<id>/` (alt görevler, büyük araç çıktıları,
`custom-title.json`), `file-history/<id>/` (değiştirdiği dosyaların eski sürümleri, geri sarma için), `uploads/<id>/`
(eklenen dosyalar), `history.jsonl`'daki istemleri ve masaüstü uygulamasından başladıysa uygulamanın
`claude-code-sessions/<hesap>/<kuruluş>/local_<id>.json` kaydı (başlık, model, ayarlar). Pakete hepsi birlikte girer.

- Paket oluştururken projeler tek listede, hafızası ve sohbetleriyle seçilir (Yedek içeriği'nde de aynı liste).
  Sohbet her zaman projesinin hafızasıyla gider, pakette de yedekte de; bunu çekirdek sağlar (`collect`), arayüz de
  sohbeti seçili projenin kutusunu kilitler. Claude, sohbetin çalıştığı klasörün hafızasını okur; hafızasız giden
  sohbet karşıda eksik kalır. Hafızası olmayan projenin konumu `memory: false` ile işaretlenir, karşı cihaz o projenin
  hafızasına dokunmaz.
- Karşıda sohbet, eşleşen projenin Claude klasörüne yazılır. İstemlerin ve masaüstü kaydının proje yolu
  (`cwd`, `originCwd`, aynıysa `gitAnchorsFolderRealpath`) o cihazdaki klasöre çevrilir.
- **Masaüstü kaydı:** o cihazda masaüstü uygulaması kuruluysa (veri klasörü varsa) ve kayıt yoksa yazılır.
  - Hesap/kuruluş klasörü yoksa oluşturulur. Uygulamanın yalnızca Remote Control ile kullanıldığı bir bilgisayarda bu
    klasör hiç oluşmamıştır; eskiden bu yüzden sohbet diske geliyor ama uygulamanın listesine girmiyordu.
  - Kaydı eksik kalmış, ama kendisi aynı olan bir sohbet, paket yeniden açılınca "güncellenecek" sayılır; böylece
    kaydı yazılır.
- **OneDrive:** Windows'ta Masaüstü, Belgeler ve Resimler OneDrive'da olabilir (`OneDrive\Desktop`,
  `OneDrive - Şirket\Documents`). Diğer cihazın `Desktop` projesi bu cihazın OneDrive'daki Masaüstü'ne eşleşir; yer
  karşılaştırmaları da baştaki OneDrive klasörünü yok sayar.
- Hiçbir sohbet silinmez ya da kısaltılmaz:

| Durum | Sonuç |
|---|---|
| Bu cihazda yok | Eklenir |
| Bu cihazdaki, gelenin başı (karşıda devam edilmiş), bazı dosyaları ya da masaüstü kaydı eksik | Güncellenir |
| Aynı | Dokunulmaz |
| Bu cihazdaki daha ileride | Dokunulmaz |
| İki cihazda da devam edilmiş | Yeni kimlikle yanına eklenir; kimlik dosyaların içinde de değişir, başlığa gelen cihazın adı eklenir |

- İstemler `oturum|zaman|metin` imzasıyla birleştirilir ve zamana göre sıralanır; var olan satır iki kez yazılmaz.
- Plan hazırlandıktan sonra bu cihazda değişen sohbet varsa (Claude o sırada yazıyor olabilir) işlem durur.
- Masaüstü uygulamasında klasör seçmeden açılan oturum, uygulamanın geçici klasöründe çalışır
  (`scratch-workspaces/<hesap>/<kuruluş>/scratch-<tarih>-<kod>`). Karşıda aynı yol, o cihazdaki uygulamanın veri
  klasörü altında kurulur (`how: 'scratch'`); klasör ilk sohbetle açılır (`mkdir` işlemi, geri dönüşte boşsa silinir).
- Böyle bir proje uygulamadaki başlığıyla gösterilir (`scratchTitles`): klasördeki ana oturumun (yan sohbet değil, en
  çok turlu) başlığı; oturum uygulamada bir klasöre taşındıysa (`scratchCarried.from`) onun başlığı, hafızası eski
  klasörde kalır. Başlık paketteki konuma da yazılır (`title`). Oturumları silinmiş bir geçici klasör, Claude klasörünün
  adından bulunur (`…-scratch-workspaces-<hesap>-<kuruluş>-scratch-…`, yeniden kodlanınca aynı adı vermesiyle doğrulanır).

### Masaüstü uygulamasının grupları

Kenar çubuğundaki gruplar uygulamanın ayar dosyasında, `claude_desktop_config.json` → `preferences.epitaxyPrefs`:
`dframe-group-scopes[<hesap>/<kuruluş>]` = `{ groups: [{ id, name, mode: 'code' }], assignments: { 'code:local_<id>':
grup }, order: { grup: [...] } }`; her grubun kenar çubuğundaki bölümü `dframe-code-sections[...].sections` içinde
(`kind: 'manual'`, tüm oturumlar bölümünden önce). Biçim uygulamanın kendi iç biçimi, belgelenmiş değil.

- Oturumun grubu kendi atamasıdır; yan sohbet (`forkedFromSessionId`) ve oturumun önceki dökümleri
  (`priorCliSessionIds`) seçimde onun grubuna sayılır ama karşıda gruba atanmaz (kaynakta da atanmamışlardır).
- Pakete yalnızca kendi atamasıyla gruptaki oturumun `meta.group`'u (`id`, `name`) girer; ayar dosyasının geri kalanı
  okunmaz, pakete girmez.
- Karşıda grup önce kimliğiyle, yoksa adıyla aranır, ikisi de yoksa bölümüyle eklenir. O cihazda zaten bir gruptaki
  oturum yerinde kalır; dosyanın geri kalanına dokunulmaz, girintisi korunur.
- Uygulama açıkken ayarlarını bellekte tutup dosyanın üstüne yazdığı için dosya yalnızca uygulama kapalıyken yazılır:
  macOS'ta `ps` ile `Claude.app/Contents/MacOS/Claude`, Windows'ta PowerShell ile yolu `AnthropicClaude` ya da
  `WindowsApps` içeren `claude.exe` aranır (Claude Code'un kendi `claude.exe`'si sayılmaz); anlaşılamazsa yazılmaz.
  Yazmadan önce dosyanın kopyası `~/.claude-memory-sync/claude-desktop/` altına alınır (son 10'u kalır).
- Uygulama açıksa sohbetler yine gelir, grup kurulmaz; paket uygulama kapalıyken yeniden açılınca sohbetler `same`
  olur ve yalnızca gruplar kurulur (işlem öncesi yedek alınmaz, ayar dosyasının kopyası yeter).
- Yedek içeriğinde `chatGroups`: o grupların bütün sohbetleri, gruba sonradan girenler dahil.
- Sohbetler yedeklere yalnızca Yedek içeriği'nde seçilince girer; işlem öncesi yedek de aynı seçimi tutar (stage klasörü
  ikisinde aynı kalsın diye). Geri al sohbetlere dokunmaz (hiçbiri kısaltılarak üzerine yazılmaz) ve alınanları
  kaldırmaz.

Sohbet içeren paket v3 biçimindedir: `MEMSYNC3`, her dosya için ayrı gzip parçası, gzip'li JSON başlık (v2'deki her
şey ve `chats.blobs`: parça, konum, uzunluk, boyut, sha256), 4 baytlık başlık uzunluğu ve yine `MEMSYNC3`. Başlık
dosyanın sonundan okunur; parçalar yalnızca yazılırken okunur ve sha256 ile doğrulanır (sohbetler toplamda yüzlerce MB
olabilir, tek JSON'a sığmaz). Sohbetsiz paketler v2 kalır; v3'ü 2.4'ten eski sürümler açamaz.

v4, tam yedeğin önceki yedekleri de parça olarak tuttuğu aynı biçimdir: her yedek dosyası yeniden sıkıştırılmadan,
16 MB'lık dilimlerle kopyalanır (`full.files[...]`: `raw: true`, konum, boyut, sha256). Sohbetli yedekler yüzlerce MB
olabildiğinden ne başlığa sığar ne de belleğe bir kerede alınır. v4'ü 2.4 açamaz; tam yedek, onu alan sürümle ya da
daha yenisiyle geri yüklenir.

## Kayıpsızlık

- Uygulamadan önce o anki durum tekrar okunur; plan hazırlandıktan sonra değişen dosya varsa işlem durur.
- Her yazmadan önce cihazın bütün hafızalarının, workspace dosyalarının ve Claude ayarlarının şifreli bir anlık görüntüsü
  alınır (aşağıda "Yedekler"); alınamazsa hiçbir şey yazılmaz. Anlık görüntü alınırken bir dosya değişirse işlem durur.
- Dosyalar önce geçici dosyaya yazılıp tek adımda yerine konur.
- Bir dosyada hata olursa o ana kadar yapılanlar eski hâline döndürülür.
- İşlem sonunda her dosya tekrar okunup doğrulanır; geçmiş ancak bundan sonra güncellenir.
- Her aktarım "Geçmiş"te kalır; "Geri al" yalnızca o aktarımın değiştirdiği dosyaları eski hâline getirir.
- Satır sonu (CRLF/LF) ve BOM farkı değişiklik sayılmaz.
- Boşalmış görünen hafıza klasörü pakete konmaz (karşıda toplu silmeye dönüşmesin).
- Windows'ta geçersiz dosya adları ve yalnızca büyük/küçük harfle ayrılan adlar işlem başlamadan engellenir.

## Yedekler

3.0'dan önce yedekler `.memsync` dosyalarıydı (günlük, işlem öncesi, elle). Artık bu cihazın bütün yedekleri tek bir
şifreli yedek klasöründe, Folder Backup'la ortak motorun (`core/`) bir yedek setinde durur: Claude seti. Eski `.memsync`
yedekleri kullanılmaz; uygulama klasöründe duruyorlarsa Yedekler ekranı nerede olduklarını ve boyutlarını söyler,
silmek kullanıcıya kalır. Paketler ve tam yedek `.memsync` dosyası olarak kalır.

| Tür | Ne zaman | Yer | Saklama |
|---|---|---|---|
| Takvimli | Takvime göre (saatte bir, her gün, her hafta ya da yalnızca elle); kaçırılan, açılışta ya da uyanınca | Yedek klasörü | Son 24 saatin hepsi, 30 gün günde bir, sonra haftada bir |
| Elle | "Şimdi yedek al" (pencere, tepsi, Folder Backup) | Yedek klasörü | Takvimlilerle aynı kural |
| İşlem öncesi | Her aktarım, geri yükleme, geri alma, workspace düzeltmesi ve tam geri yüklemeden önce | Yedek klasörü | En yeni 50'si (ayarlanır) |
| Paket | "Paket oluştur" | Seçilen klasör (varsayılan Masaüstü) | Silinmez |
| Tam yedek | "Tam yedek al" (sıfırlama öncesi) | Seçilen klasör (varsayılan Masaüstü) | Silinmez |

### Claude seti (`lib/backups.js`)

- **Kurulum.** Bir yer ve bir şifre seçilir; yedek klasörü `<yer>/Claude Memory Sync/Claude` olur. Kurtarma kodu bir kez
  gösterilir (kopyala, dosyaya kaydet); onaylanmadan pencere kapanmaz. Şifre sistemin anahtar zincirinde şifreli saklanır
  (Electron `safeStorage`). Kurulmadan hiçbir şey yazılmaz: aktarım, geri yükleme ve geri alma önce yedek ister. Yeni
  kurulumda ve 3.0'a geçen kurulumda bir kez sorulur (`config.json` → `askBackups`).
- **Var olan yedeği aç.** Sıfırlamadan sonra ya da başka bir bilgisayarda yedek klasörü şifresiyle veya kurtarma koduyla
  açılır (kodla açılınca yeni şifre konur). Anlık görüntüler olduğu gibi kalır, bu bilgisayarınkiler içine devam eder.
  Başka uygulamanın (Folder Backup'ın) yedek klasörü açılmaz (`OTHER_APP`).
- **Şifreli ve artımlı.** restic her şeyi AES-256 ile şifreler; her yedek yalnızca değişen parçaları yazar ama her anlık
  görüntü kendi başına eksiksizdir. Bir sohbet yalnızca ona eklenen kadar yeniden yer kaplar.
- **Etiketler.** Takvimli ve elle alınanlar `claude-memory-sync:backup`, işlem öncesi alınanlar
  `claude-memory-sync:before` ve `claude-memory-sync:reason=<sync|restore|undo|workspace-fix|full-restore>` taşır.
  Time Machine seyreltmesi yalnızca ilkine uygulanır, işlem öncesilerin en yeni 50'si kalır (`keepTagged`).
- **Yedekten sonra** ortak motorun adımları: tanım yedek klasörüne yazılır (değiştiyse), seyreltme, haftada bir
  `prune`, günde bir verinin on ikide birinin geri okunup denetlenmesi. Tamamını denetle ve Onar Yedekler ekranındadır.
- **Takvim** ortak motorun (`core/schedule.js`); kontrol saatin her 5 dakikasında çalışır. Başarısız yedek 30 dakika sonra
  yeniden denenir; disk takılı değilse her kontrolde. Bildirim, hata değişmedikçe bir kez gelir.
- **Tek iş.** Yedek, işlem öncesi anlık görüntü, açma, denetim ve onarım tek tek çalışır; pencerenin ortasında adım ve
  (restic söylediğinde) yüzde, İptal et ile. Durdurulan yedekten hiçbir şey kaydedilmez, öncekiler olduğu gibi kalır.
- **Diskte yer.** Yedekten önce yazılacaklar sayılır; bilgisayarın kendi diskinde 2 GB, başka diskte 100 MB boş kalmazsa
  yedek başlamaz (`NO_SPACE`), yazarken disk dolarsa durur (`DISK_FILLED`).

### Stage klasörü (`lib/stage.js`)

Her yedekten hemen önce motor `~/.claude-memory-sync/Claude` klasörünü o yedeğe girecek olanla günceller; restic bu
klasörü yedekler. İçeriği bir paketin açılmış hâlidir:

| Yol | İçerik |
|---|---|
| `manifest.json` | Paket başlığının söyledikleri (tür, neden, cihaz, konumlar, sürüm geçmişi, sohbetler) ve her dosyanın özeti |
| `memory/<proje>/<dosya>`, `workspace/<kök>/<dosya>`, `claude/<dosya>` | Paketteki anahtarlarıyla dosyalar |
| `chats/<parça>` | Sohbetlerin dosyaları (`p/<id>.jsonl`, `p/<id>/…`, `h/<id>/…`, `u/<id>/…`) |

- Klasör yedekler arasında kalır ve yerinde güncellenir: değişmeyen dosyaya dokunulmaz, restic de onu yeniden okumaz.
- Sohbet dosyaları kopyalanmaz, sohbetin kendi dosyasına sabit bağlantıdır (hard link): yer kaplamaz. Disk izin vermezse
  kopyalanır. Klasördeki hiçbir dosyanın içine yazılmaz; yeni bir dosya yerine geçer ya da dosya silinir, böylece bir
  bağlantı bağlı olduğu sohbeti asla değiştirmez. Sohbet parçalarının özeti yalnızca dosya değiştiyse yeniden alınır.
- İşlem öncesi yedek de aynı klasörü kullanır, içine bütün hafızaları alır ve Yedek içeriği'nin seçtiği sohbetleri tutar;
  iki tür arasında geçerken sohbet bağlantıları silinip yeniden kurulmaz.
- **Geri okuma.** Bir anlık görüntü uygulama klasöründe `restored/` altına geri yüklenir ve paket gibi okunur
  (`readStage`): her dosya özetiyle denetlenir, sohbet parçaları kullanıldıklarında. `snapshot:<id>` adıyla açılır;
  `prepare`, Yedek içeriği ve geri yükleme ekranı onu bir dosya yolu gibi kullanır. Son açılan iki tanesi tutulur,
  uygulama açılırken eskiler silinir. Geri alma yalnızca hafıza, workspace ve Claude dosyalarını geri yükler.
- Başka bir cihazın aynı yedek klasörüne aldığı anlık görüntüler de listelenir ve paket gibi aktarılır.

### Paket ve tam yedek yazma

Paket oluşturma ve tam yedek ayrı bir süreçte (`app/backup-worker.js`, `utilityProcess`) yazılır; pencere ve ana süreç
dosyanın boyutundan etkilenmez. Üç adımdır: `exportJob`/`fullBackupJob` nereye ne yazılacağını söyler, `runBackupJob`
yalnızca dosyayı yazar, `finishBackupJob` kaydeder.

- Dosya önce geçici adla yazılır, baştan sona okunup doğrulanır, adını en son alır. İptal süreci öldürür,
  `discardBackupJob` geçici dosyayı siler; önceden var olan hiçbir şey değişmez.
- Yazmadan önce dosyanın boyutu tahmin edilir (sohbetler örneklerin sıkışma oranıyla); diskte bir pay boş kalacak şekilde
  sığmıyorsa hiçbir şey yazılmaz (`NO_SPACE`): bilgisayarın kendi diskinde 2 GB, başka diskte 100 MB.
- Yazıldıktan sonraki kontrol geçmezse dosya hiç oluşmaz (`BUNDLE_WRITE_CHECK`).
- macOS'un exFAT disklerde koyduğu gizli `._ad.memsync` dosyaları paket sayılmaz.
- Büyük sohbet dosyaları 16 MB'lık parçalarla okunur ve sıkıştırılır (arka arkaya gzip üyeleri, `members`).

## Yedek içeriği

Ayarlar → Yedek içeriği (Yedekler sayfasında da, Folder Backup'tan da): takvimli ve elle alınan yedeklere ne gireceği.
`config.json` → `backup`:

| Alan | Anlamı |
|---|---|
| `excludeProjects` | Hafızası girmeyen projeler (anahtar) |
| `excludeRoots`, `excludeWorkspaceFiles` | Girmeyen tarama klasörleri; bir klasörün girmeyen workspace dosyaları |
| `claude` | Claude ayarları girsin mi (varsayılan evet) |
| `chats` | `none` (varsayılan), `all` (bütün sohbetler, yeniler dahil) ya da `some` |
| `chatProjects`, `chatGroups`, `chatIds` | `some`: bütün sohbetleri giren projeler ve masaüstü uygulaması grupları (yeniler dahil) ve tek tek seçilen sohbetler |

- Hafızalar ve workspace dosyaları adla dışarıda bırakılır; yeni projeler ve dosyalar kendiliğinden girer.
- Dışarıda bırakılan workspace dosyaları yedekteki konumda `skipped` diye yazılır; o yedeğe dönünce dokunulmaz.
  Dışarıda bırakılan projenin konumu yedekte yoktur; yedeğe dönünce o projeye de dokunulmaz.
- İşlem öncesi yedek bu ayara bakmaz: geri alma ve hata durumunda geri dönüş, işlemin dokunabileceği her dosyanın
  yedeğine dayanır.
- Değişiklik restic'in kendisi tarafından bulunur (boyut, değişme zamanı, inode); değişmeyen dosya okunmaz.

## Tam yedek

Bilgisayar sıfırlanmadan önce alınır; geri yüklenince uygulama hiç sıfırlanmamış gibi kaldığı yerden devam eder.

- İçerik: normal bir yedeğin her şeyi (bütün hafızalar, workspace dosyaları, Claude ayarları ve sürüm geçmişi), bütün
  sohbetler ve paketin `full` bölümünde uygulamanın kendi dosyaları: `state/config.json`, `history.json`, `state.json`,
  `activity.jsonl` ve yedeklerin nerede olduğu (`sets.json`). Şifreler (`secrets.json`, yalnızca bu bilgisayar
  çözebilir) ve Folder Backup'a söylenenler (`peer.json`) girmez. Yedek klasörü ayrıdır: sıfırlamadan sonra Var olan
  yedeği aç ile şifresiyle yeniden açılır. 3.0'dan önceki tam yedeklerin içindeki eski yedekler geri yüklenmez.
- Geri yükleme eşleştirme kullanmaz: her dosya eski yerine yazılır. Hafızalar
  `~/.claude/projects/<klasör adı>/memory` altına (proje klasörü henüz yoksa da), workspace dosyaları eski klasörlerine
  (yalnızca ev klasörü içinde ve yalnızca `.code-workspace`), Claude ayarları Claude klasörüne.
- Ev klasörü farklıysa (başka kullanıcı adı) yollar ve Claude'un klasör adları yeni ev klasörüne çevrilir:
  - hafıza ve sohbet klasörleri, uygulamanın ayarları, eşleştirmeleri ve işlem kayıtları,
  - sohbetlerin istemleri ve masaüstü kayıtları,
  - workspace dosyalarında tam yolla yazılmış klasörler; yalnızca bütün klasör adı eşleşince, yani `/Users/eski2`
    `/Users/eski` sayılmaz.

  Sohbetlerin içindeki yazışmada eski yollar kalır; Claude Code sohbeti yeni klasöründen bulur. Bir projenin klasörü
  diskte henüz yoksa uygulamanın kayıtlı yolu geçerlidir. Sohbet dosyasındaki yol, Claude klasörünün adına uymuyorsa
  sohbetin eskiden çalıştığı yerdir ve en sona kalır.
- Başka işletim sisteminde alınmış tam yedek olduğu gibi geri yüklenmez (`FULL_PLATFORM`): yollar ve ayarlar o sistemin.
  Paket aktar ekranı bunun yerine "Paket olarak aktar" sunar. Tam yedek, normal bir paketin içerdiği her şeyi taşıdığı
  için (hafızalar, workspace dosyaları, Claude ayarları, sürüm geçmişi, sohbetler) olağan aktarım adımlarından geçer:
  eşleştirme, iki yönlü birleştirme ve onay. `full` bölümü (uygulamanın ayarları, işlem kayıtları, eski yedekler) bu
  yolda kullanılmaz; o, diğer sistemin verisidir.
- Ayarlar (cihaz kimliği ve adı dahil) ve eşleştirmeler yedektekiyle değişir; sürüm geçmişi ve işlem kayıtları iki
  taraftan birleştirilir; `sets.json` yalnızca bu bilgisayarda yoksa yazılır.
- Önce her zamanki gibi cihazın işlem öncesi yedeği alınır; dosyalar geçici dosya üzerinden yazılır, hata olursa geri
  alınır, sonra geri okunup doğrulanır. Tam geri yükleme Geçmiş'ten geri alınamaz; dönmek için işlem öncesi yedek
  kullanılır.
- Eski sürümler tam yedeği normal bir yedek gibi okur (`full` bölümünü görmez).

## İzinler ve gizlilik

- Uygulama ağ isteği yapmaz; hesap, analiz ya da kullanım verisi yoktur. Veriler cihazdan yalnızca kullanıcının
  kendi taşıdığı paket ve yedeklerle çıkar. Bu, ilk açılış ekranında ve Ayarlar → Gizlilik ve izinler'de yazar.
- macOS, Masaüstü, Belgeler ve İndirilenler ilk okunduğunda izin sorar. Derlemeler ad hoc imzalı olduğundan her yeni
  derleme macOS için yeni bir uygulamadır; izinler her güncellemede yeniden sorulur.
- İlk açılış ekranı bu sorulardan önce gelir: ana süreç açıklama görülene kadar (`ready`) bu klasörlere dokunmaz.
  Ayarlar yalnızca `config.json`'dan okunur (`introStatus`; ilk açılışta proje klasörü tahmini yapılmaz), yedek
  takvimi ve Folder Backup köprüsü başlamaz, pencereden gelen motor çağrıları reddedilir, girişte gizli açılış yerine pencere gösterilir.
  "Devam" ile klasörler sırayla okunur ve macOS her biri için sorar (`completeIntro`); `introSeen` o derlemenin
  anahtarı olur (sürüm ve çalıştırılabilir dosyanın tarihi; macOS dışında bir kez gösterilir).
- İzin verilmeyen klasör: oradaki workspace dosyaları ve paketler görünmez, oradaki projelerin git bilgisi okunamaz,
  aktarımda kendiliğinden eşleşmez. `~/.claude` ve `~/.claude-memory-sync` izin istemez; hafızalar, sohbetler, Claude
  ayarları ve yedekler etkilenmez. Ayarlar'da her klasörün durumu ve Sistem Ayarları'na kısayol var.

## Durum dosyaları (`~/.claude-memory-sync`)

| Dosya | İçerik |
|---|---|
| `config.json` | Cihaz adı, tarama klasörleri, yedek içeriği, yedekleri kurma sorusu, dışarıda bırakılan projeler, arayüz dili, tema (sistem/açık/koyu), ilk açılış ekranının gösterildiği derleme |
| `history.json` | Anahtar → görülen hash'ler |
| `state.json` | Proje/kök anahtarları, onaylı eşleştirmeler, çözülmüş proje yolları |
| `activity.jsonl` | İşlem geçmişi (geri alma için öncesinde alınan anlık görüntüyle) |
| `sets.json`, `secrets.json` | Claude seti (yedek klasörü, takvim, saklama, durum) ve şifresi, sistemin şifrelediği hâliyle (ortak motorun dosyaları) |
| `Claude/` | Stage klasörü: her yedekten önce doldurulur (yukarıda) |
| `cache/`, `restored/` | restic'in önbelleği; okumak için geri yüklenen anlık görüntüler |
| `peer.json`, `requests/`, `responses/` | Folder Backup'a söylenenler ve ondan gelen istekler (aşağıda) |
| `backups/` | 3.0'dan önceki `.memsync` yedekleri, varsa; kullanılmaz |

## Folder Backup ile birlikte

İki uygulama aynı bilgisayardaysa birbirini görür (`core/peers.js`, ayrıntısı Folder Backup'ın tasarımında). Claude
setinin sahibi bu uygulamadır: takvimini, yedeğini ve değişikliğini yalnızca o yapar.

- Bu uygulama çalışırken `peer.json` yazar: çalıştığını (30 saniyede bir), o an yaptığı işi, setin durumunu, sonraki
  yedeği ve yedeğe girenlerin özetini.
- Folder Backup'ın istekleri `requests/` klasöründen işlenir: şimdi yedekle, denetle (bir kısmını), takvimi ve işlem
  öncesi yedek sayısını değiştir, yedeğe girenleri ver ve değiştir (projeler, workspace klasörleri, Claude ayarları,
  sohbetler: hiçbiri ya da tümü; tek tek seçilen sohbetler burada değişir), pencereyi Yedekler'de aç. Bu bilgisayarda
  o an olmayan projelerin dışarıda bırakılması korunur.
- Yedekler ekranında Folder Backup'ın setleri listelenir: durum, takvim, son yedek; Şimdi yedekle ve Folder Backup'ı aç
  ondan istenir. Çalışmıyorsa önce başlatılır.

## v1'den geçiş

- `config.json` v1 ise (`reposRoot`, `prefix`) v2'ye çevrilir; eski dosyalar `*.v1.json` olarak saklanır. Yedekleri
  kurma sorusu yeni kurulumdaki gibi sorulur.
- `history.json` içindeki `workspace/<dosya>` anahtarları `workspace/<kök>/<dosya>` olur.
- v1 paketleri okunur; repo adları proje anahtarı, workspace dosyaları birincil tarama klasörü kabul edilir.
- v1 CLI, v2 paketlerini okuyamaz; iki cihaz da güncellenmelidir.

## 3.0: yedekler ortak motorda

- Günlük, elle ve işlem öncesi `.memsync` yedekleri, yedek klasörünü değiştirme ve taşıma, eski yedek klasörleri ve
  başka kurulumların yedeklerini devralma kaldırıldı. Ayarlardaki karşılıkları (`backupDir`, `formerBackupDirs`,
  `earlierDeviceIds`, `daily`, `keepBefore`, `keepManual`) okunurken silinir.
- Eski yedekler diskte olduğu gibi kalır ve paket olarak açılabilir; uygulama onları yedek saymaz.
- Geçmiş'teki eski kayıtlar görünür; eski bir işlem, öncesinde bir anlık görüntü olmadığı için geri alınamaz.

## Sonraya kalanlar

- Proje klasöründeki `CLAUDE.md` (git dışı projeler için).
- Ortak bulut klasörüyle (iCloud, OneDrive) paketlerin kendiliğinden gelip gitmesi.
- İmzalı dağıtım (Apple notarization, Windows code signing) ve otomatik güncelleme; imzalı sürümlerde macOS klasör
  izinlerini güncellemeden güncellemeye hatırlar.
- Yedek klasörünü başka bir diske taşımak, ve ortak motorun ikinci kopyasını (Folder Backup'taki gibi) bu uygulamanın
  penceresine almak.
- Masaüstü uygulamasının grupları ilk sürümde yalnızca eklenir; grubu adı değişmiş ya da silinmiş oturumlar karşıda
  eski hâliyle kalır. Grup kurulmadıysa (uygulama açıktı) bunu sonradan kendiliğinden yeniden denemek.
