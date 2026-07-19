const { GROUP_CLASS_KEY, supabaseFetch, json, userError } = require('./supabase-client.js');
const { sendCampPaymentPendingEmail } = require('./email.js');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || '';
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || '';

const CAMP_OPTIONS = {
  camp_time_a: {
    label: 'Camp A',
    timeLabel: '13:00–13:45 UK time',
    passes: {
      five_session_pass: { total: 25, perSession: 5, label: '5 Session Pass' },
      three_session_pass: { total: 20, perSession: 0, label: '3 Session Pass' }
    }
  },
  camp_time_b: {
    label: 'Camp B',
    timeLabel: '19:00–19:45 UK time',
    passes: {
      five_session_pass: { total: 25, perSession: 5, label: '5 Session Pass' },
      three_session_pass: { total: 20, perSession: 0, label: '3 Session Pass' }
    }
  }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method not allowed' });

  try {
    const payload = JSON.parse(event.body || '{}');
    const clean = validatePayload(payload);

    const classes = await supabaseFetch(`group_classes?class_key=eq.${encodeURIComponent(GROUP_CLASS_KEY)}&select=id,title,status,max_seats_per_session`);
    const groupClass = classes?.[0];
    if (!groupClass || groupClass.status !== 'open') {
      throw userError('Teacher Becky’s English Summer Camp is not open for requests right now.', 409);
    }

    const activeRows = await supabaseFetch(`group_registrations?class_id=eq.${encodeURIComponent(groupClass.id)}&student_email=eq.${encodeURIComponent(clean.studentEmail)}&status=not.in.(rejected,cancelled)&select=id,student_name,student_email,camp_time,pass_type,status,payment_status,pass_price,price_per_session,currency,created_at&order=created_at.desc&limit=1`);
    const activeRegistration = activeRows?.[0];
    if (activeRegistration) {
      const existingPricing = getPassPricing(activeRegistration.camp_time || clean.campTime, activeRegistration.pass_type || clean.passType);
      const existingSessions = await getRegistrationSessions(activeRegistration.id);
      let checkoutUrl = '';

      if (activeRegistration.payment_status === 'unpaid') {
        if (STRIPE_SECRET_KEY) {
          checkoutUrl = await createStripeCheckout({
            registration: activeRegistration,
            groupClass,
            sessions: existingSessions,
            pricing: existingPricing,
            passType: activeRegistration.pass_type || clean.passType
          });
          await sendPaymentPendingEmailSafely({ registration: activeRegistration, groupClass, sessions: existingSessions, checkoutUrl });
        }

        return json(200, {
          ok: true,
          duplicate: true,
          reusedRegistration: true,
          registrationId: activeRegistration.id,
          status: activeRegistration.status,
          paymentStatus: activeRegistration.payment_status,
          checkoutUrl,
          message: checkoutUrl
            ? 'You already have an active Teacher Becky’s English Summer Camp request. Please continue payment for your existing request.'
            : 'You already have an active Teacher Becky’s English Summer Camp request. Please wait for the teacher to review it, or contact the teacher if you need to change it.'
        });
      }

      if (activeRegistration.status === 'confirmed') {
        throw userError('You already have a confirmed Teacher Becky’s English Summer Camp booking. Please contact the teacher if you need to make a change.', 409);
      }

      throw userError('You already have an active Teacher Becky’s English Summer Camp booking. Please contact the teacher if you need to change it.', 409);
    }

    const sessions = await supabaseFetch(`group_sessions?class_id=eq.${groupClass.id}&session_key=in.(${clean.selectedSessions.join(',')})&select=id,session_key,session_number,title,display_time,camp_time,capacity`);
    if (!sessions || sessions.length !== clean.selectedSessions.length) {
      throw userError('One or more selected sessions are unavailable.', 400);
    }

    await enforceCapacity(sessions);

    const pricing = getPassPricing(clean.campTime, clean.passType);
    const registrationRows = await supabaseFetch('group_registrations', {
      method: 'POST',
      body: JSON.stringify({
        class_id: groupClass.id,
        student_name: clean.studentName,
        student_email: clean.studentEmail,
        level: clean.level,
        learning_goal: clean.learningGoal,
        camp_time: clean.campTime,
        pass_type: clean.passType,
        status: 'pending_payment',
        payment_status: 'unpaid',
        pass_price: pricing.total,
        price_per_session: pricing.perSession,
        currency: 'GBP'
      })
    });

    const registration = registrationRows?.[0];
    const linkRows = sessions.map((session) => ({
      registration_id: registration.id,
      session_id: session.id,
      selection_status: 'requested'
    }));
    await supabaseFetch('group_registration_sessions', {
      method: 'POST',
      body: JSON.stringify(linkRows)
    });

    let checkoutUrl = '';
    if (STRIPE_SECRET_KEY) {
      checkoutUrl = await createStripeCheckout({
        registration,
        groupClass,
        sessions,
        pricing,
        passType: clean.passType
      });
      await sendPaymentPendingEmailSafely({ registration, groupClass, sessions, checkoutUrl });
    }

    return json(200, {
      ok: true,
      registrationId: registration.id,
      status: registration.status,
      checkoutUrl,
      message: checkoutUrl
        ? 'Booking started. Please continue to the secure payment page to confirm your place.'
        : 'Booking started. Please contact the teacher to complete payment and confirm your place.'
    });
  } catch (error) {
    console.error('submit-group-registration failed', error);
    return json(error.statusCode || 500, { message: error.message || 'Unable to submit Teacher Becky’s English Summer Camp request.' });
  }
};

