-- 0028: Renewal follow-ups and the sign-up funnel. Additive, re-runnable.

-- Offsets: vehicle tax now reminds on the due day too; insurance gets a 3-day
-- reminder (a policy must not lapse) and a due-day one.
update document_templates set default_offsets = '{43200,10080,1440,0}' where slug = 'vehicle-tax' and not (0 = any(default_offsets));
update document_templates set default_offsets = '{43200,10080,4320,1440,0}' where slug = 'vehicle-insurance' and not (4320 = any(default_offsets));
update document_templates set default_offsets = '{43200,10080,1440,0}' where slug in ('health-insurance','life-insurance','other-policy') and not (0 = any(default_offsets));

-- Where a sign-up came from (utm_source / referral code captured on the first visit).
alter table users add column if not exists signup_source text;

-- "Did you renew?" follow-ups look up the latest renewal per record.
create index if not exists renewal_history_renewal_idx on renewal_history (renewal_id, created_at desc);
