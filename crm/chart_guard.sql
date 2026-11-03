-- 진료기록(medicalRecord) DB 보호: 서명 검증, 서명 원본 수정·삭제 차단, 서명 증거·변경 기록.
--
-- Twenty는 레코드 단위 '수정 금지'를 지원하지 않는다. 그래서 워크스페이스 테이블에 트리거를 걸어
-- 화면·REST·GraphQL·API 키·DB 직접 수정 등 어떤 경로든 같은 규칙을 지키게 한다(Twenty 업그레이드와 무관하게 DB에 남는다).
--
--   1) 서명(DRAFT → SIGNED, 또는 SIGNED로 바로 만들기)
--      - 서명자: 사람 계정(MANUAL)이 직접 서명해야 하고, doctorId = 로그인한 직원(updatedBy) 이며,
--        chart_audit.signer(원장 목록)에 있어야 한다. API 키·워크플로로는 서명할 수 없다.
--      - 필수항목(의료법 시행규칙 제14조): 환자, 진료 일시, 주된 증상, 진단, 치료 내용, 진료의. 빠지면 서명 거부.
--      - 서명 일시는 DB 시각 ±5분 안이어야 한다(소급 서명 방지).
--      - contentHash는 DB가 같은 규칙으로 다시 계산한 값과 같아야 한다(서버 측 검증).
--      - 새 판: supersedes = 앞 판(서명됨, 같은 chainId), version = 앞 판 + 1, 수정 사유 필수, 같은 판 번호 중복 금지.
--      - 통과하면 chart_audit.signature에 서명 증거(서명자·시각·판·원문 해시·증거 해시)를 남긴다.
--   2) 서명한 기록: 내용·상태·서명 칸은 바꿀 수 없다. 봉인 칸(sealedAt·sealNo)만 비어 있을 때 한 번 채울 수 있다.
--      지우기(삭제·휴지통)도 거부한다. 고칠 때는 새 판을 만든다.
--   3) API 키·워크플로(사람이 아닌 계정)는 진료기록 내용을 만들거나 고칠 수 없다. 봉인 칸만 채운다.
--   4) 모든 생성·수정·삭제 시도(성공한 것)는 chart_audit.change_log에 남는다(바뀐 칸 이름만, 내용 없음).
--      chart_audit 테이블은 덧붙이기만 된다(수정·삭제 거부).
--
-- 해시 규칙은 biroso server/charts.mjs, console src/industries/clinic-chart.ts와 같다(테스트에 같은 예시 값).
-- 실행: crm/install_chart_guard.sh (스키마 이름을 :ws 로 넘긴다). 여러 번 실행해도 된다.

\set ON_ERROR_STOP on
set client_min_messages = warning;
create extension if not exists pgcrypto;
create schema if not exists chart_audit;

-- 서명할 수 있는 원장(워크스페이스 멤버). install_chart_guard.sh --signer <이메일>로 넣는다.
create table if not exists chart_audit.signer (
  member_id uuid primary key,
  label text not null,
  added_at timestamptz not null default now()
);

-- 서명 증거. 서명할 때 한 줄. evidence_hash = sha256(기록 ID·서명자·서명 일시·판·원문 해시)
create table if not exists chart_audit.signature (
  id bigserial primary key,
  record_id uuid not null,
  chain_id text not null,
  version int not null,
  signer_member_id uuid not null,
  signer_label text,
  signed_at timestamptz not null,
  content_hash text not null,
  evidence_hash text not null,
  db_user text not null default session_user,
  client_addr inet default inet_client_addr(),
  app_name text default current_setting('application_name', true),
  txid bigint not null default txid_current(),
  logged_at timestamptz not null default clock_timestamp()
);
create unique index if not exists signature_record on chart_audit.signature(record_id);
-- 같은 묶음의 같은 판은 하나만(동시에 두 수정본을 서명해도 하나만 남는다)
create unique index if not exists signature_chain_version on chart_audit.signature(chain_id, version);

-- 변경 기록(내용 없이 바뀐 칸 이름만). 거부된 시도는 트랜잭션과 함께 사라지므로 DB 로그(pgaudit)에 남는다.
create table if not exists chart_audit.change_log (
  id bigserial primary key,
  op text not null,
  record_id uuid not null,
  record_status text,
  actor_source text,
  actor_member_id uuid,
  changed text[],
  db_user text not null default session_user,
  client_addr inet default inet_client_addr(),
  app_name text default current_setting('application_name', true),
  txid bigint not null default txid_current(),
  logged_at timestamptz not null default clock_timestamp()
);
create index if not exists change_log_record on chart_audit.change_log(record_id);

