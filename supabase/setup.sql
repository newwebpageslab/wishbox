-- 위시함 클라우드 저장소 설정 (Supabase SQL Editor에 통째로 붙여넣고 Run)
-- 여러 번 실행해도 안전하게 작성했습니다.

-- 1) 위시 테이블: 위시 1개 = 1줄. 사진 파일은 아래 Storage에 따로 저장.
create table if not exists public.wishes (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,   -- 브랜드명, 상품명, 가격, 메모 등
  images      jsonb not null default '[]'::jsonb,   -- 사진 파일 경로 목록
  updated_at  bigint not null,                     -- 마지막 수정 시각(ms), 동기화 비교용
  deleted     boolean not null default false        -- 삭제 표시 (다른 기기에도 삭제 반영)
);

create index if not exists wishes_user_id_idx on public.wishes (user_id);

-- 2) 잠금(RLS): 로그인한 본인 데이터만 읽고 쓸 수 있음
alter table public.wishes enable row level security;

drop policy if exists "wishes: own rows only" on public.wishes;
create policy "wishes: own rows only" on public.wishes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 3) 사진 저장소(비공개 버킷)
insert into storage.buckets (id, name, public)
values ('wish-images', 'wish-images', false)
on conflict (id) do nothing;

-- 사진도 본인 폴더(사용자 ID로 시작하는 경로)만 접근 가능
drop policy if exists "wish-images: read own" on storage.objects;
create policy "wish-images: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'wish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "wish-images: insert own" on storage.objects;
create policy "wish-images: insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "wish-images: update own" on storage.objects;
create policy "wish-images: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'wish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "wish-images: delete own" on storage.objects;
create policy "wish-images: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'wish-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
