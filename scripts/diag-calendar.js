const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb+srv://info_db_user:PhatPhat00!@overtake-fantasy.kv0g64a.mongodb.net/?appName=Overtake-Fantasy';

async function run() {
  await mongoose.connect(MONGODB_URI);
  const RaceCalendar = mongoose.model('RaceCalendar', new mongoose.Schema({}, { strict: false }));
  const races = await RaceCalendar.find({ season: 2026, cancelled: false }).sort({ round: 1 }).lean();
  for (const r of races) {
    console.log(JSON.stringify({
      round: r.round, name: (r.name||'').substring(0, 22), meetingKey: r.meetingKey,
      raceDate: r.raceDate, qualifyingDate: r.qualifyingDate,
      sprintDate: r.sprintDate, sprintQualifyingDate: r.sprintQualifyingDate,
      isSprint: r.isSprint
    }));
  }
  await mongoose.disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
