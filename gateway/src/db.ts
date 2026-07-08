import pg from 'pg';

export type Db = pg.Pool;

/** Either the pool or a single checked-out client (inside a transaction) — both expose .query(). */
export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString });
}

/**
 * Runs fn inside a BEGIN/COMMIT transaction on a dedicated client, rolling
 * back on any error. Use this whenever a route performs more than one write
 * that must be atomic (e.g. inserting a domain row + its audit_logs entry).
 */
export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
