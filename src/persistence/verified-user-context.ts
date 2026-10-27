import { validateIdentifier } from '../domain/identifiers.ts'
import type { SqlConnection, SqlPool } from './postgres-organization-repository.ts'

export async function withVerifiedUserReadContext<T>(
  pool: SqlPool,
  verifiedUserIdInput: string,
  operation: (connection: SqlConnection) => Promise<T>,
): Promise<T> {
  return withContext(pool, verifiedUserIdInput, operation, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
}

export async function withVerifiedUserContext<T>(
  pool: SqlPool,
  verifiedUserIdInput: string,
  operation: (connection: SqlConnection) => Promise<T>,
): Promise<T> {
  return withContext(pool, verifiedUserIdInput, operation, 'BEGIN')
}

async function withContext<T>(
  pool: SqlPool,
  verifiedUserIdInput: string,
  operation: (connection: SqlConnection) => Promise<T>,
  begin: string,
): Promise<T> {
  const verifiedUserId = validateIdentifier(verifiedUserIdInput, 'Verified user ID')
  const connection = await pool.connect()
  let releaseError: Error | undefined
  try {
    await connection.query(begin)
    await connection.query(`SELECT set_config('app.user_id', $1, true)`, [verifiedUserId])
    const result = await operation(connection)
    await connection.query('COMMIT')
    return result
  } catch (error) {
    try {
      await connection.query('ROLLBACK')
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed')
      throw new AggregateError([error, rollbackError], 'Transaction failed and rollback failed')
    }
    throw error
  } finally {
    connection.release(releaseError)
  }
}
