/**
 * OVERTAKE FANTASY — MONGODB DATA MODELS
 */

import mongoose, { Schema } from 'mongoose';

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

const AssetSchema = new Schema({
  slug:               { type: String, required: true, unique: true },
  assetType:          { type: String, required: true, enum: ['driver', 'principal', 'pitCrew', 'powerUnit'] },
  name:               { type: String, required: true },
  season:             { type: Number, default: 2026 },
  team:               { type: String, required: true },
  teamSlug:           { type: String, required: true },
  teamColor:          { type: String, default: '#FFFFFF' },
  teamColorSecondary: { type: String, default: '#000000' },
  nationality:        { type: String },
  carNumber:          { type: Number },
  firstName:          { type: String },
  lastName:           { type: String },
  powerUnitSlug:      { type: String },
  carNumbers:         [{ type: Number }],
  manufacturer:       { type: String },
  suppliedTeams:      [{ type: String }],
  isActive:           { type: Boolean, default: true },
  confirmed:          { type: Boolean, default: true },
  illustrationUrl:    { type: String },
  otfRating:          { type: Number, default: 50 },
  otfBaseRating:      { type: Number, default: 50 },
  totalPoints:        { type: Number, default: 0 },
  avgPointsPerRace:   { type: Number, default: 0 },
  racesCompleted:     { type: Number, default: 0 },
  dnfCount:           { type: Number, default: 0 },
  qualifyingRaces:    { type: Number, default: 0 },
  q1Count:            { type: Number, default: 0 },
  q2Count:            { type: Number, default: 0 },
  q3Count:            { type: Number, default: 0 },
  age:                { type: Number },
  teamStrength:       { type: Number, default: 50 },
});

AssetSchema.index({ assetType: 1, season: 1 });
AssetSchema.index({ teamSlug: 1 });

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

const UserSchema = new Schema({
  googleId:    { type: String, sparse: true, unique: true },
  appleId:     { type: String, sparse: true, unique: true },
  email:       { type: String, required: true, unique: true, lowercase: true },
  displayName: { type: String, required: true },
  avatarUrl:   { type: String },
  createdAt:   { type: Date, default: Date.now },
  lastLogin:   { type: Date, default: Date.now },
  leagueIds:   [{ type: Schema.Types.ObjectId, ref: 'League' }],
  isAI:        { type: Boolean, default: false },
});

// ---------------------------------------------------------------------------
// League
// ---------------------------------------------------------------------------

const LeagueSchema = new Schema({
  name:             { type: String, required: true },
  format:           { type: String, required: true, enum: ['dynasty', 'redraft'] },
  commissionerId:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  memberIds:        [{ type: Schema.Types.ObjectId, ref: 'User' }],
  season:           { type: Number, default: 2026 },
  status:           { type: String, default: 'setup', enum: ['setup', 'drafting', 'active', 'completed'] },
  inviteCode:       { type: String, required: true, unique: true },
  maxManagers:      { type: Number, default: 10 },
  isPublic:         { type: Boolean, default: false },
  scoring: {
    poleBonus:            { type: Number, default: 10 },
    raceFirstBonus:       { type: Number, default: 25 },
    sprintFirstBonus:     { type: Number, default: 10 },
    pitCrewFirstBonus:    { type: Number, default: 25 },
    powerUnitFirstBonus:  { type: Number, default: 25 },
    principalFirstBonus:  { type: Number, default: 25 },
  },
  waiversClearDay:  { type: String, enum: ['none', 'tue', 'wed', 'thu'], default: 'wed' },
  waiverHoldDays:   { type: Number, default: 2 },
  freeAgencyType:   { type: String, enum: ['freeForAll', 'contracts'], default: 'freeForAll' },
  acquisitionType:  { type: String, enum: ['instant', 'waivers', 'reverseStandings'], default: 'instant' },
  ccStartingBalance: { type: Number, default: 100 },
  draftDateTime:    { type: Date },
  draftOrderMode:   { type: String, enum: ['random', 'manual'], default: 'random' },
  draftOrderIds:    [{ type: Schema.Types.ObjectId, ref: 'User' }],
  pickTimeLimitSeconds: { type: Number, default: 60 },
  draftMode:        { type: String, enum: ['fast', 'slow'], default: 'fast' },
  slowDraftPickHours: { type: Number, default: 24 },
  pauseStart:       { type: String, default: '00:00' },
  pauseEnd:         { type: String, default: '08:00' },
  createdAt:        { type: Date, default: Date.now },
  currentRaceIndex: { type: Number, default: 0 },
  raceCalendar:     [{ type: String }],
});

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

