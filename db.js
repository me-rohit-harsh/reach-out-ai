const { MongoClient } = require('mongodb');

const MONGO_URI = 'mongodb://localhost:27017/';
const DB_NAME = 'reachout';

let _client = null;
let _db = null;

async function getDb() {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI);
  await _client.connect();
  _db = _client.db(DB_NAME);
  await _db.collection('users').createIndex({ email: 1 }, { unique: true });
  await _db.collection('outreach').createIndex({ userEmail: 1, sentAt: -1 });
  await _db.collection('outreach').createIndex({ userEmail: 1, recipientEmail: 1 });
  console.log(`MongoDB connected → ${MONGO_URI}${DB_NAME}`);
  return _db;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function planDailyLimit(plan) {
  switch (plan) {
    case 'standard': return 50;
    case 'pro': return 100;
    case 'agency': return 500;
    default: return 20;
  }
}

function hydrateUser(user) {
  if (!user) return null;
  const today = todayStr();
  const sentToday = user.lastSentDate === today ? (user.emailsSentToday || 0) : 0;
  const limit = planDailyLimit(user.plan || 'free');
  return { ...user, emailsSent: sentToday, emailsLimit: limit };
}

const db = {
  async getUser(email) {
    if (!email) return null;
    const database = await getDb();
    const user = await database.collection('users').findOne({ email: email.toLowerCase() });
    if (!user) return null;

    const today = todayStr();
    if (user.lastSentDate && user.lastSentDate !== today) {
      await database.collection('users').updateOne(
        { email: email.toLowerCase() },
        { $set: { emailsSentToday: 0, lastSentDate: today } }
      );
      user.emailsSentToday = 0;
      user.lastSentDate = today;
    }

    return hydrateUser(user);
  },

  async getUsers() {
    const database = await getDb();
    const users = await database.collection('users').find({}).toArray();
    return users.map(hydrateUser).filter(Boolean);
  },

  async saveUser(email, userDetails) {
    if (!email) return null;
    const database = await getDb();
    const emailKey = email.toLowerCase();
    const existing = await database.collection('users').findOne({ email: emailKey }) || {};
    const plan = userDetails.plan !== undefined ? userDetails.plan : (existing.plan || 'free');

    const setFields = { email: emailKey, plan, updatedAt: new Date() };
    const fields = ['name', 'picture', 'googleId', 'refreshToken', 'accessToken',
                    'tokenExpiry', 'cvText', 'cvPath', 'promptTemplate'];
    for (const f of fields) {
      if (userDetails[f] !== undefined) setFields[f] = userDetails[f];
      else setFields[f] = existing[f] !== undefined ? existing[f] : '';
    }

    const result = await database.collection('users').findOneAndUpdate(
      { email: emailKey },
      {
        $set: setFields,
        $setOnInsert: {
          emailsSentToday: 0,
          emailsSentTotal: 0,
          lastSentDate: todayStr(),
          createdAt: new Date()
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    return hydrateUser(result);
  },

  async incrementEmailsSent(email) {
    if (!email) return null;
    const database = await getDb();
    const emailKey = email.toLowerCase();
    const today = todayStr();
    const user = await database.collection('users').findOne({ email: emailKey });
    if (!user) return null;

    const inc = { emailsSentTotal: 1 };
    const set = { updatedAt: new Date() };

    if (user.lastSentDate === today) {
      inc.emailsSentToday = 1;
    } else {
      set.emailsSentToday = 1;
      set.lastSentDate = today;
    }

    const result = await database.collection('users').findOneAndUpdate(
      { email: emailKey },
      { $inc: inc, $set: set },
      { returnDocument: 'after' }
    );
    return hydrateUser(result);
  },

  async resetUsage(email) {
    if (!email) return null;
    const database = await getDb();
    const result = await database.collection('users').findOneAndUpdate(
      { email: email.toLowerCase() },
      { $set: { emailsSentToday: 0, emailsSentTotal: 0, lastSentDate: todayStr(), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return hydrateUser(result);
  },

  async isEmailSentBefore(userEmail, recipientEmail) {
    if (!userEmail || !recipientEmail) return false;
    const database = await getDb();
    const count = await database.collection('outreach').countDocuments({
      userEmail: userEmail.toLowerCase(),
      recipientEmail: recipientEmail.toLowerCase(),
      testMode: false
    });
    return count > 0;
  },

  async recordOutreach(userEmail, { recipientEmail, recruiterName, subject, testMode }) {
    if (!userEmail) return;
    const database = await getDb();
    await database.collection('outreach').insertOne({
      userEmail: userEmail.toLowerCase(),
      recipientEmail: (recipientEmail || '').toLowerCase(),
      recruiterName: recruiterName || '',
      subject: subject || '',
      testMode: !!testMode,
      sentAt: new Date()
    });
  },

  async getOutreachHistory(userEmail, limit = 200) {
    if (!userEmail) return [];
    const database = await getDb();
    return database.collection('outreach')
      .find({ userEmail: userEmail.toLowerCase() })
      .sort({ sentAt: -1 })
      .limit(limit)
      .toArray();
  },

  async clearOutreachHistory(userEmail) {
    if (!userEmail) return;
    const database = await getDb();
    await database.collection('outreach').deleteMany({ userEmail: userEmail.toLowerCase() });
  },

  async getConfig() {
    const database = await getDb();
    const doc = await database.collection('config').findOne({ key: 'system' });
    if (!doc) return {};
    const { _id, key, updatedAt, ...rest } = doc;
    return rest;
  },

  async saveConfig(data) {
    const database = await getDb();
    const { _id, key, ...clean } = data;
    await database.collection('config').updateOne(
      { key: 'system' },
      { $set: { ...clean, key: 'system', updatedAt: new Date() } },
      { upsert: true }
    );
  },

  async createUpgradeRequest(email, details) {
    if (!email) return;
    const database = await getDb();
    await database.collection('upgrade_requests').insertOne({
      email: email.toLowerCase(),
      reason: details.reason,
      requestedAt: new Date()
    });
  },

  async getGlobalOutreach(limit = 100) {
    const database = await getDb();
    return database.collection('outreach')
      .find({})
      .sort({ sentAt: -1 })
      .limit(limit)
      .toArray();
  },

  async getUpgradeRequests() {
    const database = await getDb();
    return database.collection('upgrade_requests')
      .find({})
      .sort({ requestedAt: -1 })
      .toArray();
  }
};

module.exports = db;
