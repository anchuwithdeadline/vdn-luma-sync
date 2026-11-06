# VDN Luma to Discord Event Sync

Syncs only upcoming public events from Luma Calendar (`cal-4yoBq2YOKfqCfBj`) to Discord Scheduled Events in the Vietnam Debate Network server. An eligible event must explicitly have `visibility: public` and a valid start time strictly later than the sync run's current time. Private, unlisted, unknown-visibility, past, already-started, and invalid-date events are skipped for both creation and updates.

Existing scheduled external events are matched by their Luma registration URL, treating `lu.ma` and `luma.com` as equivalent hosts and ignoring URL query strings. A matching event keeps its Discord ID and receives the current name, description, times, location, and cover image when available. Updates do not post another announcement.

For older Discord entries without a Luma URL, matching falls back to the event name. Events with a different Luma URL are not matched by name. Ambiguous matches and failed Discord reads or updates fail the run. Active, completed, and cancelled entries are left unchanged.

New events are created and announced with the existing `@everyone` notification. The registration URL is always retained at the end of the description so long descriptions cannot break future matching. This sync does not delete Discord events or remove a cover when Luma has no cover.

GitHub Actions runs every Thursday at 09:00 Asia/Saigon (`0 2 * * 4`) and supports manual runs. Run `node --test` locally to check matching and update behavior without contacting live services.
