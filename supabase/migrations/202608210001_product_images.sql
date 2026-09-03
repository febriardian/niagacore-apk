begin;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('product-images','product-images',true,5242880,array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists product_images_read on storage.objects;
create policy product_images_read on storage.objects for select using(bucket_id='product-images');

drop policy if exists product_images_insert on storage.objects;
create policy product_images_insert on storage.objects for insert to authenticated with check(
  bucket_id='product-images' and exists(
    select 1 from public.memberships m
    where m.user_id=(select auth.uid()) and m.active
      and m.tenant_id=nullif((storage.foldername(name))[1],'')::uuid
      and m.role in('owner','business_manager','branch_manager','supervisor')
  )
);

drop policy if exists product_images_update on storage.objects;
create policy product_images_update on storage.objects for update to authenticated using(
  bucket_id='product-images' and exists(
    select 1 from public.memberships m
    where m.user_id=(select auth.uid()) and m.active
      and m.tenant_id=nullif((storage.foldername(name))[1],'')::uuid
      and m.role in('owner','business_manager','branch_manager','supervisor')
  )
) with check(bucket_id='product-images');

drop policy if exists product_images_delete on storage.objects;
create policy product_images_delete on storage.objects for delete to authenticated using(
  bucket_id='product-images' and exists(
    select 1 from public.memberships m
    where m.user_id=(select auth.uid()) and m.active
      and m.tenant_id=nullif((storage.foldername(name))[1],'')::uuid
      and m.role in('owner','business_manager','branch_manager','supervisor')
  )
);

commit;
