const { supabaseFetch } = require('./supabase-client.js');
const {
  sendCampConfirmedEmail,
  sendTeacherCampPaidBookingEmail,
  sendCampCancelledEmail
} = require('./email.js');

async function confirmCampRegistration(registrationId) {
  const now = new Date().toISOString();
  const rows = await supabaseFetch(`group_registrations?id=eq.${encodeURIComponent(registrationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      payment_status: 'paid',
      status: 'confirmed',
      updated_at: now
    })
  });

  await supabaseFetch(`group_registration_sessions?registration_id=eq.${encodeURIComponent(registrationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ selection_status: 'approved' })
  });

  return rows?.[0] || null;
}

async function sendCampConfirmedEmailsOnce(registrationId) {
  const data = await loadCampEmailData(registrationId);
  const registration = data.registration;
  const updates = {};
  const now = new Date().toISOString();

  if (!registration.student_confirmed_email_sent_at) {
    await sendCampConfirmedEmail(data);
    updates.student_confirmed_email_sent_at = now;
  }

  if (!registration.teacher_paid_email_sent_at) {
    await sendTeacherCampPaidBookingEmail(data);
    updates.teacher_paid_email_sent_at = now;
  }

  if (Object.keys(updates).length) {
    updates.updated_at = now;
    await supabaseFetch(`group_registrations?id=eq.${encodeURIComponent(registrationId)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
  }

  return { sent: updates };
}

async function sendCampCancelledEmailOnce(registrationId) {
  const data = await loadCampEmailData(registrationId);
  const registration = data.registration;
  if (registration.student_cancelled_email_sent_at) return { skipped: true };

  await sendCampCancelledEmail(data);
  await supabaseFetch(`group_registrations?id=eq.${encodeURIComponent(registrationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      student_cancelled_email_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });

  return { sent: true };
}

async function loadCampEmailData(registrationId) {
  const registrationRows = await supabaseFetch(`group_registrations?id=eq.${encodeURIComponent(registrationId)}&select=id,class_id,student_name,student_email,level,learning_goal,camp_time,pass_type,pass_price,price_per_session,currency,status,payment_status,student_confirmed_email_sent_at,teacher_paid_email_sent_at,student_cancelled_email_sent_at,created_at`);
  const registration = registrationRows?.[0];
  if (!registration) throw new Error('English Camp registration not found for email.');

  const classRows = await supabaseFetch(`group_classes?id=eq.${encodeURIComponent(registration.class_id)}&select=id,title,description,timezone,max_seats_per_session`);
  const groupClass = classRows?.[0] || {};

  const links = await supabaseFetch(`group_registration_sessions?registration_id=eq.${encodeURIComponent(registrationId)}&select=session_id,selection_status`);
  const sessionIds = (links || []).map((link) => link.session_id).filter(Boolean);
  let sessions = [];
  if (sessionIds.length) {
    sessions = await supabaseFetch(`group_sessions?id=in.(${sessionIds.join(',')})&select=id,session_key,session_number,title,display_time,camp_time,capacity&order=session_number.asc`);
  }

  return {
    registration,
    groupClass,
    sessions: sessions || [],
    reviewLink: getGroupReviewUrl()
  };
}

function getGroupReviewUrl() {
  const explicit = process.env.GROUP_REVIEW_URL || '';
  if (explicit) return explicit;
  const origin = (process.env.SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  return origin ? `${origin}/group-review.html` : 'group-review.html';
}

module.exports = {
  confirmCampRegistration,
  sendCampConfirmedEmailsOnce,
  sendCampCancelledEmailOnce,
  loadCampEmailData
};
