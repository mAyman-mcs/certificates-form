const { Pool, types } = require('pg');

// Hand back DATE columns as the raw 'YYYY-MM-DD' string. By default pg builds
// a Date at *local* midnight, so .toISOString() shifts the day for anyone west
// of UTC — every expiration date would render one day early.
types.setTypeParser(1082, (value) => value);

// Matches the env var names already used in docker-compose.yml. DB_HOST
// defaults to localhost for running the app outside Docker; set it to
// "postgres" (the compose service name) when running inside the network.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  user: process.env.POSTGRES_USER || 'certificates',
  password: process.env.POSTGRES_PASSWORD || 'certificates',
  database: process.env.POSTGRES_DB || 'certificates',
});

module.exports = pool;
