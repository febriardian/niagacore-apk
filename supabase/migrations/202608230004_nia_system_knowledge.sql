begin;

-- Curated NiagaCore guidance belongs in the database, not inside an Edge
-- Function bundle. Only reviewed, active rows may be retrieved by NIA.
create table if not exists public.nia_system_knowledge (
  id text primary key check (id ~ '^K_SYS_[0-9]+$'),
  category text not null,
  locale text not null default 'id-ID',
  title text not null check (char_length(trim(title)) between 3 and 160),
  content text not null check (char_length(trim(content)) between 20 and 4000),
  keywords text[] not null default '{}',
  source_label text not null default 'Panduan NiagaCore',
  source_url text,
  version integer not null default 1 check (version > 0),
  reviewed_at timestamptz not null,
  active boolean not null default true,
  -- Only immutable text expressions belong in a generated column. Keywords
  -- are scored separately by the RPC because array_to_string(anyarray,text)
  -- cannot be used safely in a generated expression.
  search_vector tsvector generated always as (
    to_tsvector('simple', title || ' ' || content)
  ) stored,
  updated_at timestamptz not null default now()
);

create index if not exists nia_system_knowledge_search_idx
  on public.nia_system_knowledge using gin(search_vector);

alter table public.nia_system_knowledge enable row level security;
drop policy if exists nia_system_knowledge_read on public.nia_system_knowledge;
create policy nia_system_knowledge_read on public.nia_system_knowledge
for select to authenticated using (active);

insert into public.nia_system_knowledge(id,category,title,content,keywords,source_label,version,reviewed_at)
values
  ('K_SYS_1','transaksi','Panduan retur transaksi','Buka Riwayat transaksi, pilih transaksi yang sudah selesai, lalu pilih Retur transaksi. Masukkan nominal dan alasan retur. Kasir mengajukan permintaan persetujuan; supervisor atau pemilik memproses sesuai kewenangannya. Retur pembayaran digital mengikuti status dari penyedia pembayaran.',array['retur','return','refund','pengembalian'],'Panduan transaksi NiagaCore',2,'2026-08-23T00:00:00Z'),
  ('K_SYS_2','kasir','Panduan shift kasir','Buka shift dengan saldo kas awal sebelum menerima transaksi. Gunakan Kelola kas untuk mencatat kas masuk atau keluar. Saat selesai, pilih Tutup shift, masukkan kas aktual, lalu periksa selisih sebelum mengonfirmasi penutupan.',array['shift','kasir','tutup shift','buka shift','kelola kas'],'Panduan kasir NiagaCore',2,'2026-08-23T00:00:00Z'),
  ('K_SYS_3','produk','Panduan produk dan stok','Produk dibuat dari menu Produk. Lengkapi nama, SKU atau barcode, harga jual, pengaturan persediaan, stok minimum, dan foto bila tersedia. Setelah produk dibuat, perubahan stok dicatat melalui Penyesuaian stok agar jejak audit tetap utuh.',array['produk','stok','foto produk','sku','barcode','persediaan'],'Panduan produk NiagaCore',2,'2026-08-23T00:00:00Z'),
  ('K_SYS_4','laporan','Panduan laporan usaha','Menu Laporan menampilkan ringkasan, laba rugi, neraca, ledger, dan detail sesuai periode serta ruang cabang pengguna. Angka berasal dari transaksi dan jurnal terposting. Gunakan ekspor PDF untuk dibaca, CSV untuk spreadsheet, atau JSON untuk arsip terstruktur.',array['laporan','laba rugi','neraca','ledger','jurnal','ekspor','pdf','csv','json'],'Panduan laporan NiagaCore',2,'2026-08-23T00:00:00Z'),
  ('K_SYS_5','pajak','Persiapan data pajak','Fitur Siapkan data pajak membuat rekonsiliasi dari data yang telah dipetakan di NiagaCore. File tersebut adalah dokumen persiapan dan tetap perlu diperiksa sebelum digunakan untuk pelaporan resmi.',array['pajak','rekonsiliasi','coretax','dpp','ppn'],'Panduan pajak NiagaCore',1,'2026-08-23T00:00:00Z'),
  ('K_SYS_6','pelanggan','Data pelanggan dan promosi','Analisis pelanggan memakai transaksi yang terhubung ke pelanggan. Gunakan hasil segmentasi untuk evaluasi kelompok, bukan untuk menyimpulkan sifat pribadi. Kirim promosi hanya kepada pelanggan yang telah memberi persetujuan.',array['pelanggan','rfm','segmen','loyal','promo','persetujuan'],'Panduan pelanggan NiagaCore',1,'2026-08-23T00:00:00Z')
on conflict (id) do update set
  category=excluded.category,title=excluded.title,content=excluded.content,
  keywords=excluded.keywords,source_label=excluded.source_label,
  version=excluded.version,reviewed_at=excluded.reviewed_at,active=true,updated_at=now();

create or replace function public.match_nia_system_knowledge(query_text text, match_count integer default 5)
returns table(
  id text,
  title text,
  content text,
  source_label text,
  source_url text,
  version integer,
  reviewed_at timestamptz,
  score double precision
)
language sql stable security definer set search_path='' as $$
  with query as (
    select lower(trim(coalesce(query_text,''))) as text,
      plainto_tsquery('simple',coalesce(query_text,'')) as terms
  ), ranked as (
    select k.*,
      ts_rank_cd(k.search_vector,q.terms,32)::double precision
      + coalesce((
          select count(*) * .18
          from unnest(k.keywords) as keyword(value)
          where q.text like '%' || lower(keyword.value) || '%'
        ),0)::double precision as relevance
    from public.nia_system_knowledge k cross join query q
    where k.active and (
      k.search_vector @@ q.terms
      or exists(
        select 1
        from unnest(k.keywords) as keyword(value)
        where q.text like '%' || lower(keyword.value) || '%'
      )
    )
  )
  select r.id,r.title,r.content,r.source_label,r.source_url,r.version,r.reviewed_at,r.relevance
  from ranked r where r.relevance>.08
  order by r.relevance desc,r.reviewed_at desc
  limit greatest(1,least(coalesce(match_count,5),8));
$$;

revoke all on function public.match_nia_system_knowledge(text,integer) from public;
grant execute on function public.match_nia_system_knowledge(text,integer) to authenticated;

comment on table public.nia_system_knowledge is
  'Versioned, reviewed system guidance retrieved by NIA. It is not a source for merchant financial figures.';

commit;
