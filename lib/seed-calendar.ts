import 'dotenv/config';
import { connectDB } from './db';
import { RaceCalendar } from './models';

function d(iso: string) { return new Date(iso); }
function minus1h(iso: string) { return new Date(new Date(iso).getTime() - 60 * 60 * 1000); }

const races = [
  {
    round: 1,
    name: 'Australian Grand Prix',
    country: 'Australia',
    circuit: 'Albert Park Circuit, Melbourne',
    raceDate:       d('2026-03-08T05:00:00Z'),
    qualifyingDate: d('2026-03-07T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 2,
    name: 'Chinese Grand Prix',
    country: 'China',
    circuit: 'Shanghai International Circuit',
    raceDate:       d('2026-03-15T07:00:00Z'),
    qualifyingDate: d('2026-03-13T09:00:00Z'),
    sprintDate:     d('2026-03-15T04:00:00Z'),
    isSprint: true,
  },
  {
    round: 3,
    name: 'Japanese Grand Prix',
    country: 'Japan',
    circuit: 'Suzuka Circuit',
    raceDate:       d('2026-03-29T05:00:00Z'),
    qualifyingDate: d('2026-03-28T07:00:00Z'),
    isSprint: false,
  },
  {
    round: 4,
    name: 'Bahrain Grand Prix',
    country: 'Bahrain',
    circuit: 'Bahrain International Circuit, Sakhir',
    raceDate:       d('2026-04-12T15:00:00Z'),
    qualifyingDate: d('2026-04-11T13:00:00Z'),
    isSprint: false,
    cancelled: true,
  },
  {
    round: 5,
    name: 'Saudi Arabian Grand Prix',
    country: 'Saudi Arabia',
    circuit: 'Jeddah Corniche Circuit',
    raceDate:       d('2026-04-19T17:00:00Z'),
    qualifyingDate: d('2026-04-18T13:00:00Z'),
    isSprint: false,
    cancelled: true,
  },
  {
    round: 6,
    name: 'Miami Grand Prix',
    country: 'United States',
    circuit: 'Miami International Autodrome',
    raceDate:       d('2026-05-03T19:00:00Z'),
    qualifyingDate: d('2026-05-02T20:00:00Z'),
    sprintDate:     d('2026-05-03T17:00:00Z'),
    isSprint: true,
  },
  {
    round: 7,
    name: 'Canadian Grand Prix',
    country: 'Canada',
    circuit: 'Circuit Gilles Villeneuve, Montreal',
    raceDate:       d('2026-05-24T18:00:00Z'),
    qualifyingDate: d('2026-05-23T20:00:00Z'),
    sprintDate:     d('2026-05-24T17:00:00Z'),
    isSprint: true,
  },
  {
    round: 8,
    name: 'Monaco Grand Prix',
    country: 'Monaco',
    circuit: 'Circuit de Monaco',
    raceDate:       d('2026-06-07T13:00:00Z'),
    qualifyingDate: d('2026-06-06T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 9,
    name: 'Spanish Grand Prix',
    country: 'Spain',
    circuit: 'Circuit de Barcelona-Catalunya',
    raceDate:       d('2026-06-14T13:00:00Z'),
    qualifyingDate: d('2026-06-13T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 10,
    name: 'Austrian Grand Prix',
    country: 'Austria',
    circuit: 'Red Bull Ring, Spielberg',
    raceDate:       d('2026-06-28T13:00:00Z'),
    qualifyingDate: d('2026-06-27T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 11,
    name: 'British Grand Prix',
    country: 'Great Britain',
    circuit: 'Silverstone Circuit',
    raceDate:       d('2026-07-05T14:00:00Z'),
    qualifyingDate: d('2026-07-04T14:00:00Z'),
    sprintDate:     d('2026-07-05T11:00:00Z'),
    isSprint: true,
  },
  {
    round: 12,
    name: 'Belgian Grand Prix',
    country: 'Belgium',
    circuit: 'Circuit de Spa-Francorchamps',
    raceDate:       d('2026-07-19T13:00:00Z'),
    qualifyingDate: d('2026-07-18T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 13,
    name: 'Hungarian Grand Prix',
    country: 'Hungary',
    circuit: 'Hungaroring, Budapest',
    raceDate:       d('2026-07-26T13:00:00Z'),
    qualifyingDate: d('2026-07-25T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 14,
    name: 'Dutch Grand Prix',
    country: 'Netherlands',
    circuit: 'Circuit Zandvoort',
    raceDate:       d('2026-08-23T13:00:00Z'),
    qualifyingDate: d('2026-08-22T14:00:00Z'),
    sprintDate:     d('2026-08-23T11:00:00Z'),
    isSprint: true,
  },
  {
    round: 15,
    name: 'Italian Grand Prix',
    country: 'Italy',
    circuit: 'Autodromo Nazionale Monza',
    raceDate:       d('2026-09-06T13:00:00Z'),
    qualifyingDate: d('2026-09-05T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 16,
    name: 'Madrid Grand Prix',
    country: 'Spain',
    circuit: 'Madrid Street Circuit',
    raceDate:       d('2026-09-13T13:00:00Z'),
    qualifyingDate: d('2026-09-12T14:00:00Z'),
    isSprint: false,
  },
  {
    round: 17,
    name: 'Azerbaijan Grand Prix',
    country: 'Azerbaijan',
    circuit: 'Baku City Circuit',
    raceDate:       d('2026-09-27T11:00:00Z'),
    qualifyingDate: d('2026-09-26T12:00:00Z'),
    isSprint: false,
  },
  {
    round: 18,
    name: 'Singapore Grand Prix',
    country: 'Singapore',
    circuit: 'Marina Bay Street Circuit',
    raceDate:       d('2026-10-11T12:00:00Z'),
    qualifyingDate: d('2026-10-10T09:00:00Z'),
    sprintDate:     d('2026-10-11T09:00:00Z'),
    isSprint: true,
  },
  {
    round: 19,
    name: 'United States Grand Prix',
    country: 'United States',
    circuit: 'Circuit of the Americas, Austin',
    raceDate:       d('2026-10-25T19:00:00Z'),
    qualifyingDate: d('2026-10-24T20:00:00Z'),
    isSprint: false,
  },
  {
    round: 20,
    name: 'Mexico City Grand Prix',
    country: 'Mexico',
    circuit: 'Autodromo Hermanos Rodriguez, Mexico City',
    raceDate:       d('2026-11-01T19:00:00Z'),
    qualifyingDate: d('2026-11-01T20:00:00Z'),
    isSprint: false,
  },
  {
    round: 21,
    name: 'São Paulo Grand Prix',
    country: 'Brazil',
    circuit: 'Autodromo Jose Carlos Pace, São Paulo',
    raceDate:       d('2026-11-08T17:00:00Z'),
    qualifyingDate: d('2026-11-07T20:00:00Z'),
    sprintDate:     d('2026-11-08T17:00:00Z'),
    isSprint: true,
  },
  {
    round: 22,
    name: 'Las Vegas Grand Prix',
    country: 'United States',
    circuit: 'Las Vegas Street Circuit',
    raceDate:       d('2026-11-21T07:00:00Z'),
    qualifyingDate: d('2026-11-21T06:00:00Z'),
    isSprint: false,
  },
  {
    round: 23,
    name: 'Qatar Grand Prix',
    country: 'Qatar',
    circuit: 'Lusail International Circuit',
    raceDate:       d('2026-11-29T14:00:00Z'),
    qualifyingDate: d('2026-11-28T13:00:00Z'),
    isSprint: false,
  },
  {
    round: 24,
    name: 'Abu Dhabi Grand Prix',
    country: 'United Arab Emirates',
    circuit: 'Yas Marina Circuit',
    raceDate:       d('2026-12-06T13:00:00Z'),
    qualifyingDate: d('2026-12-05T13:00:00Z'),
    isSprint: false,
  },
];

async function seedCalendar() {
  await connectDB();

  await RaceCalendar.deleteMany({ season: 2026 });

  const docs = races.map((r) => ({
    ...r,
    season: 2026,
    cancelled: (r as any).cancelled ?? false,
    // selectionDeadline = qualifyingDate - 1 hour
    selectionDeadline: minus1h(r.qualifyingDate.toISOString()),
  }));

  await RaceCalendar.insertMany(docs);

  console.log(`Inserted ${docs.length} races (${docs.filter((r) => r.cancelled).length} cancelled)`);
  process.exit(0);
}

seedCalendar().catch((err) => {
  console.error(err);
  process.exit(1);
});
