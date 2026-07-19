const { supabaseFetch, json, userError } = require('./supabase-client.js');
const { confirmCampRegistration, sendCampConfirmedEmailsOnce } = require('./group-email.js');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method not allowed' });

  try {
    if (!STRIPE_SECRET_KEY) throw userError('Stripe is not configured.', 500);

    const payload = JSON.parse(event.body || '{}');
    const sessionId = String(payload.sessionId || '').trim();
    if (!sessionId || !sessionId.startsWith('cs_')) throw userError('Missing Stripe checkout session ID.', 400);

    const stripeSession = await getStripeCheckoutSession(sessionId);
    const registrationId = stripeSession.metadata?.registration_id || stripeSession.client_reference_id;
    if (!registrationId) throw userError('This payment is missing a registration reference.', 400);

    const isPaid = stripeSession.payment_status === 'paid' || stripeSession.status === 'complete';
    if (!isPaid) throw userError('Payment has not been completed yet.', 402);

    const registration = await confirmCampRegistration(registrationId);
    await sendCampConfirmedEmailsOnce(registrationId);
    if (!registration) throw userError('Registration not found.', 404);

    const links = await supabaseFetch(`group_registration_sessions?registration_id=eq.${encodeURIComponent(registrationId)}&select=session_id,selection_status`);
    const sessionIds = (links || []).map((link) => link.session_id).filter(Boolean);
    let sessions = [];
    if (sessionIds.length) {
      sessions = await supabaseFetch(`group_sessions?id=in.(${sessionIds.join(',')})&select=id,session_number,title,display_time,session_key,camp_time&order=session_number.asc`);
    }

    return json(200, {
      ok: true,
      paymentStatus: 'paid',
      registration: {
        id: registration.id,
        studentName: registration.student_name,
        studentEmail: registration.student_email,
        campTime: registration.camp_time,
        passType: registration.pass_type,
        passPrice: registration.pass_price,
        currency: registration.currency || 'GBP',
        status: registration.status,
        paymentStatus: registration.payment_status
      },
      sessions: sessions || []
    });
  } catch (error) {
    console.error('confirm-group-payment failed', error);
    return json(error.statusCode || 500, { message: error.message || 'Unable to confirm English Camp payment.' });
  }
};

async function getStripeCheckoutSession(sessionId) {
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw userError(data.error?.message || 'Unable to verify Stripe payment.', 502);
  return data;
}
