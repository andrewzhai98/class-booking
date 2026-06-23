const { DateTime } = require("luxon");

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "English with Becky <onboarding@resend.dev>";
const TEACHER_NOTIFICATION_EMAIL = process.env.TEACHER_NOTIFICATION_EMAIL || process.env.TEACHER_EMAIL || "";
const TEACHER_TIMEZONE = process.env.TEACHER_TIMEZONE || "Europe/London";
const SITE_URL = process.env.SITE_URL || "";
const MIN_LEAD_HOURS = Number(process.env.MIN_LEAD_HOURS || 12);
const BOOKING_PAGE_URL = process.env.BOOKING_PAGE_URL || (SITE_URL ? `${SITE_URL.replace(/\/$/, "")}/booking.html` : "booking.html");
const MANAGE_CUTOFF_HOURS = Number(process.env.MANAGE_CUTOFF_HOURS || 12);

async function sendBookingConfirmationEmail({ booking, classConfig, manageLink }) {
  return sendBookingEmail({
    to: booking.email,
    subject: "Your English lesson is confirmed",
    heading: "Your English lesson is confirmed",
    intro: "Your lesson has been booked. Please save the details below.",
    booking,
    classConfig,
    manageLink,
    actionText: "View or manage your booking",
    actionUrl: manageLink,
    extraHtml: policyHtml()
  });
}

async function sendBookingUpdatedEmail({ booking, classConfig, manageLink }) {
  return sendBookingEmail({
    to: booking.email,
    subject: "Your English lesson time has been updated",
    heading: "Your English lesson time has been updated",
    intro: "Your booking has been updated. Please use the new lesson time below.",
    booking,
    classConfig,
    manageLink,
    actionText: "View or manage your booking",
    actionUrl: manageLink,
    extraHtml: policyHtml()
  });
}

async function sendBookingReminderEmail({ booking, classConfig, manageLink }) {
  return sendBookingEmail({
    to: booking.email,
    subject: "Reminder: your English lesson is today",
    heading: "Your English lesson is coming up",
    intro: "Just a friendly reminder that you have an English lesson today. Your teacher will send you the meeting link before the lesson.",
    booking,
    classConfig,
    manageLink,
    actionText: "View or manage your booking",
    actionUrl: manageLink,
    extraHtml: policyHtml()
  });
}

async function sendBookingCancelledEmail({ booking, classConfig, refunded }) {
  const creditMessage = classConfig.creditCost > 0
    ? (refunded ? "Your lesson credit has been returned." : "If this lesson used credits, please contact the teacher if you have any questions about your credit balance.")
    : "No credits were used for this booking.";

  return sendBookingEmail({
    to: booking.email,
    subject: "Your English lesson has been cancelled",
    heading: "Your English lesson has been cancelled",
    intro: "This booking has been cancelled.",
    booking,
    classConfig,
    manageLink: booking.manageLink,
    actionText: "Book another lesson",
    actionUrl: BOOKING_PAGE_URL,
    extraHtml: `<p style="margin:16px 0 0;color:#4b5563;line-height:1.6;">${escapeHtml(creditMessage)}</p>`
  });
}

async function sendTrialRequestReceivedEmail({ booking, classConfig }) {
  return sendBookingEmail({
    to: booking.email,
    subject: "We received your free trial request",
    heading: "Your free trial request has been received",
    intro: "Your free trial request has been received, but this is not a confirmed booking yet. It needs to be approved by the teacher first.",
    booking,
    classConfig,
    manageLink: "",
    actionText: "",
    actionUrl: "",
    extraHtml: `
      <p style="margin:16px 0 0;color:#4b5563;line-height:1.6;">Your selected time is a request only. Before confirming a free trial, the teacher will review your learning goals, lesson options, and availability. This helps make sure the lesson is a good fit for your needs.</p>
      <p style="margin:12px 0 0;color:#4b5563;line-height:1.6;">The teacher will contact you by email shortly to discuss the next steps.</p>
    `
  });
}

async function sendTrialRequestRejectedEmail({ booking, classConfig }) {
  return sendBookingEmail({
    to: booking.email,
    subject: "Update about your free trial request",
    heading: "Free trial request update",
    intro: "Thank you for your free trial request. After review, this requested trial time cannot be confirmed.",
    booking,
    classConfig,
    manageLink: "",
    actionText: "Book another lesson",
    actionUrl: BOOKING_PAGE_URL,
    extraHtml: `<p style="margin:16px 0 0;color:#4b5563;line-height:1.6;">Teacher may contact you by email if there is another lesson option or time that is a better fit.</p>`
  });
}

