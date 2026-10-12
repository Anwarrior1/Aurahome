import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  encodePayload, parseArtifact, publicKeyFingerprint, signatureBytes,
  verifySignedArtifact, verifyEnrollmentBundle, verifyPolicyChange, verifyRecoveryGrant,
  generateInstallationIdentity
} from '@main/recovery/trust'

// All private keys are fictional, generated in memory, and never written to disk.
const owner = generateKeyPairSync('ed25519'), custodian = generateKeyPairSync('ed25519')
const stranger = generateKeyPairSync('ed25519')
const spki = (key: typeof owner) => key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const fingerprint = (key: typeof owner) => createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const binding = {
  installationId: '123e4567-e89b-42d3-a456-426614174000',
  businessId: '123e4567-e89b-42d3-a456-426614174001',
  deviceEnrollmentId: '123e4567-e89b-42d3-a456-426614174002',
  platform: 'darwin', targetDirectory: '/Users/fictional/Library/Application Support/AURA home',
  osPrincipal: 'uid:501', appId: 'com.aurahome.erp', policyEpoch: 1
} as const
const nonce = 'ab'.repeat(32), issuedAt = '2026-10-09T01:00:00.000Z', expiresAt = '2026-10-09T01:30:00.000Z'
const now = '2026-10-09T01:01:00.000Z'
const context = { binding, ownerPublicKey: spki(owner), custodianPublicKey: spki(custodian), expectedNonce: nonce, now }
const common = { version: 1, ...binding, issuedAt }
function rawArtifact(payload: unknown, key = owner): string {
  // Independent canonical fixture encoding, not the production encoder.
  function sort(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sort)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k,v]) => [k,sort(v)]))
    return value
  }
  const p = payload as { purpose: string; role: string }
  const bytes = Buffer.from(JSON.stringify(sort(payload)))
  const signature = sign(null, Buffer.concat([Buffer.from(`AURA-BDR01-v1\0${p.purpose}\0${p.role}\0`), bytes]), key.privateKey)
  return JSON.stringify({ payload: bytes.toString('base64'), signature: signature.toString('base64') })
}
const digest = (artifact: string) => createHash('sha256').update(artifact).digest('hex')
function enrollment() {
  const authorization = rawArtifact({ ...common, purpose: 'owner-enrollment', role: 'owner', keyFingerprint: fingerprint(owner), custodianKeyFingerprint: fingerprint(custodian), nonce, expiresAt })
  const proof = rawArtifact({ ...common, purpose: 'custodian-enrollment', role: 'custodian', keyFingerprint: fingerprint(custodian), ownerAuthorizationSha256: digest(authorization), nonce, expiresAt }, custodian)
  const policyPayload = { ...common, purpose: 'installation-policy', role: 'owner', keyFingerprint: fingerprint(owner), ownerPublicKey: spki(owner), custodianPublicKey: spki(custodian), ownerKeyFingerprint: fingerprint(owner), custodianKeyFingerprint: fingerprint(custodian), operatorModel: 'single-human-two-role-keys', ownerAuthorizationSha256: digest(authorization), custodianProofSha256: digest(proof) }
  return { authorization, proof, policy: rawArtifact(policyPayload), policyPayload }
}
const authPayload = () => ({ ...common, purpose: 'owner-enrollment', role: 'owner', keyFingerprint: fingerprint(owner), custodianKeyFingerprint: fingerprint(custodian), nonce, expiresAt })
function grants() {
  const p = { ...common, purpose: 'owner-recovery-grant', role: 'owner', keyFingerprint: fingerprint(owner), custodianKeyFingerprint: fingerprint(custodian), nonce, expiresAt, operationId: '123e4567-e89b-42d3-a456-426614174003', archiveSha256: '01'.repeat(32), archiveBytes: 10000, databaseSha256: '02'.repeat(32), migrationCount: 53, migrationFingerprint: '03'.repeat(32), originalTupleSha256: '04'.repeat(32), preparation: 'purge-remember-tokens-only' }
  const approval = rawArtifact(p)
  const proof = rawArtifact({ ...common, purpose: 'custodian-recovery-grant', role: 'custodian', keyFingerprint: fingerprint(custodian), nonce, expiresAt, operationId: p.operationId, ownerGrantSha256: digest(approval) }, custodian)
  return { p, approval, proof }
}

