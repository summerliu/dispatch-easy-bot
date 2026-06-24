# Dispatch Easy

A Telegram group bot for dispatching and tracking work orders. Managers create tasks and assign them to staff via chat commands; staff complete tasks by replying with a photo proof.

## Stack

- **Bot**: [grammY](https://grammy.dev) via Next.js API route (`/api/bot`)
- **Database**: [Supabase](https://supabase.com) (PostgreSQL)
- **Hosting**: [Vercel](https://vercel.com) (free tier)

## Database Schema

```sql
-- Users / Staff
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'staff',        -- 'admin' or 'staff'
  binding_code TEXT UNIQUE,         -- Telegram @username used for assignment
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Work orders
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  assignee_id INT REFERENCES users(id),
  status TEXT DEFAULT 'pending',    -- pending | active | completed | closed
  due_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Bot Commands

| Command | Who | Description |
|---|---|---|
| `/new [task] @username` | Manager | Create and assign a task |
| `/tasks` | Anyone | List all tasks by status |
| `/ok` | Manager | Close the latest pending-review task (reply to completion notice, or pass task name) |
| `/delete [task]` | Manager | Hard-delete a task by name |

**Photo dispatch** — A manager can also send a photo with `/new [task] @username` as the caption to create a task with an image.

**Completion flow** — Staff replies to the bot's task message with a photo to mark it as `completed`. Manager then runs `/ok` (replying to the completion notice) to close it.

## Local Development

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Copy environment variables:
   ```bash
   cp .env.local.example .env.local
   ```
   Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `TELEGRAM_BOT_TOKEN`.

3. Start the dev server:
   ```bash
   pnpm dev
   ```

4. Expose port 3000 via [ngrok](https://ngrok.com):
   ```bash
   ngrok http 3000
   ```

5. Register the webhook with Telegram:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<ngrok-subdomain>.ngrok-free.app/api/bot"
   ```

## Deployment (Vercel)

1. Push to GitHub and import the repo at [vercel.com/new](https://vercel.com/new).

2. In Vercel → Settings → Environment Variables, add all three keys. For each one, make sure **Production** is checked (not just Preview):

   | Key | Where to find it |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | BotFather → `/mybots` → API Token |
   | `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` |

3. Deploy, then register the webhook:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://dispatch-easy-bot.vercel.app/api/bot"
   ```

4. Verify the webhook is active:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```
