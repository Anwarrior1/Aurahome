import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

/** Pure verification only: no Electron, SQLite, filesystem, enrollment or grant consumption. */
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
})
const keyBytes = z.string().max(128)
const bindingSchema = z.object({
  installationId: uuid, businessId: uuid, deviceEnrollmentId: uuid,
  platform: z.enum(['darwin', 'win32']), targetDirectory: z.string().min(1).max(1024),
  osPrincipal: z.string().min(1).max(184), appId: z.literal('com.aurahome.erp'), policyEpoch: epoch
}).strict()
export type InstallationBinding = z.infer<typeof bindingSchema>
const base = bindingSchema.extend({ version: z.literal(1), issuedAt: timestamp, keyFingerprint: hash })
const timed = { nonce: hash, expiresAt: timestamp }
const ownerEnrollment = base.extend({
  purpose: z.literal('owner-enrollment'), role: z.literal('owner'), ...timed,
  custodianKeyFingerprint: hash
}).strict()
const custodianEnrollment = base.extend({
  purpose: z.literal('custodian-enrollment'), role: z.literal('custodian'), ...timed,
  ownerAuthorizationSha256: hash
}).strict()
const installationPolicy = base.extend({
  purpose: z.literal('installation-policy'), role: z.literal('owner'),
  ownerPublicKey: keyBytes, custodianPublicKey: keyBytes,
  ownerKeyFingerprint: hash, custodianKeyFingerprint: hash,
  operatorModel: z.literal('single-human-two-role-keys'),
  ownerAuthorizationSha256: hash, custodianProofSha256: hash
}).strict()
const policyChange = base.extend({
  purpose: z.literal('policy-change'), role: z.literal('owner'), ...timed,
  action: z.enum(['rotate', 'revoke']), previousEpoch: epoch,
  previousPolicySha256: hash, replacementPolicySha256: hash.nullable()
}).strict()
const ownerGrant = base.extend({
  purpose: z.literal('owner-recovery-grant'), role: z.literal('owner'), ...timed,
  custodianKeyFingerprint: hash, operationId: uuid,
  archiveSha256: hash, archiveBytes: z.number().int().positive().max(5 * 1024 ** 3),
  databaseSha256: hash, migrationCount: epoch, migrationFingerprint: hash,
  originalTupleSha256: hash, preparation: z.literal('purge-remember-tokens-only')
}).strict()
const custodianGrant = base.extend({
  purpose: z.literal('custodian-recovery-grant'), role: z.literal('custodian'), ...timed,
  operationId: uuid, ownerGrantSha256: hash
}).strict()
const payloadSchema = z.discriminatedUnion('purpose', [
  ownerEnrollment, custodianEnrollment, installationPolicy, policyChange, ownerGrant, custodianGrant
])
export type SignedPayload = z.infer<typeof payloadSchema>
export type SigningPurpose = SignedPayload['purpose']
export interface VerificationContext {
  /** Supplied by a future independently trusted owner, never inferred from an artifact. */
  binding: InstallationBinding
  ownerPublicKey: string
  custodianPublicKey: string
  expectedNonce: string
  now: string
}

function fail(): never { throw new Error('Invalid recovery trust artifact') }
function canonical(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]))
    }
    return item
  }
  return JSON.stringify(sorted(value))
}
function decodeBase64(value: string, max: number): Buffer {
  if (value.length > Math.ceil(max / 3) * 4) fail()
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) fail()
  return bytes
}
function publicKey(value: string) {
  const bytes = decodeBase64(keyBytes.parse(value), 96)
  const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ type: 'spki', format: 'der' }).equals(bytes)) fail()
  return key
}
export function publicKeyFingerprint(value: string): string {
  return createHash('sha256').update(publicKey(value).export({ type: 'spki', format: 'der' })).digest('hex')
}

