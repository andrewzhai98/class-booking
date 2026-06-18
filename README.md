# English Booking Site

This is a lightweight Calendly-style booking website for English trial lessons.

## What is included

- `index.html`: landing page
- `booking.html`: booking calendar and booking form
- `success.html`: booking confirmation page
- `english_level_testen.html`: placeholder level-test page
- `netlify/functions/availability.js`: reads Google Calendar busy time and returns available slots
- `netlify/functions/book.js`: checks availability again, creates a Google Calendar event, and writes booking data to Google Sheets
- `netlify.toml`: Netlify deployment config
- `.env.example`: required environment variables

## Google Sheet columns

Create a Google Sheet tab named `Bookings` with these columns in row 1:

1. Created At
2. Booking ID
3. Status
4. Event Type
5. Start Time
6. End Time
7. Timezone
8. Name
9. Email
10. WeChat / WhatsApp
11. English Level
12. Learning Goal
13. Notes
14. Google Calendar Event ID
15. Source
16. Manage Token
17. Manage Link
18. Updated At
19. Change Count

## Required environment variables

Set these in Netlify → Site configuration → Environment variables:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_CALENDAR_ID`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SHEET_TAB`
- `TEACHER_EMAIL`
- `TEACHER_TIMEZONE`
- `WORK_DAYS`
- `WORK_START`
- `WORK_END`
- `SLOT_DURATION_MINUTES`
- `MIN_LEAD_HOURS`
- `MAX_DAYS_AHEAD`
- `PRE_BUFFER_MINUTES`
- `POST_BUFFER_MINUTES`
- `MEETING_LOCATION`
- `SITE_URL`

## Important Google setup

1. Create a Google Cloud service account.
2. Enable Google Calendar API and Google Sheets API.
3. Create a JSON key for the service account.
4. Share your Google Calendar with the service account email and give it permission to make changes to events.
5. Share your Google Sheet with the service account email and give it editor permission.
6. Put the service account email into `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
7. Put the private key into `GOOGLE_PRIVATE_KEY`.

For `GOOGLE_PRIVATE_KEY`, keep the line breaks as `\n` when adding it to Netlify.

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

## Deploy to Netlify

Recommended workflow:

1. Upload this folder to a GitHub repository.
2. Connect the repository to Netlify.
3. Set the build command to `npm run build`.
4. Set the publish directory to `.`.
5. Set the functions directory to `netlify/functions`.
6. Add the environment variables.
7. Deploy.

## Booking flow

1. Visitor opens `index.html`.
2. Visitor clicks `Book a Free Trial Class`.
3. `booking.html` detects the visitor's time zone.
4. Visitor chooses a date.
5. The frontend calls `/.netlify/functions/availability`.
6. The function reads Google Calendar busy time and returns available slots within `MIN_LEAD_HOURS` and `MAX_DAYS_AHEAD`.
7. Visitor chooses a slot and submits details.
8. The frontend calls `/.netlify/functions/book`.
9. The function checks Google Calendar again, creates an event, and appends a row to Google Sheets.
10. Visitor lands on `success.html` and can open `manage-booking.html` through a private booking management link.
11. If the lesson is more than `MIN_LEAD_HOURS` away and within `MAX_DAYS_AHEAD`, the visitor can change time or cancel online.
