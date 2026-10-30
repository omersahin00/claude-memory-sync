# Claude Memory Sync 2 — Tasarım

## Amaç

Claude Code hafızalarını, VSCode workspace dosyalarını ve Claude genel ayarlarını macOS ve Windows
arasında kayıpsız taşımak, iki yönlü eşitlemek ve düzenli yedeklemek. Kendi penceresi ve menü
çubuğu / tepsi simgesi olan bir Electron uygulaması; komut satırı (`node cli.js`) da kalır.

## Gereksinimler

1. Mac ve Windows'ta çalışan, kendi arayüzü olan uygulama.
2. Generic: "sasa" öneki şartı yok; cihazdaki tüm Claude projeleri görünür, istenen seçilir.
3. Yedek alma, paket oluşturma, aktarma, geri yükleme, geri alma.
4. Önceki yedekleri ve paketleri kendiliğinden bulup listeleme.
5. Portatif kullanım: `.memsync` dosyası verilir, içindeki her şey aktarılır (çift tıklama, sürükle-bırak).
6. Arka planda çalışıp günlük otomatik yedek; bilgisayar açılınca başlama.
7. Workspace (`.code-workspace`) dosyalarına tam destek.
8. Sade arayüz; neyin nereden alındığı, nereye yazılacağı her adımda görünür.
9. Tekrar aktarımda versiyon kontrolü: yeni, değişen, silinen, çakışan her dosya ayrı gösterilir ve onaylanır.
10. Her aktarımdan, geri yüklemeden ve geri almadan önce, daha önce yedek alınmış olsa bile yeni yedek.

## Mimari

| Katman | Yer | Görev |
|---|---|---|
| Çekirdek | `lib/` | Bağımlılıksız Node kodu. `engine.js` tek giriş noktası; CLI ve uygulama aynı çekirdeği kullanır. |
| Ana süreç | `app/main.js` | Pencere, IPC, tepsi simgesi, zamanlayıcı, dosya ilişkilendirme. |
| Köprü | `app/preload.js` | Arayüze yalnızca izin verilen çekirdek fonksiyonlarını açar (contextIsolation, sandbox). |
| Arayüz | `app/renderer/` | React + Vite. İnternete çıkmaz, dış kaynak yüklemez. |
| CLI | `cli.js` | `status`, `backup`, `export`, `sync`, `restore`. |

## Ne yedekleniyor

| Kategori | Kaynak | Paketteki anahtar |
|---|---|---|
| Proje hafızaları | `~/.claude/projects/<kodlanmış yol>/memory/**` | `memory/<proje>/<dosya>` |
| Workspace dosyaları | Tarama klasörleri altındaki `*.code-workspace` (en fazla 3 seviye, git repolarının içi hariç) | `workspace/<kök>/<dosya>` |
| Claude ayarları | `~/.claude/CLAUDE.md`, `agents/`, `commands/`, `skills/` (`skills/synced` hariç), `output-styles/` | `claude/<dosya>` |

Yedek her zaman her şeyi içerir. Paket (başka cihaza götürülecek dosya) seçilenleri içerir.
Claude uygulamasının geçici çalışma alanları (`scratch-workspaces`) yedeğe girer, pakette varsayılan olarak yoktur.

## Proje kimliği ve eşleştirme

Claude proje klasörünün adı mutlak yoldan türetilir; cihazdan cihaza değişir. Bu yüzden her projeye
klasör adından türetilen bir anahtar verilir (`sasa-custom-frontend`, `desktop`). Anahtar cihazda kalıcıdır.

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
| `MEMORY.md` | Birleştirme | Satır satır birleştirilir; aynı satır farklıysa seçim zorunlu |

Her dosyanın işareti tek tek kaldırılabilir; fark ekranı her dosya için açılır.
İşareti kaldırılan değişiklik geçmişe yazılmaz, sonraki aktarımda yine sorulur.

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
| Günlük | Ayarlanan saatte; kaçırılırsa ilk açılışta | `backups/daily` | Son 30 (değişiklik yoksa yenisi alınmaz) |
| İşlem öncesi | Her aktarım, geri yükleme, geri alma, workspace düzeltmesi öncesi | `backups/before` | Son 50 |
| Elle | "Şimdi yedek al" | `backups/manual` | Silinmez |
| Paket | "Paket oluştur" | Seçilen klasör (varsayılan Masaüstü) | Silinmez |

Kütüphane; yedek klasörünü, Masaüstünü, İndirilenler'i ve eklenen klasörleri tarar, her `.memsync`
dosyasının cihazını, tarihini, türünü ve içeriğini gösterir. Başka cihazdan gelip henüz aktarılmamış
paketler ana sayfada önerilir.

## Durum dosyaları (`~/.claude-memory-sync`)

| Dosya | İçerik |
|---|---|
| `config.json` | Cihaz adı, tarama klasörleri, yedek ayarları, dışarıda bırakılan projeler |
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
- İngilizce arayüz.
