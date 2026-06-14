# Connecting Gmail + Calendar (Phase 1)

This lets Nexus read/triage/draft/send your email and manage your Google Calendar.
It uses **your own Google account** via OAuth — there's no third-party cost, and your
refresh token is stored **AES-256-GCM encrypted in your local vault**. Access tokens
live only in memory.

It's a one-time, ~5-minute setup. You need a Google account.

## 1. Create a Google Cloud project
1. Go to https://console.cloud.google.com → create a project (any name, e.g. "Nexus").

## 2. Enable the APIs
In that project, enable both:
- **Gmail API** → https://console.cloud.google.com/apis/library/gmail.googleapis.com
- **Google Calendar API** → https://console.cloud.google.com/apis/library/calendar-json.googleapis.com

## 3. Configure the OAuth consent screen
1. APIs & Services → **OAuth consent screen**.
2. User type: **External** → Create.
3. Fill app name + your email where required. Save.
4. **Audience / Test users:** add **your own Gmail address** as a test user.
   (The app stays "unverified" — fine for personal use. You'll see a warning screen on
   first connect; click **Advanced → Go to … (unsafe)** to proceed. It's your own app.)
5. Scopes: you don't need to pre-add them here; Nexus requests them at connect time
   (Gmail read, Gmail compose/send, Calendar events).

## 4. Create the OAuth client
1. APIs & Services → **Credentials** → **Create credentials** → **OAuth client ID**.
2. Application type: **Desktop app**. Name it anything. Create.
3. Copy the **Client ID** and **Client secret**.

## 5. Put them in .env
```
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
```

## 6. Connect
```
npm start
you ▸ /connect
```
Your browser opens Google's consent screen. Approve it (click through the "unverified"
warning — it's your own app). When it says "Nexus is connected ✓", you're done.

Then try:
```
you ▸ check my unread email
you ▸ draft a reply to the latest email from <someone>
you ▸ what's on my calendar this week
you ▸ schedule a 30-min focus block tomorrow at 10am
```

## Safety
- **Reading** email/calendar runs freely (and is audited).
- **Drafting** saves a draft in Gmail for your review (gated until you raise the Email
  agent's autonomy with `/autonomy email 4`).
- **Sending** email and **creating/moving** calendar events are gated for your approval
  every time — until you choose to raise autonomy. `/kill` pauses everything instantly.
- Revoke anytime: `/google disconnect` (removes the token from your vault), or at
  https://myaccount.google.com/permissions.
