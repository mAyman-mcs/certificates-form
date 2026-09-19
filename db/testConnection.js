const pool = require('./connection');

(async () => {
  try {
    const result = await pool.query('SELECT NOW() AS now');
    console.log('Connected to Postgres. Server time:', result.rows[0].now);
  } catch (err) {
    console.error('Failed to connect to Postgres:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
