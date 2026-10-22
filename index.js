require('dotenv').config();
const {
  Client, GatewayIntentBits, Events, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, PermissionFlagsBits, MessageFlags, REST, Routes,
} = require('discord.js');
const questions = require('./questions');
const store = require('./store');
const { config } = store;

const EPHEMERAL = MessageFlags.Ephemeral;
const COLOR = 0xff6a00; // orange Halloween
const TOTAL = questions.length;
const LETTERS = ['A', 'B', 'C', 'D'];
const DEFAULT_HOURS = 24;

// ───────── Commandes ─────────
const commands = [
  new SlashCommandBuilder().setName('quiz').setDescription('Démarrer ou reprendre le quiz de cybersécurité'),
  new SlashCommandBuilder().setName('classement').setDescription('Afficher le classement du quiz'),
  new SlashCommandBuilder().setName('corrige').setDescription('Voir le corrigé et tes réponses (après la clôture)'),
  new SlashCommandBuilder()
    .setName('quiz-admin').setDescription('Gestion du quiz')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('ouvrir').setDescription('Ouvrir le quiz (fermeture automatique)')
      .addIntegerOption(o => o.setName('heures').setDescription('Durée en heures (défaut : 24)').setMinValue(1).setMaxValue(168))
      .addChannelOption(o => o.setName('salon').setDescription('Salon où annoncer le quiz (défaut : salon actuel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(s => s.setName('cloturer').setDescription('Clôturer le quiz'))
    .addSubcommand(s => s.setName('reset').setDescription('Effacer toutes les participations'))
    .addSubcommand(s => s.setName('stats').setDescription('Statistiques de participation')),
].map(c => c.toJSON());

// ───────── Helpers ─────────
const isOpen = () => config.open && (!config.endsAt || Date.now() < config.endsAt);
const endsTag = () => (config.endsAt ? `<t:${Math.floor(config.endsAt / 1000)}:R>` : null);
const isAdmin = i => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const fmtDuration = ms => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

function questionView(idx) {
  const { q, o } = questions[idx];
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🎃 Question ${idx + 1}/${TOTAL}`)
    .setDescription(`**${q}**\n\n${o.map((t, k) => `**${LETTERS[k]}.** ${t}`).join('\n')}`)
    .setFooter({ text: 'Une seule réponse, aucune modification possible.' });
  if (endsTag()) embed.addFields({ name: 'Fin du quiz', value: endsTag() });
  const row = new ActionRowBuilder().addComponents(
    LETTERS.map(l => new ButtonBuilder().setCustomId(`quiz:ans:${idx}:${l}`).setLabel(l).setStyle(ButtonStyle.Secondary)),
  );
  return { embeds: [embed], components: [row] };
}

const computeScore = answers => answers.reduce((n, a, i) => n + (a === questions[i].a ? 1 : 0), 0);

function summaryView(p) {
  const detail = p.answers.map((a, i) => `${i + 1}${a === questions[i].a ? '✅' : '❌'}`).join('  ');
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🎃 Quiz terminé !')
    .setDescription(
      `Score : **${p.score}/${TOTAL}**\nTemps : **${fmtDuration(p.finishedAt - p.startedAt)}**\n\n${detail}\n\n` +
      `Le classement et le corrigé (\`/corrige\`) seront disponibles après la clôture.`,
    );
  return { embeds: [embed], components: [] };
}

async function leaderboardEmbed(guildName) {
  const [rows, st] = await Promise.all([store.leaderboard(15), store.stats()]);
  const medals = ['🥇', '🥈', '🥉'];
  const desc = rows.length
    ? rows.map((p, k) => `${medals[k] ?? `**${k + 1}.**`} <@${p._id}> — **${p.score}/${TOTAL}** · ${fmtDuration(p.finishedAt - p.startedAt)}`).join('\n')
    : '*Aucun participant pour le moment.*';
  return new EmbedBuilder()
    .setColor(COLOR).setTitle('🏆 Classement — Halloween Datalyx J1')
    .setDescription(`${desc}\n\n👥 **${st.done}** terminé(s) · ⏳ **${st.total - st.done}** en cours`)
    .setFooter({ text: `${guildName} · égalité départagée par l'heure de réponse complète` });
}

// ───────── Client ─────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async c => {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log(`Connecté en tant que ${c.user.tag}`);
  setInterval(() => autoClose().catch(console.error), 15 * 1000);
  autoClose().catch(console.error);
});

async function autoClose() {
  if (!config.open || !config.endsAt || Date.now() < config.endsAt) return;
  await store.saveConfig({ open: false });
  const ch = config.channelId && (await client.channels.fetch(config.channelId).catch(() => null));
  ch?.send('🔒 **Le quiz est clôturé !** Utilisez `/classement` pour voir les résultats et `/corrige` pour le corrigé.').catch(() => {});
}

client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isButton() && i.customId.startsWith('quiz:')) return await onButton(i);
  } catch (e) {
    console.error(e);
    const msg = { content: '❌ Une erreur est survenue.', flags: EPHEMERAL };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {}); else i.reply(msg).catch(() => {});
  }
});