create or replace function chart_audit.append_only() returns trigger language plpgsql as $$
begin
  raise exception 'chart_audit.% 는 덧붙이기만 할 수 있습니다', tg_table_name using errcode = '42501';
end $$;
do $$ declare t text; begin
  foreach t in array array['signature', 'change_log', 'signer'] loop
    execute format('drop trigger if exists append_only on chart_audit.%I', t);
  end loop;
  foreach t in array array['signature', 'change_log'] loop
    execute format('create trigger append_only before update or delete or truncate on chart_audit.%I for each statement execute function chart_audit.append_only()', t);
  end loop;
end $$;

-- 해시 규칙: JSON 배열 [[칸, 값], ...] (공백 없음), 빈 값은 "", 일시는 UTC ISO(밀리초), 숫자는 문자열
create or replace function chart_audit.iso(t timestamptz) returns text language sql immutable as $$
  select case when t is null then '' else to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
$$;
create or replace function chart_audit.num(n double precision) returns text language sql immutable as $$
  select case when n is null then '' when n = trunc(n) then trunc(n)::bigint::text else n::text end
$$;
create or replace function chart_audit.canonical(r jsonb) returns text language sql immutable as $$
  select '[' || string_agg('[' || to_json(k)::text || ',' || to_json(coalesce(v, ''))::text || ']', ',' order by o) || ']'
  from (values
    (1, 'customerId', r->>'customerId'), (2, 'appointmentId', r->>'appointmentId'), (3, 'doctorId', r->>'doctorId'),
    (4, 'visitAt', chart_audit.iso((r->>'visitAt')::timestamptz)),
    (5, 'chiefComplaint', r->>'chiefComplaint'), (6, 'history', r->>'history'), (7, 'findings', r->>'findings'),
    (8, 'diagnosis', r->>'diagnosis'), (9, 'treatment', r->>'treatment'), (10, 'prescriptionNote', r->>'prescriptionNote'),
    (11, 'carePlan', r->>'carePlan'), (12, 'chainId', r->>'chainId'), (13, 'version', chart_audit.num((r->>'version')::double precision)),
    (14, 'supersedes', r->>'supersedes'), (15, 'amendReason', r->>'amendReason'),
    (16, 'signedAt', chart_audit.iso((r->>'signedAt')::timestamptz))
  ) as f(o, k, v)
$$;
create or replace function chart_audit.content_hash(r jsonb) returns text language sql immutable as $$
  select encode(digest(convert_to(chart_audit.canonical(r), 'UTF8'), 'sha256'), 'hex')
$$;

-- 서명한 기록에서 바뀌어도 되는 칸(Twenty가 채우는 수정자·시각·정렬·검색 칸)
create or replace function chart_audit.volatile_cols() returns text[] language sql immutable as $$
  select array['updatedAt', 'updatedBySource', 'updatedByWorkspaceMemberId', 'updatedByName', 'updatedByContext', 'position', 'searchVector']
$$;
create or replace function chart_audit.diff(a jsonb, b jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}') from (
    select key as k from jsonb_each(coalesce(a, '{}')) union select key from jsonb_each(coalesce(b, '{}'))
  ) keys where (a->k) is distinct from (b->k)
$$;

create or replace function chart_audit.guard() returns trigger language plpgsql as $$
declare
  n jsonb; o jsonb; changed text[]; src text; actor uuid; prev record; computed text; missing text[]; signer record;
  signing boolean;
