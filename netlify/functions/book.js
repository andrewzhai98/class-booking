const { google } = require("googleapis");
const { DateTime } = require("luxon");
const crypto = require("crypto");

const DEFAULT_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings";
const TEACHER_EMAIL = process.env.TEACHER_EMAIL || "";
const MEETING_LOCATION = process.env.MEETING_LOCATION || "Online";
const BUFFER_MINUTES = Number(process.env.BUFFER_MINUTES || 0);
const INVITE_ATTENDEES = process.env.INVITE_ATTENDEES === "true";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { message: "Method not allowed" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    validatePayload(payload);

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    const start = DateTime.fromISO(payload.start, { zone: "utc" });
    const end = DateTime.fromISO(payload.end, { zone: "utc" });

    const busyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.minus({ minutes: BUFFER_MINUTES }).toISO(),
        timeMax: end.plus({ minutes: BUFFER_MINUTES }).toISO(),
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });

    const busy = busyResponse.data.calendars?.[CALENDAR_ID]?.busy || [];

    if (busy.length > 0) {
      return json(409, {
        message: "This time has just been booked. Please choose another time."
      });
    }

    const bookingId = createBookingId();
    const summary = payload.eventTitle || "Free Trial English Class";
    const description = buildDescription(payload, bookingId);

    const eventRequestBody = {
      summary,
      description,
      location: MEETING_LOCATION,
      start: {
        dateTime: start.toISO(),
        timeZone: "UTC"
      },
      end: {
        dateTime: end.toISO(),
        timeZone: "UTC"
      }
    };

    if (INVITE_ATTENDEES) {
      eventRequestBody.attendees = buildAttendees(payload.email);
    }

    const calendarEventResponse = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      sendUpdates: INVITE_ATTENDEES ? "all" : "none",
      requestBody: eventRequestBody
    });

    const calendarEventId = calendarEventResponse.data.id || "";

    if (SHEET_ID) {
      await appendBookingToSheet(sheets, {
        bookingId,
        payload,
        calendarEventId,
        status: "confirmed"
      });
    }

    return json(200, {
      ok: true,
      bookingId,
      calendarEventId,
      message: "Booking confirmed."
    });
  } catch (error) {
    console.error("book error", error);

    return json(500, {
      message: error.message || "Booking failed. Please try again."
    });
  }
};

function validatePayload(payload) {
  const required = ["name", "email", "start", "end", "timezone"];

  for (const field of required) {
    if (!payload[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  const start = DateTime.fromISO(payload.start, { zone: "utc" });
  const end = DateTime.fromISO(payload.end, { zone: "utc" });

  if (!start.isValid || !end.isValid || end <= start) {
    throw new Error("Invalid booking time.");
  }

  if (!/^\S+@\S+\.\S+$/.test(payload.email)) {
    throw new Error("Invalid email address.");
  }
}

function buildDescription(payload, bookingId) {
  return [
    `Booking ID: ${bookingId}`,
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Contact: ${payload.contact || ""}`,
    `Student level: ${payload.studentLevel || ""}`,
    `Learning goal: ${payload.goal || ""}`,
    `Visitor timezone: ${payload.timezone}`,
    `Notes: ${payload.notes || ""}`,
    `Source: ${payload.source || "booking.html"}`
  ].join("\n");
}

function buildAttendees(studentEmail) {
  const attendees = [];

  if (studentEmail) {
    attendees.push({ email: studentEmail });
  }

  if (TEACHER_EMAIL && TEACHER_EMAIL !== studentEmail) {
    attendees.push({ email: TEACHER_EMAIL });
  }

  return attendees;
}

async function appendBookingToSheet(sheets, { bookingId, payload, calendarEventId, status }) {
  const values = [[
    new Date().toISOString(),
    bookingId,
    status,
    payload.eventType || "free-trial-class",
    payload.start,
    payload.end,
    payload.timezone,
    payload.name,
    payload.email,
    payload.contact || "",
    payload.studentLevel || "",
    payload.goal || "",
    payload.notes || "",
    calendarEventId,
    payload.source || "booking.html"
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:O`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values
    }
  });
}

function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY.");
  }

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/spreadsheets"
    ]
  });
}

function createBookingId() {
  return `BK-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}