import { normalizeIdentifier, validateIdentifier } from '../domain/identifiers.ts'
import { AuthorizationError, ValidationError } from '../domain/errors.ts'
import { normalizeCanonicalText } from '../domain/validation.ts'

export type OrganizationRole = 'admin' | 'member'

export interface Organization {
  id: string
  name: string
  createdAt: string
}

export interface OrganizationRepository {
  createWithAdmin(organization: Organization, adminUserId: string): Promise<void>
  findRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined>
  saveMemberAsAdmin(organizationId: string, actorUserId: string, userId: string, role: OrganizationRole, createdAt: string): Promise<void>
  removeMemberAsAdmin(organizationId: string, actorUserId: string, userId: string): Promise<void>
}

export class OrganizationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly createId: () => string,
    private readonly now: () => Date,
  ) {}

  async create(input: { name: string; actorUserId: string }): Promise<Organization> {
    const name = normalizeCanonicalText(input.name, 'Organization name', { maxLength: 200 })
    const actorUserId = validateIdentifier(input.actorUserId, 'User ID')
    const organization: Organization = {
      id: validateIdentifier(this.createId(), 'Generated ID'),
      name,
      createdAt: this.now().toISOString(),
    }
    await this.repository.createWithAdmin(organization, actorUserId)
    return organization
  }

  async roleFor(organizationIdInput: string, userIdInput: string): Promise<OrganizationRole | undefined> {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const userId = validateIdentifier(userIdInput, 'User ID')
    return this.repository.findRole(organizationId, userId)
  }

  async requireMembership(organizationId: string, userId: string): Promise<OrganizationRole> {
    const role = await this.roleFor(organizationId, userId)
    if (!role) throw new AuthorizationError('Organization membership is required')
    return role
  }

  async addMember(input: {
    organizationId: string
    actorUserId: string
    userId: string
    role: OrganizationRole
  }): Promise<void> {
    const organizationId = validateIdentifier(input.organizationId, 'Organization ID')
    const actorUserId = validateIdentifier(input.actorUserId, 'Actor user ID')
    const userId = normalizeIdentifier(input.userId, 'User ID')
    if (input.role !== 'admin' && input.role !== 'member') throw new ValidationError('Organization role is invalid')
    await this.repository.saveMemberAsAdmin(organizationId, actorUserId, userId, input.role, this.now().toISOString())
  }

  async removeMember(input: { organizationId: string; actorUserId: string; userId: string }): Promise<void> {
    const organizationId = validateIdentifier(input.organizationId, 'Organization ID')
    const actorUserId = validateIdentifier(input.actorUserId, 'Actor user ID')
    const userId = normalizeIdentifier(input.userId, 'User ID')
    await this.repository.removeMemberAsAdmin(organizationId, actorUserId, userId)
  }
}
