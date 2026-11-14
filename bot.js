// ===== Interaction handler =====
client.on('interactionCreate', async (i) => {
  if (i.isAutocomplete()) {
    try {
      const products = await getProducts();
      const focused = i.options.getFocused().toLowerCase();
      const filtered = Object.keys(products)
        .filter(p => p.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(p => ({ name: p, value: p }));
      await i.respond(filtered);
    } catch (e) { try { await i.respond([]); } catch (_) {} }
    return;
  }

  // ===== License keys =====
  if (await keyApi.handleInteraction(i)) {
    if (['keygen', 'keyreset', 'keyrevoke', 'pause', 'extend', 'shorten'].indexOf(i.commandName) !== -1) {
      updateKeyOverview().catch(() => {});
    }
    return;
  }

  // ===== /purchase =====
  if (i.isChatInputCommand() && i.commandName === 'purchase') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    const productName = i.options.getString('product');
    const plan = i.options.getString('plan');
    const key = i.options.getString('key');

    const products = await getProducts();
    const productData = products[productName];
    if (!productData) return i.editReply({ content: `⚠️ Product **${productName}** not found. Add it in <#${PRODUCT_PANEL_CHANNEL_ID}>.` });

    const duration = planDurationMs(plan);
    if (duration === undefined) return i.editReply({ content: 'Unknown plan.' });

    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(targetUser.id);
      const roleId = productData.roleId;
      if (roleId) await member.roles.add(roleId, `Purchase: ${productName} (${plan})`).catch(() => {});
      await member.roles.add(CUSTOMER_ROLE_ID, `Purchase: ${productName} (${plan})`).catch(() => {});
      await keyApi.registerKey(key, plan, productName, i.user.id).catch(() => {});
      const { endTime } = await addPurchase(targetUser.id, productName, plan, key, roleId);
      await updateOverview();
      const planText = plan === 'lifetime' ? 'Lifetime' : plan;
      const embed = new EmbedBuilder()
        .setTitle('Purchase Completed').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
        .setDescription(`Thanks for your purchase, <@${targetUser.id}>!\n\nYour plan is active and your key is shown below.`)
        .addFields(
          { name: 'Customer', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Product', value: productName, inline: true },
          { name: 'Plan', value: planText, inline: true },
          { name: 'Duration', value: formatDuration(duration), inline: true },
          { name: 'Product Role', value: roleId ? `<@&${roleId}>` : 'None', inline: true },
          { name: 'Customer Role', value: `<@&${CUSTOMER_ROLE_ID}>`, inline: true },
          { name: 'Key', value: `\`\`\`${key}\`\`\``, inline: false },
          { name: 'Expires', value: endTime === null ? 'Never (Lifetime)' : `<t:${Math.floor(endTime/1000)}:F> (<t:${Math.floor(endTime/1000)}:R>)`, inline: false }
        )
        .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
      await i.editReply({ embeds: [embed] });
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('Thank you for your purchase!').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
          .setDescription(`Hey <@${targetUser.id}>,\n\nThanks for purchasing the **${planText} Plan** for **${productName}**!\n\nHere is your key:\n\`\`\`${key}\`\`\`\nKeep it safe! 💙`)
          .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
      } catch (e) {}
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /delivered =====
  if (i.isChatInputCommand() && i.commandName === 'delivered') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.reply({ content: '⚠️ This is not an active ticket.', ephemeral: true });
    if (ticket.categorie !== 'purchase') return i.reply({ content: '⚠️ This command only works in purchase tickets.', ephemeral: true });

    await i.deferReply();
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const customerId = ticket.userId;
      const member = await guild.members.fetch(customerId).catch(() => null);
      if (member && !member.roles.cache.has(CUSTOMER_ROLE_ID)) {
        await member.roles.add(CUSTOMER_ROLE_ID, 'Purchase delivered').catch(() => {});
      }

      const confirmEmbed = new EmbedBuilder()
        .setTitle('📦 Did you receive your delivery?')
        .setColor(COLOR_LIGHT_BLUE)
        .setThumbnail(LOGO)
        .setDescription(
          `<@${customerId}>, please confirm if you have successfully received your delivery.\n\n` +
          `If you click **Yes**, a review will be automatically posted in <#${REVIEW_CHANNEL_ID}>.`
        )
        .setFooter({ text: 'Scorpion', iconURL: LOGO })
        .setTimestamp();

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_delivery_${customerId}_${ticket.productName || 'unknown'}_${ticket.plan || 'unknown'}`)
          .setLabel('Yes').setEmoji('✅').setStyle(ButtonStyle.Success)
      );

      await i.channel.send({ embeds: [confirmEmbed], components: [confirmRow] });
      await i.editReply({ content: '✅ Delivery confirmation sent to the customer.' });
    } catch (e) { await i.editReply({ content: `❌ Error: ${e.message}` }); }
    return;
  }

  // ===== /removelicense =====
  if (i.isChatInputCommand() && i.commandName === 'removelicense') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    const productName = i.options.getString('product');
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(targetUser.id);
      const existing = await removePurchase(targetUser.id, productName || null);
      if (!existing || existing.length === 0) return i.editReply({ content: `⚠️ <@${targetUser.id}> has no active license${productName ? ` for **${productName}**` : ''}.` });
      let rolesRemoved = 0;
      for (const p of existing) {
        if (p.roleId && member.roles.cache.has(p.roleId)) {
          const stillHas = (await getPurchases()).some(o => o.userId === targetUser.id && o.productName === p.productName);
          if (!stillHas) { await member.roles.remove(p.roleId, 'License removed').catch(() => {}); rolesRemoved++; }
        }
      }
      const remaining = (await getPurchases()).filter(p => p.userId === targetUser.id);
      if (remaining.length === 0 && member.roles.cache.has(CUSTOMER_ROLE_ID)) {
        await member.roles.remove(CUSTOMER_ROLE_ID, 'No active purchases').catch(() => {});
      }
      await updateOverview();
      const embed = new EmbedBuilder().setTitle('License Removed').setColor(COLOR_RED).setThumbnail(LOGO)
        .addFields(
          { name: 'Customer', value: `<@${targetUser.id}>`, inline: true },
          { name: 'Products removed', value: existing.map(e => e.productName).join(', '), inline: false },
          { name: 'Roles removed', value: `${rolesRemoved}`, inline: true }
        ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
      await i.editReply({ embeds: [embed] });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /suggestie =====
  if (i.isChatInputCommand() && i.commandName === 'suggestie') {
    await i.deferReply({ ephemeral: true });
    const text = i.options.getString('tekst');
    try {
      const channel = await client.channels.fetch(SUGGESTIE_CHANNEL_ID);
      const placeholder = new EmbedBuilder().setTitle('New Suggestion').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO).setDescription('Loading...').setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
      const msg = await channel.send({ embeds: [placeholder] });
      const suggestions = await getSuggestions();
      suggestions[msg.id] = { tekst: text, auteurId: i.user.id, approve: [], reject: [], gestart: Date.now() };
      await saveSuggestions(suggestions);
      const s = suggestions[msg.id];
      await msg.edit({ embeds: [buildSuggestionEmbed(s)], components: [buildSuggestionRow(msg.id, s)] });
      await i.editReply({ content: `Your suggestion has been posted in <#${SUGGESTIE_CHANNEL_ID}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /refresh =====
  if (i.isChatInputCommand() && i.commandName === 'refresh') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    try {
      await restartOverview();
      await i.editReply({ content: `Overview refreshed in <#${PURCHASE_LOG_CHANNEL_ID}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /removekruis =====
  if (i.isChatInputCommand() && i.commandName === 'removekruis') {
    if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: `You need the <@&${PURCHASE_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const amount = i.options.getInteger('aantal');
    try {
      const votes = await getLegitVotes();
      if (votes.reject.length === 0) return i.editReply({ content: '⚠️ No crosses to remove.' });
      const toRemove = Math.min(amount, votes.reject.length);
      votes.reject.splice(votes.reject.length - toRemove, toRemove);
      await saveLegitVotes(votes);
      await refreshLegitPoll();
      await i.editReply({ content: `✅ Removed **${toRemove}** ❌ vote(s).` });
      await logVote(i.user.id, 'reject', `removed ${toRemove} crosses`);
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /giveaway =====
  if (i.isChatInputCommand() && i.commandName === 'giveaway') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const winners = i.options.getInteger('winners');
    const item = i.options.getString('item');
    const durationMs = parseDuration(i.options.getString('time'));
    if (!durationMs || durationMs < 10000) return i.editReply({ content: '⚠️ Invalid time (min 10s).' });
    if (durationMs > 30 * 86400000) return i.editReply({ content: '⚠️ Max 30 days.' });
    try {
      const endTime = Date.now() + durationMs;
      const giveaways = await getGiveaways();
      const data = { item, winners, eindTijd: endTime, gestart: Date.now(), kanaalId: i.channelId, hostId: i.user.id, hostTag: i.user.username };
      const msg = await i.channel.send({ embeds: [buildGiveawayEmbed(data)] });
      await msg.react('🎉');
      data.messageId = msg.id;
      giveaways[msg.id] = data;
      await saveGiveaways(giveaways);
      setTimeout(() => endGiveaway(msg.id, i.channelId), durationMs);
      await i.editReply({ content: `✅ Giveaway started! Ends <t:${Math.floor(endTime/1000)}:R>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /reroll =====
  if (i.isChatInputCommand() && i.commandName === 'reroll') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const amount = i.options.getInteger('winners');
    try {
      const last = await getLastGiveaways();
      const info = last[i.channelId];
      if (!info) return i.editReply({ content: '⚠️ No ended giveaway in this channel.' });
      const channel = await client.channels.fetch(i.channelId);
      const msg = await channel.messages.fetch(info.messageId).catch(() => null);
      if (!msg) return i.editReply({ content: '⚠️ Original message not found.' });
      const { winners, totalParticipants } = await pickWinners(msg, amount);
      if (totalParticipants === 0) return i.editReply({ content: '⚠️ No participants.' });
      const g = { item: info.item, winners: amount };
      await msg.edit({ embeds: [buildGiveawayEndedEmbed(g, winners, true)] }).catch(() => {});
      if (winners.length > 0) {
        await channel.send({ content: `🎉 **Reroll!** Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${info.item}**!` }).catch(() => {});
      }
      await i.editReply({ content: `✅ Rerolled (${winners.length} winners).` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /clear =====
  if (i.isChatInputCommand() && i.commandName === 'clear') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const amount = i.options.getInteger('amount');
    try {
      const deleted = await i.channel.bulkDelete(amount, true);
      await i.editReply({ content: `✅ Deleted **${deleted.size}** messages.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /ban =====
  if (i.isChatInputCommand() && i.commandName === 'ban') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const targetUser = i.options.getUser('user');
    const durationStr = i.options.getString('duration');
    const reason = i.options.getString('reason') || 'No reason provided';
    let durationMs = null;
    if (durationStr) {
      durationMs = parseDuration(durationStr);
      if (!durationMs) return i.editReply({ content: '⚠️ Invalid duration.' });
      if (durationMs < 60000) return i.editReply({ content: '⚠️ Min 1 minute.' });
      if (durationMs > 365 * 86400000) return i.editReply({ content: '⚠️ Max 1 year.' });
    }
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const existingBan = await guild.bans.fetch(targetUser.id).catch(() => null);
      if (existingBan) return i.editReply({ content: `⚠️ <@${targetUser.id}> is already banned.` });
      try {
        await targetUser.send({ embeds: [new EmbedBuilder().setTitle('You have been banned').setColor(COLOR_RED).setThumbnail(LOGO)
          .addFields(
            { name: 'Server', value: 'Scorpion', inline: true },
            { name: 'Duration', value: durationMs ? formatShortDuration(durationMs) : 'Permanent', inline: true },
            { name: 'Reason', value: reason, inline: false }
          ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
      } catch (e) {}
      await guild.bans.create(targetUser.id, { reason: `${reason} | by ${i.user.tag}` });
      if (durationMs) await addTemporaryBan(targetUser.id, GUILD_ID, Date.now() + durationMs);
      try {
        const log = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
        if (log) await log.send({ embeds: [new EmbedBuilder().setColor(COLOR_RED).setTitle('🔨 Ban')
          .setThumbnail(targetUser.displayAvatarURL())
          .addFields(
            { name: 'User', value: `${targetUser.tag} (<@${targetUser.id}>)`, inline: false },
            { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
            { name: 'Duration', value: durationMs ? formatShortDuration(durationMs) : 'Permanent', inline: true },
            { name: 'Reason', value: reason, inline: false }
          ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
      } catch (e) {}
      await i.editReply({ content: `✅ Banned <@${targetUser.id}>${durationMs ? ` for ${formatShortDuration(durationMs)}` : ' permanently'}.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /unban =====
  if (i.isChatInputCommand() && i.commandName === 'unban') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply();
    const userId = i.options.getString('user_id').trim();
    const reason = i.options.getString('reason') || 'No reason provided';
    if (!/^\d{17,20}$/.test(userId)) return i.editReply({ content: '⚠️ Invalid Discord ID.' });
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const existingBan = await guild.bans.fetch(userId).catch(() => null);
      if (!existingBan) return i.editReply({ content: `⚠️ User \`${userId}\` is not banned.` });
      await guild.bans.remove(userId, `${reason} | by ${i.user.tag}`);
      await removeBanRecord(userId, GUILD_ID);
      try {
        const log = await client.channels.fetch(BAN_LOG_CHANNEL_ID);
        if (log) await log.send({ embeds: [new EmbedBuilder().setColor(COLOR_LIGHT_BLUE).setTitle('🔓 Unban')
          .addFields(
            { name: 'User', value: `${existingBan.user.tag} (<@${userId}>)`, inline: false },
            { name: 'Moderator', value: `<@${i.user.id}>`, inline: true },
            { name: 'Reason', value: reason, inline: false }
          ).setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
      } catch (e) {}
      await i.editReply({ content: `✅ Unbanned ${existingBan.user.tag}.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /add =====
  if (i.isChatInputCommand() && i.commandName === 'add') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.editReply({ content: 'Not an active ticket.' });
    const targetUser = i.options.getUser('user');
    try {
      await i.channel.permissionOverwrites.edit(targetUser.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
      if (!ticket.extraUsers) ticket.extraUsers = [];
      if (!ticket.extraUsers.includes(targetUser.id)) ticket.extraUsers.push(targetUser.id);
      await saveTickets(tickets);
      await i.channel.send({ content: `➕ <@${targetUser.id}> added by <@${i.user.id}>.` });
      await i.editReply({ content: `✅ Added <@${targetUser.id}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /remove =====
  if (i.isChatInputCommand() && i.commandName === 'remove') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const tickets = await getTickets();
    const ticket = tickets[i.channelId];
    if (!ticket) return i.editReply({ content: 'Not an active ticket.' });
    const targetUser = i.options.getUser('user');
    if (targetUser.id === ticket.userId) return i.editReply({ content: '⚠️ Cannot remove the ticket owner. Use `/close`.' });
    try {
      await i.channel.permissionOverwrites.delete(targetUser.id);
      if (ticket.extraUsers) ticket.extraUsers = ticket.extraUsers.filter(id => id !== targetUser.id);
      await saveTickets(tickets);
      await i.channel.send({ content: `➖ <@${targetUser.id}> removed by <@${i.user.id}>.` });
      await i.editReply({ content: `✅ Removed <@${targetUser.id}>.` });
    } catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== /close =====
  if (i.isChatInputCommand() && i.commandName === 'close') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    const tickets = await getTickets();
    if (!tickets[i.channelId]) return i.reply({ content: 'Not an active ticket.', ephemeral: true });
    await i.reply({ content: '🔒 Closing ticket...' });
    await closeTicket(i.channel, i.user.id);
    return;
  }

  // ===== /rename =====
  if (i.isChatInputCommand() && i.commandName === 'rename') {
    if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: `You need the <@&${TICKET_SUPPORT_ROLE_ID}> role.`, ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const tickets = await getTickets();
    if (!tickets[i.channelId]) return i.editReply({ content: 'Not an active ticket.' });
    const newName = i.options.getString('name').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
    if (!newName) return i.editReply({ content: '⚠️ Invalid name.' });
    try { await i.channel.setName(newName); await i.editReply({ content: `✅ Renamed to \`${newName}\`.` }); }
    catch (e) { await i.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // ===== Select menus =====
  if (i.isStringSelectMenu()) {
    if (i.customId === 'ticket_category_select') {
      const choice = i.values[0];

      if (choice === 'purchase') {
        await i.deferReply({ ephemeral: true });
        const products = await getProducts();
        const productNames = Object.keys(products);
        if (productNames.length === 0) return i.editReply({ content: '⚠️ No products available. Please contact staff.' });
        pendingPurchases.set(i.user.id, { productName: null, plan: null, payment: null });
        const menu = new StringSelectMenuBuilder()
          .setCustomId('purchase_product_select')
          .setPlaceholder('Select a product')
          .addOptions(productNames.slice(0, 25).map(p => ({ label: p, value: p })));
        return i.editReply({
          embeds: [new EmbedBuilder().setTitle('🛒 Purchase').setDescription('Which product do you want to buy?').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)],
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      const cat = TICKET_CATEGORIES[choice];
      if (!cat) return i.reply({ content: 'Unknown category.', ephemeral: true });

      const tickets = await getTickets();
      if (Object.values(tickets).find(t => t.userId === i.user.id)) {
        return i.reply({ content: '❌ You already have an open ticket.', ephemeral: true });
      }

      // HWID Reset: stuur direct een modal met key + reden (geen tussenstap)
      if (choice === 'hwidreset') {
        const modal = new ModalBuilder().setCustomId('modal_hwid_reset').setTitle('HWID Reset');
        const input1 = new TextInputBuilder()
          .setCustomId('hwid_key')
          .setLabel('Your license key')
          .setPlaceholder('SCORPION-XXXX-XXXX-XXXX-XXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(64);
        const input2 = new TextInputBuilder()
          .setCustomId('hwid_reason')
          .setLabel('Reason for HWID reset')
          .setPlaceholder('e.g. new PC, reinstalled Windows...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500);
        modal.addComponents(
          new ActionRowBuilder().addComponents(input1),
          new ActionRowBuilder().addComponents(input2)
        );
        return i.showModal(modal);
      }

      const modal = new ModalBuilder().setCustomId(`modal_create_ticket_${choice}`).setTitle(`${cat.name} Ticket`);
      const input = new TextInputBuilder()
        .setCustomId('question_answer')
        .setLabel(choice === 'support' ? 'How can we help you?' : 'Describe the bug')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return i.showModal(modal);
    }

    if (i.customId === 'purchase_product_select') {
      const data = pendingPurchases.get(i.user.id);
      if (!data) return i.update({ content: 'Session expired. Please start over.', components: [] });
      data.productName = i.values[0];
      const planMenu = new StringSelectMenuBuilder()
        .setCustomId('purchase_plan_select').setPlaceholder('Select a plan')
        .addOptions([
          { label: '1 week', value: '1 week' },
          { label: '1 month', value: '1 month' },
          { label: 'Lifetime', value: 'lifetime' },
        ]);
      return i.update({
        embeds: [new EmbedBuilder().setTitle('🛒 Purchase').setDescription(`**Product:** ${data.productName}\n\nWhich plan do you want?`).setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)],
        components: [new ActionRowBuilder().addComponents(planMenu)]
      });
    }

    if (i.customId === 'purchase_plan_select') {
      const data = pendingPurchases.get(i.user.id);
      if (!data) return i.update({ content: 'Session expired. Please start over.', components: [] });
      data.plan = i.values[0];
      const payMenu = new StringSelectMenuBuilder()
        .setCustomId('purchase_payment_select').setPlaceholder('Select a payment method')
        .addOptions(
          Object.entries(PAYMENT_METHODS).map(([key, m]) => {
            const id = emojiToId(m.emoji);
            return { label: m.name, value: key, emoji: id ? { id } : undefined };
          })
        );
      return i.update({
        embeds: [new EmbedBuilder().setTitle('🛒 Purchase')
          .setDescription(`**Product:** ${data.productName}\n**Plan:** ${data.plan}\n\nWhich payment method do you want to use?`)
          .setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)],
        components: [new ActionRowBuilder().addComponents(payMenu)]
      });
    }

    if (i.customId === 'purchase_payment_select') {
      const data = pendingPurchases.get(i.user.id);
      if (!data) return i.update({ content: 'Session expired. Please start over.', components: [] });
      data.payment = i.values[0];
      const paymentName = PAYMENT_METHODS[data.payment]?.name || data.payment;
      await i.deferUpdate();
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const ticketChannel = await createTicket(guild, i.user, 'purchase', {
          productName: data.productName,
          plan: data.plan,
          paymentName,
        });
        pendingPurchases.delete(i.user.id);
        await i.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>`, embeds: [], components: [] });
      } catch (e) {
        pendingPurchases.delete(i.user.id);
        await i.editReply({ content: `❌ Error: ${e.message}`, embeds: [], components: [] });
      }
      return;
    }

    if (i.customId === 'product_remove_select') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const productName = i.values[0];
      const products = await getProducts();
      if (!products[productName]) return i.update({ content: 'Product not found.', components: [] });
      delete products[productName];
      await saveProducts(products);
      await updateProductPanel();
      return i.update({ content: `✅ Product **${productName}** removed.`, components: [] });
    }

    if (i.customId === 'product_rename_select') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const productName = i.values[0];
      const products = await getProducts();
      if (!products[productName]) return i.update({ content: 'Product not found.', components: [] });
      const modal = new ModalBuilder().setCustomId(`product_rename_modal_${encodeURIComponent(productName)}`).setTitle(`Rename: ${productName}`.slice(0, 45));
      const input1 = new TextInputBuilder()
        .setCustomId('new_name')
        .setLabel('New product name')
        .setStyle(TextInputStyle.Short)
        .setValue(productName)
        .setRequired(true);
      const input2 = new TextInputBuilder()
        .setCustomId('new_role')
        .setLabel('New role ID (leave empty to keep)')
        .setStyle(TextInputStyle.Short)
        .setValue(products[productName].roleId || '')
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input1), new ActionRowBuilder().addComponents(input2));
      return i.showModal(modal);
    }
  }

  // ===== Modals =====
  if (i.isModalSubmit()) {
    if (i.customId === 'product_add_modal') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const name = i.fields.getTextInputValue('product_name').trim();
      const roleId = i.fields.getTextInputValue('role_id').trim().replace(/[<@&>]/g, '');
      if (!name) return i.reply({ content: '⚠️ Product name required.', ephemeral: true });
      if (!/^\d{17,20}$/.test(roleId)) return i.reply({ content: '⚠️ Invalid role ID.', ephemeral: true });
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role) return i.reply({ content: '⚠️ Role not found in this server.', ephemeral: true });
        const products = await getProducts();
        if (products[name]) return i.reply({ content: `⚠️ Product **${name}** already exists.`, ephemeral: true });
        products[name] = { roleId };
        await saveProducts(products);
        await updateProductPanel();
        return i.reply({ content: `✅ Product **${name}** added with role <@&${roleId}>.`, ephemeral: true });
      } catch (e) { return i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
    }

    if (i.customId.startsWith('product_rename_modal_')) {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const oldName = decodeURIComponent(i.customId.replace('product_rename_modal_', ''));
      const newName = i.fields.getTextInputValue('new_name').trim();
      const newRoleRaw = i.fields.getTextInputValue('new_role').trim().replace(/[<@&>]/g, '');

      if (!newName) return i.reply({ content: '⚠️ New name is required.', ephemeral: true });

      try {
        const products = await getProducts();
        if (!products[oldName]) return i.reply({ content: '⚠️ Product no longer exists.', ephemeral: true });

        let finalRole = products[oldName].roleId;
        if (newRoleRaw) {
          if (!/^\d{17,20}$/.test(newRoleRaw)) return i.reply({ content: '⚠️ Invalid role ID.', ephemeral: true });
          const guild = await client.guilds.fetch(GUILD_ID);
          const role = await guild.roles.fetch(newRoleRaw).catch(() => null);
          if (!role) return i.reply({ content: '⚠️ Role not found in this server.', ephemeral: true });
          finalRole = newRoleRaw;
        }

        if (newName !== oldName && products[newName]) {
          return i.reply({ content: `⚠️ A product named **${newName}** already exists.`, ephemeral: true });
        }

        if (newName !== oldName) {
          delete products[oldName];
        }
        products[newName] = { roleId: finalRole };
        await saveProducts(products);

        if (newName !== oldName) {
          const purchases = await getPurchases();
          let changed = false;
          for (const p of purchases) {
            if (p.productName === oldName) { p.productName = newName; changed = true; }
          }
          if (changed) await savePurchases(purchases);
        }

        await updateProductPanel();
        await updateOverview().catch(() => {});

        return i.reply({
          content: newName === oldName
            ? `✅ Product **${newName}** updated (role: <@&${finalRole}>).`
            : `✅ Product **${oldName}** hernoemd naar **${newName}** (role: <@&${finalRole}>). Bestaande purchases zijn bijgewerkt.`,
          ephemeral: true,
        });
      } catch (e) { return i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
    }

    // HWID reset modal (vanuit ticket knop of via categorie-select)
    if (i.customId === 'modal_hwid_reset') {
      const rawKey = i.fields.getTextInputValue('hwid_key');
      const reason = i.fields.getTextInputValue('hwid_reason').trim();
      const key = keyApi.normalizeKey(rawKey);

      if (!KEY_PATTERN.test(key)) {
        return i.reply({ content: '⚠️ Invalid key format. Example: `SCORPION-XXXX-XXXX-XXXX-XXXX`.', ephemeral: true });
      }

      await i.deferReply({ ephemeral: true });

      try {
        const result = await keyApi.resetHwidByKey(key);

        if (!result.ok) {
          let msg = '⚠️ Er ging iets mis.';
          if (result.error === 'unknown_key') msg = '⚠️ Onbekende key. Controleer je key en probeer opnieuw.';
          else if (result.error === 'revoked') msg = '🚫 Deze key is ingetrokken (revoked). Neem contact op met staff.';
          else if (result.error === 'not_bound') msg = 'ℹ️ Deze key is nog niet gekoppeld aan een PC (geen HWID). Je kunt hem gewoon gebruiken.';
          else if (result.error === 'invalid_key_format') msg = '⚠️ Ongeldig key-formaat.';
          return i.editReply({ content: msg });
        }

        const rec = result.rec;
        const product = rec.product || 'Onbekend';

        try {
          const logChannel = await client.channels.fetch(HWID_RESET_LOG_CHANNEL_ID).catch(() => null);
          if (logChannel) {
            await logChannel.send({
              embeds: [new EmbedBuilder()
                .setTitle('🔄 HWID Reset aangevraagd')
                .setColor(COLOR_LIGHT_BLUE)
                .setThumbnail(LOGO)
                .addFields(
                  { name: 'Gebruiker', value: `<@${i.user.id}> (${i.user.tag})`, inline: true },
                  { name: 'Ticket', value: `<#${i.channelId}>`, inline: true },
                  { name: 'Key', value: `\`${result.key}\``, inline: true },
                  { name: 'Product', value: product, inline: true },
                  { name: 'Oude HWID', value: `\`${maskHwid(result.oldHwid)}\``, inline: false },
                  { name: 'Reden', value: reason || '*(geen reden opgegeven)*', inline: false },
                  { name: 'Totaal resets', value: String(rec.hwidResets || 1), inline: true }
                )
                .setFooter({ text: 'Scorpion', iconURL: LOGO })
                .setTimestamp()],
            });
          }
        } catch (e) { console.error('HWID log:', e.message); }

        await addHwidResetRequest({
          userId: i.user.id,
          username: i.user.tag,
          ticketChannelId: i.channelId,
          key: result.key,
          product: product,
          oldHwid: result.oldHwid,
          reason: reason || '',
          at: Date.now(),
        }).catch(() => {});

        await i.channel.send({
          embeds: [new EmbedBuilder()
            .setTitle('🔄 HWID Reset')
            .setColor(COLOR_LIGHT_BLUE)
            .setThumbnail(LOGO)
            .setDescription(`De HWID van key \`${result.key}\` is gereset.\nJe kunt de key nu op je nieuwe PC gebruiken.`)
            .addFields(
              { name: 'Product', value: product, inline: true },
              { name: 'Reden', value: reason || '-', inline: true },
              { name: 'Uitgevoerd door', value: `<@${i.user.id}>`, inline: true }
            )
            .setFooter({ text: 'Scorpion', iconURL: LOGO })
            .setTimestamp()],
        }).catch(() => {});

        updateKeyOverview().catch(() => {});

        await i.editReply({ content: `✅ HWID reset voltooid voor \`${result.key}\`. Je kunt de key nu op je nieuwe PC gebruiken.` });
      } catch (e) {
        console.error('HWID reset fout:', e.message);
        await i.editReply({ content: `❌ Error: ${e.message}` });
      }
      return;
    }

    if (i.customId.startsWith('modal_create_ticket_')) {
      const categoryKey = i.customId.replace('modal_create_ticket_', '');
      const question = i.fields.getTextInputValue('question_answer');
      await i.deferReply({ ephemeral: true });
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const ticketChannel = await createTicket(guild, i.user, categoryKey, { question });
        await i.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>` });
      } catch (e) { await i.editReply({ content: `❌ Error: ${e.message}` }); }
      return;
    }
  }

  // ===== Buttons =====
  if (i.isButton()) {
    if (i.customId === 'ticket_hwid_reset') {
      const modal = new ModalBuilder().setCustomId('modal_hwid_reset').setTitle('HWID Reset');
      const input1 = new TextInputBuilder()
        .setCustomId('hwid_key')
        .setLabel('Your license key')
        .setPlaceholder('SCORPION-XXXX-XXXX-XXXX-XXXX')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(64);
      const input2 = new TextInputBuilder()
        .setCustomId('hwid_reason')
        .setLabel('Reason for HWID reset')
        .setPlaceholder('e.g. new PC, reinstalled Windows...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);
      modal.addComponents(
        new ActionRowBuilder().addComponents(input1),
        new ActionRowBuilder().addComponents(input2)
      );
      return i.showModal(modal);
    }

    if (i.customId.startsWith('confirm_delivery_')) {
      const parts = i.customId.split('_');
      const customerId = parts[2];
      const productName = parts[3] ? parts[3].replace(/_/g, ' ') : 'Unknown';
      const plan = parts[4] ? parts[4].replace(/_/g, ' ') : 'Unknown';

      if (i.user.id !== customerId) return i.reply({ content: '❌ Only the customer can confirm delivery.', ephemeral: true });
      await i.deferReply({ ephemeral: true });

      try {
        const customerUser = await client.users.fetch(customerId).catch(() => i.user);

        let reviewNum = 1;
        try {
          const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
          reviewNum = await nextReviewNumber(reviewChannel);
          await writeReviewCounter(reviewNum);
          cachedReviewCounter = reviewNum;
        } catch (e) { console.error('Review counter error:', e.message); }

        const reviewEmbed = new EmbedBuilder()
          .setTitle(`Review #${reviewNum}`)
          .setColor(COLOR_GOLD)
          .setThumbnail(LOGO)
          .setAuthor({ name: customerUser.displayName || customerUser.username, iconURL: customerUser.displayAvatarURL() })
          .addFields(
            { name: 'Product', value: productName, inline: true },
            { name: 'Plan', value: plan === 'lifetime' ? 'Lifetime' : plan, inline: true },
            { name: 'Customer', value: `<@${customerId}>`, inline: true }
          )
          .setDescription('✅ Verified purchase — thank you for your review!')
          .setFooter({ text: 'Scorpion', iconURL: LOGO })
          .setTimestamp();

        const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
        if (reviewChannel) {
          await reviewChannel.send({ embeds: [reviewEmbed] });
        }

        const tickets = await getTickets();
        if (tickets[i.channelId]) {
          await removeTicket(i.channelId);
          setTimeout(async () => { try { await i.channel.delete('Delivery confirmed'); } catch (e) {} }, 5000);
        }

        await i.editReply({ content: `✅ Thank you! Your review has been posted in <#${REVIEW_CHANNEL_ID}>.` });
      } catch (e) {
        await i.editReply({ content: `❌ Error: ${e.message}` });
      }
      return;
    }

    if (i.customId === 'verify_accept_rules') {
      try {
        if (i.member.roles.cache.has(VERIFY_ROLE_ID)) return i.reply({ content: '❌ You are already verified!', ephemeral: true });
        await i.member.roles.add(VERIFY_ROLE_ID);
        await i.reply({ content: '✅ You have accepted the rules and are now verified!', ephemeral: true });
        setTimeout(() => { updateRulesMessage().catch(() => {}); }, 1500);
      } catch (e) { await i.reply({ content: `❌ Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    if (i.customId === 'product_add') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId('product_add_modal').setTitle('Add Product');
      const input1 = new TextInputBuilder().setCustomId('product_name').setLabel('Product name').setStyle(TextInputStyle.Short).setRequired(true);
      const input2 = new TextInputBuilder().setCustomId('role_id').setLabel('Role ID (or @role)').setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input1), new ActionRowBuilder().addComponents(input2));
      return i.showModal(modal);
    }

    if (i.customId === 'product_remove') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const products = await getProducts();
      const list = Object.keys(products);
      if (!list.length) return i.reply({ content: '⚠️ No products to remove.', ephemeral: true });
      const menu = new StringSelectMenuBuilder().setCustomId('product_remove_select').setPlaceholder('Select product to remove')
        .addOptions(list.slice(0, 25).map(p => ({ label: p, value: p })));
      return i.reply({ content: 'Which product do you want to remove?', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    if (i.customId === 'product_rename') {
      if (!i.member.roles.cache.has(PURCHASE_ROLE_ID)) return i.reply({ content: 'No permission.', ephemeral: true });
      const products = await getProducts();
      const list = Object.keys(products);
      if (!list.length) return i.reply({ content: '⚠️ No products to rename.', ephemeral: true });
      const menu = new StringSelectMenuBuilder().setCustomId('product_rename_select').setPlaceholder('Select product to rename')
        .addOptions(list.slice(0, 25).map(p => ({ label: p, value: p })));
      return i.reply({ content: 'Which product do you want to rename?', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    if (i.customId === 'legit_approve') {
      try {
        const votes = await getLegitVotes();
        votes.approve = votes.approve.filter(id => id !== i.user.id);
        votes.reject = votes.reject.filter(id => id !== i.user.id);
        votes.approve.push(i.user.id);
        const confirmed = await getConfirmedRejects();
        const newConfirmed = confirmed.filter(id => id !== i.user.id);
        if (newConfirmed.length !== confirmed.length) await saveConfirmedRejects(newConfirmed);
        await saveLegitVotes(votes);
        await refreshLegitPoll();
        await i.reply({ content: '✅ Saved as **Legit**.', ephemeral: true });
        await logVote(i.user.id, 'approve', '**Are we legit?**');
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    if (i.customId === 'legit_reject') {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const tickets = await getTickets();
        const existingNotLegit = Object.entries(tickets).find(([_, t]) => t.userId === i.user.id && t.categorie === 'notlegit');
        if (existingNotLegit) return i.reply({ content: `You already have an open proof ticket: <#${existingNotLegit[0]}>.`, ephemeral: true });
        await i.deferReply({ ephemeral: true });
        const channelName = `notlegit-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
        const ticketChannel = await guild.channels.create({
          name: channelName, type: ChannelType.GuildText, parent: NOT_LEGIT_TICKET_CATEGORY_ID,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
            { id: TICKET_SUPPORT_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
          ],
          topic: `Not-Legit proof from ${i.user.tag}`,
        });
        await addTicket(ticketChannel.id, i.user.id, 'notlegit');
        const nlt = await getNotLegitTickets();
        nlt[ticketChannel.id] = { userId: i.user.id, status: 'pending', createdAt: Date.now() };
        await saveNotLegitTickets(nlt);
        const promptEmbed = new EmbedBuilder()
          .setTitle('Upload proof').setColor(COLOR_RED).setThumbnail(LOGO)
          .setDescription(`Please upload your proof here (screenshots, video, files).\n\nStaff will review it and click **Positive** or **False**.`)
          .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp();
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );
        await ticketChannel.send({ content: `<@${i.user.id}> <@&${TICKET_TAG_ROLE_ID}>`, embeds: [promptEmbed], components: [notLegitReviewRow(), closeRow] });
        await i.editReply({ content: `✅ Ticket created: <#${ticketChannel.id}>` });
      } catch (e) { try { await i.editReply({ content: `Error: ${e.message}` }); } catch (_) {} }
      return;
    }

    if (i.customId === 'notlegit_positive' || i.customId === 'notlegit_false') {
      if (!i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID)) return i.reply({ content: 'Only staff.', ephemeral: true });
      await i.deferReply({ ephemeral: true });
      const nlt = await getNotLegitTickets();
      const entry = nlt[i.channelId];
      const tickets = await getTickets();
      const ticket = tickets[i.channelId];
      if (!entry || !ticket || ticket.categorie !== 'notlegit') return i.editReply({ content: 'Not a Not-Legit ticket.' });
      if (entry.status !== 'pending') return i.editReply({ content: `Already reviewed as **${entry.status}**.` });
      try {
        const targetUserId = entry.userId;
        const votes = await getLegitVotes();
        const confirmed = await getConfirmedRejects();
        if (i.customId === 'notlegit_positive') {
          if (!votes.reject.includes(targetUserId)) votes.reject.push(targetUserId);
          if (!confirmed.includes(targetUserId)) confirmed.push(targetUserId);
          await saveLegitVotes(votes);
          await saveConfirmedRejects(confirmed);
          await setNotLegitStatus(i.channelId, 'positive');
          await refreshLegitPoll();
          await i.channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Reviewed: Positive').setColor(COLOR_LIGHT_BLUE).setThumbnail(LOGO)
            .setDescription(`Proof from <@${targetUserId}> is **valid**. ❌ vote added.\nReviewed by: <@${i.user.id}>`)
            .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
          await i.editReply({ content: '✅ Positive.' });
        } else {
          await setNotLegitStatus(i.channelId, 'false');
          await i.channel.send({ embeds: [new EmbedBuilder().setTitle('❌ Reviewed: False').setColor(COLOR_RED).setThumbnail(LOGO)
            .setDescription(`Proof from <@${targetUserId}> is **not valid**. No vote added.\nReviewed by: <@${i.user.id}>`)
            .setFooter({ text: 'Scorpion', iconURL: LOGO }).setTimestamp()] });
          await i.editReply({ content: '❌ False.' });
        }
      } catch (e) { try { await i.editReply({ content: `Error: ${e.message}` }); } catch (_) {} }
      return;
    }

    if (i.customId === 'ticket_close') {
      try {
        const tickets = await getTickets();
        const ticket = tickets[i.channelId];
        if (!ticket) return i.reply({ content: 'Not a ticket.', ephemeral: true });
        const isOwner = ticket.userId === i.user.id;
        const isStaff = i.member.roles.cache.has(TICKET_SUPPORT_ROLE_ID);
        if (!isOwner && !isStaff) return i.reply({ content: 'No permission.', ephemeral: true });
        await i.reply({ content: '🔒 Closing...' });
        await closeTicket(i.channel, i.user.id);
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }

    if (i.customId.startsWith('suggest_approve_') || i.customId.startsWith('suggest_reject_')) {
      const messageId = i.customId.split('_').pop();
      if (!i.member.roles.cache.has(CUSTOMER_ROLE_ID)) return i.reply({ content: `You need the <@&${CUSTOMER_ROLE_ID}> role.`, ephemeral: true });
      try {
        const suggestions = await getSuggestions();
        const s = suggestions[messageId];
        if (!s) return i.reply({ content: 'Suggestion no longer exists.', ephemeral: true });
        const isApprove = i.customId.startsWith('suggest_approve_');
        s.approve = s.approve.filter(id => id !== i.user.id);
        s.reject = s.reject.filter(id => id !== i.user.id);
        if (isApprove) s.approve.push(i.user.id);
        else s.reject.push(i.user.id);
        await saveSuggestions(suggestions);
        await i.update({ embeds: [buildSuggestionEmbed(s)], components: [buildSuggestionRow(messageId, s)] });
        await logVote(i.user.id, isApprove ? 'approve' : 'reject', `suggestion: **${s.tekst.slice(0, 80)}**`);
      } catch (e) { await i.reply({ content: `Error: ${e.message}`, ephemeral: true }); }
      return;
    }
  }
});

// ===== Welcome =====
client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  try {
    const channel = await client.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('Welcome to Scorpion!')
      .setColor(COLOR_LIGHT_BLUE)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setDescription(
        `Welcome <@${member.id}>! 🎉\n\n` +
        `Please read the rules in <#${RULES_CHANNEL_ID}> and accept them to get access.\n\n` +
        `> 🛒 Products → <#${PRICING_CHANNEL_ID}>\n` +
        `> 🎫 Need help? Open a ticket.`
      )
      .setFooter({ text: `Member #${member.guild.memberCount}`, iconURL: LOGO })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Welcome:', e.message); }
  await updateRulesMessage();
});

// ===== Member leave =====
client.on('guildMemberRemove', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  try {
    const purchases = await getPurchases();
    const had = purchases.find(p => p.userId === member.id);
    if (!had) return;
    await savePurchases(purchases.filter(p => p.userId !== member.id));
    await updateOverview();
  } catch (e) {}
});

// ===== Role update (verify count) =====
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;
  const hadRole = oldMember.roles.cache.has(VERIFY_ROLE_ID);
  const hasRole = newMember.roles.cache.has(VERIFY_ROLE_ID);
  if (hadRole !== hasRole) {
    setTimeout(() => { updateRulesMessage().catch(() => {}); }, 1000);
  }
});

// ===== Channel delete =====
client.on('channelDelete', async (channel) => {
  try {
    const tickets = await getTickets();
    if (tickets[channel.id]) { delete tickets[channel.id]; await saveTickets(tickets); }
    const nlt = await getNotLegitTickets();
    if (nlt[channel.id]) { delete nlt[channel.id]; await saveNotLegitTickets(nlt); }
  } catch (e) {}
});

// ===== Ready =====
client.once('ready', async () => {
  console.log(`Online as ${client.user.tag}`);
  startStatusInterval();
  startExpiryInterval();
  startBanInterval();

  await updateOverview();
  startOverviewInterval();

  await updateKeyOverview();
  startKeyOverviewInterval();

  await setupRules();
  await setupPricing();
  await setupTicketPanel();
  await setupLegitPoll();
  await setupProductPanel();
  await setupPaymentMethods();

  await restoreGiveaways();
});

client.login(TOKEN);
