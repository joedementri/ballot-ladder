# Test fixtures

## `save-v1.json.gz`

A real version 1 save (the format before M12), used by `test/migrate.test.ts`.

How it was made:
1. On the pre-M12 code (commit `87b9334`), seed 2024: a Democrat from Harrisburg, PA was installed as their state representative. The script introduced an education bill, took option 0 on every decision and played 14 months (to March 2026).
2. To keep the file small, the save was pruned to Pennsylvania's offices (plus President and Vice President) and the politicians they reference. The engine materializes other offices lazily from `seed|officeId`.
3. Every field added in M7–M11 was then deleted, so the file has the oldest version 1 shape:
   - game: `difficulty`, `monthStart`, `lastSummary`, `leadership`, `vacancies`, `specials`, `startYear`, `tickets`, `rivals`, `redistricting`
   - player: `log`, `favors`, `role`, `bid`, `committees`, `bills`, `budget`, `policies`
   - world: `policy`, `fiscal`
   - politicians: `notable`, `ambition`
4. The news list was trimmed to 40 items, and the JSON was gzipped.

Don't regenerate it with current code: it has to stay a version 1 save. When the format changes again (`SAVE_VERSION` 3), add a `save-v2.json.gz` next to it rather than replacing it.
