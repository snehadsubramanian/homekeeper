-- Step 7: deleting a duty hides it but keeps its history (decided Nov 23, 2026).
-- A deleted duty has deleted_at set (UTC ISO timestamp); its open occurrence is
-- cancelled and its Google task removed. Completed occurrences stay.
ALTER TABLE duties ADD COLUMN deleted_at TEXT;
