const { google } = require("googleapis");
const { DateTime } = require("luxon");
const crypto = require("crypto");

const DEFAULT_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Bookings";
const STUDENTS_SHEET_TAB = process.env.STUDENTS_SHEET_TAB || "Students";
const CREDIT_TRANSACTIONS_SHEET_TAB = process.env.CREDIT_TRANSACTIONS_SHEET_TAB || "CreditTransactions";
const TEACHER_EMAIL = process.env.TEACHER_EMAIL || "";
const MEETING_LOCATION = process.env.MEETING_LOCATION || "Online";
const PRE_BUFFER_MINUTES = Number(process.env.PRE_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);
const POST_BUFFER_MINUTES = Number(process.env.POST_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);
const INVITE_ATTENDEES = process.env.INVITE_ATTENDEES === "true";
const MIN_LEAD_HOURS = Number(process.env.MIN_LEAD_HOURS || 12);
const MAX_DAYS_AHEAD = Number(process.env.MAX_DAYS_AHEAD || 14);
const MAX_BOOKINGS_PER_DAY = Number(process.env.MAX_BOOKINGS_PER_DAY || 4);
const MAX_ACTIVE_BOOKINGS_PER_EMAIL = Number(process.env.MAX_ACTIVE_BOOKINGS_PER_EMAIL || 2);
const SITE_URL = process.env.SITE_URL || "";

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { message: "Method not allowed" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    validatePayload(payload);

    const classConfig = getClassConfig(payload.eventType);
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    const start = DateTime.fromISO(payload.start, { zone: "utc" });
    const end = start.plus({ minutes: classConfig.durationMinutes });
    const now = DateTime.utc();

    if (start < now.plus({ hours: MIN_LEAD_HOURS })) {
      throw userError(`Please choose a time at least ${MIN_LEAD_HOURS} hours in advance.`, 409);
    }

    if (start > now.plus({ days: MAX_DAYS_AHEAD })) {
      throw userError(`Please choose a time within the next ${MAX_DAYS_AHEAD} days.`, 409);
    }

    let bookings = [];
    let student = null;

    if (SHEET_ID) {
      bookings = await getExistingBookings(sheets);
      enforceBookingRules(bookings, payload, start, classConfig);

      if (classConfig.requiresCredits) {
        student = await getStudentByEmail(sheets, payload.email);
        if (!student) {
          throw userError("No active lesson package was found for this email. Please purchase a lesson package before booking.", 409);
        }

        if (student.status !== "active") {
          throw userError("Your lesson package is not active. Please contact us before booking.", 409);
        }

        if (student.creditsBalance < classConfig.creditCost) {
          throw userError("You do not have enough lesson credits. Please purchase a lesson package before booking.", 409);
        }
      }
    }

    const busyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.minus({ minutes: PRE_BUFFER_MINUTES }).toISO(),
        timeMax: end.plus({ minutes: POST_BUFFER_MINUTES }).toISO(),
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });

    const busy = busyResponse.data.calendars?.[CALENDAR_ID]?.busy || [];
    if (busy.length > 0) {
      throw userError("This time has just been booked. Please choose another time.", 409);
    }

    const bookingId = createBookingId();
    const manageToken = createManageToken();
    const manageLink = buildManageLink(payload, bookingId, manageToken);
    const description = buildDescription(payload, bookingId, classConfig, manageToken, manageLink);

    const eventRequestBody = {
      summary: classConfig.title,
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
        manageToken,
        manageLink,
        payload,
        classConfig,
        start,
        end,
        calendarEventId,
        status: "confirmed"
      });

      if (classConfig.requiresCredits && student) {
        const balanceAfter = await deductStudentCredits(sheets, student, classConfig.creditCost, payload.name);
        await appendCreditTransaction(sheets, {
          email: payload.email,
          type: "booking",
          amount: -classConfig.creditCost,
          balanceAfter,
          bookingId,
          notes: `Booked ${classConfig.title}`
        });
      }
    }

    return json(200, {
      ok: true,
      bookingId,
      manageToken,
      manageLink,
      calendarEventId,
      classType: classConfig.eventType,
      classTitle: classConfig.title,
      durationMinutes: classConfig.durationMinutes,
      creditCost: classConfig.creditCost,
      start: start.toISO(),
      end: end.toISO(),
      timezone: payload.timezone,
      message: "Booking confirmed."
    });
  } catch (error) {
    console.error("book error", error);
    return json(error.statusCode || 500, {
      message: error.message || "Booking failed. Please try again."
    });
  }
};

function validatePayload(payload) {
  const required = ["name", "email", "start", "timezone", "eventType"];
  for (const field of required) {
    if (!payload[field]) throw userError(`Missing required field: ${field}`, 400);
  }

  payload.email = normalizeEmail(payload.email);

  const start = DateTime.fromISO(payload.start, { zone: "utc" });
  if (!start.isValid) {
    throw userError("Invalid booking time.", 400);
  }

  if (!/^\S+@\S+\.\S+$/.test(payload.email)) {
    throw userError("Invalid email address.", 400);
  }
}

function getClassConfig(eventType) {
  const classConfig = CLASS_TYPES[eventType];
  if (!classConfig) {
    throw userError("Invalid class type. Please choose Free Trial or Regular Lesson.", 400);
  }
  return classConfig;
}

