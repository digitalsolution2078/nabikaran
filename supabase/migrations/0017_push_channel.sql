-- 0017: Free app (push) notification as a reminder channel, for every plan.
-- A push reminder costs nothing: its job is scheduled without a credit
-- reservation and the dispatcher sends it as a web push. Additive, re-runnable.

do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'renewal_items'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'channels'
  loop execute format('alter table renewal_items drop constraint %I', c.conname); end loop;
  alter table renewal_items add constraint renewal_items_channels_check
    check (cardinality(channels) between 1 and 4 and channels <@ array['sms','whatsapp','email','push']::text[]);

  for c in select conname from pg_constraint where conrelid = 'reminder_jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'channel'
  loop execute format('alter table reminder_jobs drop constraint %I', c.conname); end loop;
  alter table reminder_jobs add constraint reminder_jobs_channel_check check (channel in ('sms','whatsapp','email','push'));
end $$;

create or replace function wallet_reserve_for_job(p_job_id uuid) returns text language plpgsql as $$
declare j reminder_jobs; w wallets; r credit_reservations; has_r boolean; active_r boolean;
        avail bigint; delta bigint; pid uuid; units int;
begin
  select * into j from reminder_jobs where id = p_job_id for update;
  if not found then raise exception 'job not found'; end if;
  if j.status not in ('planned','awaiting_credits','scheduled') then
    return j.status;
  end if;
  -- App (push) notifications are free: no credits, no included messages, never blocked.
  if j.channel = 'push' then
    update reminder_jobs set status = 'scheduled', last_error = null, updated_at = now() where id = j.id;
    return 'scheduled';
  end if;
  w := wallet_lock(j.user_id);
  units := greatest(j.estimated_segments, 1);
  select * into r from credit_reservations where reminder_job_id = j.id for update;
  has_r := found;
  active_r := has_r and r.status = 'active';

  -- An included-message hold: keep it when the size is unchanged, otherwise return it first.
  if active_r and r.allowance_units > 0 then
    if r.allowance_units = units then
      update reminder_jobs set status = 'scheduled', updated_at = now() where id = j.id;
      return 'scheduled';
    end if;
    update plan_allowances set reserved = greatest(reserved - r.allowance_units, 0)
     where user_plan_id = r.allowance_plan_id and channel = j.channel;
    update credit_reservations set status = 'released', released_at = now(), allowance_units = 0, allowance_plan_id = null where id = r.id;
    active_r := false;
  end if;

  -- Pro: included messages first.
  if not active_r then
    pid := plan_allowance_pick(j.user_id, j.channel, units, j.due_at_utc);
    if pid is not null then
      update plan_allowances set reserved = reserved + units where user_plan_id = pid and channel = j.channel;
      if has_r then
        update credit_reservations set held_credits = 0, status = 'active', released_at = null, allowance_plan_id = pid, allowance_units = units where id = r.id;
      else
        insert into credit_reservations (reminder_job_id, user_id, held_credits, allowance_plan_id, allowance_units)
          values (j.id, j.user_id, 0, pid, units);
      end if;
      update reminder_jobs set status = 'scheduled', updated_at = now() where id = j.id;
      return 'scheduled';
    end if;
  end if;

  -- Included messages used up while Pro is active: credits only with the customer's
  -- permission (asked when saving, or "use credits automatically" in Pro settings).
  if not active_r
     and coalesce(current_setting('nabikaran.allow_credits', true), '') <> 'on'
     and not coalesce((select u.pro_credit_fallback from users u where u.id = j.user_id), false)
     and exists (select 1 from user_plans p join plan_allowances a on a.user_plan_id = p.id and a.channel = j.channel
                  where p.user_id = j.user_id and p.status = 'active' and p.kind in ('paid','grant')
                    and p.starts_at <= now() and p.ends_at > now() and j.due_at_utc < p.ends_at and a.granted > 0) then
    update reminder_jobs set status = 'awaiting_credits', last_error = 'included messages used up: allow wallet credits', updated_at = now() where id = j.id;
    return 'needs_permission';
  end if;

  -- Credits (unchanged behaviour).
  if active_r then
    delta := j.estimated_credits - r.held_credits;
  else
    delta := j.estimated_credits;
  end if;
  avail := w.posted_balance_credits - w.reserved_credits;
  if delta > avail then
    update reminder_jobs set status = 'awaiting_credits', updated_at = now() where id = j.id;
    return 'awaiting_credits';
  end if;
  if active_r then
    update credit_reservations set held_credits = j.estimated_credits where id = r.id;
  elsif has_r then
    update credit_reservations set held_credits = j.estimated_credits, status = 'active', released_at = null, allowance_units = 0, allowance_plan_id = null where id = r.id;
  else
    insert into credit_reservations (reminder_job_id, user_id, held_credits) values (j.id, j.user_id, j.estimated_credits);
  end if;
  update wallets set reserved_credits = reserved_credits + delta, version = version + 1, updated_at = now()
    where user_id = j.user_id;
  update reminder_jobs set status = 'scheduled', last_error = null, updated_at = now() where id = j.id;
  return 'scheduled';
end $$;
