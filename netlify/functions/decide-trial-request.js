const { google } = require("googleapis");
const { DateTime } = require("luxon");
const { sendBookingConfirmationEmail, sendTeacherNewBookingEmail, sendTrialRequestRejectedEmail } = require("./email");

const DEFAULT_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings";
const TEACHER_EMAIL = process.env.TEACHER_EMAIL || "";
const MEETING_LOCATION = process.env.MEETING_LOCATION || "Online";
const PRE_BUFFER_MINUTES = Number(process.env.PRE_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);
const POST_BUFFER_MINUTES = Number(process.env.POST_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);
const INVITE_ATTENDEES = process.env.INVITE_ATTENDEES === "true";

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
  try { await sendFn(); } catch (error) { console.error(`Email failed for ${type} ${bookingId}`, error); }
}

function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function toNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function userError(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; return e; }
function json(statusCode, body) { return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }

async function getBookings(sheets) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A:Y` });
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
    reminder3hForStartTime: row[20] || "",
    approvalToken: row[21] || "",
    approvedAt: row[22] || "",
    rejectedAt: row[23] || "",
    decisionAt: row[24] || ""
  }));
}

function getClassConfig(eventType) {
  const config = CLASS_TYPES[eventType];
  if (!config) throw userError("Invalid class type.", 400);
  return config;
}

function findTrialRequest(bookings, bookingId, token) {
  const booking = bookings.find(item => item.bookingId === bookingId && item.approvalToken === token);
  if (!booking) throw userError("Trial request not found or review link is invalid.", 404);
  if (booking.eventType !== "free-trial") throw userError("This review link is only for free trial requests.", 400);
  return booking;
}

function buildDescription(booking, classConfig) {
  return [
    `Booking ID: ${booking.bookingId}`,
    `Manage token: ${booking.manageToken}`,
    `Manage link: ${booking.manageLink}`,
    `Class type: ${classConfig.title}`,
    `Duration: ${classConfig.durationMinutes} minutes`,
    `Credit cost: ${classConfig.creditCost}`,
    `Name: ${booking.name}`,
    `Email: ${booking.email}`,
    `Contact: ${booking.contact || ""}`,
    `Student level: ${booking.studentLevel || ""}`,
    `Learning goal: ${booking.goal || ""}`,
    `Visitor timezone: ${booking.timezone}`,
    `Notes: ${booking.notes || ""}`,
    "Approved free trial request"
  ].join("\n");
}

function buildAttendees(studentEmail) {
  const attendees = [];
  if (studentEmail) attendees.push({ email: studentEmail });
  if (TEACHER_EMAIL && TEACHER_EMAIL !== studentEmail) attendees.push({ email: TEACHER_EMAIL });
  return attendees;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { message: "Method not allowed" });
  try {
    if (!SHEET_ID) throw userError("Missing GOOGLE_SHEET_ID.", 500);
    const payload = JSON.parse(event.body || "{}");
    const bookingId = payload.bookingId || "";
    const token = payload.token || "";
    const decision = String(payload.decision || "").toLowerCase();
    if (!bookingId || !token || !["approve", "reject"].includes(decision)) throw userError("Missing request id, token, or decision.", 400);

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const calendar = google.calendar({ version: "v3", auth });
    const booking = findTrialRequest(await getBookings(sheets), bookingId, token);
    const config = getClassConfig(booking.eventType);
    if (booking.status !== "pending_approval") throw userError(`This request has already been ${booking.status}.`, 409);

    const decidedAt = new Date().toISOString();

    if (decision === "reject") {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!C${booking.rowNumber}:Y${booking.rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[
          "rejected",
          booking.eventType,
          booking.startTime,
          booking.endTime,
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
          decidedAt,
          booking.changeCount,
          booking.reminder3hSentAt,
          booking.reminder3hForStartTime,
          booking.approvalToken,
          booking.approvedAt,
          decidedAt,
          decidedAt
        ]] }
      });

      await sendEmailSafely(() => sendTrialRequestRejectedEmail({ booking, classConfig: config }), booking.bookingId, "trial_request_rejected");
      return json(200, { ok: true, status: "rejected", message: "Trial request rejected." });
    }

    const start = DateTime.fromISO(booking.startTime, { zone: "utc" });
    const end = DateTime.fromISO(booking.endTime, { zone: "utc" });
    if (!start.isValid || !end.isValid) throw userError("Invalid request time.", 400);

    const busyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.minus({ minutes: PRE_BUFFER_MINUTES }).toISO(),
        timeMax: end.plus({ minutes: POST_BUFFER_MINUTES }).toISO(),
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });

    const busy = busyResponse.data.calendars?.[CALENDAR_ID]?.busy || [];
    if (busy.length > 0) throw userError("This time is no longer available. Please reject this request or contact the student to arrange another time.", 409);

    const eventRequestBody = {
      summary: config.title,
      description: buildDescription(booking, config),
      location: MEETING_LOCATION,
      start: { dateTime: start.toISO(), timeZone: "UTC" },
      end: { dateTime: end.toISO(), timeZone: "UTC" }
    };
    if (INVITE_ATTENDEES) eventRequestBody.attendees = buildAttendees(booking.email);

    const calendarEventResponse = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      sendUpdates: INVITE_ATTENDEES ? "all" : "none",
      requestBody: eventRequestBody
    });
    const calendarEventId = calendarEventResponse.data.id || "";

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!C${booking.rowNumber}:Y${booking.rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        "confirmed",
        booking.eventType,
        booking.startTime,
        booking.endTime,
        booking.timezone,
        booking.name,
        booking.email,
        booking.contact,
        booking.studentLevel,
        booking.goal,
        booking.notes,
        calendarEventId,
        booking.source,
        booking.manageToken,
        booking.manageLink,
        decidedAt,
        booking.changeCount,
        booking.reminder3hSentAt,
        booking.reminder3hForStartTime,
        booking.approvalToken,
        decidedAt,
        booking.rejectedAt,
        decidedAt
      ]] }
    });

    const approvedBooking = { ...booking, status: "confirmed", calendarEventId };
    await sendEmailSafely(() => sendBookingConfirmationEmail({ booking: approvedBooking, classConfig: config, manageLink: booking.manageLink }), booking.bookingId, "trial_approved_confirmation");
    await sendEmailSafely(() => sendTeacherNewBookingEmail({ booking: approvedBooking, classConfig: config, manageLink: booking.manageLink }), booking.bookingId, "teacher_trial_approved");

    return json(200, { ok: true, status: "confirmed", calendarEventId, message: "Trial request approved and calendar event created." });
  } catch (error) {
    console.error("decide-trial-request error", error);
    return json(error.statusCode || 500, { message: error.message || "Could not update trial request." });
  }
};
