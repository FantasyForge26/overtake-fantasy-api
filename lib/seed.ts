import 'dotenv/config';
import { connectDB } from './db';
import { Asset } from './models';

const TEAMS = [
  { team: 'Red Bull Racing',  teamSlug: 'red-bull',      teamColor: '#3671C6', teamColorSecondary: '#CC1E4A', teamStrength: 85, puSlug: 'ford-red-bull' },
  { team: 'Racing Bulls',     teamSlug: 'racing-bulls',  teamColor: '#6692FF', teamColorSecondary: '#CC1E4A', teamStrength: 60, puSlug: 'ford-red-bull' },
  { team: 'McLaren',          teamSlug: 'mclaren',       teamColor: '#FF8000', teamColorSecondary: '#000000', teamStrength: 95, puSlug: 'mercedes' },
  { team: 'Mercedes',         teamSlug: 'mercedes',      teamColor: '#00D2BE', teamColorSecondary: '#000000', teamStrength: 80, puSlug: 'mercedes' },
  { team: 'Ferrari',          teamSlug: 'ferrari',       teamColor: '#E8002D', teamColorSecondary: '#FFFFFF', teamStrength: 90, puSlug: 'ferrari' },
  { team: 'Aston Martin',     teamSlug: 'aston-martin',  teamColor: '#358C75', teamColorSecondary: '#FFFFFF', teamStrength: 70, puSlug: 'mercedes' },
  { team: 'Williams',         teamSlug: 'williams',      teamColor: '#64C4FF', teamColorSecondary: '#FFFFFF', teamStrength: 65, puSlug: 'mercedes' },
  { team: 'Audi',             teamSlug: 'audi',          teamColor: '#C00D0D', teamColorSecondary: '#FFFFFF', teamStrength: 55, puSlug: 'audi' },
  { team: 'Haas',             teamSlug: 'haas',          teamColor: '#B6BABD', teamColorSecondary: '#E8002D', teamStrength: 50, puSlug: 'ferrari' },
  { team: 'Alpine',           teamSlug: 'alpine',        teamColor: '#0093CC', teamColorSecondary: '#FF87BC', teamStrength: 58, puSlug: 'renault' },
  { team: 'Cadillac',         teamSlug: 'cadillac',      teamColor: '#374F6B', teamColorSecondary: '#FFFFFF', teamStrength: 45, puSlug: 'cadillac' },
];

