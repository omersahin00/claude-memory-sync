# claude-memory-sync

"sasa" önekli repoların **Claude Code hafızalarını** ve **VSCode workspace dosyalarını** cihazlar arasında
(macOS / Windows / Linux) taşır, iki yönlü eşitler ve yedekler. Bağımlılığı yok, Node.js 18+ yeterli.

## Kurulum (her cihazda bir kez)

Klasörü cihaza kopyala (ya da git'ten klonla), içine gir ve çalıştır:

```
cd claude-memory-sync
node cli.js status
```

İlk çalıştırmada repo klasörünü, cihaz adını ve öneki sorar, onay verince kaydeder.

**Neden `node cli.js`?** Global bir komut kurulmadığı için başka bir programla ad çakışması olmaz.
Windows PowerShell'deki "running scripts is disabled" (Execution Policy) hatasına da takılmaz.
İstersen `npm link` ile `claude-memory-sync` adında global komut da kurulabilir, ama gerekmez.

## Komutlar

| Komut | Ne yapar | Yazar mı? |
|---|---|---|
| `node cli.js status` | İşletim sistemi, Claude dizini, repolar, hafıza sayıları, workspace'ler | Hayır |
| `node cli.js backup [-o klasör]` | Tüm hafızaları tek bir `.memsync` dosyasına koyar | Onaydan sonra |
| `node cli.js sync <dosya>` | Paketi bu cihazla iki yönlü birleştirir | Onaydan sonra, önce otomatik yedek |
| `node cli.js restore <dosya>` | Bu cihazı paketteki hâline döndürür | Onaydan sonra, önce otomatik yedek |
| `node cli.js config` | Ayarları değiştirir | Onaydan sonra |

## Dosyalar nerede

| Ne | Nerede |
|---|---|
| `backup` çıktısı | Varsayılan Masaüstü (`-o` ile başka klasör): `claude-memory-<cihaz>-<tarih>.memsync` |
| Otomatik yedekler | `~/.claude-memory-sync/backups/auto-before-sync-<tarih>.memsync` (Windows: `C:\Users\<kullanıcı>\.claude-memory-sync\backups\`) |
| Ayarlar ve eşitleme geçmişi | `~/.claude-memory-sync/config.json`, `history.json` |

`.memsync` dosyası zip değildir, açılmaz; olduğu gibi komuta verilir. Herhangi bir klasörde durabilir.

## Senaryolar

**Mac → Windows ilk taşıma**
1. Mac: `node cli.js backup` → Masaüstündeki `.memsync` dosyasını Windows'a taşı
2. Windows: `node cli.js sync "C:\Users\<kullanıcı>\Downloads\claude-memory-....memsync"`
3. Klonlanmamış ya da Claude'da hiç açılmamış repolar klon komutuyla listelenir. Onları hazırlayıp aynı komutu tekrar çalıştır.

**Karşılıklı eşitleme** (iki cihazda da çalışıldıysa)
1. A: `node cli.js backup` → B: `node cli.js sync <dosya>`
2. B: `node cli.js backup` → A: `node cli.js sync <dosya>`

İki adımdan sonra iki cihaz birebir aynıdır.

**Format öncesi / sonrası**
- Önce: `node cli.js backup -o <harici disk>`. `~/.claude-memory-sync` klasörü de formatla silinir, paketi cihazın dışına çıkar.
- Sonra: repoları klonla, her birini Claude Code'da bir kez aç, `node cli.js restore <dosya>`

**Son eşitlemeyi geri al**
Her `sync`/`restore` sonunda yazılan komut: `node cli.js restore "<otomatik yedek>"`

## Nasıl karar veriyor

Her cihaz, her dosyanın gördüğü sürümlerin hash'lerini tutar (`history.json`) ve pakete de koyar.
Böylece "karşıda silindi" ile "burada yeni eklendi" ayırt edilir:

| Durum | Sonuç |
|---|---|
| Yalnız karşıda değişmiş ya da eklenmiş | Alınır |
| Karşıda silinmiş, burada değişmemiş | Silinir |
| Yalnız burada değişmiş, eklenmiş ya da silinmiş | Dokunulmaz |
| İki tarafta da değişmiş | Fark gösterilir ve sorulur: `l` bu cihaz / `r` karşı / `b` ikisini de tut |
| `MEMORY.md` iki tarafta da değişmiş | Satır satır birleştirilir; aynı dosyanın satırı farklıysa sorulur |

Onay sorularına `y` evet, başka her şey hayır demektir.

## Güvenlik

- Onay verilmeden hiçbir dosya yazılmaz; girdi kesilirse cevap "hayır" sayılır.
- `sync` ve `restore` önce bu cihazın tam yedeğini alır ve geri okuyarak doğrular.
- Dosyalar önce geçici dosyaya yazılıp tek adımda yerine konur; işlem bitince her dosya tekrar okunup doğrulanır.
- Paketteki her dosyanın hash'i okunurken kontrol edilir; bozuk paket reddedilir.
- Satır sonu (CRLF/LF) ve BOM farkı değişiklik sayılmaz.
- Hafıza klasörü tamamen boşalmış görünen repo pakete konmaz (karşı cihazda toplu silmeye dönüşmesin).
- Windows'ta geçersiz dosya adları ve yalnızca büyük/küçük harfle ayrılan adlar işlem başlamadan engellenir.

## Claude proje klasörü nasıl bulunuyor

Claude Code hafızayı `~/.claude/projects/<kodlanmış yol>/memory` altında tutar. Araç eşleşmeyi üç yolla arar:
1. **folder name**: yoldaki harf/rakam dışı karakterlerin `-` yapılmış hâli
2. **session log**: klasördeki `*.jsonl` oturum dosyalarının `cwd` alanı
3. **guessed**: yalnızca repo adı sonekiyle tek aday varsa (sarı uyarıyla gösterilir)

Proje klasörü yoksa repo "no Claude project" diye listelenir: klasörü Claude Code'da açıp bir mesaj göndermek yeterli.
`CLAUDE_CONFIG_DIR` ortam değişkeni tanınır.

## Dikkat

- Eşitleme sırasında o repolarda açık Claude Code oturumu olmasın.
- Workspace dosyalarındaki göreli yollar taşınır. Repo klasörünün dışına çıkan yollar (ör. `../../../Desktop/...`)
  için uyarı verilir; hedef cihazda o klasörler de aynı göreli yerde olmalı.

## Test

```
npm test
```
