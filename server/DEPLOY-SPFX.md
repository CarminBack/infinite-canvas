# SPFX Canvas deployment

Build the `deploy/spfx-v019` branch with GitHub Actions. The frontend uses `VITE_BASE=/image/`; the gateway uses `CANVAS_BASE_PATH=/image` and `CANVAS_PUBLIC_ORIGIN=https://spfx.wxkj.one`. Nginx must forward the complete `/image/` prefix, without stripping it; `/image` redirects to `/image/video`.

Set `CANVAS_IMAGE_API_KEY` and `CANVAS_VIDEO_API_KEY` only in the server environment file (mode 0600, never committed). Set image/video upstreams with `IMAGE_API_BASE_URL` and `VIDEO_API_BASE_URL`. Providing both keys enables shared-workbench access without OAuth. The browser receives only same-origin proxy URLs and the literal placeholder `session`; anyone with access to this public workbench can use the shared allowance, as with the previous deployment. Text/audio are not configured.

Use a dedicated persistent data directory for Canvas uploads. Existing limits are unchanged: images 30 MiB, video 50 MiB, audio 15 MiB, uploads retained 7 days. Uploaded URLs include `/image/u/`. Do not modify Agnes `/api/uploads`, `/api/assets`, `/uploads` or `/video` routes. Browser-local project/history storage is retained; no database migration is performed.

Before switching, back up the Nginx vhost and existing container inspection, preserve the old image/container and record the new immutable revision. Run `nginx -t`, verify the candidate health/model catalogs/static assets/reference upload without paid generation, then switch only the Canvas upstream. Roll back the Nginx vhost and old upstream immediately if checks fail.