begin
  if tg_op = 'DELETE' then
    if old."recordStatus"::text = 'SIGNED' then
      raise exception '서명한 진료기록은 지울 수 없습니다(기록 %)', old.id using errcode = '42501';
    end if;
    insert into chart_audit.change_log(op, record_id, record_status, changed) values ('DELETE', old.id, old."recordStatus"::text, '{}');
    return old;
  end if;

  n := to_jsonb(new);
  o := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  changed := chart_audit.diff(o - chart_audit.volatile_cols(), case when o is null then jsonb_strip_nulls(n) else n end - chart_audit.volatile_cols());
  src := coalesce(n->>'updatedBySource', n->>'createdBySource');
  actor := coalesce((n->>'updatedByWorkspaceMemberId')::uuid, (n->>'createdByWorkspaceMemberId')::uuid);
  if tg_op = 'INSERT' then
    src := coalesce(n->>'createdBySource', src);
    actor := coalesce((n->>'createdByWorkspaceMemberId')::uuid, actor);
  end if;

  -- 사람이 아닌 계정(API 키·워크플로·시스템)은 봉인 칸만
  if coalesce(src, '') <> 'MANUAL' then
    if tg_op = 'INSERT' or not (changed <@ array['sealedAt', 'sealNo']) then
      raise exception '진료기록 내용은 사람 계정으로만 쓸 수 있습니다(%: %)', coalesce(src, '알 수 없음'), array_to_string(changed, ',') using errcode = '42501';
    end if;
  end if;

  -- 서명한 기록: 봉인 칸을 처음 채우는 것 말고는 바꿀 수 없다
  if tg_op = 'UPDATE' and old."recordStatus"::text = 'SIGNED' then
    if not (changed <@ array['sealedAt', 'sealNo']) then
      raise exception '서명한 진료기록은 고칠 수 없습니다. 새 판을 만드세요(바뀐 칸: %)', array_to_string(changed, ',') using errcode = '42501';
    end if;
    if (old."sealNo" is not null and 'sealNo' = any(changed)) or (old."sealedAt" is not null and 'sealedAt' = any(changed)) then
      raise exception '봉인 정보는 한 번만 채울 수 있습니다' using errcode = '42501';
    end if;
  end if;

  -- NULL 상태에서 SIGNED로 바뀌는 경우도 서명으로 본다(NULL 비교로 검사를 건너뛰지 않게)
  signing := coalesce(new."recordStatus"::text = 'SIGNED', false) and (tg_op = 'INSERT' or old."recordStatus"::text is distinct from 'SIGNED');
  if tg_op = 'INSERT' and (new."sealedAt" is not null or new."sealNo" is not null) then
    raise exception '봉인 정보는 봉인 작업만 채웁니다' using errcode = '42501';
  end if;

  if signing then
    select * into signer from chart_audit.signer where member_id = new."doctorId";
    if new."doctorId" is null or actor is distinct from new."doctorId" then
      raise exception '서명은 진료의 본인 계정으로만 할 수 있습니다' using errcode = '42501';
    end if;
    if signer is null then
      raise exception '서명 권한이 있는 원장 계정이 아닙니다' using errcode = '42501';
    end if;
    missing := array_remove(array[
      case when new."customerId" is null then '환자' end,
      case when new."visitAt" is null then '진료 일시' end,
      case when coalesce(btrim(new."chiefComplaint"), '') = '' then '주된 증상' end,
      case when coalesce(btrim(new."diagnosis"), '') = '' then '진단' end,
      case when coalesce(btrim(new."treatment"), '') = '' then '치료 내용' end
    ], null);
    if array_length(missing, 1) > 0 then
      raise exception '필수항목이 비어 서명할 수 없습니다: %', array_to_string(missing, ', ') using errcode = '23514';
    end if;
    if new."signedAt" is null or abs(extract(epoch from (new."signedAt" - now()))) > 300 then
      raise exception '서명 일시가 서버 시각과 맞지 않습니다' using errcode = '23514';
    end if;
    if coalesce(new."chainId", '') = '' or coalesce(new."version", 0) < 1 then
      raise exception '기록 묶음·판 번호가 없습니다' using errcode = '23514';
    end if;
    if new."supersedes" is not null and new."supersedes" <> '' then
      execute format('select id, "recordStatus"::text as st, "chainId", "version" from %I.%I where id::text = $1', tg_table_schema, tg_table_name)
        into prev using new."supersedes";
      if prev is null or prev.st is distinct from 'SIGNED' or prev."chainId" is distinct from new."chainId" or prev."version" + 1 is distinct from new."version" then
        raise exception '앞 판과 이어지지 않는 새 판입니다' using errcode = '23514';
      end if;
      if coalesce(btrim(new."amendReason"), '') = '' then
        raise exception '새 판에는 수정 사유가 필요합니다' using errcode = '23514';
      end if;
    elsif new."version" <> 1 then
      raise exception '첫 판이 아닌데 앞 판이 없습니다' using errcode = '23514';
    end if;
    perform 1 from chart_audit.signature s where s.chain_id = new."chainId" and s.version = new."version"::int;
    if found then
      raise exception '같은 판 번호가 이미 서명되어 있습니다' using errcode = '23505';
    end if;
    computed := chart_audit.content_hash(n);
    if new."contentHash" is distinct from computed then
      raise exception '서명 해시가 서버에서 계산한 값과 다릅니다' using errcode = '23514';
    end if;
    insert into chart_audit.signature(record_id, chain_id, version, signer_member_id, signer_label, signed_at, content_hash, evidence_hash)
    values (new.id, new."chainId", new."version"::int, new."doctorId", signer.label, new."signedAt", computed,
      encode(digest(convert_to(json_build_array(new.id::text, new."doctorId"::text, chart_audit.iso(new."signedAt"), new."version"::int, computed)::text, 'UTF8'), 'sha256'), 'hex'));
  end if;

  insert into chart_audit.change_log(op, record_id, record_status, actor_source, actor_member_id, changed)
  values (tg_op, new.id, new."recordStatus"::text, src, actor, changed);
  return new;