async function getExistingBookings(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:S`
  });

  const rows = response.data.values || [];
  return rows.slice(1).map((row) => ({
    createdAt: row[0] || "",
    bookingId: row[1] || "",
    status: row[2] || "",
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

function enforceBookingRules(bookings, payload, requestedStart, classConfig) {
  const activeStatuses = new Set(["pending", "confirmed"]);
  const invalidTrialStatuses = new Set(["pending", "confirmed", "completed"]);
  const now = DateTime.utc();
  const requestedDay = requestedStart.setZone(DEFAULT_TIMEZONE).toISODate();
  const email = normalizeEmail(payload.email);

  if (classConfig.eventType === "free-trial") {
    const previousTrial = bookings.find((booking) => {
      const status = String(booking.status || "").toLowerCase();
      return booking.email === email && booking.eventType === "free-trial" && invalidTrialStatuses.has(status);
    });

    if (previousTrial) {
      throw userError("You have already booked a free trial class. Please book a regular lesson or contact us.", 409);
    }
  }

  const activeFutureBookings = bookings.filter((booking) => {
    const status = String(booking.status || "").toLowerCase();
    const bookingStart = DateTime.fromISO(booking.startTime, { zone: "utc" });
    return activeStatuses.has(status) && bookingStart.isValid && bookingStart > now;
  });

  if (MAX_ACTIVE_BOOKINGS_PER_EMAIL > 0) {
    const userActiveBookings = activeFutureBookings.filter((booking) => booking.email === email);

    if (userActiveBookings.length >= MAX_ACTIVE_BOOKINGS_PER_EMAIL) {
      throw userError(
        `You already have ${MAX_ACTIVE_BOOKINGS_PER_EMAIL} upcoming booking(s). Please attend or cancel an existing class before booking another one.`,
        409
      );
    }
  }

  if (MAX_BOOKINGS_PER_DAY > 0) {
    const dailyCount = activeFutureBookings.filter((booking) => {
      const bookingStart = DateTime.fromISO(booking.startTime, { zone: "utc" });
      return bookingStart.isValid && bookingStart.setZone(DEFAULT_TIMEZONE).toISODate() === requestedDay;
    }).length;

    if (dailyCount >= MAX_BOOKINGS_PER_DAY) {
      throw userError("This day is fully booked. Please choose another date.", 409);
    }
  }
}

async function getStudentByEmail(sheets, email) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${STUDENTS_SHEET_TAB}!A:H`
  });

  const rows = response.data.values || [];
  const normalizedEmail = normalizeEmail(email);

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (normalizeEmail(row[0] || "") === normalizedEmail) {
      return {
        rowNumber: index + 1,
        email: normalizedEmail,
        name: row[1] || "",
        totalCreditsPurchased: toNumber(row[2]),
        creditsUsed: toNumber(row[3]),
        creditsBalance: toNumber(row[4]),
        status: String(row[5] || "").trim().toLowerCase(),
        lastUpdated: row[6] || "",
        notes: row[7] || ""
      };
    }
  }

  return null;
}

async function deductStudentCredits(sheets, student, creditCost, fallbackName) {
  const updatedUsed = student.creditsUsed + creditCost;
  const updatedBalance = student.creditsBalance - creditCost;
  const updatedAt = new Date().toISOString();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${STUDENTS_SHEET_TAB}!A${student.rowNumber}:H${student.rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        student.email,
        student.name || fallbackName || "",
        student.totalCreditsPurchased,
        updatedUsed,
        updatedBalance,
        student.status || "active",
        updatedAt,
        student.notes || ""
      ]]
    }
  });

  return updatedBalance;
}

async function appendBookingToSheet(sheets, { bookingId, manageToken, manageLink, payload, classConfig, start, end, calendarEventId, status }) {
  const values = [[
    new Date().toISOString(),
    bookingId,
    status,
    classConfig.eventType,
    start.toISO(),
    end.toISO(),
    payload.timezone,
    payload.name,
    payload.email,
    payload.contact || "",
    payload.studentLevel || "",
    payload.goal || "",
    payload.notes || "",
    calendarEventId,
    payload.source || "booking.html",
    manageToken,
    manageLink,
    "",
    0
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:S`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values }
  });
}

async function appendCreditTransaction(sheets, { email, type, amount, balanceAfter, bookingId, notes }) {
  const values = [[
    new Date().toISOString(),
    createTransactionId(),
    email,
    type,
    amount,
    balanceAfter,
    bookingId || "",
    notes || ""
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CREDIT_TRANSACTIONS_SHEET_TAB}!A:H`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values }
  });
}

function buildDescription(payload, bookingId, classConfig, manageToken, manageLink) {
  return [
    `Booking ID: ${bookingId}`,
    `Manage token: ${manageToken}`,
    `Manage link: ${manageLink}`,
    `Class type: ${classConfig.title}`,
    `Duration: ${classConfig.durationMinutes} minutes`,
    `Credit cost: ${classConfig.creditCost}`,
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
  if (studentEmail) attendees.push({ email: studentEmail });
  if (TEACHER_EMAIL && TEACHER_EMAIL !== studentEmail) attendees.push({ email: TEACHER_EMAIL });
  return attendees;
}

function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw userError("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY.", 500);
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

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function userError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createBookingId() {
  return `BK-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function createTransactionId() {
  return `TX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function createManageToken() {
  return crypto.randomBytes(18).toString("hex");
}

function buildManageLink(payload, bookingId, manageToken) {
  const baseUrl = String(SITE_URL || payload.siteUrl || "").replace(/\/$/, "");
  if (!baseUrl) return `manage-booking.html?id=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(manageToken)}`;
  return `${baseUrl}/manage-booking.html?id=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(manageToken)}`;
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