const RosterSchema = new Schema({
  leagueId:           { type: Schema.Types.ObjectId, ref: 'League', required: true },
  userId:             { type: Schema.Types.ObjectId, ref: 'User', required: true },
  season:             { type: Number, default: 2026 },
  teamName:           { type: String, default: 'My Team' },
  teamPrimaryColor:   { type: String, default: '' },
  teamSecondaryColor: { type: String, default: '' },
  teamAccentColor:    { type: String, default: '' },
  driver1AssetId:     { type: Schema.Types.ObjectId, ref: 'Asset' },
  driver2AssetId:     { type: Schema.Types.ObjectId, ref: 'Asset' },
  principalAssetId:   { type: Schema.Types.ObjectId, ref: 'Asset' },
  pitCrew1AssetId:    { type: Schema.Types.ObjectId, ref: 'Asset' },
  pitCrew2AssetId:    { type: Schema.Types.ObjectId, ref: 'Asset' },
  powerUnitAssetId:   { type: Schema.Types.ObjectId, ref: 'Asset' },
  salaryUsed:         { type: Number, default: 0 },
  deadCapThisSeason:  { type: Number, default: 0 },
  deadCapNextSeason:  { type: Number, default: 0 },
  totalPoints:        { type: Number, default: 0 },
  seasonRank:         { type: Number, default: 0 },
  updatedAt:          { type: Date, default: Date.now },
});

