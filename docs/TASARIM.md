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
6. Arka planda çalışıp günlük otomatik yedek; bilgisayar açılınca başlama.
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
- CLI ve çekirdeğin hata mesajları İngilizce kalır; arayüz hata kodlarını (`errors.<KOD>`) kendi diline çevirir.
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

- Paket oluştururken sohbetler proje proje seçilir; sohbet seçilince projesinin hafızası da seçilir. Hafızası
  seçilmeyen projenin konumu `memory: false` ile işaretlenir, karşı cihaz o projenin hafızasına dokunmaz.
- Karşıda sohbet, eşleşen projenin Claude klasörüne yazılır; istemlerin ve masaüstü kaydının proje yolu o cihazdaki
  klasöre çevrilir. Masaüstü kaydı yalnızca o cihazdaki uygulamada aynı hesap/kuruluş klasörü varsa ve kayıt yoksa
  yazılır.
- Hiçbir sohbet silinmez ya da kısaltılmaz:

| Durum | Sonuç |
|---|---|
| Bu cihazda yok | Eklenir |
| Bu cihazdaki, gelenin başı (karşıda devam edilmiş) ya da bazı dosyaları eksik | Güncellenir |
| Aynı | Dokunulmaz |
| Bu cihazdaki daha ileride | Dokunulmaz |
| İki cihazda da devam edilmiş | Yeni kimlikle yanına eklenir; kimlik dosyaların içinde de değişir, başlığa gelen cihazın adı eklenir |

- İstemler `oturum|zaman|metin` imzasıyla birleştirilir ve zamana göre sıralanır; var olan satır iki kez yazılmaz.
- Plan hazırlandıktan sonra bu cihazda değişen sohbet varsa (Claude o sırada yazıyor olabilir) işlem durur.
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
| Günlük | Ayarlanan saatte (5 dakikalık adımlar; kontrol saatin her 5 dakikasında); kaçırılırsa açılışta ya da uyanınca | `backups/daily` | Ayardaki sayı, varsayılan 30 (değişiklik yoksa yeni dosya yazılmaz, Geçmiş'e "değişiklik yok" düşer) |
| İşlem öncesi | Her aktarım, geri yükleme, geri alma, workspace düzeltmesi öncesi | `backups/before` | Ayardaki sayı, varsayılan 50 |
| Elle | "Şimdi yedek al" | `backups/manual` | Silinmez |
| Paket | "Paket oluştur" | Seçilen klasör (varsayılan Masaüstü) | Silinmez |
| Tam yedek | "Tam yedek al" (sıfırlama öncesi) | Seçilen klasör (varsayılan Masaüstü) | Silinmez |

Kütüphane; yedek klasörünü, Masaüstünü, İndirilenler'i ve eklenen klasörleri tarar, her `.memsync`
dosyasının cihazını, tarihini, türünü ve içeriğini gösterir. Başka cihazdan gelip henüz aktarılmamış
paketler ana sayfada önerilir.

## Yedek içeriği

Ayarlar → Yedek içeriği (Yedekler sayfasında da): günlük ve elle alınan yedeklere ne gireceği. `config.json` →
`backup`:

| Alan | Anlamı |
|---|---|
| `excludeProjects` | Hafızası girmeyen projeler (anahtar) |
| `excludeRoots`, `excludeWorkspaceFiles` | Girmeyen tarama klasörleri; bir klasörün girmeyen workspace dosyaları |
| `claude` | Claude ayarları girsin mi (varsayılan evet) |
| `chats` | `none` (varsayılan), `all` (bütün sohbetler, yeniler dahil) ya da `some` |
| `chatProjects`, `chatIds` | `some`: bütün sohbetleri giren projeler (yeniler dahil) ve tek tek seçilen sohbetler |

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
- Ev klasörü farklıysa (başka kullanıcı adı) yollar ve Claude'un klasör adları yeni ev klasörüne çevrilir. Başka
  işletim sisteminde alınmış tam yedek geri yüklenmez; sistem değişirken paket kullanılır.
- Ayarlar (cihaz kimliği ve adı dahil) ve eşleştirmeler yedektekiyle değişir; sürüm geçmişi ve işlem kayıtları iki
  taraftan birleştirilir; yedekler yedek klasörüne eklenir, aynı adlı farklı yedek yeni adla kaydedilir.
- Önce her zamanki gibi cihazın yedeği alınır; dosyalar geçici dosya üzerinden yazılır, hata olursa geri alınır, sonra
  geri okunup doğrulanır. Tam geri yükleme Geçmiş'ten geri alınamaz; dönmek için işlem öncesi yedek kullanılır.
- Eski sürümler tam yedeği normal bir yedek gibi okur (`full` bölümünü görmez).

## Durum dosyaları (`~/.claude-memory-sync`)

| Dosya | İçerik |
|---|---|
| `config.json` | Cihaz adı, tarama klasörleri, yedek ayarları, dışarıda bırakılan projeler, arayüz dili, tema (sistem/açık/koyu) |
| `history.json` | Anahtar → görülen hash'ler |
| `state.json` | Proje/kök anahtarları, onaylı eşleştirmeler, çözülmüş proje yolları |
| `activity.jsonl` | İşlem geçmişi (geri alma bilgisiyle) |
| `backups/` | Otomatik ve elle alınan yedekler |

## v1'den geçiş

- `config.json` v1 ise (`reposRoot`, `prefix`) v2'ye çevrilir; eski dosyalar `*.v1.json` olarak saklanır.
- `history.json` içindeki `workspace/<dosya>` anahtarları `workspace/<kök>/<dosya>` olur.
- v1 paketleri okunur; repo adları proje anahtarı, workspace dosyaları birincil tarama klasörü kabul edilir.
- v1 CLI, v2 paketlerini okuyamaz; iki cihaz da güncellenmelidir.

## Sonraya kalanlar

- Proje klasöründeki `CLAUDE.md` (git dışı projeler için).
- Ortak bulut klasörüyle (iCloud, OneDrive) paketlerin kendiliğinden gelip gitmesi.
- İmzalı dağıtım (Apple notarization, Windows code signing) ve otomatik güncelleme.
- Sohbetli büyük yedekler ana süreçte saniyeler sürer (bütün sohbetlerle 15 sn); bu işleri ayrı iş parçacığına almak.
- Sohbetli günlük yedeklerde değişmeyen sohbetleri yedekler arasında bir kez saklamak (yer kazanmak için).
