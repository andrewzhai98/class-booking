const { GROUP_CLASS_KEY, supabaseFetch, json, requireAdmin } = require('./supabase-client.js');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'GET') return json(405, { message: 'Method not allowed' });

  try {
    requireAdmin(event);
    const classes = await supabaseFetch(`group_classes?class_key=eq.${encodeURIComponent(GROUP_CLASS_KEY)}&select=id,class_key,title,status,max_seats_per_session,timezone`);
    const groupClass = classes?.[0];
    if (!groupClass) return json(404, { message: 'English Camp class not found.' });

    const sessions = await supabaseFetch(`group_sessions?class_id=eq.${groupClass.id}&select=id,session_key,session_number,title,display_time,camp_time,capacity&order=camp_time.asc,session_number.asc`);
    const registrations = await supabaseFetch(`group_registrations?class_id=eq.${groupClass.id}&select=id,student_name,student_email,level,learning_goal,camp_time,pass_type,pass_price,price_per_session,currency,status,payment_status,teacher_notes,created_at&order=created_at.desc`);
    const registrationIds = registrations.map((item) => item.id);
    let links = [];
    if (registrationIds.length) {
      links = await supabaseFetch(`group_registration_sessions?registration_id=in.(${registrationIds.join(',')})&select=registration_id,session_id,selection_status`);
    }

    return json(200, { ok: true, groupClass, sessions, registrations, links });
  } catch (error) {
    console.error('get-group-review failed', error);
    return json(error.statusCode || 500, { message: error.message || 'Unable to load English Camp review data.' });
  }
};