describe('BDR-01 Phase 1 pure trust verification (no enrollment or filesystem authority)', () => {
  it('accepts an independently signed owner enrollment authorization with exact binding', () => {
    const payload = authPayload()
    expect(verifySignedArtifact(rawArtifact(payload), 'owner-enrollment', context)).toEqual(payload)
  })
  it('verifies the different custodian key and cross-linked single-human policy bundle', () => {
    const bundle = enrollment()
    expect(verifyEnrollmentBundle(bundle, context)).toEqual(bundle.policyPayload)
  })
  it('computes the public SPKI fingerprint and canonical bytes independently', () => {
    expect(publicKeyFingerprint(spki(owner))).toBe(fingerprint(owner))
    expect(encodePayload(authPayload()).toString()).toBe(Buffer.from(JSON.parse(rawArtifact(authPayload())).payload, 'base64').toString())
    expect(signatureBytes(authPayload()).subarray(0, 42).toString()).toContain('AURA-BDR01-v1\0owner-enrollment\0owner\0')
  })
  it('generates distinct installation and device UUIDs independent of business SQLite', () => {
    const input = { businessId: binding.businessId, platform: binding.platform, targetDirectory: binding.targetDirectory, osPrincipal: binding.osPrincipal }
    const a = generateInstallationIdentity(input), b = generateInstallationIdentity(input)
    expect(a.installationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.deviceEnrollmentId).not.toBe(a.installationId)
    expect(a.installationId).not.toBe(b.installationId)
    expect(a).toMatchObject({ ...input, appId: binding.appId, policyEpoch: 1 })
  })
  it.each(['installationId', 'businessId', 'deviceEnrollmentId', 'policyEpoch', 'targetDirectory', 'osPrincipal', 'platform', 'appId'] as const)('rejects signed %s binding substitution', (field) => {
    const replacement = field.endsWith('Id') ? '123e4567-e89b-42d3-a456-426614174099' : field === 'policyEpoch' ? 2 : field === 'platform' ? 'win32' : field === 'osPrincipal' ? 'uid:502' : field === 'appId' ? 'other.app' : '/elsewhere'
    expect(() => verifySignedArtifact(rawArtifact({ ...authPayload(), [field]: replacement }), 'owner-enrollment', context)).toThrow()
  })
  it.each(['owner-enrollment', 'custodian-enrollment', 'installation-policy', 'policy-change', 'owner-recovery-grant', 'custodian-recovery-grant'] as const)('rejects purpose substitution into %s', (purpose) => {
    if (purpose === 'owner-enrollment') expect(() => verifySignedArtifact(enrollment().proof, purpose, context)).toThrow()
    else expect(() => verifySignedArtifact(rawArtifact(authPayload()), purpose, context)).toThrow()
  })
  it.each([
    ['unknown version', { version: 2 }], ['unknown field', { authority: true }],
    ['wrong role', { role: 'custodian' }], ['wrong fingerprint', { keyFingerprint: '00'.repeat(32) }],
    ['malformed UUID', { installationId: 'owner' }], ['negative epoch', { policyEpoch: -1 }],
    ['fractional epoch', { policyEpoch: 1.5 }], ['empty nonce', { nonce: '' }],
    ['short nonce', { nonce: 'aa' }], ['bad time', { issuedAt: 'yesterday' }],
    ['invalid calendar time', { issuedAt: '2026-02-30T01:00:00.000Z' }],
    ['offset time', { issuedAt: '2026-10-09T03:00:00.000+02:00' }],
    ['expiry before issuance', { expiresAt: '2026-10-09T00:59:00.000Z' }],
    ['excessive TTL', { expiresAt: '2026-10-10T01:00:00.000Z' }],
    ['relative root', { targetDirectory: 'data' }], ['parent traversal', { targetDirectory: '/safe/../other' }],
    ['NUL in root', { targetDirectory: '/safe\0other' }], ['noncanonical root', { targetDirectory: '/safe//other' }]
  ])('rejects canonical but invalid payload: %s', (_name, change) => {
    expect(() => verifySignedArtifact(rawArtifact({ ...authPayload(), ...change }), 'owner-enrollment', context)).toThrow()
  })
  it('rejects owner signature from the wrong key even with forged fingerprint claims', () => {
    expect(() => verifySignedArtifact(rawArtifact(authPayload(), stranger), 'owner-enrollment', context)).toThrow()
  })
  it('rejects custodian signing owner purpose and owner signing custodian purpose', () => {
    expect(() => verifySignedArtifact(rawArtifact(authPayload(), custodian), 'owner-enrollment', context)).toThrow()
    const p = parseArtifact(enrollment().proof).payload
    expect(() => verifySignedArtifact(rawArtifact(p, owner), 'custodian-enrollment', context)).toThrow()
  })
  it('rejects identical role keys despite individually valid signatures', () => {
    expect(() => verifySignedArtifact(rawArtifact(authPayload()), 'owner-enrollment', { ...context, custodianPublicKey: spki(owner) })).toThrow()
  })
  it('rejects public keys of the wrong type and malformed/noncanonical SPKI', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    expect(() => publicKeyFingerprint(ec.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))).toThrow()
    expect(() => publicKeyFingerprint('not-a-key')).toThrow()
    expect(() => publicKeyFingerprint(spki(owner) + '\n')).toThrow()
  })
  it.each(['payload', 'signature'])('rejects modified %s bytes', (field) => {
    const e = JSON.parse(rawArtifact(authPayload())), bytes = Buffer.from(e[field], 'base64')
    bytes[bytes.length - 2]! ^= 1; e[field] = bytes.toString('base64')
    expect(() => verifySignedArtifact(JSON.stringify(e), 'owner-enrollment', context)).toThrow()
  })
  it.each(['whitespace', 'duplicate envelope field', 'extra envelope field', 'missing field', 'bad base64', 'short signature', 'oversized', 'reordered payload', 'duplicate payload field', 'invalid UTF8'])('rejects ambiguous artifact: %s', (kind) => {
    const original = rawArtifact(authPayload()), e = JSON.parse(original)
    let value = original
    if (kind === 'whitespace') value = ' ' + original
    if (kind === 'duplicate envelope field') value = original.replace('{', `{"payload":"${e.payload}",`)
    if (kind === 'extra envelope field') value = JSON.stringify({ ...e, trusted: true })
    if (kind === 'missing field') value = JSON.stringify({ payload: e.payload })
    if (kind === 'bad base64') value = JSON.stringify({ ...e, signature: e.signature + '\n' })
    if (kind === 'short signature') value = JSON.stringify({ ...e, signature: Buffer.alloc(63).toString('base64') })
    if (kind === 'oversized') value = 'x'.repeat(20001)
    if (kind === 'reordered payload') value = JSON.stringify({ ...e, payload: Buffer.from(JSON.stringify(authPayload())).toString('base64') })
    if (kind === 'duplicate payload field') value = JSON.stringify({ ...e, payload: Buffer.from(Buffer.from(e.payload, 'base64').toString().replace('{', '{"version":1,')).toString('base64') })
    if (kind === 'invalid UTF8') value = JSON.stringify({ ...e, payload: Buffer.from([0xff,0xfe]).toString('base64') })
    expect(() => parseArtifact(value)).toThrow()
  })
  it('rejects expired, future and old-challenge artifacts (no durable consumption claim)', () => {
    const a = rawArtifact(authPayload())
    expect(() => verifySignedArtifact(a, 'owner-enrollment', { ...context, now: expiresAt })).toThrow()
    expect(() => verifySignedArtifact(a, 'owner-enrollment', { ...context, now: '2026-10-09T00:59:00.000Z' })).toThrow()
    expect(() => verifySignedArtifact(a, 'owner-enrollment', { ...context, expectedNonce: 'cd'.repeat(32) })).toThrow()
    expect(() => verifySignedArtifact(a, 'owner-enrollment', { ...context, now: 'invalid' })).toThrow()
  })
  it('rejects enrollment proof linked to a different owner authorization', () => {
    const b = enrollment(), p = parseArtifact(b.proof).payload
    expect(() => verifyEnrollmentBundle({ ...b, proof: rawArtifact({ ...p, ownerAuthorizationSha256: '00'.repeat(32) }, custodian) }, context)).toThrow()
  })
  it.each(['ownerAuthorizationSha256', 'custodianProofSha256', 'ownerPublicKey', 'custodianPublicKey', 'operatorModel'])('rejects policy %s substitution', (field) => {
    const b = enrollment(), value = field.endsWith('Sha256') ? '00'.repeat(32) : field.endsWith('PublicKey') ? spki(stranger) : 'two-independent-humans'
    expect(() => verifyEnrollmentBundle({ ...b, policy: rawArtifact({ ...b.policyPayload, [field]: value }) }, context)).toThrow()
  })
  it('validates a signed policy rotation/revocation at the next exact epoch without applying it', () => {
    for (const action of ['rotate', 'revoke'] as const) {
      const p = { ...common, purpose: 'policy-change', role: 'owner', keyFingerprint: fingerprint(owner), nonce, expiresAt, action, previousEpoch: 1, policyEpoch: 2, previousPolicySha256: '11'.repeat(32), replacementPolicySha256: action === 'rotate' ? '22'.repeat(32) : null }
      expect(verifyPolicyChange(rawArtifact(p), context, '11'.repeat(32))).toEqual(p)
      expect(() => verifyPolicyChange(rawArtifact(p), context, '33'.repeat(32))).toThrow()
      expect(() => verifyPolicyChange(rawArtifact({ ...p, policyEpoch: 3 }), context, '11'.repeat(32))).toThrow()
    }
  })
  it('rejects revocation carrying a replacement and rotation missing one', () => {
    const p = { ...common, purpose: 'policy-change', role: 'owner', keyFingerprint: fingerprint(owner), nonce, expiresAt, previousEpoch: 1, policyEpoch: 2, previousPolicySha256: '11'.repeat(32) }
    for (const [action, replacementPolicySha256] of [['revoke', '22'.repeat(32)], ['rotate', null]]) expect(() => verifyPolicyChange(rawArtifact({ ...p, action, replacementPolicySha256 }), context, '11'.repeat(32))).toThrow()
  })
  it('verifies a future exact-candidate owner grant and a separate custodian countersignature as data only', () => {
    const g = grants()
    const candidate = { operationId: g.p.operationId, archiveSha256: g.p.archiveSha256, archiveBytes: g.p.archiveBytes, databaseSha256: g.p.databaseSha256, migrationCount: 53, migrationFingerprint: g.p.migrationFingerprint, originalTupleSha256: g.p.originalTupleSha256 }
    expect(verifyRecoveryGrant(g.approval, g.proof, context, candidate)).toEqual(g.p)
    for (const field of Object.keys(candidate) as (keyof typeof candidate)[]) {
      const value = typeof candidate[field] === 'number' ? 999 : field === 'operationId' ? '123e4567-e89b-42d3-a456-426614174099' : '99'.repeat(32)
      expect(() => verifyRecoveryGrant(g.approval, g.proof, context, { ...candidate, [field]: value })).toThrow()
    }
  })
  it('rejects a future countersignature linked to another grant or operation', () => {
    const g = grants(), p = parseArtifact(g.proof).payload
    for (const change of [{ ownerGrantSha256: '00'.repeat(32) }, { operationId: '123e4567-e89b-42d3-a456-426614174099' }]) {
      expect(() => verifyRecoveryGrant(g.approval, rawArtifact({ ...p, ...change }, custodian), context, g.p)).toThrow()
    }
  })
  it.each(['C:\\safe\\image:stream', 'C:\\safe\\CON', 'C:\\safe\\name.', 'C:\\safe\\name '])('rejects Windows alias or alternate-stream root %s', (targetDirectory) => {
    expect(() => generateInstallationIdentity({ businessId: binding.businessId, platform: 'win32', osPrincipal: 'S-1-5-21-100-200-300-1001', targetDirectory })).toThrow()
  })
  it('accepts canonical Windows identity but rejects drive-relative, UNC and mixed roots', () => {
    const input = { businessId: binding.businessId, platform: 'win32' as const, osPrincipal: 'S-1-5-21-100-200-300-1001', targetDirectory: 'C:\\Users\\fictional\\AppData\\Roaming\\AURA home' }
    expect(generateInstallationIdentity(input)).toMatchObject(input)
    for (const targetDirectory of ['C:relative', '\\\\host\\share', 'C:\\safe/other', 'C:\\safe\\..\\other']) expect(() => generateInstallationIdentity({ ...input, targetDirectory })).toThrow()
  })
})