function validateBinding(input: unknown): InstallationBinding {
  const b = bindingSchema.parse(input), root = b.targetDirectory
  // Lexical contract only. This makes no claim about realpath, ACLs or OS identity.
  if ([...root].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail()
  if (b.platform === 'darwin') {
    if (!/^uid:(0|[1-9]\d*)$/.test(b.osPrincipal) || !root.startsWith('/') || root.includes('\\') || posix.normalize(root) !== root || root === '/' || root.endsWith('/') || root.split('/').some((part) => part === '.' || part === '..')) fail()
  } else {
    const components = root.slice(3).split('\\')
    if (components.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail()
    if (!/^S-1-\d+(?:-\d+)+$/.test(b.osPrincipal) || !/^[A-Z]:\\/.test(root) || root.includes('/') || win32.normalize(root) !== root || root.length <= 3 || root.endsWith('\\') || root.split('\\').some((part) => part === '.' || part === '..')) fail()
  }
  return b
}
function validatedPayload(input: unknown): SignedPayload {
  const p = payloadSchema.parse(input)
  validateBinding(Object.fromEntries(Object.keys(bindingSchema.shape).map((k) => [k, p[k as keyof typeof p]])))
  if ('expiresAt' in p) {
    const duration = Date.parse(p.expiresAt) - Date.parse(p.issuedAt)
    if (duration <= 0 || duration > 30 * 60 * 1000) fail()
  }
  if (p.purpose === 'installation-policy') {
    if (publicKeyFingerprint(p.ownerPublicKey) !== p.ownerKeyFingerprint || publicKeyFingerprint(p.custodianPublicKey) !== p.custodianKeyFingerprint || p.ownerKeyFingerprint === p.custodianKeyFingerprint || p.keyFingerprint !== p.ownerKeyFingerprint) fail()
  }
  if (p.purpose === 'policy-change') {
    if (p.policyEpoch !== p.previousEpoch + 1 || (p.action === 'revoke' ? p.replacementPolicySha256 !== null : p.replacementPolicySha256 === null)) fail()
  }
  return p
}
export function encodePayload(input: unknown): Buffer {
  const encoded = Buffer.from(canonical(validatedPayload(input)))
  if (encoded.length > 8192) fail()
  return encoded
}
export function signatureBytes(input: unknown): Buffer {
  const p = validatedPayload(input)
  return Buffer.concat([Buffer.from(`AURA-BDR01-v1\0${p.purpose}\0${p.role}\0`), encodePayload(p)])
}

/** Wire format: canonical JSON {payload: canonical-base64 UTF8 JSON, signature: base64 64 bytes}. */
export function parseArtifact(input: string): { payload: SignedPayload; signature: Buffer } {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 20000) fail()
  const envelope = z.object({ payload: z.string(), signature: z.string() }).strict().parse(JSON.parse(input))
  if (canonical(envelope) !== input) fail() // Also rejects duplicates and lexical ambiguity.
  const bytes = decodeBase64(envelope.payload, 8192)
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const payload = validatedPayload(JSON.parse(raw))
  if (!encodePayload(payload).equals(bytes)) fail()
  const signature = decodeBase64(envelope.signature, 64)
  if (signature.length !== 64) fail()
  return { payload, signature }
}

/** Returns verified data only, not an enrolled policy or a consumable recovery capability. */
export function verifySignedArtifact(input: string, purpose: SigningPurpose, ctx: VerificationContext): SignedPayload {
  const b = validateBinding(ctx.binding), now = Date.parse(timestamp.parse(ctx.now))
  hash.parse(ctx.expectedNonce)
  const owner = publicKeyFingerprint(ctx.ownerPublicKey), custodian = publicKeyFingerprint(ctx.custodianPublicKey)
  if (owner === custodian) fail()
  const { payload: p, signature } = parseArtifact(input)
  if (p.purpose !== purpose) fail()
  for (const field of Object.keys(b) as (keyof InstallationBinding)[]) {
    const expected = field === 'policyEpoch' && p.purpose === 'policy-change' ? b.policyEpoch + 1 : b[field]
    if (p[field] !== expected) fail()
  }
  const fingerprint = p.role === 'owner' ? owner : custodian
  if (p.keyFingerprint !== fingerprint || !verify(null, signatureBytes(p), publicKey(p.role === 'owner' ? ctx.ownerPublicKey : ctx.custodianPublicKey), signature)) fail()
  if (Date.parse(p.issuedAt) > now) fail()
  if ('expiresAt' in p && (now >= Date.parse(p.expiresAt) || p.nonce !== ctx.expectedNonce)) fail()
  if ('custodianKeyFingerprint' in p && p.custodianKeyFingerprint !== custodian) fail()
  if (p.purpose === 'installation-policy' && (p.ownerPublicKey !== ctx.ownerPublicKey || p.custodianPublicKey !== ctx.custodianPublicKey)) fail()
  return p
}
const artifactHash = (value: string) => createHash('sha256').update(value).digest('hex')
export function verifyEnrollmentBundle(
  artifacts: { authorization: string; proof: string; policy: string }, ctx: VerificationContext
): z.infer<typeof installationPolicy> {
  verifySignedArtifact(artifacts.authorization, 'owner-enrollment', ctx)
  const proof = verifySignedArtifact(artifacts.proof, 'custodian-enrollment', ctx)
  const policy = verifySignedArtifact(artifacts.policy, 'installation-policy', ctx)
  if (proof.purpose !== 'custodian-enrollment' || policy.purpose !== 'installation-policy' || proof.ownerAuthorizationSha256 !== artifactHash(artifacts.authorization) || policy.ownerAuthorizationSha256 !== artifactHash(artifacts.authorization) || policy.custodianProofSha256 !== artifactHash(artifacts.proof)) fail()
  return policy
}
export function verifyPolicyChange(input: string, ctx: VerificationContext, previousPolicySha256: string): z.infer<typeof policyChange> {
  const p = verifySignedArtifact(input, 'policy-change', ctx)
  if (p.purpose !== 'policy-change' || p.previousEpoch !== ctx.binding.policyEpoch || p.previousPolicySha256 !== hash.parse(previousPolicySha256)) fail()
  return p
}
export type CandidateFacts = Pick<z.infer<typeof ownerGrant>,
  'operationId' | 'archiveSha256' | 'archiveBytes' | 'databaseSha256' | 'migrationCount' | 'migrationFingerprint' | 'originalTupleSha256'>
export function verifyRecoveryGrant(approval: string, countersignature: string, ctx: VerificationContext, candidate: CandidateFacts): z.infer<typeof ownerGrant> {
  const p = verifySignedArtifact(approval, 'owner-recovery-grant', ctx)
  const c = verifySignedArtifact(countersignature, 'custodian-recovery-grant', ctx)
  if (p.purpose !== 'owner-recovery-grant' || c.purpose !== 'custodian-recovery-grant' || c.ownerGrantSha256 !== artifactHash(approval) || c.operationId !== p.operationId) fail()
  for (const field of ['operationId', 'archiveSha256', 'archiveBytes', 'databaseSha256', 'migrationCount', 'migrationFingerprint', 'originalTupleSha256'] as const) if (p[field] !== candidate[field]) fail()
  return p
}
export function generateInstallationIdentity(input: Pick<InstallationBinding, 'businessId' | 'platform' | 'targetDirectory' | 'osPrincipal'>): InstallationBinding {
  return validateBinding({ ...input, installationId: randomUUID(), deviceEnrollmentId: randomUUID(), appId: 'com.aurahome.erp', policyEpoch: 1 })
}
