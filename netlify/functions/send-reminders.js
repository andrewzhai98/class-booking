const { google } = require("googleapis");
const { DateTime } = require("luxon");
const { sendBookingReminderEmail } = require("./email");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings";
const REMINDER_LEAD_HOURS = Number(process.env.REMINDER_LEAD_HOURS || 3);

const CLASS_TYPES = {
  "free-trial": {
    eventType: "free-trial",
    title: "Free Trial English Class",
    durationMinutes: Number(process.env.FREE_TRIAL_DURATION_MINUTES || 15),
    creditCost: Number(process.env.FREE_TRIAL_CREDIT_COST || 0),
    requiresCredits: false
  },
  "regular-lesson": {
    eventType: "regular-lesson",
    title: "Regular English Lesson",
    durationMinutes: Number(process.env.REGULAR_LESSON_DURATION_MINUTES || 45),
    creditCost: Number(process.env.REGULAR_LESSON_CREDIT_COST || 1),
    requiresCredits: true
  }
};

exports.handler = async () => {
  try {
    if (!SHEET_ID) throw new Error("Missing GOOGLE_SHEET_ID.");

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const now = DateTime.utc();
    const reminderWindowEnd = now.plus({ hours: REMINDER_LEAD_HOURS });
    const bookings = await getBookings(sheets);
    const dueBookings = bookings.filter((booking) => shouldSendReminder(booking, now, reminderWindowEnd));

    const results = [];
    for (const booking of dueBookings) {
      const classConfig = getClassConfig(booking.eventType);
      try {
        const emailResult = await sendBookingReminderEmail({
          booking,
          classConfig,
          manageLink: booking.manageLink
        });

        if (emailResult?.skipped) {
          results.push({ bookingId: booking.bookingId, skipped: emailResult.reason || "email_skipped" });
          continue;
        }

        await markReminderSent(sheets, booking, now);
        results.push({ bookingId: booking.bookingId, sent: true });
      } catch (error) {
        console.error(`Reminder email failed for ${booking.bookingId}`, error);
        results.push({ bookingId: booking.bookingId, error: error.message || "reminder_failed" });
      }
    }

    return json(200, {
      ok: true,
      checked: bookings.length,
      due: dueBookings.length,
      sent: results.filter((item) => item.sent).length,
      results
    });
  } catch (error) {
    console.error("send-reminders error", error);
    return json(500, { ok: false, message: error.message || "Could not send reminders." });
  }
};

function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY.");
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

async function getBookings(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:U`
  });
  const rows = response.data.values || [];
  return rows.slice(1).map((row, index) => ({
    rowNumber: index + 2,
    createdAt: row[0] || "",
    bookingId: row[1] || "",
    status: String(row[2] || "").trim().toLowerCase(),
    eventType: row[3] || "",
    startTime: row[4] || "",
    endTime: row[5] || "",
    timezone: row[6] || "",
    name: row[7] || "",
    email: normalizeEmail(row[8] || ""),
    contact: row[9] || "",
    studentLevel: row[10] || "",
    goal: row[11] || "",
    notes: row[12] || "",
    calendarEventId: row[13] || "",
    source: row[14] || "",
    manageToken: row[15] || "",
    manageLink: row[16] || "",
    updatedAt: row[17] || "",
    changeCount: toNumber(row[18]),
    reminder3hSentAt: row[19] || "",
    reminder3hForStartTime: row[20] || ""
  }));
}

function shouldSendReminder(booking, now, reminderWindowEnd) {
  if (booking.status !== "confirmed") return false;
  if (!booking.email || !booking.startTime || !booking.endTime) return false;
  if (booking.reminder3hForStartTime === booking.startTime) return false;

  const start = DateTime.fromISO(booking.startTime, { zone: "utc" });
  if (!start.isValid) return false;

  return start > now && start <= reminderWindowEnd;
}

async function markReminderSent(sheets, booking, now) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!T${booking.rowNumber}:U${booking.rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[now.toISO(), booking.startTime]]
    }
  });
}

function getClassConfig(eventType) {
  const config = CLASS_TYPES[eventType];
  if (!config) throw new Error(`Invalid class type for reminder: ${eventType}`);
  return config;
}

function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function toNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function json(statusCode, body) { return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
