-- Staging only. Do NOT execute against the production database.
-- Disable the real merchant QR seeded by the application migrations.
update app_settings set value = jsonb_set(value, '{enabled}', 'false'::jsonb)
where key = 'manual_qr';
update app_settings set value = jsonb_set(value, '{enabled}', 'false'::jsonb)
where key = 'whatsapp';
