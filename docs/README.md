# Dokumentasi NiagaCore

## 1. Tentang project

NiagaCore adalah aplikasi mPOS Android untuk mengelola transaksi dan operasional usaha Indonesia. Aplikasi mobile menjadi antarmuka utama, sedangkan Supabase menyediakan autentikasi, PostgreSQL, Row Level Security (RLS), Storage, Realtime, RPC, dan Edge Functions. Repository juga menyertakan situs statis distribusi APK dan quality gate.

## 2. Tujuan dan sasaran pengguna

NiagaCore menyatukan kasir, persediaan, pembelian, pelanggan, keuangan, tim, dan analitik. Sistem mendukung usaha retail, F&B, jasa, dan grosir dengan modul yang mengikuti jenis usaha aktif.

Peran yang dikenali source adalah pemilik, manajer usaha, kepala cabang, supervisor, kasir, gudang, pembelian, keuangan, staf layanan, dapur, pramusaji, auditor, dan admin platform. Menu serta data disaring berdasarkan peran, tenant, usaha, dan cabang.

## 3. Fitur pengguna usaha

### Penjualan dan pelanggan

- Keranjang POS, pencarian produk, pemindaian barcode, diskon, pajak, dan pemeriksaan stok.
- Pembayaran tunai, QRIS Midtrans, serta kredit dengan pembayaran awal dan cicilan.
- Draft keranjang server, riwayat transaksi, struk ber-QR, cetak, dan berbagi PDF.
- Retur, disposisi stok, persetujuan refund, pemulihan QRIS, dan kedaluwarsa pembayaran.
- Pelanggan, batas piutang, izin komunikasi, loyalitas, segmentasi RFM, dan rekomendasi promosi.

### Produk dan operasional

- Produk/jasa, kategori, harga, HPP, satuan, SKU, barcode, foto, stok, dan batas minimum.
- Pemasok, pesanan pembelian, penerimaan barang, tagihan, retur, dan daftar harga grosir.
- Opname, penyesuaian dan transfer stok, lot, gudang, resep, modifier, meja, dapur, layanan, dan janji temu.
- Shift per pengguna/perangkat/cabang, kas masuk/keluar, persetujuan, perangkat, printer Android, scanner kamera, dan uji scanner HID.

### Keuangan, laporan, dan NIA

- Piutang, utang, beban, jurnal berpasangan, periode akuntansi, aset, penyusutan, dan pajak.
- Dashboard serta laporan penjualan, laba rugi, neraca, buku besar, arus kas, persediaan, pajak, dan aging.
- Cakupan laporan cabang aktif atau seluruh cabang dalam usaha aktif sesuai hak akses.
- NIA untuk ringkasan, prediksi, anomali, basis pengetahuan, versi model/dataset, drift, evaluasi grounding, dan kalibrasi.
- Saldo usaha, rekening terenkripsi, verifikasi admin, permintaan pencairan, bukti transfer, dan wallet ledger.

## 4. Fitur admin dan role lainnya

Pemilik mengelola usaha, cabang, staf, perangkat, akuntansi, laporan, QRIS, rekening, dan kebijakan. Supervisor serta manajer memiliki area sesuai izin bisnis/cabang; role khusus hanya melihat modul yang relevan.

Control center admin platform menyediakan verifikasi merchant dan QRIS; verifikasi rekening dan pencairan; rekonsiliasi pembayaran dan retry refund; status merchant dan perangkat; feature flag; rilis; insiden; support case; tim admin berbasis role dan MFA; quality gate; kesehatan operasi; jejak aktivitas; dan observability.

## 5. Panduan penggunaan

### Registrasi dan ruang kerja

1. Daftar dengan email dan kata sandi, kemudian verifikasi email.
2. Isi identitas pemilik, tenant, usaha, dan cabang pertama.
3. Pilih jenis usaha agar modul yang sesuai ditampilkan.
4. Pemilik dapat menambah usaha/cabang melalui **Usaha & cabang**. Ketuk identitas pada header untuk berpindah ruang kerja.

### Transaksi kasir

