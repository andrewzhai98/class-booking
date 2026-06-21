const { google } = require("googleapis");
const { DateTime } = require("luxon");
const { sendBookingCancelledEmail, sendTeacherBookingCancelledEmail } = require("./email");

const DEFAULT_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings";
const STUDENTS_SHEET_TAB = process.env.STUDENTS_SHEET_TAB || "Students";
const CREDIT_TRANSACTIONS_SHEET_TAB = process.env.CREDIT_TRANSACTIONS_SHEET_TAB || "CreditTransactions";
const MIN_LEAD_HOURS = Number(process.env.MIN_LEAD_HOURS || 12);
const MANAGE_CUTOFF_HOURS = Number(process.env.MANAGE_CUTOFF_HOURS || 12);

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

async function sendEmailSafely(sendFn, bookingId, type) {
  try {
    await sendFn();
  } catch (error) {
    console.error(`Email failed for ${type} ${bookingId}`, error);
  }
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

function canManageBooking(booking) {
  if (booking.status !== "confirmed") return false;
  const start = DateTime.fromISO(booking.startTime, { zone: "utc" });
  return start.isValid && start > DateTime.utc().plus({ hours: MANAGE_CUTOFF_HOURS });
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
    if (!bookingId || !token) throw userError("Missing booking id or token.", 400);

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const calendar = google.calendar({ version: "v3", auth });
    const bookings = await getBookings(sheets);
    const booking = findBooking(bookings, bookingId, token);
    if (!canManageBooking(booking)) throw userError(`This booking can no longer be cancelled online within ${MANAGE_CUTOFF_HOURS} hours of the lesson. Please contact the teacher directly.`, 409);

    const config = getClassConfig(booking.eventType);
    if (booking.calendarEventId) {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: booking.calendarEventId });
    }

    const updatedAt = new Date().toISOString();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!C${booking.rowNumber}:S${booking.rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        "cancelled",
        booking.eventType,
        booking.startTime,
        booking.endTime,
        booking.timezone,
        booking.name,
        booking.email,
        booking.contact,
        booking.studentLevel,
        booking.goal,
        `${booking.notes || ""}\nCancelled at ${updatedAt}`.trim(),
        booking.calendarEventId,
        booking.source,
        booking.manageToken,
        booking.manageLink,
        updatedAt,
        booking.changeCount
      ]] }
    });

    let refunded = false;
    if (config.requiresCredits && config.creditCost > 0) {
      const student = await getStudentByEmail(sheets, booking.email);
      if (student) {
        const updatedUsed = Math.max(0, student.creditsUsed - config.creditCost);
        const balanceAfter = student.creditsBalance + config.creditCost;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${STUDENTS_SHEET_TAB}!A${student.rowNumber}:H${student.rowNumber}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[student.email, student.name || booking.name || "", student.totalCreditsPurchased, updatedUsed, balanceAfter, student.status || "active", updatedAt, student.notes || ""]] }
        });
        await appendCreditTransaction(sheets, { email: booking.email, type: "refund", amount: config.creditCost, balanceAfter, bookingId, notes: `Cancelled ${config.title}` });
        refunded = true;
      }
    }

    await sendEmailSafely(() => sendBookingCancelledEmail({
      booking,
      classConfig: config,
      refunded
    }), booking.bookingId, "booking_cancelled");

    await sendEmailSafely(() => sendTeacherBookingCancelledEmail({
      booking,
      classConfig: config,
      refunded,
      manageLink: booking.manageLink
    }), booking.bookingId, "teacher_booking_cancelled");

    return json(200, { ok: true, message: "Booking cancelled.", refunded });
  } catch (error) {
    console.error("cancel-booking error", error);
    return json(error.statusCode || 500, { message: error.message || "Could not cancel booking." });
  }
};

async function getStudentByEmail(sheets, email) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${STUDENTS_SHEET_TAB}!A:H` });
  const rows = response.data.values || [];
  const normalizedEmail = normalizeEmail(email);
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (normalizeEmail(row[0] || "") === normalizedEmail) {
      return { rowNumber: index + 1, email: normalizedEmail, name: row[1] || "", totalCreditsPurchased: toNumber(row[2]), creditsUsed: toNumber(row[3]), creditsBalance: toNumber(row[4]), status: String(row[5] || "").trim().toLowerCase(), lastUpdated: row[6] || "", notes: row[7] || "" };
    }
  }
  return null;
}

async function appendCreditTransaction(sheets, { email, type, amount, balanceAfter, bookingId, notes }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CREDIT_TRANSACTIONS_SHEET_TAB}!A:H`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[new Date().toISOString(), createTransactionId(), email, type, amount, balanceAfter, bookingId || "", notes || ""]] }
  });
}
