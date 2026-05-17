# OfficePilot — Ubuntu 22.04 VPS Deployment Runbook

> **Audience:** Lal Singh (reviewer/operator) — and anyone bringing OfficePilot up on a fresh Ubuntu 22.04 VPS.
>
> This runbook is the canonical step-by-step companion to **SPEC.md §17**. Commands are copy-paste-able; every section is numbered so you can resume where you left off. The target host is `office.chitly.live`.

---

## 0. Server prerequisites

Confirm (or plan to install) the following before running any of the steps below:

- [ ] Ubuntu 22.04 LTS (fresh VPS, root or sudo-enabled user)
- [ ] Node.js 20.x LTS (NodeSource setup — installed in §1)
- [ ] PostgreSQL 15+ (installed in §2)
- [ ] Nginx (installed in §3)
- [ ] Certbot with the Nginx plugin for Let's Encrypt (installed in §4)
- [ ] PM2 process manager — `npm i -g pm2` (installed in §5)
- [ ] Domain `office.chitly.live` with an `A` record pointing to the VPS public IP (verify with `dig +short office.chitly.live`)

Tip: SSH in as a non-root sudoer. Every command below assumes you are that user unless it begins with `sudo -u postgres` or similar.

---

## 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verify:

```bash
node -v   # should print v20.x.x
npm -v
```

---

## 2. Install PostgreSQL 15

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
```

Verify the server is running and you can list databases:

```bash
sudo systemctl status postgresql --no-pager
sudo -u postgres psql -c '\l'
```

> If `apt` ships an older Postgres on your image, add the official PGDG repo (https://wiki.postgresql.org/wiki/Apt) before `apt install`.

---

## 3. Install Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

Sanity check: `curl -I http://localhost/` should return `HTTP/1.1 200 OK` from the default site.

---