1. Buka **Kasir**, pilih atau pindai produk, lalu atur kuantitas.
2. Pilih pelanggan untuk transaksi kredit.
3. Pilih tunai, QRIS, atau kredit. Untuk kredit, isi pembayaran awal dan jatuh tempo.
4. Selesaikan pembayaran. Struk tersimpan pada **Riwayat Transaksi** untuk dicetak atau dibagikan.
5. Catat cicilan berikutnya melalui modul **Piutang usaha**.

### Produk, stok, dan shift

Gunakan **Produk & stok** untuk produk, foto, SKU, barcode, harga, HPP, satuan, dan batas stok. Aktivitas lanjutan berada pada **Lainnya**, termasuk penerimaan, opname, transfer, penyesuaian, lot, dan gudang. Buka shift dengan kas awal, catat pergerakan kas, lalu tutup menggunakan kas aktual.

### Laporan, staf, dan NIA

Pada **Laporan**, pilih periode, tab, dan cakupan cabang. Pemilik/keuangan dapat menghitung penyusutan dan mengekspor rekonsiliasi pajak. Pemilik mengundang staf dengan role serta cabang, mengirim ulang undangan, atau mencabut akses. Aktifkan AI cloud untuk insight NIA dan tambahkan panduan internal pada **Basis pengetahuan** agar Tanya NIA menjawab dengan sumber.

## 6. Arsitektur frontend, backend, database, dan layanan

`apps/mobile` menggunakan Expo Router, React Native, React Query, SecureStore, Zustand, React Hook Form, Zod, kamera, notifications, printing, sharing, dan Sentry. `auth-provider` membentuk konteks tenant/usaha/cabang/role; `remote-store` menjadi lapisan akses Supabase.

Migrasi SQL membentuk schema secara append-only. Operasi penting dipusatkan pada RPC dan trigger agar penjualan, stok, wallet, jurnal, refund, serta pencatatan aktivitas tetap atomik. RLS membatasi tenant/cabang. Mutation log, conflict review, Realtime, dan polling menopang sinkronisasi beberapa perangkat.

Midtrans menyediakan QRIS, webhook, rekonsiliasi, refund, dan settlement. Cloudflare Workers AI serta Gemini menjadi provider NIA. EAS membangun Android, Expo Push Service mengirim notifikasi, dan Sentry menangkap error aplikasi.

## 7. Struktur repository

| Path                    | Isi                                                  |
| ----------------------- | ---------------------------------------------------- |
| `apps/mobile`           | aplikasi Android dan aset                            |
| `apps/distribution-web` | halaman distribusi, manifest, provenance, dan SBOM   |
| `packages/*`            | akuntansi, kontrak, domain, hardware, bahasa, dan UI |
| `supabase/migrations`   | schema, kebijakan, RPC, dan trigger                  |
| `supabase/functions`    | API serverless dan webhook                           |
| `supabase/tests`        | pgTAP/RLS integration tests                          |
| `scripts`               | validasi, konfigurasi, rilis, backup, dan Sentry     |
| `.maestro`              | skenario E2E Android                                 |

## 8. Prasyarat dan instalasi lokal

Gunakan Node.js 22.13.0, pnpm 11.25.0, Docker, Supabase CLI, serta Android SDK/emulator atau perangkat Android.

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
supabase start
supabase db reset
pnpm start
```

Untuk emulator Android, gunakan URL host yang dapat dijangkau emulator, misalnya `http://10.0.2.2:54321`, bukan loopback perangkat. Gunakan development build untuk dependensi native di luar Expo Go.

## 9. Konfigurasi environment

Variabel `EXPO_PUBLIC_*` masuk ke bundle dan tidak boleh berisi rahasia.

