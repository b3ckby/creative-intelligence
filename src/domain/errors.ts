export class ApplicationError extends Error {
  constructor(
    public readonly statusCode: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
    public readonly publicMessage: string,
    internalMessage = publicMessage,
  ) {
    super(internalMessage)
    this.name = new.target.name
  }
}

export class ValidationError extends ApplicationError {
  constructor(internalMessage = 'Request is invalid', publicMessage = 'Invalid request') {
    super(400, publicMessage, internalMessage)
  }
}

export class AuthenticationError extends ApplicationError {
  constructor() {
    super(401, 'Authentication is required')
  }
}

export class AuthorizationError extends ApplicationError {
  constructor(internalMessage = 'Access denied') {
    super(403, 'Access denied', internalMessage)
  }
}

export class ConflictError extends ApplicationError {
  constructor(internalMessage = 'Resource conflict') {
    super(409, 'Resource conflict', internalMessage)
  }
}

export class NotFoundError extends ApplicationError {
  constructor(internalMessage = 'Resource not found') {
    super(404, 'Not found', internalMessage)
  }
}

export class RateLimitError extends ApplicationError {
  constructor() {
    super(429, 'Too many login attempts')
  }
}

export class ExternalProviderError extends ApplicationError {
  constructor() {
    super(502, 'Ad provider is unavailable')
  }
}

export class ServiceUnavailableError extends ApplicationError {
  constructor() {
    super(503, 'Service unavailable')
  }
}

export class DataIntegrityError extends Error {
  constructor(internalMessage = 'Stored data failed data-integrity validation') {
    super(internalMessage)
    this.name = 'DataIntegrityError'
  }
}
