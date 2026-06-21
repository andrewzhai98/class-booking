const { google } = require("googleapis");
const { DateTime } = require("luxon");

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
  if (event.httpMethod !== "GET") return json(405, { message: "Method not allowed" });
  try {
    if (!SHEET_ID) throw userError("Missing GOOGLE_SHEET_ID.", 500);
    const bookingId = event.queryStringParameters?.id || "";
    const token = event.queryStringParameters?.token || "";
    if (!bookingId || !token) throw userError("Missing booking id or token.", 400);
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const booking = findBooking(await getBookings(sheets), bookingId, token);
    return json(200, { ok: true, booking: publicBooking(booking), canManage: canManageBooking(booking), cutoffHours: MANAGE_CUTOFF_HOURS });
  } catch (error) {
    console.error("get-booking error", error);
    return json(error.statusCode || 500, { message: error.message || "Could not load booking." });
  }
};