| Variabel                                                         | Lingkup | Fungsi                           |
| ---------------------------------------------------------------- | ------- | -------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`      | mobile  | API dan publishable key Supabase |
| `EXPO_PUBLIC_APP_ENV`, `EXPO_PUBLIC_SENTRY_DSN`                  | mobile  | environment dan monitoring       |
| `EXPO_PUBLIC_RECEIPT_VERIFY_URL`                                 | mobile  | URL verifikasi struk             |
| `EXPO_PUBLIC_UPDATE_MANIFEST_URL`                                | mobile  | manifest pembaruan APK           |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | backend | akses Supabase                   |
| `MIDTRANS_SERVER_KEY`, `MIDTRANS_ENVIRONMENT`                    | backend | pembayaran production            |
| `WALLET_ENCRYPTION_KEY_BASE64`                                   | backend | AES-256-GCM rekening pencairan   |
| `APP_DEEP_LINK_URL`, `APP_PASSWORD_RESET_DEEP_LINK_URL`          | backend | undangan dan reset akun          |
| `AI_PROVIDER_ORDER`, `CLOUDFLARE_*`, `GEMINI_*`                  | backend | provider/model NIA               |
| `NIA_EVALUATION_CRON_SECRET`, `NOTIFICATION_CRON_SECRET`         | backend | autentikasi job terjadwal        |

Gunakan `.env.example` sebagai daftar awal. Simpan rahasia pada Supabase secrets, EAS environment, atau GitHub Actions secrets.

## 10. Autentikasi dan pengelolaan akun

Supabase Auth menangani registrasi, verifikasi email, login, reset kata sandi, refresh sesi, dan MFA TOTP. Sesi mobile disimpan di SecureStore. Onboarding pemilik memakai `bootstrap_owner`; undangan staf/admin memiliki lifecycle server-side dan deep link. Perangkat diregistrasi per sesi, dapat dicabut, dan dapat dilindungi PIN enam digit.

## 11. Integrasi layanan eksternal

Rahasia Midtrans berada pada Edge Functions. URL notifikasi provider diarahkan ke `/functions/v1/midtrans-webhook`. QRIS dibuat server-side dalam mode production; signature, nominal, idempotensi, dan state diverifikasi pada webhook/rekonsiliasi. Provider NIA dipilih melalui `AI_PROVIDER_ORDER`; output model divatasi bukti mesin deterministik dan knowledge retrieval.

## 12. Model data atau koleksi database

- Identitas: `profiles`, `tenants`, `businesses`, `branches`, `memberships`, `membership_branches`, `devices`.
- Perdagangan: `products`, `customers`, `sales`, `sale_items`, `payments`, `refunds`, `sale_drafts`.
- Stok/pembelian: `inventory_movements`, `inventory_lots`, `warehouses`, `purchase_orders`, `goods_receipts`, `stock_counts`, `stock_transfers`, `partners`.
- Akuntansi: `accounts`, `journal_entries`, `journal_lines`, `subledger_documents`, `expenses`, `fixed_assets`, `tax_policies`.
- Wallet: `merchant_wallets`, `wallet_ledger`, `withdrawal_accounts`, `withdrawal_requests`, `merchant_verifications`.
- Operasional: `shifts`, `approval_requests`, `audit_events`, `sync_mutations`, `sync_failure_events`, `notification_outbox`, `push_tokens`.
- NIA/observability: `ai_insights`, `nia_knowledge_documents`, `nia_model_registry`, `nia_dataset_versions`, `nia_drift_measurements`, `nia_evaluation_runs`, `observability_spans`.
- Platform: `platform_admins`, `platform_releases`, `platform_incidents`, `support_cases`, `production_gate_evidence`.

Schema otoritatif berada pada `supabase/migrations`; `config/database-contract.json` menjaga kontrak minimum aplikasi.

## 13. Referensi API dan webhook

Edge Functions tersedia pada `/functions/v1/<nama>`.

| Endpoint                      | Metode dan autentikasi    | Kegunaan                                     |
| ----------------------------- | ------------------------- | -------------------------------------------- |
| `ai-insights`                 | POST, bearer user         | insight dan Tanya NIA                        |
| `create-midtrans-transaction` | POST, bearer user         | membuat QRIS server-side                     |
| `reconcile-midtrans`          | POST, bearer user/admin   | mengambil status provider                    |
| `refund-midtrans`             | POST, bearer user/admin   | request, persetujuan, atau retry refund      |
| `midtrans-webhook`            | POST, signature Midtrans  | finalisasi pembayaran/refund                 |
| `sync`                        | POST, bearer user         | push mutation dan pull delta                 |
| `wallet-account`              | POST, bearer user/admin   | set rekening terenkripsi atau reveal berizin |
| `invite-staff`                | POST, bearer pemilik      | membuat undangan staf                        |
| `invite-platform-admin`       | POST, bearer admin        | membuat undangan admin                       |
| `nia-knowledge`               | POST, bearer user         | list, upsert, atau delete pengetahuan        |
| `nia-evaluator`               | POST, `x-nia-cron-secret` | evaluasi dan kalibrasi NIA                   |
| `notification-dispatch`       | POST, `x-cron-secret`     | pengiriman push notification                 |
| `health`                      | GET/POST                  | status konfigurasi dan operasi               |

Payload detail mengikuti validasi setiap `supabase/functions/*/index.ts` dan pemanggilan typed pada mobile. RPC publik didefinisikan dalam migrasi SQL.

## 14. Keamanan

- RLS serta permission mengisolasi tenant, usaha, cabang, dan role.
- Service-role key, Midtrans key, wallet key, token AI, serta cron secret hanya digunakan backend.
- Rekening dienkripsi AES-256-GCM; reveal memerlukan permission admin dan dicatat sebagai peristiwa keamanan.
- Webhook memverifikasi signature, nominal, idempotensi, dan transisi state.
- Jurnal posted immutable; koreksi memakai reversal.
- Sesi memakai SecureStore, MFA TOTP tersedia, dan perangkat dapat dicabut.
- Pelaporan kerentanan mengikuti `SECURITY.md`.

## 15. Testing dan quality gate

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm migrations:check
pnpm database:contract
pnpm release:check
supabase test db
```

Maestro melalui workflow **Android Maestro E2E** menguji tunai, kredit/cicilan, shift, refund, perpindahan usaha/cabang, batas role, pencabutan perangkat, QRIS recovery, sinkronisasi, hardware baseline, kesehatan operasi, dan governance NIA.

## 16. Build dan deployment

```bash
pnpm --filter @niagacore/mobile exec expo export --platform android --clear
pnpm build:preview
pnpm build:production
supabase link --project-ref <project-ref>
supabase db push
supabase functions deploy
```

Build production memakai `apps/mobile/eas.json`. `pnpm release:apk <path-apk>` memverifikasi signature/versi, menghitung SHA-256, dan memperbarui manifest. APK/AAB tidak disimpan di Git.

## 17. Monitoring, backup, dan operasional

Sentry menangkap error mobile. Endpoint `health`, observability spans/jobs, dan control center menyediakan pemeriksaan kesehatan serta trace. GitHub Actions menjalankan evaluasi NIA terjadwal dan drill backup/restore ke database terisolasi. Bukti rilis disimpan sebagai artifact dan direktori lokalnya diabaikan Git.

## 18. Troubleshooting

- **Backend tidak terkonfigurasi:** periksa URL/key publik dan jalankan `pnpm start:clear`.
- **Emulator gagal ke Supabase lokal:** gunakan alamat host emulator.
- **Email tidak masuk:** periksa Auth SMTP, redirect URL, function log, dan spam.
- **QRIS gagal:** periksa verifikasi merchant, environment Midtrans production, dan function log.
- **Pembayaran menunggu:** gunakan periksa status; rekonsiliasi/expiry server memperbarui state.
- **Notifikasi tidak masuk:** aktifkan izin Android, registrasikan ulang token, dan periksa outbox.
- **Migrasi lokal gagal:** jalankan `supabase stop`, lalu `supabase db reset` pada database pengembangan.

## 19. Panduan kontribusi

1. Buat branch untuk satu fokus perubahan.
2. Ikuti TypeScript strict mode, pola RPC/RLS, dan migrasi append-only.
3. Sertakan unit test, database test, atau Maestro flow sesuai dampak.
4. Jalankan `pnpm check`, pemeriksaan migrasi, dan kontrak database.
5. Jangan commit environment, credential, APK, log, dump, atau data pengguna.
6. Gunakan template pull request dan jelaskan cara uji serta dampak schema/keamanan.

## 20. MIT License

NiagaCore dirilis berdasarkan MIT License. Lihat `LICENSE` untuk teks lisensi.