async function onCommand(i) {
  const uid = i.user.id;

  if (i.commandName === 'quiz') {
    let p = await store.getPlayer(uid);
    if (p?.finishedAt) return i.reply({ ...summaryView(p), flags: EPHEMERAL });
    if (!isOpen()) return i.reply({ content: '🔒 Le quiz est clôturé.', flags: EPHEMERAL });
    if (!p) p = await store.startPlayer(uid, i.user.username);
    console.log(`[quiz] ${i.user.tag} démarre/reprend (question ${p.answers.length + 1})`);
    return i.reply({ ...questionView(p.answers.length), flags: EPHEMERAL }); // reprise possible
  }

  if (i.commandName === 'classement') {
    if (isOpen() && !isAdmin(i)) {
      return i.reply({ content: '🔒 Le classement sera publié après la clôture du quiz.', flags: EPHEMERAL });
    }
    // admin avant clôture : aperçu privé ; après clôture : public
    return i.reply({ embeds: [await leaderboardEmbed(i.guild.name)], flags: isOpen() ? EPHEMERAL : undefined });
  }

  if (i.commandName === 'corrige') {
    if (isOpen()) return i.reply({ content: '🔒 Le corrigé sera disponible après la clôture.', flags: EPHEMERAL });
    const p = await store.getPlayer(uid);
    const lines = questions.map((qu, k) => {
      const mine = p?.answers[k];
      const mark = !mine ? '➖' : mine === qu.a ? '✅' : '❌';
      return `${mark} **${k + 1}.** Bonne réponse : **${qu.a}**${mine ? ` · Ta réponse : ${mine}` : ''}`;
    });
    return i.reply({
      embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📖 Corrigé').setDescription(lines.join('\n'))],
      flags: EPHEMERAL,
    });
  }

  if (i.commandName === 'quiz-admin') {
    if (!isAdmin(i)) return i.reply({ content: '⛔ Réservé aux administrateurs.', flags: EPHEMERAL });
    const sub = i.options.getSubcommand();

    if (sub === 'ouvrir') {
      const hours = i.options.getInteger('heures') ?? DEFAULT_HOURS;
      const channel = i.options.getChannel('salon') ?? i.channel;
      const endsAt = Date.now() + hours * 3600 * 1000;
      try {
        await channel.send(`🎃 **Le quiz de cybersécurité est ouvert !** Lance \`/quiz\` pour participer. Fin <t:${Math.floor(endsAt / 1000)}:R>.`);
      } catch (e) {
        console.error(e);
        return i.reply({
          content: `❌ Impossible d'écrire dans ${channel} (${e.message}). Vérifie les permissions du bot sur ce salon. Le quiz n'a pas été ouvert.`,
          flags: EPHEMERAL,
        });
      }
      await store.saveConfig({ open: true, endsAt, channelId: channel.id });
      return i.reply({ content: `🔓 Quiz ouvert pour ${hours}h. Annonce publiée dans ${channel}.`, flags: EPHEMERAL });
    }
    if (sub === 'cloturer') {
      await store.saveConfig({ open: false });
      return i.reply({ content: '🔒 Quiz clôturé. `/classement` est maintenant public.', flags: EPHEMERAL });
    }
    if (sub === 'reset') {
      await store.resetPlayers();
      return i.reply({ content: '🗑️ Participations effacées.', flags: EPHEMERAL });
    }
    if (sub === 'stats') {
      const st = await store.stats();
      return i.reply({
        content: `Démarrés : **${st.total}** · Terminés : **${st.done}** · Moyenne : **${st.avg == null ? '—' : st.avg.toFixed(2)}/${TOTAL}** · État : ${isOpen() ? 'ouvert' : 'clôturé'}${endsTag() ? ` · Fin ${endsTag()}` : ''}`,
        flags: EPHEMERAL,
      });
    }
  }
}

async function onButton(i) {
  const [, kind, idxStr, letter] = i.customId.split(':');
  const uid = i.user.id;

  // Bouton "Question suivante"
  if (kind === 'next') {
    const p = await store.getPlayer(uid);
    if (!p || p.finishedAt) return i.update({ components: [] });
    return i.update(questionView(p.answers.length));
  }

  // Bouton de réponse
  if (!isOpen()) return i.update({ content: '🔒 Le quiz est clôturé.', embeds: [], components: [] });
  const idx = Number(idxStr);

  // Atomique : refuse si la question a déjà reçu une réponse (double clic, ancien message…)
  let p = await store.recordAnswer(uid, idx, letter);
  if (!p) {
    return i.update({ content: '⚠️ Question déjà répondue. Relance `/quiz` pour reprendre.', embeds: [], components: [] });
  }
  console.log(`[quiz] ${i.user.tag} Q${idx + 1} -> ${letter}`);
  const correct = letter === questions[idx].a;

  if (p.answers.length === TOTAL) {
    p = await store.finishPlayer(uid, computeScore(p.answers));
    console.log(`[quiz] ${i.user.tag} a terminé : ${p.score}/${TOTAL}`);
    return i.update(summaryView(p));
  }

  const embed = new EmbedBuilder()
    .setColor(correct ? 0x2ecc71 : 0xe74c3c)
    .setTitle(correct ? '✅ Bonne réponse !' : '❌ Mauvaise réponse')
    .setDescription(`Question ${idx + 1}/${TOTAL} · ta réponse : **${letter}**`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('quiz:next').setLabel('Question suivante ➜').setStyle(ButtonStyle.Primary),
  );
  return i.update({ embeds: [embed], components: [row] });
}

(async () => {
  await store.connect();
  console.log('MongoDB connecté');
  await client.login(process.env.DISCORD_TOKEN);
})().catch(e => { console.error('Démarrage impossible :', e); process.exit(1); });