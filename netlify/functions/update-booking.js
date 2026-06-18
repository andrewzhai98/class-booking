const { google } = require("googleapis");
const { DateTime } = require("luxon");

const DEFAULT_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings";
const MIN_LEAD_HOURS = Number(process.env.MIN_LEAD_HOURS || 12);
const MAX_DAYS_AHEAD = Number(process.env.MAX_DAYS_AHEAD || 14);
const PRE_BUFFER_MINUTES = Number(process.env.PRE_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);
const POST_BUFFER_MINUTES = Number(process.env.POST_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);

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

function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw userError("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY.", 500);
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"]
  });
}

function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function toNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function userError(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; return e; }
function json(statusCode, body) { return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
function createTransactionId() { return `TX-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`; }

async function getBookings(sheets) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A:S` });
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
    changeCount: toNumber(row[18])
  }));
}

function findBooking(bookings, bookingId, token) {
  const booking = bookings.find(item => item.bookingId === bookingId && item.manageToken === token);
  if (!booking) throw userError("Booking not found or link is invalid.", 404);
  return booking;
}

function getClassConfig(eventType) {
  const config = CLASS_TYPES[eventType];
  if (!config) throw userError("Invalid class type.", 400);
  return config;
}

async function patchEventIfPresent(calendar, eventId, start, end, timezone, sendUpdates) {
  if (!eventId) return;
  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: {
      start: { dateTime: start.toISO(), timeZone: timezone },
      end: { dateTime: end.toISO(), timeZone: timezone }
    },
    sendUpdates
  });
}

function canManageBooking(booking) {
  if (booking.status !== "confirmed") return false;
  const start = DateTime.fromISO(booking.startTime, { zone: "utc" });
  return start.isValid && start > DateTime.utc().plus({ hours: MIN_LEAD_HOURS });
}

function publicBooking(booking) {
  const config = getClassConfig(booking.eventType);
  return {
    bookingId: booking.bookingId,
    status: booking.status,
    eventType: booking.eventType,
    classTitle: config.title,
    durationMinutes: config.durationMinutes,
    creditCost: config.creditCost,
    startTime: booking.startTime,
    endTime: booking.endTime,
    timezone: booking.timezone,
    name: booking.name,
    email: booking.email,
    contact: booking.contact,
    studentLevel: booking.studentLevel,
    goal: booking.goal,
    notes: booking.notes
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { message: "Method not allowed" });
  try {
    if (!SHEET_ID) throw userError("Missing GOOGLE_SHEET_ID.", 500);
    const payload = JSON.parse(event.body || "{}");
    const bookingId = payload.bookingId || "";
    const token = payload.token || "";
    if (!bookingId || !token || !payload.start) throw userError("Missing booking id, token, or new start time.", 400);

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const calendar = google.calendar({ version: "v3", auth });
    const bookings = await getBookings(sheets);
    const booking = findBooking(bookings, bookingId, token);
    if (!canManageBooking(booking)) throw userError(`This booking can no longer be changed online within ${MIN_LEAD_HOURS} hours of the lesson. Please contact the teacher directly.`, 409);

    const config = getClassConfig(booking.eventType);
    const newStart = DateTime.fromISO(payload.start, { zone: "utc" });
    if (!newStart.isValid) throw userError("Invalid new booking time.", 400);
    const now = DateTime.utc();
    if (newStart < now.plus({ hours: MIN_LEAD_HOURS })) throw userError(`Please choose a time at least ${MIN_LEAD_HOURS} hours in advance.`, 409);
    if (newStart > now.plus({ days: MAX_DAYS_AHEAD })) throw userError(`Please choose a time within the next ${MAX_DAYS_AHEAD} days.`, 409);
    const newEnd = newStart.plus({ minutes: config.durationMinutes });

    const busyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: newStart.minus({ minutes: PRE_BUFFER_MINUTES }).toISO(),
        timeMax: newEnd.plus({ minutes: POST_BUFFER_MINUTES }).toISO(),
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });
    const busy = busyResponse.data.calendars?.[CALENDAR_ID]?.busy || [];
    const protectedStart = newStart.minus({ minutes: PRE_BUFFER_MINUTES });
    const protectedEnd = newEnd.plus({ minutes: POST_BUFFER_MINUTES });
    const oldStart = DateTime.fromISO(booking.startTime, { zone: "utc" });
    const oldEnd = DateTime.fromISO(booking.endTime, { zone: "utc" });
    const oldProtectedStart = oldStart.minus({ minutes: PRE_BUFFER_MINUTES });
    const oldProtectedEnd = oldEnd.plus({ minutes: POST_BUFFER_MINUTES });
    const overlaps = busy.some(item => {
      const busyStart = DateTime.fromISO(item.start, { zone: "utc" });
      const busyEnd = DateTime.fromISO(item.end, { zone: "utc" });
      const overlapsNew = busyStart < protectedEnd && busyEnd > protectedStart;
      const isOwnOldEvent = oldStart.isValid && oldEnd.isValid && busyStart < oldProtectedEnd && busyEnd > oldProtectedStart;
      return overlapsNew && !isOwnOldEvent;
    });
    if (overlaps) throw userError("This time has just been booked. Please choose another time.", 409);

    if (booking.calendarEventId) {
      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: booking.calendarEventId,
        requestBody: {
          summary: config.title,
          start: { dateTime: newStart.toISO(), timeZone: "UTC" },
          end: { dateTime: newEnd.toISO(), timeZone: "UTC" },
          description: `${booking.notes || ""}

Updated booking time from ${booking.startTime} to ${newStart.toISO()}`.trim()
        }
      });
    }

    const updatedAt = new Date().toISOString();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!E${booking.rowNumber}:S${booking.rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        newStart.toISO(),
        newEnd.toISO(),
        booking.timezone,
        booking.name,
        booking.email,
        booking.contact,
        booking.studentLevel,
        booking.goal,
        booking.notes,
        booking.calendarEventId,
        booking.source,
        booking.manageToken,
        booking.manageLink,
        updatedAt,
        booking.changeCount + 1
      ]] }
    });

    return json(200, { ok: true, message: "Booking updated.", start: newStart.toISO(), end: newEnd.toISO() });
  } catch (error) {
    console.error("update-booking error", error);
    return json(error.statusCode || 500, { message: error.message || "Could not update booking." });
  }
};