RosterSchema.index({ leagueId: 1, userId: 1, season: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

const ContractSchema = new Schema({
  leagueId:         { type: Schema.Types.ObjectId, ref: 'League', required: true },
  rosterId:         { type: Schema.Types.ObjectId, ref: 'Roster', required: true },
  userId:           { type: Schema.Types.ObjectId, ref: 'User', required: true },
  assetId:          { type: Schema.Types.ObjectId, ref: 'Asset', required: true },
  assetType:        { type: String, required: true },
  annualValue:      { type: Number, required: true },
  totalValue:       { type: Number, required: true },
  years:            { type: Number, required: true, min: 1, max: 4 },
  seasonStart:      { type: Number, required: true },
  seasonEnd:        { type: Number, required: true },
  isActive:         { type: Boolean, default: true },
  terminatedSeason: { type: Number },
  deadCapRemaining: { type: Number, default: 0 },
  deadCapSeasons:   [{ type: Number }],
});

// ---------------------------------------------------------------------------
// SeasonStanding
// ---------------------------------------------------------------------------

const RaceHistoryEntrySchema = new Schema({
  raceIndex:        { type: Number },
  raceName:         { type: String },
  pointsThisRace:   { type: Number },
  cumulativePoints: { type: Number },
  rank:             { type: Number },
}, { _id: false });

const SeasonStandingSchema = new Schema({
  leagueId:    { type: Schema.Types.ObjectId, ref: 'League', required: true },
  userId:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
  rosterId:    { type: Schema.Types.ObjectId, ref: 'Roster', required: true },
  season:      { type: Number, required: true },
  totalPoints: { type: Number, default: 0 },
  rank:        { type: Number, default: 0 },
  raceHistory: [RaceHistoryEntrySchema],
  updatedAt:   { type: Date, default: Date.now },
});

SeasonStandingSchema.index({ leagueId: 1, season: 1, rank: 1 });

// ---------------------------------------------------------------------------
// DraftSession
// ---------------------------------------------------------------------------

const DraftPickSchema = new Schema({
  pickNumber: { type: Number },
  round:      { type: Number },
  userId:     { type: Schema.Types.ObjectId, ref: 'User' },
  assetId:    { type: Schema.Types.ObjectId, ref: 'Asset' },
  assetType:  { type: String },
  pickedAt:   { type: Date },
}, { _id: false });

const DraftSessionSchema = new Schema({
  leagueId:             { type: Schema.Types.ObjectId, ref: 'League', required: true },
  season:               { type: Number, required: true },
  status:               { type: String, enum: ['pending', 'active', 'paused', 'completed'], default: 'pending' },
  draftOrder:           [{ type: Schema.Types.ObjectId, ref: 'User' }],
  currentPickIndex:     { type: Number, default: 0 },
  currentRound:         { type: Number, default: 1 },
  totalRounds:          { type: Number, default: 6 },
  totalPicks:           { type: Number },
  availableAssetIds:    [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
  picks:                [DraftPickSchema],
  pickTimeLimitSeconds: { type: Number, default: 60 },
  currentPickStartedAt: { type: Date },
  preDraftStartedAt:    { type: Date },
  autoDraftUserIds:     [{ type: String }],
  createdAt:            { type: Date, default: Date.now },
  completedAt:          { type: Date },
});

// ---------------------------------------------------------------------------
// DraftQueue
// ---------------------------------------------------------------------------

const DraftQueueSchema = new Schema({
  leagueId:  { type: Schema.Types.ObjectId, ref: 'League', required: true },
  userId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  queue:     [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
  updatedAt: { type: Date, default: Date.now },
});

DraftQueueSchema.index({ leagueId: 1, userId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

const TransactionSchema = new Schema({
  leagueId:    { type: Schema.Types.ObjectId, ref: 'League', required: true },
  userId:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type:        { type: String, enum: ['add', 'drop', 'draft', 'trade', 'race', 'settings'], required: true },
  addAssetId:  { type: Schema.Types.ObjectId, ref: 'Asset' },
  dropAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
  note:        { type: String },
  createdAt:   { type: Date, default: Date.now },
});

// ---------------------------------------------------------------------------
// RaceResult
// ---------------------------------------------------------------------------

const DriverResultSchema = new Schema({
  driverSlug:          { type: String, required: true },
  startPosition:       { type: Number },
  finishPosition:      { type: Number },
  qualifyingPosition:  { type: Number },
  fastestLap:          { type: Boolean, default: false },
  speedTrapViolation:  { type: Boolean, default: false },
  notClassified:       { type: Boolean, default: false },
  dnf:                 { type: Boolean, default: false },
  penalizedSeconds:    { type: Number, default: 0 },
}, { _id: false });

const PitCrewResultSchema = new Schema({
  pitCrewSlug:       { type: String, required: true },
  stopTimes:         [{ type: Number }],
  fastestStopOverall: { type: Boolean, default: false },
}, { _id: false });

const RaceResultSchema = new Schema({
  leagueId:      { type: Schema.Types.ObjectId, ref: 'League', required: true },
  season:        { type: Number, default: 2026 },
  round:         { type: Number, required: true },
  driverResults: [DriverResultSchema],
  pitCrewResults:[PitCrewResultSchema],
  enteredBy:         { type: String },
  enteredAt:         { type: Date },
  calculated:        { type: Boolean, default: false },
  qualifyingScored:  { type: Boolean, default: false },
  sprintScored:      { type: Boolean, default: false },
  raceScored:        { type: Boolean, default: false },
});

RaceResultSchema.index({ leagueId: 1, season: 1, round: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// PerformanceSelection
// ---------------------------------------------------------------------------

const PerformanceSelectionSchema = new Schema({
  leagueId:           { type: Schema.Types.ObjectId, ref: 'League', required: true },
  userId:             { type: String, required: true },
  season:             { type: Number, default: 2026 },
  round:              { type: Number, required: true },
  driver1Boost:       { type: Schema.Types.ObjectId, ref: 'Asset' },
  driver2Boost:       { type: Schema.Types.ObjectId, ref: 'Asset' },
  pitCrew1Boost:      { type: Schema.Types.ObjectId, ref: 'Asset' },
  pitCrew2Boost:      { type: Schema.Types.ObjectId, ref: 'Asset' },
  driver1BoostCount:  { type: Number, default: 0 },
  driver2BoostCount:  { type: Number, default: 0 },
  pitCrew1BoostCount: { type: Number, default: 0 },
  pitCrew2BoostCount: { type: Number, default: 0 },
  submittedAt:        { type: Date },
  locked:             { type: Boolean, default: false },
});

PerformanceSelectionSchema.index({ leagueId: 1, userId: 1, season: 1, round: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// RaceCalendar
// ---------------------------------------------------------------------------

const RaceCalendarSchema = new Schema({
  round:             { type: Number, required: true },
  season:            { type: Number, required: true },
  name:              { type: String, required: true },
  country:           { type: String, required: true },
  circuit:           { type: String, required: true },
  raceDate:          { type: Date, required: true },
  qualifyingDate:    { type: Date, required: true },
  sprintDate:        { type: Date },
  selectionDeadline: { type: Date, required: true },
  isSprint:          { type: Boolean, default: false },
  cancelled:         { type: Boolean, default: false },
});

RaceCalendarSchema.index({ season: 1, round: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// HistoricalSeason
// ---------------------------------------------------------------------------

const HistoricalSeasonSchema = new Schema({
  assetSlug:              { type: String, required: true },
  assetType:              { type: String, enum: ['driver', 'principal', 'pitCrew', 'powerUnit'] },
  season:                 { type: Number, required: true },
  team:                   { type: String },
  racesCompleted:         { type: Number, default: 0 },
  wins:                   { type: Number, default: 0 },
  podiums:                { type: Number, default: 0 },
  pointsFinishes:         { type: Number, default: 0 },
  dnfCount:               { type: Number, default: 0 },
  totalPoints:            { type: Number, default: 0 },
  avgPointsPerRace:       { type: Number, default: 0 },
  championshipPosition:   { type: Number },
  q3Count:                { type: Number, default: 0 },
  qualifyingRaces:        { type: Number, default: 0 },
  avgQualifyingPosition:  { type: Number, default: 0 },
  avgPitStopTime:         { type: Number },
  fastestStopCount:       { type: Number },
  constructorPosition:    { type: Number },
});

HistoricalSeasonSchema.index({ assetSlug: 1, season: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// HistoricalRaceBreakdown
// ---------------------------------------------------------------------------

const HistoricalRaceBreakdownSchema = new Schema({
  assetSlug: { type: String, required: true },
  assetType: { type: String, enum: ['driver', 'principal', 'pitCrew', 'powerUnit'] },
  season:    { type: Number, required: true },
  round:     { type: Number, required: true },
  flag:      { type: String },
  shortName: { type: String },
  qPos:      { type: Number },
  qStage:    { type: String, enum: ['Q1', 'Q2', 'Q3'] },
  qPts:      { type: Number },
  rPts:        { type: Number, default: 0 },
  flBonus:     { type: Number, default: 0 },
  btBonus:     { type: Number, default: 0 },
  pgScore:     { type: Number, default: 0 },
  tot:         { type: Number, default: 0 },
  dnf:         { type: Boolean, default: false },
  // principal-specific: driver finish positions
  driver1Pos:  { type: Number },
  driver2Pos:  { type: Number },
  driver1Name: { type: String },
  driver2Name: { type: String },
  // powerUnit-specific: individual car finish positions that contributed to the score
  carPositions: [{ type: Number }],
  // pitCrew-specific: per-race stop details
  stopCount:        { type: Number },
  avgStopTime:      { type: Number },
  fastestStop:      { type: Number },
  wasOverallFastest:{ type: Boolean },
  stop1Time:        { type: Number },
  stop2Time:        { type: Number },
  stop3Time:        { type: Number },
});

HistoricalRaceBreakdownSchema.index({ assetSlug: 1, season: 1, round: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// ChatMessage
// ---------------------------------------------------------------------------

const ChatMessageSchema = new Schema({
  leagueId:     { type: String, required: true },
  userId:       { type: String, required: true },
  userName:     { type: String, required: true },
  userInitials: { type: String, required: true },
  message:      { type: String, default: '' },
  type:         { type: String, enum: ['text', 'asset', 'gif'], default: 'text' },
  assetId:      { type: String },
  assetName:    { type: String },
  assetOtf:     { type: Number },
  gifUrl:       { type: String },
  reactions:    { type: Map, of: [String], default: {} },
}, { timestamps: true });

ChatMessageSchema.index({ leagueId: 1, createdAt: 1 });

// ---------------------------------------------------------------------------
// AssetNews
// ---------------------------------------------------------------------------

const AssetNewsSchema = new Schema({
  assetSlug:   { type: String, required: true },
  headlines:   [{
    title:       { type: String },
    summary:     { type: String },
    url:         { type: String },
    source:      { type: String },
    publishedAt: { type: String },
  }],
  generatedAt:  { type: Date },
  searchQuery:  { type: String },
});

AssetNewsSchema.index({ assetSlug: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Exports (HMR-safe)
// ---------------------------------------------------------------------------

export const Asset          = mongoose.models.Asset          || mongoose.model('Asset',          AssetSchema);
export const User           = mongoose.models.User           || mongoose.model('User',           UserSchema);
export const League         = mongoose.models.League         || mongoose.model('League',         LeagueSchema);
export const Roster         = mongoose.models.Roster         || mongoose.model('Roster',         RosterSchema);
export const Contract       = mongoose.models.Contract       || mongoose.model('Contract',       ContractSchema);
export const SeasonStanding = mongoose.models.SeasonStanding || mongoose.model('SeasonStanding', SeasonStandingSchema);
export const DraftSession   = mongoose.models.DraftSession   || mongoose.model('DraftSession',   DraftSessionSchema);
export const DraftQueue     = mongoose.models.DraftQueue     || mongoose.model('DraftQueue',     DraftQueueSchema);
export const RaceResult            = mongoose.models.RaceResult            || mongoose.model('RaceResult',            RaceResultSchema);
export const Transaction           = mongoose.models.Transaction           || mongoose.model('Transaction',           TransactionSchema);
export const PerformanceSelection  = mongoose.models.PerformanceSelection  || mongoose.model('PerformanceSelection',  PerformanceSelectionSchema);
export const RaceCalendar          = mongoose.models.RaceCalendar          || mongoose.model('RaceCalendar',          RaceCalendarSchema);
export const HistoricalSeason         = mongoose.models.HistoricalSeason         || mongoose.model('HistoricalSeason',         HistoricalSeasonSchema);
export const HistoricalRaceBreakdown  = mongoose.models.HistoricalRaceBreakdown  || mongoose.model('HistoricalRaceBreakdown',  HistoricalRaceBreakdownSchema);
export const ChatMessage              = mongoose.models.ChatMessage              || mongoose.model('ChatMessage',              ChatMessageSchema);
export const AssetNews                = mongoose.models.AssetNews                || mongoose.model('AssetNews',                AssetNewsSchema);
