# Worker

Claims due reminders and notification outbox entries using MongoDB leases. Reminder recurrence and delivery retry are independent: unstarted task reminders repeat every 10 minutes while the task waits to be started, in proposed, accepted or to do (in review, blocked, parked, backlog or draft they stay quiet and look again a repeat later), while failed deliveries use capped exponential backoff and become `dead` after eight attempts. The expense tracker's upcoming payments are planned here too (every few minutes, one reminder per repeating expense and manager; docs/expenses.md#upcoming-payments). A reminder's rings share one inbox row: each delivered ring takes over the earlier row (ring times and count carried over) and arrives on top, unread.

```powershell
$env:MONGODB_URI='mongodb://127.0.0.1:27018/venture_studio_dev?replicaSet=ventureStudio'
$env:MONGODB_DB='venture_studio_dev'
npm run dev --workspace @venture-studio/worker
```

Without Resend/VAPID credentials, local mode records in-app notifications and logs a labelled local delivery. Production requires live credentials and a MongoDB replica set.

Email delivery uses a provider idempotency key plus per-channel progress markers. Web Push is intentionally at-least-once across a crash or expired lease; every payload includes the stable outbox ID as `notificationId`, and clients must deduplicate on that value.

