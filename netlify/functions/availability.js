const { google } = require("googleapis");
const { DateTime } = require("luxon");

const DEFAULT_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SLOT_DURATION_MINUTES = Number(process.env.SLOT_DURATION_MINUTES || 30);
const BUFFER_MINUTES = Number(process.env.BUFFER_MINUTES || 0);
const WORK_DAYS = parseWorkDays(process.env.WORK_DAYS || "1,2,3,4,5");
const WORK_START = process.env.WORK_START || "09:00";
const WORK_END = process.env.WORK_END || "17:00";

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { message: "Method not allowed" });
  }

  try {
    const date = event.queryStringParameters?.date;
    const visitorTimezone = event.queryStringParameters?.timezone || DEFAULT_TIMEZONE;
    const duration = Number(event.queryStringParameters?.duration || SLOT_DURATION_MINUTES);

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json(400, { message: "Missing or invalid date. Expected YYYY-MM-DD." });
    }

    const dayInTeacherTimezone = DateTime.fromISO(date, { zone: DEFAULT_TIMEZONE });

    if (!dayInTeacherTimezone.isValid) {
      return json(400, { message: "Invalid date." });
    }

    if (!WORK_DAYS.includes(dayInTeacherTimezone.weekday)) {
      return json(200, { date, timezone: visitorTimezone, slots: [] });
    }

    const startOfWork = combineDateAndTime(dayInTeacherTimezone, WORK_START, DEFAULT_TIMEZONE);
    const endOfWork = combineDateAndTime(dayInTeacherTimezone, WORK_END, DEFAULT_TIMEZONE);

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const busyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: startOfWork.toUTC().toISO(),
        timeMax: endOfWork.toUTC().toISO(),
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });

    const busy = busyResponse.data.calendars?.[CALENDAR_ID]?.busy || [];
    const slots = buildAvailableSlots({
      startOfWork,
      endOfWork,
      duration,
      bufferMinutes: BUFFER_MINUTES,
      busy,
      visitorTimezone
    });

    return json(200, {
      date,
      timezone: visitorTimezone,
      teacherTimezone: DEFAULT_TIMEZONE,
      slots
    });
  } catch (error) {
    console.error("availability error", error);
    return json(500, {
      message: "Could not load availability. Please check Google Calendar environment variables."
    });
  }
};

function buildAvailableSlots({ startOfWork, endOfWork, duration, bufferMinutes, busy, visitorTimezone }) {
  const slots = [];
  const now = DateTime.utc().plus({ minutes: 30 });
  let cursor = startOfWork;

  while (cursor.plus({ minutes: duration }) <= endOfWork) {
    const slotStart = cursor;
    const slotEnd = cursor.plus({ minutes: duration });

    const isInFuture = slotStart.toUTC() > now;
    const overlapsBusy = busy.some((item) => {
      const busyStart = DateTime.fromISO(item.start).minus({ minutes: bufferMinutes });
      const busyEnd = DateTime.fromISO(item.end).plus({ minutes: bufferMinutes });
      return slotStart < busyEnd && slotEnd > busyStart;
    });

    if (isInFuture && !overlapsBusy) {
      const visitorStart = slotStart.setZone(visitorTimezone);
      slots.push({
        start: slotStart.toUTC().toISO(),
        end: slotEnd.toUTC().toISO(),
        label: visitorStart.toFormat("h:mm a")
      });
    }

    cursor = cursor.plus({ minutes: duration });
  }

  return slots;
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

function combineDateAndTime(date, time, zone) {
  const [hour, minute] = time.split(":").map(Number);
  return DateTime.fromObject(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute
    },
    { zone }
  );
}

function parseWorkDays(value) {
  return value.split(",").map((item) => Number(item.trim())).filter(Boolean);
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
