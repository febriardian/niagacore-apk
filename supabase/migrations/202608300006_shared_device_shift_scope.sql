begin;

-- Satu perangkat dapat dipakai bergantian oleh beberapa akun atau cabang.
-- Setiap kombinasi akun, perangkat, dan cabang tetap hanya boleh memiliki
-- satu shift terbuka agar saldo kas tidak tercatat ganda.
drop index if exists public.one_open_shift_per_device;
create unique index if not exists one_open_shift_per_user_device_branch
  on public.shifts(device_id,user_id,branch_id) where status='open';

commit;
