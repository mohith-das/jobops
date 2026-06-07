-- 004: track where the active career_packet came from, so a reseed (cv.md → packet) never
-- silently overwrites edits made via chat (update_career_packet).
--
--   origin = 'seed'      → first-run seed
--            'reseed'    → rebuilt from cv.md + config/profile.yml
--            'chat_edit' → written via update_career_packet (chat is the edit surface)
--
-- A 'chat_edit' active packet is "ahead of cv.md" on purpose; reseed must require an
-- explicit force to replace it (see core/profile.ts seedCareerPacketFromFiles).

ALTER TABLE career_packet ADD COLUMN origin TEXT NOT NULL DEFAULT 'reseed';

-- Protect whatever packet is active at upgrade time. This feature exists precisely because
-- chat edits were being lost, so we assume the current active row may hold chat edits and
-- mark it user-edited — the first post-upgrade reseed then warns instead of clobbering.
-- NOTE: on a brand-new DB this migration runs BEFORE any packet is seeded, so there is no
-- active row yet and this UPDATE is a no-op — new installs start clean at 'reseed'/'seed'.
UPDATE career_packet SET origin = 'chat_edit' WHERE is_active = 1;
