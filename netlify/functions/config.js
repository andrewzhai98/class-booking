const DEFAULT_MAX_DAYS_AHEAD = 14;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { message: "Method not allowed" });
  }

  return json(200, {
    maxDaysAhead: positiveNumber(process.env.MAX_DAYS_AHEAD, DEFAULT_MAX_DAYS_AHEAD),
    minLeadHours: positiveNumber(process.env.MIN_LEAD_HOURS, 12),
    slotDurationMinutes: positiveNumber(process.env.SLOT_DURATION_MINUTES, 15),
    freeTrialDurationMinutes: positiveNumber(process.env.FREE_TRIAL_DURATION_MINUTES, 15),
    regularLessonDurationMinutes: positiveNumber(process.env.REGULAR_LESSON_DURATION_MINUTES, 45)
  });
};

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