end $$;

-- 저장된 기록의 서명 검증: 지금 내용 해시 = 서명 때 해시 = 서명 증거
create or replace function chart_audit.verify_record(r jsonb) returns table(ok boolean, reason text) language sql stable as $$
  select
    s.id is not null and chart_audit.content_hash(r) = s.content_hash and r->>'contentHash' = s.content_hash
      and s.signer_member_id::text = r->>'doctorId' and chart_audit.iso((r->>'signedAt')::timestamptz) = chart_audit.iso(s.signed_at),
    case
      when s.id is null then '서명 증거 없음'
      when chart_audit.content_hash(r) <> s.content_hash then '서명 뒤 내용이 바뀜'
      when r->>'contentHash' is distinct from s.content_hash then '서명 해시 칸이 바뀜'
      when s.signer_member_id::text is distinct from r->>'doctorId' then '서명자가 바뀜'
      else 'ok' end
  from (select 1) one left join chart_audit.signature s on s.record_id = (r->>'id')::uuid
$$;

drop trigger if exists chart_guard on :"ws"."_medicalRecord";
create trigger chart_guard before insert or update or delete on :"ws"."_medicalRecord"
  for each row execute function chart_audit.guard();

-- 이미 서명돼 있던 기록(트리거 전)은 증거를 소급해 만든다(내용 해시가 맞는 것만, 표시: db_user=backfill)
insert into chart_audit.signature(record_id, chain_id, version, signer_member_id, signer_label, signed_at, content_hash, evidence_hash, db_user)
select m.id, m."chainId", m."version"::int, m."doctorId", 'backfill', m."signedAt", m."contentHash",
  encode(digest(convert_to(json_build_array(m.id::text, m."doctorId"::text, chart_audit.iso(m."signedAt"), m."version"::int, m."contentHash")::text, 'UTF8'), 'sha256'), 'hex'), 'backfill'
from :"ws"."_medicalRecord" m
where m."recordStatus"::text = 'SIGNED' and m."doctorId" is not null and m."contentHash" = chart_audit.content_hash(to_jsonb(m))
  and not exists (select 1 from chart_audit.signature s where s.record_id = m.id);

-- DB 감사 로그(pgaudit): 진료기록·감사 테이블에 대한 모든 조회·수정을 DB 로그에 남긴다(앱·관리자 직접 접근 모두).
-- crm의 twenty-db가 pgaudit을 불러온 경우에만(shared_preload_libraries). 없으면 건너뛴다.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'auditor') then create role auditor nologin; end if;
  if current_setting('shared_preload_libraries', true) like '%pgaudit%' then
    create extension if not exists pgaudit;
    raise notice 'pgaudit: 진료기록 테이블 접근을 DB 로그에 남깁니다';
  else
    raise warning 'pgaudit이 없습니다. crm의 twenty-db를 crm/twenty-db:local 이미지로 바꾸세요(DB 직접 접근 기록이 남지 않음)';
  end if;
end $$;
grant select, insert, update, delete on :"ws"."_medicalRecord" to auditor;
grant select, insert, update, delete on chart_audit.signer, chart_audit.signature, chart_audit.change_log to auditor;
