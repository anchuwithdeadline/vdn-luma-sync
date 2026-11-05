const BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').replace(/^\uFEFF/, '').trim();
const GUILD_ID = (process.env.DISCORD_GUILD_ID || '1520303271787368508').replace(/^\uFEFF/, '').trim();
const LUMA_CALENDAR_ID = (process.env.LUMA_CALENDAR_ID || 'cal-4yoBq2YOKfqCfBj').replace(/^\uFEFF/, '').trim();
const ANNOUNCEMENT_CHANNEL_ID = (process.env.ANNOUNCEMENT_CHANNEL_ID || '1567848463440412734').replace(/^\uFEFF/, '').trim();

if (!BOT_TOKEN) {
  console.error('❌ Error: DISCORD_BOT_TOKEN environment variable is required.');
  process.exit(1);
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
  const entries = lumaData.entries || [];
  console.log(`✅ Found ${entries.length} event(s) on Luma.`);

  const headers = {
    'Authorization': `Bot ${BOT_TOKEN}`,
    'Content-Type': 'application/json'
  };

  console.log('2. Fetching existing Discord Scheduled Events...');
  const discordRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events`, { headers });
  const discordEventsRaw = await discordRes.json();
  const discordEvents = Array.isArray(discordEventsRaw) ? discordEventsRaw : [];

  for (const entry of entries) {
    const ev = entry.event;
    if (!ev) continue;

    console.log(`\nProcessing: "${ev.name}"...`);

    // Check if Discord already has an event with matching name or start time
    const existing = discordEvents.find(de => de.name.toLowerCase() === ev.name.toLowerCase());
    if (existing) {
      console.log(`⏩ Event already exists on Discord (ID: ${existing.id}). Skipping.`);
      continue;
    }

    // Determine event location
    let locationStr = 'Online';
    if (ev.geo_address_info && ev.geo_address_info.full_address) {
      locationStr = ev.geo_address_info.full_address;
    } else if (ev.geo_address_info && ev.geo_address_info.address) {
      locationStr = ev.geo_address_info.address;
    }

    const lumaUrl = `https://lu.ma/${ev.url}`;
    const description = ev.description
      ? `${ev.description}\n\nĐăng ký tại:\n👉 ${lumaUrl}`.slice(0, 1000)
      : `Đăng ký tại:\n👉 ${lumaUrl}`;

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
    if (ev.cover_url) {
      try {
        console.log(`- Fetching cover image from: ${ev.cover_url}`);
        const imgRes = await fetch(ev.cover_url);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get('content-type') || 'image/jpeg';
          if (buffer.length <= 7 * 1024 * 1024) {
            payload.image = `data:${mime};base64,${buffer.toString('base64')}`;
            console.log(`- Attached image (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
          } else {
            console.log('- Image size > 7MB, skipped.');
          }
        }
      } catch (err) {
        console.warn('Could not attach image:', err.message);
      }
    }

    console.log('- Creating Discord Scheduled Event...');
    const createRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (createRes.ok) {
      const created = await createRes.json();
      console.log(`🎉 Successfully created Discord Scheduled Event: ${created.name} (ID: ${created.id})`);

      // Post notification in announcements channel
      const startDate = new Date(ev.start_at);
      const endDate = new Date(ev.end_at);
      const timeStr = `${startDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} - ${endDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} (${startDate.toLocaleDateString('vi-VN')})`;

      const notifyEmbed = {
        title: `📢 SỰ KIỆN MỚI: ${ev.name}`,
        description: `Vietnam Debate Network vừa mở đăng ký sự kiện mới trên Luma!\n\n🗓️ **Thời gian:** ${timeStr}\n📍 **Địa điểm:** ${payload.entity_metadata.location}\n\n👉 **Xem chi tiết sự kiện trên đỉnh server hoặc bấm nút bên dưới để nhận vé Luma:**`,
        color: 0x5865F2,
        footer: { text: 'Vietnam Debate Network (VDN) Events' },
        timestamp: new Date().toISOString()
      };

      const notifyComponents = [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: '🎟️ Đăng Ký Vé Trên Luma',
              url: lumaUrl
            }
          ]
        }
      ];

      console.log('- Sending announcement notification in announcements channel...');
      await fetch(`https://discord.com/api/v10/channels/${ANNOUNCEMENT_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: '@everyone',
          embeds: [notifyEmbed],
          components: notifyComponents
        })
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
