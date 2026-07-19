-- English Camp / Group Class MVP schema
-- Run this in Supabase SQL Editor.
-- Existing 1v1 Free Trial / Regular Lesson data stays in Google Sheets.

create extension if not exists "pgcrypto";

create table if not exists group_classes (
  id uuid primary key default gen_random_uuid(),
  class_key text not null unique,
  title text not null,
  description text,
  status text not null default 'open' check (status in ('draft','open','closed','completed')),
  timezone text not null default 'Europe/London',
  max_seats_per_session integer not null default 6,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists group_sessions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references group_classes(id) on delete cascade,
  session_key text not null,
  session_number integer not null,
  title text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  display_time text not null,
  camp_time text not null default 'camp_time_a' check (camp_time in ('camp_time_a','camp_time_b')),
  capacity integer not null default 6,
  created_at timestamptz not null default now(),
  unique (class_id, session_key),
  unique (class_id, camp_time, session_number)
);

create table if not exists group_registrations (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references group_classes(id) on delete cascade,
  student_name text not null,
  student_email text not null,
  level text,
  learning_goal text,
  camp_time text not null default 'camp_time_a' check (camp_time in ('camp_time_a','camp_time_b')),
  pass_type text not null check (pass_type in ('three_session_pass','five_session_pass')),
  status text not null default 'pending_payment' check (status in ('pending_payment','pending_review','confirmed','approved','waitlisted','rejected','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','refunded')),
  pass_price numeric(10,2),
  price_per_session numeric(10,2),
  currency text not null default 'GBP',
  teacher_notes text,
  student_confirmed_email_sent_at timestamptz,
  teacher_paid_email_sent_at timestamptz,
  student_cancelled_email_sent_at timestamptz,
  review_token text not null default encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists group_registration_sessions (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references group_registrations(id) on delete cascade,
  session_id uuid not null references group_sessions(id) on delete cascade,
  selection_status text not null default 'requested' check (selection_status in ('requested','approved','waitlisted','cancelled')),
  created_at timestamptz not null default now(),
  unique (registration_id, session_id)
);

create index if not exists idx_group_sessions_class_id on group_sessions(class_id);
create index if not exists idx_group_registrations_class_id on group_registrations(class_id);
create index if not exists idx_group_registrations_status on group_registrations(status);
create index if not exists idx_group_registration_sessions_registration_id on group_registration_sessions(registration_id);
create index if not exists idx_group_registration_sessions_session_id on group_registration_sessions(session_id);

-- Prevent duplicate active English Camp requests from the same email in the same class.
-- Rejected or cancelled requests are excluded, so the student can book again after teacher rejection/cancellation.
create unique index if not exists idx_unique_active_group_registration_email
  on group_registrations (class_id, lower(student_email))
  where status not in ('rejected','cancelled');


insert into group_classes (class_key, title, description, status, timezone, max_seats_per_session)
values (
  'english-camp-mvp',
  'English Camp 5-Session Speaking Mini Course',
  'Small-group English Camp with 3-session and 5-session pass options.',
  'open',
  'Europe/London',
  6
)
on conflict (class_key) do update set
  title = excluded.title,
  description = excluded.description,
  status = excluded.status,
  timezone = excluded.timezone,
  max_seats_per_session = excluded.max_seats_per_session,
  updated_at = now();

-- Safe migration for projects that already ran an earlier MVP group_sessions schema.
alter table if exists group_sessions
  add column if not exists camp_time text not null default 'camp_time_a';

alter table if exists group_sessions
  drop constraint if exists group_sessions_class_id_session_number_key;

alter table if exists group_sessions
  drop constraint if exists group_sessions_camp_time_check;

alter table if exists group_sessions
  add constraint group_sessions_camp_time_check
  check (camp_time in ('camp_time_a','camp_time_b'));

create unique index if not exists idx_unique_group_sessions_class_camp_time_number
  on group_sessions (class_id, camp_time, session_number);

with selected_class as (
  select id from group_classes where class_key = 'english-camp-mvp'
)
update group_sessions
set camp_time = 'camp_time_a',
    session_key = case session_number
      when 1 then 'camp-a-session-1'
      when 2 then 'camp-a-session-2'
      when 3 then 'camp-a-session-3'
      when 4 then 'camp-a-session-4'
      when 5 then 'camp-a-session-5'
      else session_key
    end,
    display_time = case session_number
      when 1 then 'Monday · 13:00–13:45 UK time'
      when 2 then 'Tuesday · 13:00–13:45 UK time'
      when 3 then 'Wednesday · 13:00–13:45 UK time'
      when 4 then 'Thursday · 13:00–13:45 UK time'
      when 5 then 'Friday · 13:00–13:45 UK time'
      else display_time
    end
where class_id in (select id from selected_class)
  and session_key in ('session-1','session-2','session-3','session-4','session-5');

with selected_class as (
  select id from group_classes where class_key = 'english-camp-mvp'
)
insert into group_sessions (class_id, session_key, session_number, title, display_time, camp_time, capacity)
select selected_class.id, session_key, session_number, title, display_time, camp_time, 6
from selected_class
cross join (values
  ('camp-a-session-1', 1, 'Session 1', 'Monday · 13:00–13:45 UK time', 'camp_time_a'),
  ('camp-a-session-2', 2, 'Session 2', 'Tuesday · 13:00–13:45 UK time', 'camp_time_a'),
  ('camp-a-session-3', 3, 'Session 3', 'Wednesday · 13:00–13:45 UK time', 'camp_time_a'),
  ('camp-a-session-4', 4, 'Session 4', 'Thursday · 13:00–13:45 UK time', 'camp_time_a'),
  ('camp-a-session-5', 5, 'Session 5', 'Friday · 13:00–13:45 UK time', 'camp_time_a'),
  ('camp-b-session-1', 1, 'Session 1', 'Monday · 19:00–19:45 UK time', 'camp_time_b'),
  ('camp-b-session-2', 2, 'Session 2', 'Tuesday · 19:00–19:45 UK time', 'camp_time_b'),
  ('camp-b-session-3', 3, 'Session 3', 'Wednesday · 19:00–19:45 UK time', 'camp_time_b'),
  ('camp-b-session-4', 4, 'Session 4', 'Thursday · 19:00–19:45 UK time', 'camp_time_b'),
  ('camp-b-session-5', 5, 'Session 5', 'Friday · 19:00–19:45 UK time', 'camp_time_b')
) as seed(session_key, session_number, title, display_time, camp_time)
on conflict (class_id, session_key) do update set
  session_number = excluded.session_number,
  title = excluded.title,
  display_time = excluded.display_time,
  camp_time = excluded.camp_time,
  capacity = excluded.capacity;


-- Safe migration for projects that already ran an earlier MVP schema.
alter table if exists group_registrations
  drop constraint if exists group_registrations_pass_type_check;

alter table if exists group_registrations
  add constraint group_registrations_pass_type_check
  check (pass_type in ('three_session_pass','five_session_pass'));

alter table if exists group_registrations
  add column if not exists camp_time text not null default 'camp_time_a',
  add column if not exists pass_price numeric(10,2),
  add column if not exists price_per_session numeric(10,2),
  add column if not exists currency text not null default 'GBP';

alter table if exists group_registrations
  drop constraint if exists group_registrations_camp_time_check;

alter table if exists group_registrations
  add constraint group_registrations_camp_time_check
  check (camp_time in ('camp_time_a','camp_time_b'));

alter table if exists group_registrations
  drop constraint if exists group_registrations_status_check;

alter table if exists group_registrations
  alter column status set default 'pending_payment';

alter table if exists group_registrations
  add constraint group_registrations_status_check
  check (status in ('pending_payment','pending_review','confirmed','approved','waitlisted','rejected','cancelled'));

alter table if exists group_registrations
  add column if not exists student_confirmed_email_sent_at timestamptz,
  add column if not exists teacher_paid_email_sent_at timestamptz,
  add column if not exists student_cancelled_email_sent_at timestamptz;

update group_registrations
set status = 'pending_payment', updated_at = now()
where status = 'pending_review' and payment_status <> 'paid';

update group_registrations
set status = 'confirmed', updated_at = now()
where status in ('pending_review','approved') and payment_status = 'paid';


-- Keep seeded English Camp session times aligned with Camp A / Camp B.
with selected_class as (
  select id from group_classes where class_key = 'english-camp-mvp'
)
update group_sessions
set display_time = case session_key
  when 'camp-a-session-1' then 'Monday · 13:00–13:45 UK time'
  when 'camp-a-session-2' then 'Tuesday · 13:00–13:45 UK time'
  when 'camp-a-session-3' then 'Wednesday · 13:00–13:45 UK time'
  when 'camp-a-session-4' then 'Thursday · 13:00–13:45 UK time'
  when 'camp-a-session-5' then 'Friday · 13:00–13:45 UK time'
  when 'camp-b-session-1' then 'Monday · 19:00–19:45 UK time'
  when 'camp-b-session-2' then 'Tuesday · 19:00–19:45 UK time'
  when 'camp-b-session-3' then 'Wednesday · 19:00–19:45 UK time'
  when 'camp-b-session-4' then 'Thursday · 19:00–19:45 UK time'
  when 'camp-b-session-5' then 'Friday · 19:00–19:45 UK time'
  else display_time
end
where class_id in (select id from selected_class)
  and session_key in ('camp-a-session-1','camp-a-session-2','camp-a-session-3','camp-a-session-4','camp-a-session-5','camp-b-session-1','camp-b-session-2','camp-b-session-3','camp-b-session-4','camp-b-session-5');
