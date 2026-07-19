const { supabaseFetch, json, requireAdmin, userError } = require('./supabase-client.js');
const { sendCampCancelledEmailOnce } = require('./group-email.js');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method not allowed' });

  try {
    requireAdmin(event);
    const payload = JSON.parse(event.body || '{}');
    const registrationId = String(payload.registrationId || '').trim();
    const action = String(payload.action || '').trim();
    if (!registrationId) throw userError('Missing registration ID.');

    const registrationRows = await supabaseFetch(`group_registrations?id=eq.${encodeURIComponent(registrationId)}&select=id,status,payment_status`);
    const currentRegistration = registrationRows?.[0];
    if (!currentRegistration) throw userError('Registration not found.', 404);

    const update = {};

async function enforceCapacity(registrationId) {
  const selected = await supabaseFetch(`group_registration_sessions?registration_id=eq.${encodeURIComponent(registrationId)}&select=session_id`);
  for (const row of selected || []) {
    const sessionRows = await supabaseFetch(`group_sessions?id=eq.${encodeURIComponent(row.session_id)}&select=id,title,capacity`);
    const session = sessionRows?.[0];
    if (!session) continue;
    const approvedLinks = await supabaseFetch(`group_registration_sessions?session_id=eq.${encodeURIComponent(row.session_id)}&selection_status=eq.approved&select=registration_id`);
    const occupied = (approvedLinks || []).filter((link) => link.registration_id !== registrationId).length;
    if (occupied >= Number(session.capacity || 6)) {
      throw userError(`${session.title || 'This session'} is already full. Please reject or cancel this request, or choose another session.`, 409);
    }
  }
}
    let selectionStatus = null;
    if (action === 'cancel') {
      update.status = 'cancelled';
      selectionStatus = 'cancelled';
    } else if (action === 'reject') {
      update.status = 'cancelled';
      selectionStatus = 'cancelled';
    } else if (action === 'approve') {
      update.status = 'confirmed';
      selectionStatus = 'approved';
    } else {
      throw userError('Unknown action.');
    }
    update.updated_at = new Date().toISOString();

    const rows = await supabaseFetch(`group_registrations?id=eq.${encodeURIComponent(registrationId)}`, {
      method: 'PATCH',
      body: JSON.stringify(update)
    });

    if (selectionStatus) {
      await supabaseFetch(`group_registration_sessions?registration_id=eq.${encodeURIComponent(registrationId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ selection_status: selectionStatus })
      });
    }

    if (action === 'cancel' || action === 'reject') {
      await sendCampCancelledEmailOnce(registrationId);
    }

    return json(200, { ok: true, registration: rows?.[0] || null });
  } catch (error) {
    console.error('update-group-registration failed', error);
    return json(error.statusCode || 500, { message: error.message || 'Unable to update English Camp registration.' });
  }
};