async function seed() {
  await connectDB();
  await Asset.deleteMany({ season: 2026 });

  // ---------------------------------------------------------------------------
  // DRIVERS
  // ---------------------------------------------------------------------------
  const drivers = [
    // Red Bull Racing
    { slug: 'max-verstappen',    firstName: 'Max',       lastName: 'Verstappen',  carNumber: 3,  age: 27, otfBaseRating: 96, nationality: 'Dutch',          teamSlug: 'red-bull' },
    { slug: 'isack-hadjar',      firstName: 'Isack',     lastName: 'Hadjar',      carNumber: 6,  age: 20, otfBaseRating: 74, nationality: 'French-Algerian', teamSlug: 'red-bull' },
    // Racing Bulls
    { slug: 'liam-lawson',       firstName: 'Liam',      lastName: 'Lawson',      carNumber: 30, age: 22, otfBaseRating: 77, nationality: 'New Zealander',  teamSlug: 'racing-bulls' },
    { slug: 'arvid-lindblad',    firstName: 'Arvid',     lastName: 'Lindblad',    carNumber: 41, age: 18, otfBaseRating: 65, nationality: 'Swedish',        teamSlug: 'racing-bulls' },
    // McLaren
    { slug: 'lando-norris',      firstName: 'Lando',     lastName: 'Norris',      carNumber: 1,  age: 25, otfBaseRating: 93, nationality: 'British',        teamSlug: 'mclaren' },
    { slug: 'oscar-piastri',     firstName: 'Oscar',     lastName: 'Piastri',     carNumber: 81, age: 24, otfBaseRating: 87, nationality: 'Australian',     teamSlug: 'mclaren' },
    // Mercedes
    { slug: 'george-russell',    firstName: 'George',    lastName: 'Russell',     carNumber: 63, age: 27, otfBaseRating: 88, nationality: 'British',        teamSlug: 'mercedes' },
    { slug: 'kimi-antonelli',    firstName: 'Kimi',      lastName: 'Antonelli',   carNumber: 12, age: 18, otfBaseRating: 79, nationality: 'Italian',        teamSlug: 'mercedes' },
    // Ferrari
    { slug: 'charles-leclerc',   firstName: 'Charles',   lastName: 'Leclerc',     carNumber: 16, age: 27, otfBaseRating: 91, nationality: 'Monegasque',     teamSlug: 'ferrari' },
    { slug: 'lewis-hamilton',    firstName: 'Lewis',     lastName: 'Hamilton',    carNumber: 44, age: 40, otfBaseRating: 89, nationality: 'British',        teamSlug: 'ferrari' },
    // Aston Martin
    { slug: 'fernando-alonso',   firstName: 'Fernando',  lastName: 'Alonso',      carNumber: 14, age: 43, otfBaseRating: 88, nationality: 'Spanish',        teamSlug: 'aston-martin' },
    { slug: 'lance-stroll',      firstName: 'Lance',     lastName: 'Stroll',      carNumber: 18, age: 26, otfBaseRating: 72, nationality: 'Canadian',       teamSlug: 'aston-martin' },
    // Williams
    { slug: 'carlos-sainz',      firstName: 'Carlos',    lastName: 'Sainz',       carNumber: 55, age: 30, otfBaseRating: 83, nationality: 'Spanish',        teamSlug: 'williams' },
    { slug: 'alex-albon',        firstName: 'Alex',      lastName: 'Albon',       carNumber: 23, age: 28, otfBaseRating: 78, nationality: 'Thai',           teamSlug: 'williams' },
    // Audi
    { slug: 'nico-hulkenberg',   firstName: 'Nico',      lastName: 'Hülkenberg',  carNumber: 27, age: 37, otfBaseRating: 80, nationality: 'German',         teamSlug: 'audi' },
    { slug: 'gabriel-bortoleto', firstName: 'Gabriel',   lastName: 'Bortoleto',   carNumber: 5,  age: 20, otfBaseRating: 64, nationality: 'Brazilian',      teamSlug: 'audi' },
    // Haas
    { slug: 'esteban-ocon',      firstName: 'Esteban',   lastName: 'Ocon',        carNumber: 31, age: 28, otfBaseRating: 76, nationality: 'French',         teamSlug: 'haas' },
    { slug: 'oliver-bearman',    firstName: 'Oliver',    lastName: 'Bearman',     carNumber: 87, age: 19, otfBaseRating: 62, nationality: 'British',        teamSlug: 'haas' },
    // Alpine
    { slug: 'pierre-gasly',      firstName: 'Pierre',    lastName: 'Gasly',       carNumber: 10, age: 28, otfBaseRating: 78, nationality: 'French',         teamSlug: 'alpine' },
    { slug: 'franco-colapinto',  firstName: 'Franco',    lastName: 'Colapinto',   carNumber: 43, age: 21, otfBaseRating: 68, nationality: 'Argentine',      teamSlug: 'alpine' },
    // Cadillac
    { slug: 'sergio-perez',      firstName: 'Sergio',    lastName: 'Pérez',       carNumber: 11, age: 35, otfBaseRating: 82, nationality: 'Mexican',        teamSlug: 'cadillac' },
    { slug: 'valtteri-bottas',   firstName: 'Valtteri',  lastName: 'Bottas',      carNumber: 77, age: 35, otfBaseRating: 75, nationality: 'Finnish',        teamSlug: 'cadillac' },
  ].map((d) => {
    const t = TEAMS.find((t) => t.teamSlug === d.teamSlug)!;
    return {
      slug: d.slug,
      assetType: 'driver',
      season: 2026,
      isActive: true,
      confirmed: true,
      name: `${d.firstName} ${d.lastName}`,
      firstName: d.firstName,
      lastName: d.lastName,
      carNumber: d.carNumber,
      age: d.age,
      nationality: d.nationality,
      team: t.team,
      teamSlug: t.teamSlug,
      teamColor: t.teamColor,
      teamColorSecondary: t.teamColorSecondary,
      teamStrength: t.teamStrength,
      powerUnitSlug: t.puSlug,
      otfBaseRating: d.otfBaseRating,
      otfRating: d.otfBaseRating,
    };
  });

  // ---------------------------------------------------------------------------
  // PRINCIPALS
  // ---------------------------------------------------------------------------
  const principalData = [
    { slug: 'laurent-mekies',    firstName: 'Laurent',  lastName: 'Mekies',     otfBaseRating: 72, nationality: 'French',      teamSlug: 'red-bull' },
    { slug: 'alan-permane',      firstName: 'Alan',     lastName: 'Permane',    otfBaseRating: 55, nationality: 'British',     teamSlug: 'racing-bulls' },
    { slug: 'andrea-stella',     firstName: 'Andrea',   lastName: 'Stella',     otfBaseRating: 78, nationality: 'Italian',     teamSlug: 'mclaren' },
    { slug: 'toto-wolff',        firstName: 'Toto',     lastName: 'Wolff',      otfBaseRating: 82, nationality: 'Austrian',    teamSlug: 'mercedes' },
    { slug: 'fred-vasseur',      firstName: 'Fred',     lastName: 'Vasseur',    otfBaseRating: 75, nationality: 'French',      teamSlug: 'ferrari' },
    { slug: 'adrian-newey',      firstName: 'Adrian',   lastName: 'Newey',      otfBaseRating: 85, nationality: 'British',     teamSlug: 'aston-martin' },
    { slug: 'james-vowles',      firstName: 'James',    lastName: 'Vowles',     otfBaseRating: 58, nationality: 'British',     teamSlug: 'williams' },
    { slug: 'jonathan-wheatley', firstName: 'Jonathan', lastName: 'Wheatley',   otfBaseRating: 60, nationality: 'British',     teamSlug: 'audi' },
    { slug: 'ayao-komatsu',      firstName: 'Ayao',     lastName: 'Komatsu',    otfBaseRating: 52, nationality: 'Japanese',    teamSlug: 'haas' },
    { slug: 'flavio-briatore',   firstName: 'Flavio',   lastName: 'Briatore',   otfBaseRating: 68, nationality: 'Italian',     teamSlug: 'alpine' },
    { slug: 'graeme-lowdon',     firstName: 'Graeme',   lastName: 'Lowdon',     otfBaseRating: 45, nationality: 'British',     teamSlug: 'cadillac' },
  ];

  // Collect car numbers per team from drivers
  const teamCarNumbers: Record<string, number[]> = {};
  for (const d of drivers) {
    if (!teamCarNumbers[d.teamSlug]) teamCarNumbers[d.teamSlug] = [];
    teamCarNumbers[d.teamSlug].push(d.carNumber);
  }

  const principals = principalData.map((p) => {
    const t = TEAMS.find((t) => t.teamSlug === p.teamSlug)!;
    return {
      slug: p.slug,
      assetType: 'principal',
      season: 2026,
      isActive: true,
      confirmed: true,
      name: `${p.firstName} ${p.lastName}`,
      firstName: p.firstName,
      lastName: p.lastName,
      nationality: p.nationality,
      carNumbers: teamCarNumbers[p.teamSlug] ?? [],
      team: t.team,
      teamSlug: t.teamSlug,
      teamColor: t.teamColor,
      teamColorSecondary: t.teamColorSecondary,
      teamStrength: t.teamStrength,
      otfBaseRating: p.otfBaseRating,
      otfRating: p.otfBaseRating,
    };
  });

  // ---------------------------------------------------------------------------
  // PIT CREWS — one per car (slug: [teamSlug]-pit-crew-[carNumber])
  // ---------------------------------------------------------------------------
  const pitCrews = drivers.map((d) => {
    const t = TEAMS.find((t) => t.teamSlug === d.teamSlug)!;
    const otfBaseRating = Math.round(t.teamStrength / 10 + 45);
    return {
      slug: `${t.teamSlug}-pit-crew-${d.carNumber}`,
      assetType: 'pitCrew',
      season: 2026,
      isActive: true,
      confirmed: true,
      name: `${t.team} Pit Crew (Car ${d.carNumber})`,
      team: t.team,
      teamSlug: t.teamSlug,
      teamColor: t.teamColor,
      teamColorSecondary: t.teamColorSecondary,
      teamStrength: t.teamStrength,
      carNumber: d.carNumber,
      otfBaseRating,
      otfRating: otfBaseRating,
    };
  });

  // ---------------------------------------------------------------------------
  // POWER UNITS — one per team
  // ---------------------------------------------------------------------------
  const powerUnitData = [
    { teamSlug: 'red-bull',      name: 'Ford Red Bull Powertrains', manufacturer: 'Ford Red Bull Powertrains', otfBaseRating: 82 },
    { teamSlug: 'racing-bulls',  name: 'Ford Red Bull Powertrains', manufacturer: 'Ford Red Bull Powertrains', otfBaseRating: 82 },
    { teamSlug: 'mclaren',       name: 'Mercedes',                  manufacturer: 'Mercedes',                  otfBaseRating: 88 },
    { teamSlug: 'mercedes',      name: 'Mercedes',                  manufacturer: 'Mercedes',                  otfBaseRating: 88 },
    { teamSlug: 'ferrari',       name: 'Ferrari',                   manufacturer: 'Ferrari',                   otfBaseRating: 85 },
    { teamSlug: 'aston-martin',  name: 'Honda',                     manufacturer: 'Honda',                     otfBaseRating: 80 },
    { teamSlug: 'williams',      name: 'Mercedes',                  manufacturer: 'Mercedes',                  otfBaseRating: 88 },
    { teamSlug: 'audi',          name: 'Audi',                      manufacturer: 'Audi',                      otfBaseRating: 68 },
    { teamSlug: 'haas',          name: 'Ferrari',                   manufacturer: 'Ferrari',                   otfBaseRating: 85 },
    { teamSlug: 'alpine',        name: 'Renault',                   manufacturer: 'Renault',                   otfBaseRating: 72 },
    { teamSlug: 'cadillac',      name: 'General Motors',            manufacturer: 'General Motors',            otfBaseRating: 60 },
  ];

  const powerUnits = powerUnitData.map((pu) => {
    const t = TEAMS.find((t) => t.teamSlug === pu.teamSlug)!;
    return {
      slug: `${pu.teamSlug}-pu`,
      assetType: 'powerUnit',
      season: 2026,
      isActive: true,
      confirmed: true,
      name: pu.name,
      manufacturer: pu.manufacturer,
      powerUnitSlug: pu.teamSlug,
      team: t.team,
      teamSlug: t.teamSlug,
      teamColor: t.teamColor,
      teamColorSecondary: t.teamColorSecondary,
      teamStrength: t.teamStrength,
      otfBaseRating: pu.otfBaseRating,
      otfRating: pu.otfBaseRating,
    };
  });

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
