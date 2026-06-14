import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI!;

if (!MONGODB_URI) {
  throw new Error("Please define MONGODB_URI in .env.local");
}

let cached = (global as any).mongoose ?? { conn: null, promise: null };
(global as any).mongoose = cached;

/**
 * Connects to MongoDB and caches the connection across Vercel function
 * invocations within the same warm instance.
 *
 * CONNECTION POOLING NOTE — critical for M0 free tier:
 *   Mongoose's default maxPoolSize is 100. Each warm Vercel function instance
 *   keeps its own pool, so with ~10 cron endpoints firing every minute plus
 *   tester traffic plus recent deploys leaving warm instances behind, total
 *   open connections can easily reach 200–500. M0 caps at 500 — past that,
 *   new connections are rejected and the API starts erroring.
 *
 *   maxPoolSize: 5 here means each warm instance keeps at most 5 connections.
 *   A single Next.js API route only needs 1–2 at a time (and even with the H7
 *   transaction work, sessions only need one connection each). Lowering this
 *   trades a tiny bit of latency under burst load for sustainable connection
 *   accounting on the free tier.
 *
 *   If we ever upgrade past M0 (M10 caps at 1500, M20 at 3000), maxPoolSize
 *   can be raised — but on serverless, large pools rarely help. The right
 *   ceiling for serverless workloads is "small + many" not "big + few".
 */
export async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, {
      dbName: "overtake-fantasy",
      bufferCommands: false,
      maxPoolSize: 5,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      maxIdleTimeMS: 30000,
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
