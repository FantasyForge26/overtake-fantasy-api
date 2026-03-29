import 'dotenv/config';
import { connectDB } from './db';
import { Asset } from './models';

async function seed() {
  await connectDB();

  await Asset.deleteMany({ season: 2026 });

  // ---------------------------------------------------------------------------
  // DRIVERS
  // ---------------------------------------------------------------------------
  const drivers = [
    {
      slug: 'max-verstappen', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Max Verstappen', firstName: 'Max', lastName: 'Verstappen',
      team: 'Red Bull Racing', teamSlug: 'red-bull',
      carNumber: 1, nationality: 'Dutch',
      powerUnitSlug: 'ford-red-bull',
      teamColor: '#3671C6', teamColorSecondary: '#CC1E4A',
    },
    {
      slug: 'liam-lawson', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Liam Lawson', firstName: 'Liam', lastName: 'Lawson',
      team: 'Red Bull Racing', teamSlug: 'red-bull',
      carNumber: 30, nationality: 'New Zealander',
      powerUnitSlug: 'ford-red-bull',
      teamColor: '#3671C6', teamColorSecondary: '#CC1E4A',
    },
    {
      slug: 'george-russell', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'George Russell', firstName: 'George', lastName: 'Russell',
      team: 'Mercedes', teamSlug: 'mercedes',
      carNumber: 63, nationality: 'British',
      powerUnitSlug: 'mercedes',
      teamColor: '#00D2BE', teamColorSecondary: '#000000',
    },
    {
      slug: 'andrea-kimi-antonelli', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Andrea Kimi Antonelli', firstName: 'Andrea Kimi', lastName: 'Antonelli',
      team: 'Mercedes', teamSlug: 'mercedes',
      carNumber: 12, nationality: 'Italian',
      powerUnitSlug: 'mercedes',
      teamColor: '#00D2BE', teamColorSecondary: '#000000',
    },
    {
      slug: 'lewis-hamilton', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Lewis Hamilton', firstName: 'Lewis', lastName: 'Hamilton',
      team: 'Ferrari', teamSlug: 'ferrari',
      carNumber: 44, nationality: 'British',
      powerUnitSlug: 'ferrari',
      teamColor: '#E8002D', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'charles-leclerc', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Charles Leclerc', firstName: 'Charles', lastName: 'Leclerc',
      team: 'Ferrari', teamSlug: 'ferrari',
      carNumber: 16, nationality: 'Monegasque',
      powerUnitSlug: 'ferrari',
      teamColor: '#E8002D', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'lando-norris', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Lando Norris', firstName: 'Lando', lastName: 'Norris',
      team: 'McLaren', teamSlug: 'mclaren',
      carNumber: 4, nationality: 'British',
      powerUnitSlug: 'mercedes',
      teamColor: '#FF8000', teamColorSecondary: '#000000',
    },
    {
      slug: 'oscar-piastri', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Oscar Piastri', firstName: 'Oscar', lastName: 'Piastri',
      team: 'McLaren', teamSlug: 'mclaren',
      carNumber: 81, nationality: 'Australian',
      powerUnitSlug: 'mercedes',
      teamColor: '#FF8000', teamColorSecondary: '#000000',
    },
    {
      slug: 'fernando-alonso', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Fernando Alonso', firstName: 'Fernando', lastName: 'Alonso',
      team: 'Aston Martin', teamSlug: 'aston-martin',
      carNumber: 14, nationality: 'Spanish',
      powerUnitSlug: 'honda-aston-martin',
      teamColor: '#358C75', teamColorSecondary: '#CEDC00',
    },
    {
      slug: 'lance-stroll', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Lance Stroll', firstName: 'Lance', lastName: 'Stroll',
      team: 'Aston Martin', teamSlug: 'aston-martin',
      carNumber: 18, nationality: 'Canadian',
      powerUnitSlug: 'honda-aston-martin',
      teamColor: '#358C75', teamColorSecondary: '#CEDC00',
    },
    {
      slug: 'pierre-gasly', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Pierre Gasly', firstName: 'Pierre', lastName: 'Gasly',
      team: 'Alpine', teamSlug: 'alpine',
      carNumber: 10, nationality: 'French',
      powerUnitSlug: 'mercedes-alpine',
      teamColor: '#FF87BC', teamColorSecondary: '#0090FF',
    },
    {
      slug: 'jack-doohan', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Jack Doohan', firstName: 'Jack', lastName: 'Doohan',
      team: 'Alpine', teamSlug: 'alpine',
      carNumber: 7, nationality: 'Australian',
      powerUnitSlug: 'mercedes-alpine',
      teamColor: '#FF87BC', teamColorSecondary: '#0090FF',
    },
    {
      slug: 'alexander-albon', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Alexander Albon', firstName: 'Alexander', lastName: 'Albon',
      team: 'Williams', teamSlug: 'williams',
      carNumber: 23, nationality: 'Thai',
      powerUnitSlug: 'mercedes',
      teamColor: '#00A3E0', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'carlos-sainz', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Carlos Sainz', firstName: 'Carlos', lastName: 'Sainz',
      team: 'Williams', teamSlug: 'williams',
      carNumber: 55, nationality: 'Spanish',
      powerUnitSlug: 'mercedes',
      teamColor: '#00A3E0', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'yuki-tsunoda', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Yuki Tsunoda', firstName: 'Yuki', lastName: 'Tsunoda',
      team: 'Racing Bulls', teamSlug: 'racing-bulls',
      carNumber: 22, nationality: 'Japanese',
      powerUnitSlug: 'ford-red-bull',
      teamColor: '#6692FF', teamColorSecondary: '#CC1E4A',
    },
    {
      slug: 'isack-hadjar', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Isack Hadjar', firstName: 'Isack', lastName: 'Hadjar',
      team: 'Racing Bulls', teamSlug: 'racing-bulls',
      carNumber: 6, nationality: 'French-Algerian',
      powerUnitSlug: 'ford-red-bull',
      teamColor: '#6692FF', teamColorSecondary: '#CC1E4A',
    },
    {
      slug: 'esteban-ocon', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Esteban Ocon', firstName: 'Esteban', lastName: 'Ocon',
      team: 'Haas', teamSlug: 'haas',
      carNumber: 31, nationality: 'French',
      powerUnitSlug: 'ferrari',
      teamColor: '#B6BABD', teamColorSecondary: '#E8002D',
    },
    {
      slug: 'oliver-bearman', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Oliver Bearman', firstName: 'Oliver', lastName: 'Bearman',
      team: 'Haas', teamSlug: 'haas',
      carNumber: 87, nationality: 'British',
      powerUnitSlug: 'ferrari',
      teamColor: '#B6BABD', teamColorSecondary: '#E8002D',
    },
    {
      slug: 'nico-hulkenberg', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Nico Hulkenberg', firstName: 'Nico', lastName: 'Hulkenberg',
      team: 'Audi', teamSlug: 'audi',
      carNumber: 27, nationality: 'German',
      powerUnitSlug: 'audi',
      teamColor: '#B5BAC1', teamColorSecondary: '#C00000',
    },
    {
      slug: 'gabriel-bortoleto', assetType: 'driver', season: 2026, isActive: true, confirmed: true,
      name: 'Gabriel Bortoleto', firstName: 'Gabriel', lastName: 'Bortoleto',
      team: 'Audi', teamSlug: 'audi',
      carNumber: 5, nationality: 'Brazilian',
      powerUnitSlug: 'audi',
      teamColor: '#B5BAC1', teamColorSecondary: '#C00000',
    },
    {
      slug: 'cadillac-driver-1', assetType: 'driver', season: 2026, isActive: true, confirmed: false,
      name: 'Cadillac Driver 1', firstName: 'TBC', lastName: 'TBC',
      team: 'Cadillac', teamSlug: 'cadillac',
      carNumber: 11, nationality: 'TBC',
      powerUnitSlug: 'ford-red-bull',
      teamColor: '#BA0000', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'cadillac-driver-2', assetType: 'driver', season: 2026, isActive: true, confirmed: false,
      name: 'Cadillac Driver 2', firstName: 'TBC', lastName: 'TBC',
      team: 'Cadillac', teamSlug: 'cadillac',
      carNumber: 12, nationality: 'TBC',
      powerUnitSlug: 'ford-red-bull',
      teamColor: '#BA0000', teamColorSecondary: '#FFFFFF',
    },
  ];

  // ---------------------------------------------------------------------------
  // PRINCIPALS
  // ---------------------------------------------------------------------------
  const principals = [
    {
      slug: 'christian-horner', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Christian Horner', firstName: 'Christian', lastName: 'Horner',
      team: 'Red Bull Racing', teamSlug: 'red-bull',
      nationality: 'British', carNumbers: [1, 30],
      teamColor: '#3671C6', teamColorSecondary: '#CC1E4A',
    },
    {
      slug: 'toto-wolff', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Toto Wolff', firstName: 'Toto', lastName: 'Wolff',
      team: 'Mercedes', teamSlug: 'mercedes',
      nationality: 'Austrian', carNumbers: [63, 12],
      teamColor: '#00D2BE', teamColorSecondary: '#000000',
    },
    {
      slug: 'frederic-vasseur', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Frederic Vasseur', firstName: 'Frederic', lastName: 'Vasseur',
      team: 'Ferrari', teamSlug: 'ferrari',
      nationality: 'French', carNumbers: [44, 16],
      teamColor: '#E8002D', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'andrea-stella', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Andrea Stella', firstName: 'Andrea', lastName: 'Stella',
      team: 'McLaren', teamSlug: 'mclaren',
      nationality: 'Italian', carNumbers: [4, 81],
      teamColor: '#FF8000', teamColorSecondary: '#000000',
    },
    {
      slug: 'mike-krack', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Mike Krack', firstName: 'Mike', lastName: 'Krack',
      team: 'Aston Martin', teamSlug: 'aston-martin',
      nationality: 'Luxembourgish', carNumbers: [14, 18],
      teamColor: '#358C75', teamColorSecondary: '#CEDC00',
    },
    {
      slug: 'oliver-oakes', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Oliver Oakes', firstName: 'Oliver', lastName: 'Oakes',
      team: 'Alpine', teamSlug: 'alpine',
      nationality: 'British', carNumbers: [10, 7],
      teamColor: '#FF87BC', teamColorSecondary: '#0090FF',
    },
    {
      slug: 'james-vowles', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'James Vowles', firstName: 'James', lastName: 'Vowles',
      team: 'Williams', teamSlug: 'williams',
      nationality: 'British', carNumbers: [23, 55],
      teamColor: '#00A3E0', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'laurent-mekies', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Laurent Mekies', firstName: 'Laurent', lastName: 'Mekies',
      team: 'Racing Bulls', teamSlug: 'racing-bulls',
      nationality: 'French', carNumbers: [22, 6],
      teamColor: '#6692FF', teamColorSecondary: '#CC1E4A',
    },
    {
      slug: 'ayao-komatsu', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Ayao Komatsu', firstName: 'Ayao', lastName: 'Komatsu',
      team: 'Haas', teamSlug: 'haas',
      nationality: 'Japanese', carNumbers: [31, 87],
      teamColor: '#B6BABD', teamColorSecondary: '#E8002D',
    },
    {
      slug: 'mattia-binotto', assetType: 'principal', season: 2026, isActive: true, confirmed: true,
      name: 'Mattia Binotto', firstName: 'Mattia', lastName: 'Binotto',
      team: 'Audi', teamSlug: 'audi',
      nationality: 'Italian', carNumbers: [27, 5],
      teamColor: '#B5BAC1', teamColorSecondary: '#C00000',
    },
    {
      slug: 'graeme-lowdon', assetType: 'principal', season: 2026, isActive: true, confirmed: false,
      name: 'Graeme Lowdon', firstName: 'Graeme', lastName: 'Lowdon',
      team: 'Cadillac', teamSlug: 'cadillac',
      nationality: 'British', carNumbers: [11, 12],
      teamColor: '#BA0000', teamColorSecondary: '#FFFFFF',
    },
  ];

  // ---------------------------------------------------------------------------
  // PIT CREWS
  // One per driver car number. slug: pit-crew-{carNumber}, except Cadillac car
  // 12 which uses pit-crew-12c to avoid collision with Antonelli's car 12.
  // ---------------------------------------------------------------------------
  const pitCrewEntries = [
    // Red Bull Racing
    { carNumber: 1,  slug: 'pit-crew-1',   team: 'Red Bull Racing', teamSlug: 'red-bull',      teamColor: '#3671C6', teamColorSecondary: '#CC1E4A' },
    { carNumber: 30, slug: 'pit-crew-30',  team: 'Red Bull Racing', teamSlug: 'red-bull',      teamColor: '#3671C6', teamColorSecondary: '#CC1E4A' },
    // Mercedes
    { carNumber: 63, slug: 'pit-crew-63',  team: 'Mercedes',        teamSlug: 'mercedes',      teamColor: '#00D2BE', teamColorSecondary: '#000000' },
    { carNumber: 12, slug: 'pit-crew-12',  team: 'Mercedes',        teamSlug: 'mercedes',      teamColor: '#00D2BE', teamColorSecondary: '#000000' },
    // Ferrari
    { carNumber: 44, slug: 'pit-crew-44',  team: 'Ferrari',         teamSlug: 'ferrari',       teamColor: '#E8002D', teamColorSecondary: '#FFFFFF' },
    { carNumber: 16, slug: 'pit-crew-16',  team: 'Ferrari',         teamSlug: 'ferrari',       teamColor: '#E8002D', teamColorSecondary: '#FFFFFF' },
    // McLaren
    { carNumber: 4,  slug: 'pit-crew-4',   team: 'McLaren',         teamSlug: 'mclaren',       teamColor: '#FF8000', teamColorSecondary: '#000000' },
    { carNumber: 81, slug: 'pit-crew-81',  team: 'McLaren',         teamSlug: 'mclaren',       teamColor: '#FF8000', teamColorSecondary: '#000000' },
    // Aston Martin
    { carNumber: 14, slug: 'pit-crew-14',  team: 'Aston Martin',    teamSlug: 'aston-martin',  teamColor: '#358C75', teamColorSecondary: '#CEDC00' },
    { carNumber: 18, slug: 'pit-crew-18',  team: 'Aston Martin',    teamSlug: 'aston-martin',  teamColor: '#358C75', teamColorSecondary: '#CEDC00' },
    // Alpine
    { carNumber: 10, slug: 'pit-crew-10',  team: 'Alpine',          teamSlug: 'alpine',        teamColor: '#FF87BC', teamColorSecondary: '#0090FF' },
    { carNumber: 7,  slug: 'pit-crew-7',   team: 'Alpine',          teamSlug: 'alpine',        teamColor: '#FF87BC', teamColorSecondary: '#0090FF' },
    // Williams
    { carNumber: 23, slug: 'pit-crew-23',  team: 'Williams',        teamSlug: 'williams',      teamColor: '#00A3E0', teamColorSecondary: '#FFFFFF' },
    { carNumber: 55, slug: 'pit-crew-55',  team: 'Williams',        teamSlug: 'williams',      teamColor: '#00A3E0', teamColorSecondary: '#FFFFFF' },
    // Racing Bulls
    { carNumber: 22, slug: 'pit-crew-22',  team: 'Racing Bulls',    teamSlug: 'racing-bulls',  teamColor: '#6692FF', teamColorSecondary: '#CC1E4A' },
    { carNumber: 6,  slug: 'pit-crew-6',   team: 'Racing Bulls',    teamSlug: 'racing-bulls',  teamColor: '#6692FF', teamColorSecondary: '#CC1E4A' },
    // Haas
    { carNumber: 31, slug: 'pit-crew-31',  team: 'Haas',            teamSlug: 'haas',          teamColor: '#B6BABD', teamColorSecondary: '#E8002D' },
    { carNumber: 87, slug: 'pit-crew-87',  team: 'Haas',            teamSlug: 'haas',          teamColor: '#B6BABD', teamColorSecondary: '#E8002D' },
    // Audi
    { carNumber: 27, slug: 'pit-crew-27',  team: 'Audi',            teamSlug: 'audi',          teamColor: '#B5BAC1', teamColorSecondary: '#C00000' },
    { carNumber: 5,  slug: 'pit-crew-5',   team: 'Audi',            teamSlug: 'audi',          teamColor: '#B5BAC1', teamColorSecondary: '#C00000' },
    // Cadillac
    { carNumber: 11, slug: 'pit-crew-11',  team: 'Cadillac',        teamSlug: 'cadillac',      teamColor: '#BA0000', teamColorSecondary: '#FFFFFF' },
    { carNumber: 12, slug: 'pit-crew-12c', team: 'Cadillac',        teamSlug: 'cadillac',      teamColor: '#BA0000', teamColorSecondary: '#FFFFFF' },
  ];

  const pitCrews = pitCrewEntries.map(({ carNumber, slug, team, teamSlug, teamColor, teamColorSecondary }) => ({
    slug,
    assetType: 'pitCrew',
    season: 2026,
    isActive: true,
    confirmed: !teamSlug.includes('cadillac') || slug !== 'pit-crew-12c' ? (teamSlug !== 'cadillac') : false,
    name: `${team} Pit Crew (Car ${carNumber})`,
    team,
    teamSlug,
    carNumber,
    teamColor,
    teamColorSecondary,
  }));

  // Cadillac pit crews are unconfirmed
  pitCrews.forEach(p => {
    if (p.teamSlug === 'cadillac') p.confirmed = false;
  });

  // ---------------------------------------------------------------------------
  // POWER UNITS
  // ---------------------------------------------------------------------------
  const powerUnits = [
    {
      slug: 'ford-red-bull', assetType: 'powerUnit', season: 2026, isActive: true, confirmed: true,
      name: 'Ford/Red Bull',
      team: 'Ford/Red Bull', teamSlug: 'ford-red-bull',
      manufacturer: 'Ford/Red Bull',
      suppliedTeams: ['Red Bull Racing', 'Racing Bulls', 'Cadillac'],
      teamColor: '#3671C6', teamColorSecondary: '#CC1E4A',
    },
    {
      slug: 'mercedes', assetType: 'powerUnit', season: 2026, isActive: true, confirmed: true,
      name: 'Mercedes',
      team: 'Mercedes', teamSlug: 'mercedes',
      manufacturer: 'Mercedes',
      suppliedTeams: ['Mercedes', 'McLaren', 'Williams'],
      teamColor: '#00D2BE', teamColorSecondary: '#000000',
    },
    {
      slug: 'ferrari', assetType: 'powerUnit', season: 2026, isActive: true, confirmed: true,
      name: 'Ferrari',
      team: 'Ferrari', teamSlug: 'ferrari',
      manufacturer: 'Ferrari',
      suppliedTeams: ['Ferrari', 'Haas'],
      teamColor: '#E8002D', teamColorSecondary: '#FFFFFF',
    },
    {
      slug: 'honda-aston-martin', assetType: 'powerUnit', season: 2026, isActive: true, confirmed: true,
      name: 'Honda (Aston Martin)',
      team: 'Aston Martin', teamSlug: 'aston-martin',
      manufacturer: 'Honda',
      suppliedTeams: ['Aston Martin'],
      teamColor: '#358C75', teamColorSecondary: '#CEDC00',
    },
    {
      slug: 'audi', assetType: 'powerUnit', season: 2026, isActive: true, confirmed: true,
      name: 'Audi',
      team: 'Audi', teamSlug: 'audi',
      manufacturer: 'Audi',
      suppliedTeams: ['Audi'],
      teamColor: '#B5BAC1', teamColorSecondary: '#C00000',
    },
    {
      slug: 'mercedes-alpine', assetType: 'powerUnit', season: 2026, isActive: true, confirmed: true,
      name: 'Mercedes (Alpine customer)',
      team: 'Alpine', teamSlug: 'alpine',
      manufacturer: 'Mercedes',
      suppliedTeams: ['Alpine'],
      teamColor: '#FF87BC', teamColorSecondary: '#0090FF',
    },
  ];

  // ---------------------------------------------------------------------------
  // INSERT
  // ---------------------------------------------------------------------------
  const insertedDrivers    = await Asset.insertMany(drivers);
  const insertedPrincipals = await Asset.insertMany(principals);
  const insertedPitCrews   = await Asset.insertMany(pitCrews);
  const insertedPowerUnits = await Asset.insertMany(powerUnits);

  console.log(`Inserted ${insertedDrivers.length} drivers`);
  console.log(`Inserted ${insertedPrincipals.length} principals`);
  console.log(`Inserted ${insertedPitCrews.length} pit crews`);
  console.log(`Inserted ${insertedPowerUnits.length} power units`);

  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
