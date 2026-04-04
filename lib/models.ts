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