async function sendTeacherNewBookingEmail({ booking, classConfig, manageLink }) {
  return sendTeacherEmail({
    subject: `New booking: ${classConfig.title}`,
    heading: `New booking: ${classConfig.title}`,
    intro: "A student has booked a lesson.",
    booking,
    classConfig,
    manageLink,
    timeLabel: "Lesson time"
  });
}

async function sendTeacherTrialReviewEmail({ booking, classConfig, reviewLink }) {
  return sendTeacherEmail({
    subject: "New free trial request",
    heading: "New free trial request",
    intro: "A student has requested a free trial class. Please review the student details before confirming.",
    booking,
    classConfig,
    manageLink: reviewLink,
    timeLabel: "Requested trial time",
    statusRows: [["Request status", "Pending teacher approval"]]
  });
}

async function sendTeacherBookingUpdatedEmail({ booking, classConfig, previousStartTime, previousEndTime, manageLink }) {
  return sendTeacherEmail({
    subject: `Booking updated: ${classConfig.title}`,
    heading: `Booking updated: ${classConfig.title}`,
    intro: "A student has updated their booking time.",
    booking,
    classConfig,
    manageLink,
    timeLabel: "New lesson time",
    previousStartTime,
    previousEndTime
  });
}

async function sendTeacherBookingCancelledEmail({ booking, classConfig, refunded, manageLink }) {
  return sendTeacherEmail({
    subject: `Booking cancelled: ${classConfig.title}`,
    heading: `Booking cancelled: ${classConfig.title}`,
    intro: "A student has cancelled a booking.",
    booking,
    classConfig,
    manageLink,
    timeLabel: "Cancelled lesson time",
    statusRows: [["Credit refunded", refunded ? "Yes" : "No"]]
  });
}

async function sendTeacherEmail({ subject, heading, intro, booking, classConfig, manageLink, timeLabel, previousStartTime, previousEndTime, statusRows = [] }) {
  if (!TEACHER_NOTIFICATION_EMAIL) {
    console.warn("Teacher email skipped: TEACHER_NOTIFICATION_EMAIL is not set.");
    return { skipped: true, reason: "missing_teacher_email" };
  }

  return sendRawEmail({
    to: TEACHER_NOTIFICATION_EMAIL,
    subject,
    html: buildTeacherEmailHtml({ heading, intro, booking, classConfig, manageLink, timeLabel, previousStartTime, previousEndTime, statusRows }),
    text: buildTeacherEmailText({ heading, intro, booking, classConfig, manageLink, timeLabel, previousStartTime, previousEndTime, statusRows })
  });
}

async function sendBookingEmail({ to, subject, heading, intro, booking, classConfig, manageLink, actionText, actionUrl, extraHtml = "" }) {
  const html = buildEmailHtml({ heading, intro, booking, classConfig, manageLink, actionText, actionUrl, extraHtml });
  const text = buildEmailText({ heading, intro, booking, classConfig, manageLink, actionUrl });
  return sendRawEmail({ to, subject, html, text });
}

