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
6. Arka planda çalışıp günlük otomatik yedek (kullanıcı açarsa); bilgisayar açılınca başlama.
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

Günlük ve elle alınan yedek, Yedek içeriği'nde bırakılanları içerir (aşağıda). İşlem öncesi yedek her zaman bütün
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
- Sohbetler işlem öncesi yedeklere hiç girmez (hiçbiri kısaltılarak üzerine yazılmadığı için); günlük ve elle alınan
  yedeklere yalnızca Yedek içeriği'nde seçilince girer. Geri al, alınan sohbetleri kaldırmaz.

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
- Her yazmadan önce cihazın tam yedeği alınır ve geri okunarak doğrulanır.
- Dosyalar önce geçici dosyaya yazılıp tek adımda yerine konur.
- Bir dosyada hata olursa o ana kadar yapılanlar eski hâline döndürülür.
- İşlem sonunda her dosya tekrar okunup doğrulanır; geçmiş ancak bundan sonra güncellenir.
- Her aktarım "Geçmiş"te kalır; "Geri al" yalnızca o aktarımın değiştirdiği dosyaları eski hâline getirir.
- Satır sonu (CRLF/LF) ve BOM farkı değişiklik sayılmaz.
- Boşalmış görünen hafıza klasörü pakete konmaz (karşıda toplu silmeye dönüşmesin).
- Windows'ta geçersiz dosya adları ve yalnızca büyük/küçük harfle ayrılan adlar işlem başlamadan engellenir.

## Yedekler

