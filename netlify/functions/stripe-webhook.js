const crypto = require('crypto');
const { json } = require('./supabase-client.js');
const { confirmCampRegistration, sendCampConfirmedEmailsOnce } = require('./group-email.js');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method not allowed' });

  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const stripeEvent = STRIPE_WEBHOOK_SECRET
      ? verifyStripeWebhook(rawBody, event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '')
      : JSON.parse(rawBody || '{}');

    if (stripeEvent.type === 'checkout.session.completed' || stripeEvent.type === 'checkout.session.async_payment_succeeded') {
      const session = stripeEvent.data?.object || {};
      const registrationId = session.metadata?.registration_id || session.client_reference_id;
      const isPaid = session.payment_status === 'paid' || session.status === 'complete';

      if (registrationId && isPaid) {
        await confirmCampRegistration(registrationId);
        await sendCampConfirmedEmailsOnce(registrationId);
      }
    }

    return json(200, { received: true });
  } catch (error) {
    console.error('stripe-webhook failed', error);
    return json(400, { message: error.message || 'Webhook error' });
  }
};

function verifyStripeWebhook(rawBody, signatureHeader) {
  if (!signatureHeader) throw new Error('Missing Stripe signature.');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, value] = part.split('=');
      return [key, value];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('Invalid Stripe signature header.');

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(signedPayload, 'utf8').digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    throw new Error('Invalid Stripe webhook signature.');
  }

  return JSON.parse(rawBody);
}
