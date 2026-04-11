import mongoose from 'mongoose';
await mongoose.connect('mongodb+srv://info_db_user:PhatPhat00!@overtake-fantasy.kv0g64a.mongodb.net/overtake-fantasy?appName=Overtake-Fantasy');
const db = mongoose.connection.db;
const drivers = await db.collection('assets')
  .find({ assetType: 'driver', season: 2026 })
  .sort({ otfRating: -1 })
  .project({ slug: 1, otfRating: 1, otfBaseRating: 1, avgPointsPerRace: 1, racesCompleted: 1 })
  .toArray();
for (const d of drivers) {
  console.log(`${d.slug.padEnd(25)} OTF=${d.otfRating} base=${d.otfBaseRating} avg=${(d.avgPointsPerRace??0).toFixed(1)} races=${d.racesCompleted}`);
}
await mongoose.disconnect();
