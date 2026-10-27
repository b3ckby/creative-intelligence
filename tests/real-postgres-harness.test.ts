import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLoopbackProvisionerUrl,
  cleanupTargets,
  validateLocalProvisionerUrl,
} from './postgres/helpers/real-postgres.ts'

test('local PostgreSQL auto-provisioner URL carries its generated credentials', () => {
  const url = new URL(buildLoopbackProvisionerUrl('temporary_role', 'p@ss:/word', '5432'))

  assert.equal(url.protocol, 'postgresql:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '5432')
  assert.equal(decodeURIComponent(url.username), 'temporary_role')
  assert.equal(decodeURIComponent(url.password), 'p@ss:/word')
  assert.equal(url.pathname, '/postgres')
})

test('provisioner URL rejects routing overrides and non-numeric localhost aliases', () => {
  assert.throws(
    () => validateLocalProvisionerUrl('postgresql://admin@127.0.0.1/postgres?host=evil.example'),
    /routing override/i,
  )
  assert.throws(
    () => validateLocalProvisionerUrl('postgresql://admin@127.0.0.1/postgres?service=remote'),
    /routing override/i,
  )
  assert.throws(
    () => validateLocalProvisionerUrl('postgresql:///postgres?host=%2Fsafe&host=evil.example'),
    /routing override/i,
  )
  assert.throws(
    () => validateLocalProvisionerUrl('postgresql:///postgres?host=evil.example&host=%2Fsafe'),
    /routing override/i,
  )
  assert.throws(
    () => validateLocalProvisionerUrl('postgresql://admin@localhost/postgres'),
    /numeric loopback/i,
  )
  assert.doesNotThrow(() => validateLocalProvisionerUrl('postgresql://admin@127.0.0.1:5432/postgres'))
  assert.doesNotThrow(() => validateLocalProvisionerUrl('postgresql:///postgres?host=%2Fvar%2Frun%2Fpostgresql'))
})

test('cleanup selects only artifacts whose creation completed or began from a proven-absent state', () => {
  const names = { database: 'db', loginRole: 'login', runtimeRole: 'runtime', rlsOwnerRole: 'owner' }

  assert.deepEqual(cleanupTargets(names, {}), [])
  assert.deepEqual(cleanupTargets(names, { databaseCreated: true }), ['database:db'])
  assert.deepEqual(
    cleanupTargets(names, { loginRoleCreated: true, fixedRolesOwned: true }),
    ['role:login', 'role:runtime', 'role:owner'],
  )
})