async function sendRawEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.warn("Email skipped: RESEND_API_KEY is not set.");
    return { skipped: true, reason: "missing_api_key" };
  }

  if (!to) {
    console.warn("Email skipped: recipient email is missing.");
    return { skipped: true, reason: "missing_recipient" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [to],
      subject,
      html,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || `Resend email failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
}

function buildEmailHtml({ heading, intro, booking, classConfig, manageLink, actionText, actionUrl, extraHtml }) {
  const studentName = escapeHtml(booking.name || "there");
  const rows = [
    ["Class", classConfig.title],
    ["Date and time", formatRange(booking.startTime, booking.endTime, booking.timezone)],
    ["Time zone", booking.timezone || "UTC"],
    ["Duration", `${classConfig.durationMinutes} minutes`],
    ["Credits", `${classConfig.creditCost} credit${classConfig.creditCost === 1 ? "" : "s"}`],
    ["Booking ID", booking.bookingId]
  ];

  const detailRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 0;color:#6b7280;font-weight:700;width:36%;">${escapeHtml(label)}</td>
      <td style="padding:10px 0;color:#111827;font-weight:800;">${escapeHtml(value)}</td>
    </tr>
  `).join("");

  const actionButton = actionUrl ? `
    <p style="margin:24px 0 0;">
      <a href="${escapeAttribute(actionUrl)}" style="display:inline-block;background:linear-gradient(90deg,#ec4899,#8b5cf6);color:#ffffff;text-decoration:none;border-radius:999px;padding:13px 18px;font-weight:900;">${escapeHtml(actionText)}</a>
    </p>
  ` : "";

  const manageNote = manageLink ? `
    <p style="margin:16px 0 0;color:#6b7280;line-height:1.6;">Private manage link: <a href="${escapeAttribute(manageLink)}" style="color:#7c3aed;">${escapeHtml(manageLink)}</a></p>
    <p style="margin:8px 0 0;color:#6b7280;line-height:1.6;">Please keep this link private.</p>
  ` : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;color:#111827;">
    <div style="max-width:640px;margin:0 auto;padding:28px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:24px;padding:28px;box-shadow:0 12px 32px rgba(17,24,39,.08);">
        <div style="display:inline-block;background:#fdf2f8;color:#be185d;border-radius:999px;padding:7px 12px;font-size:13px;font-weight:900;margin-bottom:14px;">English with Becky</div>
        <h1 style="margin:0 0 12px;font-size:30px;line-height:1.15;">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 18px;color:#4b5563;line-height:1.6;">Hi ${studentName},</p>
        <p style="margin:0 0 18px;color:#4b5563;line-height:1.6;">${escapeHtml(intro)}</p>
        <table role="presentation" width="100%" style="border-collapse:collapse;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:18px 0;">${detailRows}</table>
        ${actionButton}
        ${manageNote}
        ${extraHtml || ""}
        <p style="margin:24px 0 0;color:#4b5563;line-height:1.6;">See you soon,<br>English with Becky</p>
      </div>
    </div>
  </body>
</html>`;
}

function buildEmailText({ heading, intro, booking, classConfig, manageLink, actionUrl }) {
  return [
    heading,
    "",
    `Hi ${booking.name || "there"},`,
    intro,
    "",
    `Class: ${classConfig.title}`,
    `Date and time: ${formatRange(booking.startTime, booking.endTime, booking.timezone)}`,
    `Time zone: ${booking.timezone || "UTC"}`,
    `Duration: ${classConfig.durationMinutes} minutes`,
    `Credits: ${classConfig.creditCost} credit${classConfig.creditCost === 1 ? "" : "s"}`,
    `Booking ID: ${booking.bookingId}`,
    "",
    manageLink ? `Manage booking: ${manageLink}` : "",
    actionUrl && actionUrl !== manageLink ? `Link: ${actionUrl}` : "",
    "",
    manageLink ? `Cancellation policy: You can cancel your lesson online no less than ${MANAGE_CUTOFF_HOURS} hours before the lesson. If it is less than ${MANAGE_CUTOFF_HOURS} hours before the lesson, please contact the teacher directly.` : "",
    "",
    "English with Becky"
  ].filter(Boolean).join("\n");
}

function buildTeacherEmailHtml({ heading, intro, booking, classConfig, manageLink, timeLabel, previousStartTime, previousEndTime, statusRows }) {
  const lessonRows = [
    [timeLabel, formatRange(booking.startTime, booking.endTime, TEACHER_TIMEZONE)],
    ["Time zone", TEACHER_TIMEZONE],
    ["Class", classConfig.title],
    ["Duration", `${classConfig.durationMinutes} minutes`],
    ["Cancellation policy", `Students can cancel online no less than ${MANAGE_CUTOFF_HOURS} hours before the lesson.`],
    ...statusRows
  ];

  if (previousStartTime && previousEndTime) {
    lessonRows.unshift(["Previous lesson time", formatRange(previousStartTime, previousEndTime, TEACHER_TIMEZONE)]);
  }

  const studentRows = [
    ["Name", booking.name || ""],
    ["Email", booking.email || ""],
    ["Contact", booking.contact || ""],
    ["Level", booking.studentLevel || ""],
    ["Goal", booking.goal || ""],
    ["Notes", booking.notes || ""]
  ].filter(([, value]) => String(value || "").trim());

  const adminRows = [
    ["Booking ID", booking.bookingId || ""],
    ["Manage link", manageLink || booking.manageLink || ""]
  ].filter(([, value]) => String(value || "").trim());

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;color:#111827;">
    <div style="max-width:680px;margin:0 auto;padding:28px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:24px;padding:28px;box-shadow:0 12px 32px rgba(17,24,39,.08);">
        <div style="display:inline-block;background:#fdf2f8;color:#be185d;border-radius:999px;padding:7px 12px;font-size:13px;font-weight:900;margin-bottom:14px;">Teacher notification</div>
        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.15;">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 18px;color:#4b5563;line-height:1.6;">${escapeHtml(intro)}</p>
        ${tableHtml("Lesson details", lessonRows)}
        ${tableHtml("Student details", studentRows)}
        ${tableHtml("Admin details", adminRows)}
      </div>
    </div>
  </body>
</html>`;
}