| Tür | Ne zaman | Yer | Saklama |
|---|---|---|---|
| Günlük | Otomatik yedek açıksa ayarlanan saatte (5 dakikalık adımlar; kontrol saatin her 5 dakikasında); kaçırılırsa açılışta ya da uyanınca | `backups/daily` | Ayardaki sayı, varsayılan 30 (değişiklik yoksa yeni dosya yazılmaz, Geçmiş'e "değişiklik yok" düşer) |
| İşlem öncesi | Her aktarım, geri yükleme, geri alma, workspace düzeltmesi öncesi | `backups/before` | Ayardaki sayı, varsayılan 50 |
| Elle | "Şimdi yedek al" | `backups/manual` | Ayardaki sayı; varsayılan 0, hiçbiri silinmez |
| Paket | "Paket oluştur" | Seçilen klasör (varsayılan Masaüstü) | Silinmez |
| Tam yedek | "Tam yedek al" (sıfırlama öncesi) | Seçilen klasör (varsayılan Masaüstü) | Silinmez |

Kütüphane; yedek klasörünü, eski yedek klasörlerini, Masaüstünü, İndirilenler'i ve eklenen klasörleri tarar, her
`.memsync` dosyasının cihazını, tarihini, türünü ve içeriğini gösterir. Başka cihazdan gelip henüz aktarılmamış
paketler ana sayfada önerilir.

Saklama sayısı yalnızca bu cihazın yedeklerini sayar ve siler; klasör başka cihazla ortak olabilir. Okunamayan dosya
sayılmaz, silinmez.

### Yedek alma süreci

Elle, tepsiden, günlük ve tam yedek ile paket oluşturma ayrı bir süreçte (`app/backup-worker.js`, `utilityProcess`) çalışır;
pencere ve ana süreç dosyanın boyutundan etkilenmez. Üç adımdır: `backupJob` nereye ne yazılacağını söyler, `runBackupJob` yalnızca dosyayı yazar,
`finishBackupJob` kaydeder (geçmiş, son günlük yedek, eskileri silme). Aktarım öncesi yedek hâlâ ana süreçte.

- Süreç çalışırken pencerenin ortasında durum, yüzde ve İptal et görünür; arkası tıklama ve tuş almaz (`inert`), yazma
  işlemleri reddedilir (`BUSY`).
- Dosya önce geçici adla yazılır, baştan sona okunup doğrulanır, adını en son alır. İptal süreci öldürür, `discardBackupJob`
  geçici dosyayı siler; kayıt ve eski yedekleri silme henüz yapılmadığı için önceden var olan hiçbir şey değişmez.
- Her yazmadan önce (elle, günlük, işlem öncesi, tam yedek, paket) dosyanın boyutu tahmin edilir: önceki yedekler olduğu
  gibi, sohbetler her birinden üç örneğin sıkışma oranıyla, diğer dosyalar en fazla üçte bir büyümüş olarak sayılır.
  Dosya, diskte bir pay boş kalacak şekilde sığmıyorsa hiçbir şey yazılmaz (`NO_SPACE`): bilgisayarın kendi diskinde
  (ev klasörünün diski) 2 GB, başka diskte 100 MB. Tam yedek penceresi tahmini boyutu ve seçilen yerdeki boş alanı
  gösterir, sığmıyorsa oluşturmaya izin vermez; süreç penceresi de tahmini boyutu yazar.
- Yazıldıktan sonraki kontrol geçmezse dosya hiç oluşmaz; hata bir paketin bozuk olduğunu değil, bu yazmanın kontrolden
  geçemediğini söyler (`BUNDLE_WRITE_CHECK`, ayrıntısıyla).
- macOS'un exFAT gibi disklerde dosyaların yanına koyduğu gizli `._ad.memsync` dosyaları yedek sayılmaz: listelenmez, taşınmaz,
  tam yedeğe girmez, silinmez. Elle adı değiştirilmiş yedek, tam yedeğe adında izin verilmeyen karakterler `-` olarak girer.
- İptal edilen günlük yedek bir sonraki saatinde alınır (`dailySkippedAt`). Uygulama kapanırken kalan geçici dosyalar listelerde
  görünmez, bir günden eskisi sonraki yedekte silinir.
- Büyük sohbet dosyaları 16 MB'lık parçalarla okunur ve sıkıştırılır (arka arkaya gzip üyeleri, `members`); dosya boyutu
  belleğe bağlı değildir. Eski sürümler bu dosyayı tek gzip olarak okur.

## Otomatik yedek

Günlük yedek kendiliğinden açılmaz, kullanıcı açarsa çalışır. Kapatmak hiçbir şeyi silmez. İşlem öncesi ve elle alınan
yedekler bundan etkilenmez.

- Yeni kurulum kapalı gelir ve bir kez sorar. `config.json` → `daily`: `enabled`, `time`, `keep`, `ask`; `ask` sorunun
  cevap beklediğini gösterir. Cevap beklerken yedek alınmaz.
- Soru açıklama ekranından sonra pencerenin üstünde gelir, saat de orada seçilir. Kapatılacak yeri yoktur: uygulama
  cevaplanmadan kapatılırsa sonraki açılışta yine gelir. macOS'ta her yeni derlemede gelen açıklama ekranı soruyu
  tekrarlamaz.
- Sorulan ayar dosyası: `daily.enabled` değeri true ya da false olmayan (yeni kurulum, v1 ayarları). Değeri olan dosya
  olduğu gibi kalır ve sorulmaz. Önceki sürümler günlük yedeği açık olarak yazıyordu; güncelleme var olan kurulumun
  yedeklerini sessizce durdurmaz. Tam yedekten dönen ayarlar da aynı kurala uyar.
- Düğmeler: Genel Bakış, Ayarlar → Otomatik yedek, menü çubuğu / sistem tepsisi menüsü. Biri değişince diğerleri
  güncellenir. `updateSettings`, `daily.enabled` gördüğünde `ask`'ı kapatır: nereden değiştirilirse değiştirilsin soruya
  cevap sayılır.
- Açılınca kaçırılmış yedek kuralı geçerlidir: hiç yedek alınmadıysa ya da son yedek son saatten eskiyse sonraki
  kontrolde (en çok 5 dakika) alınır, sonra her gün o saatte. O günün yedeği alınmışsa saatini bekler.

## Yedek klasörünü değiştirme

Klasör bazlı bir yedekleme programı gibi çalışır: yeni klasör seçilince önce incelenir, sorulacak bir şey varsa sorulur,
yedekler taşınabilir. Klasör yalnızca bu yoldan değişir (`updateSettings` artık `backupDir` almaz).

| Adım | Çekirdek | Ne yapar |
|---|---|---|
| 1 | `reviewBackupFolder` | Klasöre yazılabildiğini dener; taşınabilecek yedekleri, yeni klasörde bulunanları ve gereken/boş yeri çıkarır |
| 2 | `inspectBackup` | Bulunan her dosyayı baştan sona okur, her parçayı hash'iyle karşılaştırır |
| 3 | `backupFolderFindings` | Bulunanların özeti ve seçimlere göre saklama sınırı uyarısı |
| 4 | `applyBackupFolder` | Klasörü değiştirir, bulunanları geçmişe ekler, taşınacakları sıraya koyar |
| 5 | `moveNextBackup` | Tek dosya taşır; sıra bitene kadar çağrılır, pencere ilerlemeyi gösterir ve durdurabilir |

Her çağrı tek dosyayla uğraştığından ve kopya ana süreci tutmadığından pencere donmaz (ölçüm: bu Mac, 02.11.2026, disk
imajına 136 MB, en uzun takılma 28 ms; 324 MB'lık sohbetli yedeğin baştan sona okunması 2 sn).

Taşınacak ya da sorulacak bir şey yoksa pencere açılmaz, klasör değişir. Seçilen klasör zaten yedek klasörüyse (bağlantılı
klasör ya da başka yazılışı da aynı sayılır) değişiklik olmaz, yalnızca içindekiler incelenir.

### Taşıma

- Kaynak: yedek klasörü, varsayılan klasör ve `formerBackupDirs` altındaki bu cihaza ait bütün `.memsync` dosyaları
  (iki seviyeye kadar). Başka cihazların yedekleri ve okunamayan dosyalar yerinde kalır; kaç tane olduğu yazar.
- Dosya her an iki yerden birindedir: aynı diskte `rename`; başka diskte hedefin yanına kopya, `fsync`, iki tarafın sha256
  karşılaştırması, `rename`, klasör `fsync`, ancak sonra kaynağın silinmesi. Değişme zamanı korunur.
- Hedefte aynı ad ve aynı içerik varsa (aynı dosya değilse) kaynak silinir; aynı ad ve başka içerik varsa üzerine yazılmaz,
  `-2` ile yanına konur. Bağlantılı klasör yüzünden iki yol tek dosyaysa dokunulmaz.
- Taşınan her dosyanın ardından `activity.jsonl` (`path`, `backupPath`, `bundle.path`) ve son günlük yedeğin yolu
  güncellenir; Geri al ve günlük değişiklik kontrolü yedeği yeni yerinde bulur.
- Taşınamayan dosya diğerlerini bekletmez: kalanlar taşınır, sonunda liste gösterilir, "Tekrar dene" yalnızca onları dener.
- Yarıda durursa (durdurma, hata, uygulamanın kapanması) düzen bozulmaz: taşınan yeni klasörde, kalan eskisinde ve
  listede. Boşalan `daily`, `before`, `manual` klasörleri silinir, seçilen klasörün kendisi kalır.
- Yer yetmiyorsa taşıma seçilemez, klasör yine değiştirilebilir. Yer yalnızca başka diske gidecek dosyalar için hesaplanır.
- Yedek klasörü, taşınan bir klasörün içinde olamaz (`BACKUP_DIR_INSIDE`); üst klasörü olabilir. Varsayılan klasöre dönüş
  her zaman serbest.
- Seçilmiş klasör yoksa (disk takılı değil) yedek alınmaz (`BACKUP_DIR_MISSING`) ve klasör yeniden oluşturulmaz: disk sıradan
  bir klasöre bağlanıyorsa yedekler bilgisayarın kendi diskine yazılırdı. Günlük yedek her kontrolde yeniden dener, disk
  gelince alınır; bildirim hata değişmedikçe bir kez gösterilir.

### Eski klasörler

Taşınmayan yedekler eski yerinde kalır, listede görünür ve geri yüklenebilir. Eski klasör `formerBackupDirs`'e yazılır;
içinde `.memsync` kalmayınca listeden düşer, ulaşılamıyorsa (takılı olmayan disk) kalır. Bu cihazın başka klasörde kalan
yedekleri (`backupsElsewhere`) Yedekler sayfasında ve Ayarlar'da "Buraya taşı" ile her zaman taşınabilir. Bu özellikten
önce varsayılan klasörde kalmış yedekler de böyle bulunur. Tam yedek bu klasörlerdeki yedekleri de alır, başka cihazlarınkini
almaz.

### Klasörde bulunanlar

| Bulunan | Durum | Sonuç |
|---|---|---|
| Bu cihazın sağlam yedeği | `mine` | Listeye ve Geçmiş'e girer, yedekleme buradan devam eder |
| Aynı bilgisayarın eski kurulumundan (bilgisayar adı, ev klasörü ve sistem aynı, cihaz kimliği farklı) | `earlier` | Sorulur, işaretli gelir. Onaylanırsa kimliği `earlierDeviceIds`'e girer ve bu cihazın yedeği sayılır |
| Başka cihazın sağlam yedeği | `other` | Listede kalır, aktarılabilir; değiştirilmez, saklama sayısına girmez, silinmez |
| Bozuk, eksik ya da daha yeni sürümden | `damaged` | Yedek sayılmaz, dokunulmaz; sebebi yazar |

"Devam etmek" şu demek:

- Günlük ve elle alınan yedekler Geçmiş'e kendi tarihlerinde, `adopted` işaretiyle girer; aynı yedek iki kez girmez.
- En yeni günlük yedek bilinenden yeniyse `lastDaily` olur: saati geldiğinde yedek alınır, sohbetsiz yedekte içerik
  değişmediyse yeni dosya yazılmaz (parmak izi yedeğin içinden hesaplanır). Sohbetlide parmak izi sohbet dosyalarının
  diskteki zamanını istediğinden hesaplanamaz, sonraki günlük yedek yeni dosya olur.
- Elle taşınmış yedekler: Geçmiş'te artık olmayan bir yolu gösteren kayıtlar aynı adlı yedeğe bağlanır, Geri al çalışır.
- Saklama sayısı bu yedekleri de sayar. Sınırı aşacaksa sonraki yedekte kaç tanesinin silineceği önceden yazar.
- `history.json` değişmez: orası başka cihazlarla neyin paylaşıldığını tutar, yedeğin bulunması paylaşıldığı anlamına
  gelmez. Yedeğe dönünce her zamanki gibi birleşir.

Günlük yedek, son yedek başka klasörde kaldıysa "değişiklik yok" diyerek atlanmaz; yeni klasöre de bir yedek yazılır.

## Yedek içeriği

Ayarlar → Yedek içeriği (Yedekler sayfasında da): günlük ve elle alınan yedeklere ne gireceği. `config.json` →
`backup`:

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
- Günlük yedekte değişiklik kontrolü: dosyaların hash'leri ve sohbet dosyalarının boyutu ile değişme zamanı (her gün
  yüzlerce MB'ı hash'lememek için).
- Ölçüm (bu Mac, 01.11.2026, bütün sohbetler): 42 sohbet 931 MB → yedek 363 MB, 15 sn; değişiklik yoksa günlük
  kontrol 0,2 sn; bu yedeği içeren tam yedek 1,1 GB, 19 sn.

## Tam yedek

Bilgisayar sıfırlanmadan önce alınır; geri yüklenince uygulama hiç sıfırlanmamış gibi kaldığı yerden devam eder.

- İçerik: normal bir yedeğin her şeyi (bütün hafızalar, workspace dosyaları, Claude ayarları ve sürüm geçmişi), bütün
  sohbetler ve paketin `full` bölümünde uygulamanın kendi dosyaları: `state/config.json`, `history.json`, `state.json`,
  `activity.jsonl` (ve v1 kalıntıları) ile `backups/{daily,before,manual}` altındaki bütün yedekler, bayt bayt ve
  sha256 ile doğrulanarak (yedekler v4 parçası olarak, yukarıda).
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
  taraftan birleştirilir; yedekler yedek klasörüne eklenir, aynı adlı farklı yedek yeni adla kaydedilir.
- Önce her zamanki gibi cihazın yedeği alınır; dosyalar geçici dosya üzerinden yazılır, hata olursa geri alınır, sonra
  geri okunup doğrulanır. Tam geri yükleme Geçmiş'ten geri alınamaz; dönmek için işlem öncesi yedek kullanılır.
- Eski sürümler tam yedeği normal bir yedek gibi okur (`full` bölümünü görmez).

## İzinler ve gizlilik

- Uygulama ağ isteği yapmaz; hesap, analiz ya da kullanım verisi yoktur. Veriler cihazdan yalnızca kullanıcının
  kendi taşıdığı paket ve yedeklerle çıkar. Bu, ilk açılış ekranında ve Ayarlar → Gizlilik ve izinler'de yazar.
- macOS, Masaüstü, Belgeler ve İndirilenler ilk okunduğunda izin sorar. Derlemeler ad hoc imzalı olduğundan her yeni
  derleme macOS için yeni bir uygulamadır; izinler her güncellemede yeniden sorulur.
- İlk açılış ekranı bu sorulardan önce gelir: ana süreç açıklama görülene kadar (`ready`) bu klasörlere dokunmaz.
  Ayarlar yalnızca `config.json`'dan okunur (`introStatus`; ilk açılışta proje klasörü tahmini yapılmaz), günlük yedek
  zamanlayıcısı başlamaz, pencereden gelen motor çağrıları reddedilir, girişte gizli açılış yerine pencere gösterilir.
  "Devam" ile klasörler sırayla okunur ve macOS her biri için sorar (`completeIntro`); `introSeen` o derlemenin
  anahtarı olur (sürüm ve çalıştırılabilir dosyanın tarihi; macOS dışında bir kez gösterilir).
- İzin verilmeyen klasör: oradaki workspace dosyaları ve paketler görünmez, oradaki projelerin git bilgisi okunamaz,
  aktarımda kendiliğinden eşleşmez. `~/.claude` ve `~/.claude-memory-sync` izin istemez; hafızalar, sohbetler, Claude
  ayarları ve yedekler etkilenmez. Ayarlar'da her klasörün durumu ve Sistem Ayarları'na kısayol var.

## Durum dosyaları (`~/.claude-memory-sync`)

| Dosya | İçerik |
|---|---|
| `config.json` | Cihaz adı, tarama klasörleri, yedek ayarları ve yedek içeriği, eski yedek klasörleri, devralınan kurulumlar, dışarıda bırakılan projeler, arayüz dili, tema (sistem/açık/koyu), ilk açılış ekranının gösterildiği derleme |
| `history.json` | Anahtar → görülen hash'ler |
| `state.json` | Proje/kök anahtarları, onaylı eşleştirmeler, çözülmüş proje yolları |
| `activity.jsonl` | İşlem geçmişi (geri alma bilgisiyle) |
| `backups/` | Otomatik ve elle alınan yedekler |

## v1'den geçiş

- `config.json` v1 ise (`reposRoot`, `prefix`) v2'ye çevrilir; eski dosyalar `*.v1.json` olarak saklanır. v1'de günlük
  yedek yoktu: otomatik yedek kapalı gelir ve yeni kurulumdaki gibi sorulur.
- `history.json` içindeki `workspace/<dosya>` anahtarları `workspace/<kök>/<dosya>` olur.
- v1 paketleri okunur; repo adları proje anahtarı, workspace dosyaları birincil tarama klasörü kabul edilir.
- v1 CLI, v2 paketlerini okuyamaz; iki cihaz da güncellenmelidir.

## Sonraya kalanlar

- Proje klasöründeki `CLAUDE.md` (git dışı projeler için).
- Ortak bulut klasörüyle (iCloud, OneDrive) paketlerin kendiliğinden gelip gitmesi.
- İmzalı dağıtım (Apple notarization, Windows code signing) ve otomatik güncelleme; imzalı sürümlerde macOS klasör
  izinlerini güncellemeden güncellemeye hatırlar.
- Sohbetli büyük yedekler ana süreçte saniyeler sürer (bütün sohbetlerle 15 sn); bu işleri ayrı iş parçacığına almak.
- Sohbetli günlük yedeklerde değişmeyen sohbetleri yedekler arasında bir kez saklamak (yer kazanmak için).
- Masaüstü uygulamasının grupları ilk sürümde yalnızca eklenir; grubu adı değişmiş ya da silinmiş oturumlar karşıda
  eski hâliyle kalır. Grup kurulmadıysa (uygulama açıktı) bunu sonradan kendiliğinden yeniden denemek.
