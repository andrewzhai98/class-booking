const { google } = require("googleapis");
const { DateTime } = require("luxon");

const DEFAULT_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SLOT_DURATION_MINUTES = Number(process.env.SLOT_DURATION_MINUTES || 15);
const PRE_BUFFER_MINUTES = Number(process.env.PRE_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);
const POST_BUFFER_MINUTES = Number(process.env.POST_BUFFER_MINUTES ?? process.env.BUFFER_MINUTES ?? 15);
const MIN_LEAD_HOURS = Number(process.env.MIN_LEAD_HOURS || 12);

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { message: "Method not allowed" });

  try {
    requireEnv(["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY", "GOOGLE_CALENDAR_ID"]);

    const date = event.queryStringParameters?.date;
    const visitorTimezone = event.queryStringParameters?.timezone || DEFAULT_TIMEZONE;
    const duration = Number(event.queryStringParameters?.duration || SLOT_DURATION_MINUTES);

    if (!date) return json(400, { message: "Missing date parameter." });

    const workDays = parseWorkDays(process.env.WORK_DAYS || "1,2,3,4,5");
    const dayInTeacherTimezone = DateTime.fromISO(date, { zone: DEFAULT_TIMEZONE });

    if (!dayInTeacherTimezone.isValid) return json(400, { message: "Invalid date." });

    if (!workDays.includes(dayInTeacherTimezone.weekday)) {
      return json(200, { date, timezone: visitorTimezone, slots: [] });
    }

    const startOfWork = setTime(dayInTeacherTimezone, process.env.WORK_START || "09:00");
    const endOfWork = setTime(dayInTeacherTimezone, process.env.WORK_END || "17:00");

    const auth = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const busyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: startOfWork.minus({ minutes: PRE_BUFFER_MINUTES }).toISO(),
        timeMax: endOfWork.plus({ minutes: POST_BUFFER_MINUTES }).toISO(),
        timeZone: DEFAULT_TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });

    const busy = busyResponse.data.calendars?.[CALENDAR_ID]?.busy || [];
    const slots = buildAvailableSlots({
      startOfWork,
      endOfWork,
      duration,
      preBufferMinutes: PRE_BUFFER_MINUTES,
      postBufferMinutes: POST_BUFFER_MINUTES,
      busy,
      visitorTimezone
    });

    return json(200, {
      date,
      timezone: visitorTimezone,
      teacherTimezone: DEFAULT_TIMEZONE,
      minLeadHours: MIN_LEAD_HOURS,
      slots
    });
  } catch (error) {
    console.error(error);
    return json(error.statusCode || 500, { message: error.publicMessage || "Could not load availability. Please check Google Calendar environment variables." });
  }
};

function buildAvailableSlots({ startOfWork, endOfWork, duration, preBufferMinutes, postBufferMinutes, busy, visitorTimezone }) {
  const slots = [];
  const now = DateTime.utc().plus({ hours: MIN_LEAD_HOURS });
  let cursor = startOfWork;

  while (cursor.plus({ minutes: duration }) <= endOfWork) {
    const slotStart = cursor;
    const slotEnd = cursor.plus({ minutes: duration });
    const protectedStart = slotStart.minus({ minutes: preBufferMinutes });
    const protectedEnd = slotEnd.plus({ minutes: postBufferMinutes });

    const overlapsBusy = busy.some((item) => {
      const busyStart = DateTime.fromISO(item.start);
      const busyEnd = DateTime.fromISO(item.end);
      return protectedStart < busyEnd && protectedEnd > busyStart;
    });

    if (slotStart.toUTC() > now && !overlapsBusy) {
      const visitorStart = slotStart.setZone(visitorTimezone);
      const visitorEnd = slotEnd.setZone(visitorTimezone);
      slots.push({
        start: visitorStart.toISO(),
        end: visitorEnd.toISO(),
        label: visitorStart.toFormat("HH:mm"),
        display: `${visitorStart.toFormat("ccc, LLL d, HH:mm")} - ${visitorEnd.toFormat("HH:mm")}`
      });
    }

    cursor = cursor.plus({ minutes: SLOT_DURATION_MINUTES });
  }

  return slots;
}

function setTime(date, time) {
  const [hour, minute] = time.split(":").map(Number);
  return date.set({ hour, minute, second: 0, millisecond: 0 });
}

function parseWorkDays(value) {
  return value.split(",").map((item) => Number(item.trim())).filter(Boolean);
}

function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/calendar"]
  });
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    const error = new Error(`Missing required environment variables: ${missing.join(", ")}`);
    error.statusCode = 500;
    error.publicMessage = "Missing Google Calendar environment variables.";
    throw error;
  }
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