## 4. Install Certbot (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
```

We'll run `certbot --nginx` later (§16) once the Nginx vhost is configured.

---

## 5. Install PM2

```bash
sudo npm i -g pm2
pm2 -v
```

PM2 will run two processes per `ecosystem.config.js`: `officepilot-web` (Next.js) and `officepilot-cron` (the cron worker). See SPEC §17.3.

---

## 6. Clone the repository

```bash
cd /var/www
sudo git clone <your-repo-url> officepilot
sudo chown -R $USER:$USER officepilot
cd officepilot
```

Replace `<your-repo-url>` with the actual git URL (e.g., `git@github.com:chitly/officepilot.git`).

---

## 7. Install dependencies

```bash
npm ci
```

We deliberately install dev dependencies too, because the build pipeline needs `prisma`, `tsx`, and `typescript`.

---

## 8. Set up PostgreSQL

Open a Postgres shell and create the database, role, and grants:

```bash
sudo -u postgres psql
```

Inside `psql`, run:

```sql
CREATE DATABASE officepilot;
CREATE USER officepilot_user WITH PASSWORD 'strong-pass-here';
GRANT ALL ON DATABASE officepilot TO officepilot_user;
\c officepilot
GRANT ALL ON SCHEMA public TO officepilot_user;
\q
```

> Replace `'strong-pass-here'` with a long random password and stash it in your secrets vault — you'll paste it into `DATABASE_URL` in the next step.

---

## 9. Configure `.env.production`

> 🚨 **Security checklist before you start this section:**
>
> - **Never commit `.env.production`** — it is gitignored via `.env*.local` + `.env.production` patterns in `.gitignore`. After this section, run `git status` and confirm it shows as untracked.
> - **Do not reuse your local `.env` secrets.** The local `.env` in the dev workspace is for dev DB only. Generate fresh production secrets with `openssl rand` below.
> - **Rotate `ADMIN_SEED_PASSWORD` immediately after first login.** The seed script uses it to create the initial admin row; after that the password is the bcrypt hash in the DB, but if the seed password leaks before rotation, anyone with the email can sign in.
> - **`chmod 600 .env.production` is enforced** at the end of this section (line ≈ §9 closing). Confirm with `ls -la .env.production` — only the owning user should have read access.

Copy the template and edit it:

```bash
cp .env.example .env.production
nano .env.production
```

Generate strong secrets:

```bash
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -hex 32      # ENCRYPTION_KEY
openssl rand -hex 32      # CRON_SECRET
openssl rand -hex 32      # WEBHOOK_HMAC_SECRET
```

Fill in at minimum:

- `DATABASE_URL=postgresql://officepilot_user:strong-pass-here@localhost:5432/officepilot?schema=public`
- `NEXTAUTH_URL=https://office.chitly.live`
- `NEXTAUTH_SECRET=...` (from `openssl rand -base64 32`)
- `ENCRYPTION_KEY=...` (from `openssl rand -hex 32`)
- `CRON_SECRET=...` (from `openssl rand -hex 32`)
- `WEBHOOK_HMAC_SECRET=...` (from `openssl rand -hex 32`)
- `ANTHROPIC_API_KEY=sk-ant-...` (from https://console.anthropic.com/)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD` (used once in §11 — pick a **long random string**, e.g. `openssl rand -base64 18`, NOT a memorable phrase; rotate via Settings → Profile right after first login)

Lock the file down so only your user can read it:

```bash
chmod 600 .env.production
```

> Next.js automatically loads `.env.production` for `npm run build` and `npm start`. The cron worker is started via PM2 with the same env.

---

## 10. Run database migrations

```bash
npx prisma migrate deploy
```

This applies every committed migration in `prisma/migrations/` to the live database without prompting.

---

## 11. Seed the initial admin user

```bash
ADMIN_SEED_EMAIL=admin@chitly.live \
ADMIN_SEED_PASSWORD='strong-admin-pass' \
npx prisma db seed
```

The seed is idempotent — re-running it won't duplicate the admin row. Rotate the password from **Settings → Account** after first login.

---

## 12. Build the Next.js app

```bash
npm run build
```

This compiles the production bundle into `.next/`. It must succeed with zero TypeScript errors before you start PM2.

---

## 13. Build the cron worker

```bash
npm run worker:build
```

This emits the standalone worker into `dist/worker/` (per `tsconfig.worker.json`) so PM2 can run it as `officepilot-cron`.

---

## 14. Start the app with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

`pm2 startup` prints a `sudo env PATH=... pm2 startup systemd ...` command — copy and run it as instructed so PM2 resurrects on reboot. After that, run `pm2 save` once more to persist the current process list.

Sanity check:

```bash
pm2 status
pm2 logs officepilot-web --lines 50
pm2 logs officepilot-cron --lines 50
```

> The two processes are defined in `ecosystem.config.js` per SPEC §17.3: `officepilot-web` (Next.js, cluster mode) and `officepilot-cron` (the worker that hits `/api/cron/*` on schedule).

---

## 15. Configure Nginx as a reverse proxy

Create `/etc/nginx/sites-available/officepilot`:

```bash
sudo nano /etc/nginx/sites-available/officepilot
```

Paste:

```nginx
server {
  listen 80;
  server_name office.chitly.live;

  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
  }
}
```

Enable the site, validate the config, reload:

```bash
sudo ln -s /etc/nginx/sites-available/officepilot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Browse to `http://office.chitly.live` — you should see the Next.js login page (over plain HTTP, until §16 enables TLS).

---

## 16. Issue an SSL certificate with Certbot

```bash
sudo certbot --nginx -d office.chitly.live
```

Certbot will:

1. Prove ownership over HTTP-01.
2. Rewrite the Nginx vhost to listen on `443` with the freshly issued cert.
3. Add an automatic HTTP→HTTPS redirect.

Certbot installs a systemd timer (`certbot.timer`) that runs `certbot renew` twice daily — auto-renewal is on by default. Verify with:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## 17. Configure the firewall (UFW)

Lock the box down so only SSH, HTTP, and HTTPS reach the public Internet — Nginx is the only path to port 3000:

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw deny 3000
sudo ufw enable
sudo ufw status verbose
```

---

## 18. Configure backups

Daily `pg_dump` to `/var/backups/officepilot/` with 14-day rotation:

```bash
sudo mkdir -p /var/backups/officepilot
sudo chown postgres:postgres /var/backups/officepilot
sudo -u postgres crontab -e
```

Append:

```cron
0 2 * * * pg_dump -U officepilot_user officepilot | gzip > /var/backups/officepilot/officepilot-$(date +\%Y\%m\%d).sql.gz
30 2 * * * find /var/backups/officepilot -mtime +14 -delete
```

> The `\%` escapes are required by `crontab` so `%Y%m%d` reaches `date`. Verify your latest dump is non-empty: `ls -lh /var/backups/officepilot/`.

For off-box durability, sync `/var/backups/officepilot/` to S3/B2 with `rclone` on a separate cron line.

---

## 19. Monitoring and logs

PM2 is your primary observability surface:

```bash
pm2 status                       # process health, CPU, memory, restarts
pm2 logs officepilot-web         # tail Next.js logs
pm2 logs officepilot-cron        # tail cron worker logs
pm2 logs --lines 200             # all processes, last 200 lines
pm2 monit                        # interactive dashboard
```

Nginx and Postgres logs:

```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
sudo journalctl -u postgresql -f
```

---

## 20. Updates / redeploys

Standard zero-friction deploy after pushing to `main`:

```bash
cd /var/www/officepilot
git pull
npm ci
npx prisma migrate deploy
npm run build
npm run worker:build
pm2 reload all
```

`pm2 reload all` performs a zero-downtime restart of both `officepilot-web` (cluster mode rolls workers one by one) and `officepilot-cron`. If a migration is destructive, snapshot the DB first: `sudo -u postgres pg_dump officepilot | gzip > ~/pre-deploy-$(date +%Y%m%d-%H%M).sql.gz`.

---

## 21. Troubleshooting (quick reference)

| Symptom | First thing to check |
| --- | --- |
| **PM2 process keeps restarting** | `pm2 logs <name>` — read the startup error. Common causes: missing env vars in `.env.production`, port 3000 already taken, build artifact missing (`npm run build` / `npm run worker:build`). |
| **Prisma can't connect to Postgres** | Confirm `DATABASE_URL` matches the role/password from §8. Check Postgres is listening: `sudo ss -ltnp | grep 5432`. If you switched to TCP auth, edit `/etc/postgresql/15/main/pg_hba.conf` and reload: `sudo systemctl reload postgresql`. |
| **Nginx returns 502 Bad Gateway** | The upstream Next.js app isn't responding. Verify `pm2 status` shows `officepilot-web` online. Confirm it's bound to `localhost:3000` (`curl -I http://localhost:3000`). Check `/var/log/nginx/error.log` for the exact upstream error. |
| **AI insights fail with auth/credit errors** | The Anthropic key isn't reaching the runtime. Either set `ANTHROPIC_API_KEY` in `.env.production` and `pm2 reload all`, or paste the key into the encrypted `Setting('anthropic_api_key')` row from **Settings → Integrations**. |
| **Cron jobs aren't firing** | `pm2 logs officepilot-cron` should print the schedule on boot and a line per run. Verify `CRON_SECRET` matches what the worker sends in `Authorization: Bearer ...`, and that `CRON_BASE_URL` resolves to the running web process (default `http://localhost:3000`). Confirm `CRON_TIMEZONE=Asia/Kolkata` if `0 9 * * *` should fire at 09:00 IST. |

For anything not in this table, capture `pm2 logs --lines 500` plus the relevant Nginx/Postgres log slice and attach them to the bug report.

---

## 22. Ad-platform integration setup

OfficePilot reads campaign spend / signups from Meta Marketing API and Google Ads. **v0.1.3 stores the credentials only — actual sync ships in v0.1.4.** Pasting credentials now lets you verify them and unblocks the sync wiring later.

All paths below assume you're logged in as an admin at `office.chitly.live/settings`. Sensitive values are AES-256-GCM-encrypted at rest (SPEC §12.2); the GET endpoint returns `***` instead of plaintext.

### 22.1 Meta Ads (Facebook + Instagram)

Both networks share one Meta Business app; you only need one access token.

- **Meta Access Token** — paste a long-lived (System User) token.
  - Quickest: log into <https://developers.facebook.com/tools/explorer/>, pick your Meta Business app, generate a **User Access Token** with the `ads_read` scope, then exchange it for a long-lived token at <https://developers.facebook.com/tools/debug/accesstoken/>.
  - Production: create a **System User** in Business Manager (Business Settings → Users → System users), assign it to your Ad Account with **View performance** access, and generate a token that never expires. Documented at <https://developers.facebook.com/docs/marketing-api/system-users/overview>.
- **Ad Account ID** — `act_<numbers>`. Visible in the URL when you open <https://business.facebook.com/adsmanager> (`?act=…`).
- **Business ID** — optional. Only set this if you proxy calls through a Business Manager parent; we don't use it in v0.1.3.

Paste into **Settings → Meta Ads**, save, then click **Test connection**. Success shows the principal's display name (e.g. "Connected to Meta as Chitly Ads System User").

### 22.2 Google Ads

The first-time setup takes ~30 minutes because the developer-token approval is manual.

- **Developer token** — apply at <https://ads.google.com/aw/apicenter>. You'll get a "test access" token immediately (works against your own customer account) and the **Basic / Standard** approval lands 1-3 weeks later via email. The string is 22 characters.
- **Customer ID** — your 10-digit Google Ads customer ID, format `123-456-7890`. Visible top-right when you're logged into <https://ads.google.com>. Hyphens are stripped on save.
- **OAuth client** — create a Web application OAuth client at <https://console.cloud.google.com/apis/credentials>. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI (needed for the next step). The client ID ends in `.apps.googleusercontent.com`; the secret is a string starting with `GOCSPX-`.
- **Refresh token** — mint via OAuth Playground:
  1. Open <https://developers.google.com/oauthplayground>.
  2. Click the gear → check **Use your own OAuth credentials** → paste the client ID + secret.
  3. In step 1, scroll to **Google Ads API** → tick `https://www.googleapis.com/auth/adwords`.
  4. Click **Authorize APIs**, log in as the Google account that has access to the Ads customer.
  5. Click **Exchange authorization code for tokens** — the **Refresh token** is the long string (starts with `1//`).
- **Login Customer ID** — optional MCC manager-account ID, same 10-digit format. Only set this if your Ads customer sits under a manager account.

Paste into **Settings → Google Ads**, save, then click **Test connection**. The probe is a single OAuth refresh against `https://oauth2.googleapis.com/token` — a 200 confirms the client ID, client secret, and refresh token are mutually consistent. It does NOT call the Google Ads API itself (that needs gRPC + an approved developer token; v0.1.4 work).

> **What to do if "Test connection" fails:** read the toast description verbatim. Meta/Google return reliable diagnostics (`invalid_grant`, "Token has been expired or revoked", "Permissions error", etc.) and re-wording would only obscure them. Most common cause: pasting an OAuth refresh token from a different client ID/secret pair.
