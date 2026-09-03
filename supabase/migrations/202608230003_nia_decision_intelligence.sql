begin;

-- Document chunks are indexed independently so retrieval does not compare a
-- short question with an entire manual. The parent document remains the
-- permission and lifecycle boundary.
create table if not exists public.nia_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.nia_knowledge_documents(id) on delete cascade,
  tenant_id uuid not null,
  business_id uuid not null,
  branch_id uuid,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(trim(content)) between 20 and 2400),
  embedding extensions.vector(768) not null,
  search_vector tsvector generated always as (to_tsvector('simple', content)) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,document_id) references public.nia_knowledge_documents(tenant_id,id) on delete cascade,
  foreign key (tenant_id,business_id) references public.businesses(tenant_id,id),
  foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
  unique (document_id,chunk_index)
);

create index if not exists nia_knowledge_chunks_scope_idx
  on public.nia_knowledge_chunks(tenant_id,business_id,branch_id,document_id,chunk_index);
create index if not exists nia_knowledge_chunks_embedding_idx
  on public.nia_knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists nia_knowledge_chunks_search_idx
  on public.nia_knowledge_chunks using gin(search_vector);

alter table public.nia_knowledge_chunks enable row level security;
drop policy if exists nia_knowledge_chunks_select_member on public.nia_knowledge_chunks;
create policy nia_knowledge_chunks_select_member on public.nia_knowledge_chunks
for select to authenticated using (
  private.is_tenant_member(tenant_id)
  and (branch_id is null or private.can_access_branch(tenant_id,branch_id))
);

create or replace function public.match_nia_knowledge_hybrid(
  target_tenant_id uuid,
  target_business_id uuid,
  target_branch_id uuid,
  query_text text,
  query_embedding extensions.vector(768),
  match_count integer default 6
)
returns table(
  id uuid,
  document_id uuid,
  title text,
  content text,
  chunk_index integer,
  metadata jsonb,
  semantic_similarity double precision,
  keyword_rank double precision,
  score double precision
)
language sql stable security definer set search_path='' as $$
  with candidates as (
    select c.id,c.document_id,d.title,c.content,c.chunk_index,
      d.metadata || c.metadata as metadata,
      greatest(0,1-(c.embedding OPERATOR(extensions.<=>) query_embedding))::double precision as semantic_similarity,
      ts_rank_cd(c.search_vector,plainto_tsquery('simple',coalesce(query_text,'')),32)::double precision as keyword_rank
    from public.nia_knowledge_chunks c
    join public.nia_knowledge_documents d
      on d.tenant_id=c.tenant_id and d.id=c.document_id
    where c.tenant_id=target_tenant_id
      and c.business_id=target_business_id
      and d.active
      and (c.branch_id is null or c.branch_id=target_branch_id)
      and private.can_access_branch(target_tenant_id,target_branch_id)
  )
  select id,document_id,title,content,chunk_index,metadata,
    semantic_similarity,keyword_rank,
    (semantic_similarity*.72 + least(1,keyword_rank)*.28)::double precision as score
  from candidates
  where semantic_similarity>=.34 or keyword_rank>0
  order by score desc,chunk_index
  limit greatest(1,least(coalesce(match_count,6),12));
$$;

revoke all on function public.match_nia_knowledge_hybrid(uuid,uuid,uuid,text,extensions.vector,integer) from public;
grant execute on function public.match_nia_knowledge_hybrid(uuid,uuid,uuid,text,extensions.vector,integer) to authenticated;

comment on table public.nia_knowledge_chunks is
  'Permission-scoped chunks for hybrid semantic and keyword retrieval. Answers must cite document and chunk.';

commit;
