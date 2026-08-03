// migrate.js
// Run with: DATABASE_URL=postgres://... node migrate.js

const db = require('./db');

async function migrate() {
  try {
    console.log('Running migrations...');
    await db.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS local_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        upstream_id TEXT UNIQUE NOT NULL,
        username TEXT,
        email TEXT,
        full_name TEXT,
        created_at timestamptz DEFAULT now()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
        project_id TEXT,
        attendance_type TEXT,
        notes TEXT,
        check_in_time timestamptz NOT NULL,
        check_in_lat double precision,
        check_in_lng double precision,
        check_in_address text,
        check_out_time timestamptz,
        check_out_lat double precision,
        check_out_lng double precision,
        check_out_address text,
        checkout_type text,
        duration_minutes integer,
        office text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_attendance_user_id ON attendance (user_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_attendance_check_in_time ON attendance (check_in_time);`);

    console.log('Migrations applied successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

migrate();
