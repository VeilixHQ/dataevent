// Stockage MongoDB : config du quiz (1 document) + une participation par utilisateur.
const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
let players, configCol;

// Config en mémoire (lecture synchrone) + persistée en base
const config = { open: false, endsAt: null, channelId: null };

async function connect() {
  await client.connect();
  const db = client.db(process.env.MONGO_DB || 'datalyx_quiz');
  players = db.collection('quiz_players');
  configCol = db.collection('quiz_config');
  await players.createIndex({ finishedAt: 1, score: -1 });
  const saved = await configCol.findOne({ _id: 'main' });
  if (saved) {
    config.open = !!saved.open;
    config.endsAt = saved.endsAt ?? null;
    config.channelId = saved.channelId ?? null;
  }
}

async function saveConfig(patch) {
  Object.assign(config, patch);
  await configCol.updateOne({ _id: 'main' }, { $set: { ...config } }, { upsert: true });
}

const getPlayer = uid => players.findOne({ _id: uid });

async function startPlayer(uid, username) {
  try {
    await players.updateOne(
      { _id: uid },
      { $setOnInsert: { username, answers: [], startedAt: Date.now(), finishedAt: null, score: 0 } },
      { upsert: true },
    );
  } catch (e) {
    if (e.code !== 11000) throw e; // double clic simultané : déjà créé
  }
  return players.findOne({ _id: uid });
}

// Enregistre la réponse de la question idx UNIQUEMENT si elle n'a pas déjà été donnée (atomique).
// Retourne le document mis à jour, ou null si refusé (déjà répondu / terminé).
const recordAnswer = (uid, idx, letter) =>
  players.findOneAndUpdate(
    { _id: uid, finishedAt: null, answers: { $size: idx } },
    { $push: { answers: letter } },
    { returnDocument: 'after' },
  );

const finishPlayer = (uid, score) =>
  players.findOneAndUpdate(
    { _id: uid, finishedAt: null },
    { $set: { finishedAt: Date.now(), score } },
    { returnDocument: 'after' },
  );

const leaderboard = limit =>
  players.find({ finishedAt: { $ne: null } }).sort({ score: -1, finishedAt: 1 }).limit(limit).toArray();

async function stats() {
  const total = await players.countDocuments();
  const done = await players.countDocuments({ finishedAt: { $ne: null } });
  const [agg] = await players.aggregate([
    { $match: { finishedAt: { $ne: null } } },
    { $group: { _id: null, avg: { $avg: '$score' } } },
  ]).toArray();
  return { total, done, avg: agg?.avg ?? null };
}

const resetPlayers = () => players.deleteMany({});

module.exports = { connect, config, saveConfig, getPlayer, startPlayer, recordAnswer, finishPlayer, leaderboard, stats, resetPlayers };