function buildTeacherEmailText({ heading, intro, booking, classConfig, manageLink, timeLabel, previousStartTime, previousEndTime, statusRows }) {
  const lines = [heading, "", intro, "", "Lesson details:"];
  if (previousStartTime && previousEndTime) lines.push(`Previous lesson time: ${formatRange(previousStartTime, previousEndTime, TEACHER_TIMEZONE)}`);
  lines.push(`${timeLabel}: ${formatRange(booking.startTime, booking.endTime, TEACHER_TIMEZONE)}`);
  lines.push(`Time zone: ${TEACHER_TIMEZONE}`);
  lines.push(`Class: ${classConfig.title}`);
  lines.push(`Duration: ${classConfig.durationMinutes} minutes`);
  for (const [label, value] of statusRows) lines.push(`${label}: ${value}`);
  lines.push("", "Student details:");
  for (const [label, value] of [["Name", booking.name], ["Email", booking.email], ["Contact", booking.contact], ["Level", booking.studentLevel], ["Goal", booking.goal], ["Notes", booking.notes]]) {
    if (String(value || "").trim()) lines.push(`${label}: ${value}`);
  }
  lines.push("", "Admin details:", `Booking ID: ${booking.bookingId || ""}`);
  const finalManageLink = manageLink || booking.manageLink || "";
  if (finalManageLink) lines.push(`Manage link: ${finalManageLink}`);
  return lines.filter(Boolean).join("\n");
}

function tableHtml(title, rows) {
  if (!rows.length) return "";
  const body = rows.map(([label, value]) => `
    <tr>
      <td style="padding:9px 0;color:#6b7280;font-weight:700;width:34%;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:9px 0;color:#111827;font-weight:800;vertical-align:top;overflow-wrap:anywhere;">${escapeHtml(value)}</td>
    </tr>
  `).join("");
  return `
    <h2 style="margin:22px 0 8px;font-size:18px;">${escapeHtml(title)}</h2>
    <table role="presentation" width="100%" style="border-collapse:collapse;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">${body}</table>
  `;
}

function policyHtml() {
  return `
    <div style="margin-top:22px;background:#faf5ff;border:1px solid #ede9fe;border-radius:18px;padding:16px;">
      <p style="margin:0 0 6px;color:#111827;font-weight:900;">Cancellation policy</p>
      <p style="margin:0;color:#4b5563;line-height:1.6;">You can cancel your lesson online no less than ${MANAGE_CUTOFF_HOURS} hours before the lesson. If it is less than ${MANAGE_CUTOFF_HOURS} hours before the lesson, please contact the teacher directly.</p>
    </div>
  `;
}

function formatRange(startIso, endIso, timezone) {
  const start = DateTime.fromISO(startIso, { zone: "utc" }).setZone(timezone || "UTC");
  const end = DateTime.fromISO(endIso, { zone: "utc" }).setZone(timezone || "UTC");
  if (!start.isValid || !end.isValid) return `${startIso} - ${endIso}`;
  return `${start.toFormat("cccc, LLLL d, yyyy, h:mm a")} - ${end.toFormat("h:mm a")}`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

module.exports = {
  sendBookingConfirmationEmail,
  sendBookingUpdatedEmail,
  sendBookingCancelledEmail,
  sendBookingReminderEmail,
  sendTrialRequestReceivedEmail,
  sendTrialRequestRejectedEmail,
  sendTeacherNewBookingEmail,
  sendTeacherTrialReviewEmail,
  sendTeacherBookingUpdatedEmail,
  sendTeacherBookingCancelledEmail
};