function validatePayload(payload) {
  const campTime = String(payload.campTime || '').trim();
  const passType = String(payload.passType || '').trim();
  const selectedSessions = Array.isArray(payload.selectedSessions) ? payload.selectedSessions.map(String) : [];
  const expectedCount = passType === 'five_session_pass' ? 5 : passType === 'three_session_pass' ? 3 : 0;

  if (!payload.studentName || String(payload.studentName).trim().length < 2) throw userError('Please enter the student name.');
  if (!payload.studentEmail || !/^\S+@\S+\.\S+$/.test(String(payload.studentEmail))) throw userError('Please enter a valid student email.');
  if (!campTime || !['camp_time_a', 'camp_time_b'].includes(campTime)) throw userError('Please choose a camp time.');
  if (!passType || !['three_session_pass', 'five_session_pass'].includes(passType)) throw userError('Please choose a pass type.');
  if (selectedSessions.length !== expectedCount) throw userError(`Please choose exactly ${expectedCount} sessions for this pass.`);
  const allowedSessions = getAllowedSessionKeys(campTime);
  if (selectedSessions.some(sessionKey => !allowedSessions.includes(sessionKey))) throw userError('Please choose sessions from your selected camp time.');
  if (payload.termsAccepted !== true) throw userError('Please read and agree to the Terms and Conditions before submitting.');

  return {
    studentName: String(payload.studentName).trim(),
    studentEmail: String(payload.studentEmail).trim().toLowerCase(),
    level: String(payload.level || '').trim(),
    learningGoal: String(payload.learningGoal || '').trim(),
    campTime,
    passType,
    selectedSessions
  };
}

async function sendPaymentPendingEmailSafely({ registration, groupClass, sessions, checkoutUrl }) {
  try {
    await sendCampPaymentPendingEmail({ registration, groupClass, sessions, checkoutUrl });
  } catch (error) {
    console.error('Camp payment pending email failed', error);
  }
}

function getPassPricing(campTime, passType) {
  const camp = CAMP_OPTIONS[campTime] || CAMP_OPTIONS.camp_time_a;
  const pricing = camp.passes[passType];
  if (!pricing) throw userError('Please choose a valid pass type.');
  return { ...pricing, campLabel: camp.label, timeLabel: camp.timeLabel };
}

