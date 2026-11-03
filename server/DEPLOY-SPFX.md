# SPFX Canvas deployment

Build the `deploy/spfx-v019` branch with GitHub Actions. The frontend uses `VITE_BASE=/image/`; the gateway uses `CANVAS_BASE_PATH=/image` and `CANVAS_PUBLIC_ORIGIN=https://spfx.wxkj.one`. Nginx must forward the complete `/image/` prefix, without stripping it; `/image` redirects to `/image/video`.

Set `CANVAS_IMAGE_API_KEY` and `CANVAS_VIDEO_API_KEY` only in the server environment file (mode 0600, never committed). Set image/video upstreams with `IMAGE_API_BASE_URL` and `VIDEO_API_BASE_URL`. Providing both keys enables shared-workbench access without OAuth. The browser receives only same-origin proxy URLs and the literal placeholder `session`; anyone with access to this public workbench can use the shared allowance, as with the previous deployment. Text/audio are not configured.

Use a dedicated persistent data directory for Canvas uploads. Existing limits are unchanged: images 30 MiB, video 50 MiB, audio 15 MiB, uploads retained 7 days. Uploaded URLs include `/image/u/`. Do not modify Agnes `/api/uploads`, `/api/assets`, `/uploads` or `/video` routes. Browser-local project/history storage is retained; no database migration is performed.

Before switching, back up the Nginx vhost and existing container inspection, preserve the old image/container and record the new immutable revision. Run `nginx -t`, verify the candidate health/model catalogs/static assets/reference upload without paid generation, then switch only the Canvas upstream. Roll back the Nginx vhost and old upstream immediately if checks fail.

## Media-stream hotfix acceptance

The deployed application revision is `0e56f6d5af72ed26ce720d5d0d05aeec68b789da`, pinned to `ghcr.io/carminback/infinite-canvas-image@sha256:bc9847df2efeca3a84034fb22faf8fd8a5f952dcadd4ae734d800849f5522bb3`. Only the Canvas container at `127.0.0.1:3005` was replaced; Nginx configuration/master, effective environment, persistent mount, and unrelated containers remain unchanged. The previous container `infinite-canvas-spfx-7f32ac2` is retained stopped.

Protected backups and release evidence are in `/root/infinite-canvas-spfx/backups/stream-fix-20261103T132029Z/`: consistent SQLite backup, upload-file archive, effective environment, original Nginx/container inspections, deployment helper, and final verification. Backups contain server-only credentials and must remain private. Do not restore old business data for application rollback.

Both existing completed tasks were downloaded through the public SPFX `/image/` entry with matching SHA-256 hashes and byte counts (38,164,617 and 45,039,993). Chrome fetched the complete blobs and played both 720×1280, 30.048-second videos with `readyState=4`, decoded frames and no media error. A controlled cancellation did not interrupt its sibling download or restart the new container. Session/catalog/pages, desktop/mobile views, SQLite contents and all 23 upload-file hashes passed; no paid generation was submitted.

Historical failed-download messages are stored in the user's browser. Reload the page and use the existing task's result-retrieval retry; do not submit a new generation to recover these videos.

For a later rollback, obtain fresh production confirmation first, then use the retained deployment helper's `rollback --backup /root/infinite-canvas-spfx/backups/stream-fix-20261103T132029Z` phase. It stops only the candidate and restarts the retained original container on the same port without restoring the database, uploads or Nginx configuration.
