const BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').replace(/^\uFEFF/, '').trim();
const GUILD_ID = (process.env.DISCORD_GUILD_ID || '1520303271787368508').replace(/^\uFEFF/, '').trim();
const LUMA_CALENDAR_ID = (process.env.LUMA_CALENDAR_ID || 'cal-4yoBq2YOKfqCfBj').replace(/^\uFEFF/, '').trim();
const ANNOUNCEMENT_CHANNEL_ID = (process.env.ANNOUNCEMENT_CHANNEL_ID || '1567848463440412734').replace(/^\uFEFF/, '').trim();

if (!BOT_TOKEN) {
  console.error('❌ Error: DISCORD_BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const DAY_MS = 24 * 3600 * 1000;

function lumaKeys(text) {
  return [...String(text || '').matchAll(/https:\/\/(?:lu\.ma|luma\.com)\/[^\s<>()\[\]"]+/gi)].map(([link]) => {
    const url = new URL(link);
    return url.pathname.replace(/\/$/, '');
  });
}

function optimizeCoverUrl(url) {
  if (!url) return null;
  if (url.includes('images.lumacdn.com/') && !url.includes('cdn-cgi/image')) {
    return url.replace(
      'https://images.lumacdn.com/',
      'https://images.lumacdn.com/cdn-cgi/image/format=jpeg,fit=cover,quality=80,width=1200,height=630/'
    );
  }
  return url;
}

function formatLocation(raw) {
  return String(raw || 'Online')
    .replace(/,\s*French Quarter/gi, '')
    .replace(/\s+\d{5,6}(?=,|$)/g, '')
    .replace(/,\s*(?:Vietnam|Việt Nam)$/i, '')
    .replace(/^([^,]+-\s*(\d+\s+[^,]+)),\s*\d+\s+(?:P\.\s*)?\2/i, '$1');
}

function buildNotificationPayload(ev, location, lumaUrl, coverUrl, isReminder = false) {
  const startDate = new Date(ev.start_at);
  const endDate = new Date(ev.end_at || startDate.getTime() + 2 * 3600 * 1000);
  const tz = { timeZone: 'Asia/Ho_Chi_Minh' };
  const startClock = startDate.toLocaleTimeString('vi-VN', { ...tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const endClock = endDate.toLocaleTimeString('vi-VN', { ...tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const weekday = startDate.toLocaleDateString('vi-VN', { ...tz, weekday: 'long' });
  const datePart = startDate.toLocaleDateString('vi-VN', { ...tz, day: '2-digit', month: '2-digit', year: 'numeric' });
  const unixStart = Math.floor(startDate.getTime() / 1000);
  const timeStr = `${startClock} – ${endClock} · ${weekday}, ${datePart} (<t:${unixStart}:R>)`;

  const authorName = isReminder ? '⏰ NHẮC LỊCH · CÒN 7 NGÀY' : '📢 SỰ KIỆN MỚI';
  const lead = isReminder
    ? 'Sự kiện của Vietnam Debate Network sẽ diễn ra vào tuần sau! Hãy đăng ký tham gia sớm nhé.'
    : 'Vietnam Debate Network vừa mở đăng ký sự kiện mới trên Luma!';

  const embed = {
    author: { name: authorName },
    title: ev.name,
    url: lumaUrl,
    description: `${lead}\n\n🗓️ **Thời gian:** ${timeStr}\n📍 **Địa điểm:** ${location}`,
    color: 0x5865F2,
    footer: { text: 'VDN Meetup' },
    timestamp: new Date().toISOString()
  };
  if (coverUrl) embed.image = { url: coverUrl };

  return {
    content: '@everyone',
    embeds: [embed],
    components: [{
      type: 1,
      components: [{ type: 2, style: 5, label: '🎟️ Đăng Ký Tham Gia', url: lumaUrl }]
    }]
  };
}

async function syncLumaEvents() {
  console.log(`1. Fetching events from Luma Calendar (${LUMA_CALENDAR_ID})...`);
  const lumaRes = await fetch(`https://api.lu.ma/calendar/get-items?calendar_api_id=${LUMA_CALENDAR_ID}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  });

  if (!lumaRes.ok) {
    throw new Error(`Failed to fetch Luma calendar: ${lumaRes.status} ${await lumaRes.text()}`);
  }

  const lumaData = await lumaRes.json();
  const now = Date.now();
  const entries = (lumaData.entries || []).filter(entry => {
    const event = entry?.event;
    return event?.visibility === 'public' && Date.parse(event.start_at) > now;
  });
  console.log(`✅ Found ${entries.length} upcoming public event(s) on Luma.`);
  if (!entries.length) return;

  const headers = {
    'Authorization': `Bot ${BOT_TOKEN}`,
    'Content-Type': 'application/json'
  };

  console.log('2. Fetching existing Discord Scheduled Events...');
  const discordRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events`, { headers });
  if (!discordRes.ok) {
    throw new Error(`Failed to fetch Discord events: ${discordRes.status}`);
  }
  const discordEventsRaw = await discordRes.json();
  if (!Array.isArray(discordEventsRaw)) throw new Error('Invalid Discord event list');
  const discordEvents = discordEventsRaw;
  let channelMessages = null;

  for (const entry of entries) {
    const ev = entry.event;
    if (!ev) continue;

    console.log(`\nProcessing: "${ev.name}"...`);

    // Check if Discord already has an event with matching name or start time
    // Prefer the registration URL: names and start times can change.
    if (!ev.url) throw new Error('Luma event is missing its registration URL');
    const lumaUrl = /^https:\/\//i.test(ev.url) ? ev.url : `https://lu.ma/${ev.url}`;
    const [key] = lumaKeys(lumaUrl);
    if (!key) throw new Error('Invalid Luma registration URL');
    let matches = discordEvents.filter(de => lumaKeys(de.description).includes(key));
    if (!matches.length) {
      matches = discordEvents.filter(de => !lumaKeys(de.description).length && de.name.toLowerCase() === ev.name.slice(0, 100).toLowerCase());
    }
    if (matches.length > 1) throw new Error(`Multiple Discord events match Luma event ${ev.api_id || key}`);
    const existing = matches[0];
    if (existing && existing.status !== 1) {
      console.log(`⏩ Event is no longer scheduled (ID: ${existing.id}). Skipping.`);
      continue;
    }
    if (existing && existing.entity_type !== 3) throw new Error(`Matched event ${existing.id} is not external`);

    // Determine event location
    let locationStr = 'Online';
    if (ev.geo_address_info && ev.geo_address_info.full_address) {
      locationStr = formatLocation(ev.geo_address_info.full_address);
    } else if (ev.geo_address_info && ev.geo_address_info.address) {
      locationStr = formatLocation(ev.geo_address_info.address);
    }

    const registration = `Đăng ký tại: ${lumaUrl}`;
    if (registration.length > 1000) throw new Error('Luma registration URL is too long');
    const intro = (ev.description || '').slice(0, Math.max(0, 1000 - registration.length - 2));
    const description = intro ? `${intro}\n\n${registration}` : registration;

    const payload = {
      name: ev.name.slice(0, 100),
      privacy_level: 2, // GUILD_ONLY
      scheduled_start_time: new Date(ev.start_at).toISOString(),
      scheduled_end_time: ev.end_at ? new Date(ev.end_at).toISOString() : new Date(new Date(ev.start_at).getTime() + 2 * 3600 * 1000).toISOString(),
      description,
      entity_type: 3, // EXTERNAL
      entity_metadata: {
        location: locationStr.slice(0, 100)
      }
    };

    // Download cover image if present
    const coverUrl = optimizeCoverUrl(ev.cover_url);
    if (coverUrl) {
      try {
        console.log(`- Fetching optimized cover image from: ${coverUrl}`);
        const imgRes = await fetch(coverUrl);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get('content-type') || 'image/jpeg';
          if (buffer.length <= 7 * 1024 * 1024) {
            payload.image = `data:${mime};base64,${buffer.toString('base64')}`;
            console.log(`- Attached image (${(buffer.length / 1024).toFixed(1)} KB)`);
          } else {
            console.log('- Image size > 7MB, skipped.');
          }
        }
      } catch (err) {
        console.warn('Could not attach image:', err.message);
      }
    }

    if (existing) {
      console.log(`- Updating Discord Scheduled Event (ID: ${existing.id})...`);
      const updateRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events/${existing.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload)
      });
      if (!updateRes.ok) throw new Error(`Failed to update Discord event ${existing.id}: ${updateRes.status}`);
      Object.assign(existing, await updateRes.json());
      console.log(`✅ Updated Discord Scheduled Event (ID: ${existing.id}).`);

      const msUntilStart = Date.parse(ev.start_at) - now;
      if (msUntilStart > 6 * DAY_MS && msUntilStart <= 7.6 * DAY_MS) {
        if (!channelMessages) {
          const msgRes = await fetch(`https://discord.com/api/v10/channels/${ANNOUNCEMENT_CHANNEL_ID}/messages?limit=50`, { headers });
          channelMessages = msgRes.ok ? await msgRes.json() : [];
        }
        // ponytail: scan last 50 channel messages instead of external state DB; upgrade if channel exceeds 50 msgs/day
        const alreadyReminded = Array.isArray(channelMessages) && channelMessages.some(
          msg => msg.embeds?.some(e => e.author?.name?.startsWith('⏰') || e.title?.startsWith('⏰')) && lumaKeys(JSON.stringify(msg)).includes(key)
        );
        if (!alreadyReminded) {
          const reminderBody = buildNotificationPayload(ev, payload.entity_metadata.location, lumaUrl, coverUrl, true);
          console.log('- Sending 7-day reminder in announcements channel...');
          await fetch(`https://discord.com/api/v10/channels/${ANNOUNCEMENT_CHANNEL_ID}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify(reminderBody)
          });
          if (Array.isArray(channelMessages)) channelMessages.push(reminderBody);
          console.log('✅ Sent 7-day reminder notification to @everyone');
        }
      }
      continue;
    }

    console.log('- Creating Discord Scheduled Event...');
    const createRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (createRes.ok) {
      const created = await createRes.json();
      discordEvents.push(created);
      console.log(`🎉 Successfully created Discord Scheduled Event: ${created.name} (ID: ${created.id})`);

      const notifyBody = buildNotificationPayload(ev, payload.entity_metadata.location, lumaUrl, coverUrl, false);
      console.log('- Sending announcement notification in announcements channel...');
      await fetch(`https://discord.com/api/v10/channels/${ANNOUNCEMENT_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(notifyBody)
      });
      console.log('✅ Sent announcement notification to @everyone');
    } else {
      console.error('Failed to create Discord event:', await createRes.text());
    }
  }

  console.log('\nAll Luma events synced!');
}

syncLumaEvents().catch(err => {
  console.error('Error syncing events:', err);
  process.exit(1);
});