function getAllowedSessionKeys(campTime) {
  const prefix = campTime === 'camp_time_b' ? 'camp-b-session-' : 'camp-a-session-';
  return [1, 2, 3, 4, 5].map(number => `${prefix}${number}`);
}


async function enforceCapacity(sessions) {
  for (const session of sessions || []) {
    const links = await supabaseFetch(`group_registration_sessions?session_id=eq.${encodeURIComponent(session.id)}&selection_status=eq.approved&select=registration_id`);
    const confirmed = links || [];
    if (confirmed.length >= Number(session.capacity || 6)) {
      throw userError(`${session.title || 'This session'} is already full. Please choose another session.`, 409);
    }
  }
}

async function getRegistrationSessions(registrationId) {
  const links = await supabaseFetch(`group_registration_sessions?registration_id=eq.${encodeURIComponent(registrationId)}&select=session_id`);
  const sessionIds = (links || []).map((link) => link.session_id).filter(Boolean);
  if (!sessionIds.length) return [];
  return supabaseFetch(`group_sessions?id=in.(${sessionIds.join(',')})&select=id,session_key,session_number,title,display_time,camp_time,capacity`);
}

function getSessionDayLabel(session) {
  const displayTime = String(session?.display_time || '');
  const day = displayTime.split('·')[0]?.trim();
  return day || session?.title || session?.session_key || '';
}

async function createStripeCheckout({ registration, groupClass, sessions, pricing, passType }) {
  const origin = getSiteOrigin();
  const successUrl = STRIPE_SUCCESS_URL || `${origin}/english-camp-confirmation.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = STRIPE_CANCEL_URL || `${origin}/english-camp.html?payment=cancelled&registration=${encodeURIComponent(registration.id)}`;
  const orderedSessions = (sessions || []).slice().sort((a, b) => Number(a.session_number || 0) - Number(b.session_number || 0));
  const sessionSummary = orderedSessions
    .map((session) => [session.title || session.session_key, session.display_time].filter(Boolean).join(' · '))
    .join(', ');
  const sessionDays = orderedSessions
    .map((session) => getSessionDayLabel(session))
    .filter(Boolean)
    .join(', ');
  const campTime = registration.camp_time || orderedSessions[0]?.camp_time || 'camp_time_a';
  const camp = CAMP_OPTIONS[campTime] || CAMP_OPTIONS.camp_time_a;
  const productName = `Teacher Becky’s English Summer Camp — ${camp.label} ${camp.timeLabel} — ${pricing.label}`;
  const productDescription = sessionDays
    ? `Summer in the UK · Selected sessions: ${sessionDays} · ${camp.timeLabel}`
    : sessionSummary || `${camp.label} · ${camp.timeLabel}`;

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('customer_email', registration.student_email);
  params.append('client_reference_id', registration.id);
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', 'gbp');
  params.append('line_items[0][price_data][unit_amount]', String(Math.round(pricing.total * 100)));
  params.append('line_items[0][price_data][product_data][name]', productName);
  params.append('line_items[0][price_data][product_data][description]', productDescription);
  params.append('metadata[registration_id]', registration.id);
  params.append('metadata[camp_time]', campTime);
  params.append('metadata[camp_label]', camp.label);
  params.append('metadata[camp_time_label]', camp.timeLabel);
  params.append('metadata[pass_type]', passType);
  params.append('metadata[pass_label]', pricing.label);
  params.append('metadata[amount_gbp]', String(pricing.total));
  params.append('metadata[selected_sessions]', orderedSessions.map((session) => session.session_key).filter(Boolean).join(','));

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw userError(data.error?.message || 'Unable to create Stripe checkout session.', 502);
  }
  return data.url;
}

function getSiteOrigin() {
  const configured = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  return 'http://localhost:8888';
}
