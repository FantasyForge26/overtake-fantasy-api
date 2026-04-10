import mongoose from 'mongoose';
await mongoose.connect('mongodb+srv://info_db_user:PhatPhat00!@overtake-fantasy.kv0g64a.mongodb.net/overtake-fantasy?appName=Overtake-Fantasy');
const db = mongoose.connection.db;

// Check what seasons exist in historicalracebreakdowns for pit crews
const sample = await db.collection('historicalracebreakdowns')
  .find({ assetType: 'pitCrew' })
  .limit(3)
  .toArray();
console.log('Sample historicalracebreakdowns:', JSON.stringify(sample, null, 2));

await mongoose.disconnect();
